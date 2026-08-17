import { DRAFT_VERIFY_CWD, ensureInternalCwd } from "./internal-cwd.js";

/**
 * Adversarial check of a bootstrap draft before a human ever reads it.
 *
 * The first real bootstrap run failed in a specific, repeatable way: claims
 * about *mechanism* were accurate (spot-checking every one in `gotchas`
 * against the code found no errors), while claims that *aggregate* were not
 * — an invented error count, and a dependency direction read off
 * package.json manifests rather than actual imports. Both were wrong in
 * seconds to check and would have entered the knowledge base stated
 * confidently, which is precisely the authority Component 4.6 says must not
 * be spent on unreviewed output.
 *
 * So the check is deliberately narrow. It does not review prose, judge
 * usefulness, or suggest improvements — that is the human's job at review,
 * and a verifier with opinions produces noise that trains you to skip it.
 * It extracts falsifiable claims, runs a command against each, and reports
 * only mismatches.
 *
 * A separate process rather than a self-review phase in the bootstrap
 * prompt, because an agent re-reading its own draft mostly reconfirms what
 * it already believes. This one never sees the reasoning that produced the
 * claim — only the claim, and the repository.
 *
 * Runs under DRAFT_VERIFY_CWD, not in the checkout. Global hooks catch every
 * `claude` on the machine, so a verifier running inside the worktree would
 * register as a session and feed its own events back to the collector. It is
 * given the repo path and uses absolute paths instead.
 */

const VERIFY_MODEL = "claude-haiku-4-5-20251001";
const VERIFY_TIMEOUT_MS = 120_000;

/** Cap on what one draft can report, so a pathological run can't flood review. */
const MAX_DISPUTES = 8;

export type DraftVerdict = "unverified" | "clean" | "disputed" | "error";

export interface DraftDispute {
  /** The claim as the draft states it, quoted closely enough to find. */
  claim: string;
  /** What checking actually showed. */
  finding: string;
  /** The command run, so a human can re-check rather than trust this. */
  evidence: string;
}

export interface DraftVerification {
  verdict: DraftVerdict;
  disputes: DraftDispute[];
}

function buildPrompt(slug: string, body: string, repoPath: string): string {
  return `You are fact-checking a generated documentation draft against the repository it describes. Be adversarial: you are useful only if you find things that are wrong.

The repository is at ${repoPath}. Inspect it with absolute paths (it is not your working directory).

Draft slug: ${slug}

--- BEGIN DRAFT ---
${body}
--- END DRAFT ---

Check only claims that are FALSIFIABLE by running a command:
- Any number (counts of errors, files, tests, packages).
- Any claim about which files, packages or modules do or do not do something.
- Any claim about a command's behaviour or output.
- Any claim that a named symbol, file, path or config value exists.

Verify a dependency or import claim by checking actual imports (rg for the
import statement), NOT by reading package.json — a declared dependency is
often unused, and that difference has already produced a wrong claim here.

Do NOT report: opinions, advice, judgements about what matters, prose style,
omissions, or anything you cannot check by running something. A claim you
verified as correct is not worth reporting either.

Report ONLY mismatches, as JSON and nothing else:

{"disputes":[{"claim":"<quoted from the draft>","finding":"<what you actually found>","evidence":"<the command you ran>"}]}

If everything checkable holds up, reply with exactly: {"disputes":[]}`;
}

/**
 * Extracts the JSON object from a model reply. Kept lenient because a
 * verifier that "fails" on a stray sentence of preamble would silently
 * downgrade every draft to unverified, which reads identically to a clean
 * one in the UI unless the verdict is distinguished — hence the separate
 * `error` verdict rather than falling back to `clean`.
 */
function parseDisputes(raw: string): DraftDispute[] | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as {
      disputes?: Array<Partial<DraftDispute>>;
    };
    if (!Array.isArray(parsed.disputes)) return null;

    return parsed.disputes
      .filter((d) => d.claim && d.finding)
      .slice(0, MAX_DISPUTES)
      .map((d) => ({
        claim: String(d.claim),
        finding: String(d.finding),
        evidence: String(d.evidence ?? ""),
      }));
  } catch {
    return null;
  }
}

export async function verifyDraft(
  slug: string,
  body: string,
  repoPath: string
): Promise<DraftVerification> {
  ensureInternalCwd(DRAFT_VERIFY_CWD);

  const proc = Bun.spawn(
    [
      "claude",
      "-p",
      buildPrompt(slug, body, repoPath),
      "--model",
      VERIFY_MODEL,
      // Read-only tools only. The verifier inspects; it must never be able to
      // edit the repository it is checking. Bash is needed despite being the
      // broad one — the failure class this exists to catch is claims about
      // command output ("235 errors"), which cannot be checked by reading.
      "--tools",
      "Bash,Read,Grep,Glob",
      // Tool access is scoped to the working directory, so without this the
      // verifier can see nothing and returns "I need permissions to access
      // …" — which parses as a failed check rather than a clean one, so the
      // omission would have quietly downgraded every draft to unverified.
      "--add-dir",
      repoPath,
      // Non-interactive: there is nobody to answer a permission prompt, so
      // without a mode it refuses every command. Same trust level as the
      // setup command the launcher already runs — the user's own tooling on
      // the user's own machine — and narrowed by the read-only tool list.
      "--permission-mode",
      "bypassPermissions",
      // This is what actually keeps the subprocess out of Standup's own feed,
      // and it is not optional. Hooks live in ~/.claude/settings.json, the
      // `user` source; excluding it means they never fire, so there is
      // nothing to filter. Dropping the `user` source also drops the MCP
      // registration, and --strict-mcp-config makes that explicit — a
      // fact-checker has no business holding checkpoint or ask_human.
      //
      // The reserved cwd alone is NOT sufficient here, which is the trap:
      // --add-dir makes the subprocess report the *added* directory as its
      // cwd, so a verifier pointed at a repo shows up as an ordinary session
      // in that repo and sails straight past a cwd-based guard. Measured —
      // two verifier runs registered two sessions before this was added.
      "--setting-sources",
      "project",
      "--strict-mcp-config",
      "--output-format",
      "json",
    ],
    { cwd: DRAFT_VERIFY_CWD, stdout: "pipe", stderr: "pipe" }
  );

  const timer = setTimeout(() => proc.kill(), VERIFY_TIMEOUT_MS);

  try {
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    if (proc.exitCode !== 0) return { verdict: "error", disputes: [] };

    const parsed = JSON.parse(stdout) as { result?: string; is_error?: boolean };
    if (parsed.is_error || !parsed.result) return { verdict: "error", disputes: [] };

    const disputes = parseDisputes(parsed.result);
    if (disputes === null) return { verdict: "error", disputes: [] };

    return {
      verdict: disputes.length > 0 ? "disputed" : "clean",
      disputes,
    };
  } catch (err) {
    console.error(`[draft-verify] ${slug} failed:`, err);
    return { verdict: "error", disputes: [] };
  } finally {
    clearTimeout(timer);
  }
}
