import { DRAFT_VERIFY_CWD, ensureInternalCwd } from "./internal-cwd.js";
import { headlessSettingsArgs } from "./claude-cli.js";
import {
  mainlineRefreshReason,
  openSnapshots,
  refreshMainline,
  type MainlineDeps,
  type MainlineRef,
  type MainlineSnapshot,
  type MainlineSnapshots,
} from "./knowledge-mainline.js";
import { checkDisputeEvidence, type DroppedDisputes, type EntailmentJudge } from "./knowledge-dispute-evidence.js";
import { withoutSlotEnv } from "./worker-env.js";

/**
 * Adversarial check of a bootstrap draft before a human ever reads it.
 *
 * The first real bootstrap run failed in a specific, repeatable way: claims
 * about *mechanism* were accurate (spot-checking every one in `gotchas`
 * against the code found no errors), while claims that *aggregate* were not
 * — an invented error count, and a dependency direction read off
 * package.json manifests rather than actual imports. Both were wrong in
 * seconds to check and would have entered the knowledge base stated
 * confidently, which is precisely the authority that must not be spent on
 * unreviewed output.
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
 * The repository is read at its freshly fetched mainline (knowledge-mainline.ts),
 * not at whatever the local checkout holds, and every dispute must quote the
 * line it rests on or name what it searched; that evidence is re-checked at
 * the same commit and a dispute whose evidence fails is dropped
 * (knowledge-dispute-evidence.ts).
 *
 * Runs under DRAFT_VERIFY_CWD, not in the checkout. Global hooks catch every
 * `claude` on the machine, so a verifier running inside the worktree would
 * register as a session and feed its own events back to the collector. It is
 * given the repo path and uses absolute paths instead.
 */

const VERIFY_MODEL = "claude-haiku-4-5-20251001";
const VERIFY_TIMEOUT_MS = 120_000;

/**
 * Confidence an agent-written doc is published at before its fact-check has
 * passed. Below full confidence so ranking and the resolver treat it as an
 * unconfirmed claim, above the injection floor so a useful proposal still
 * reaches agents meanwhile. A passing verification lifts it to full confidence
 * and stamps last_verified_at; until then last_verified_at stays unset.
 */
export const UNVERIFIED_CONFIDENCE = 0.6;

/** Cap on what one draft can report, so a pathological run can't flood review. */
const MAX_DISPUTES = 8;

export type DraftVerdict =
  | "unverified"
  | "unverifiable"
  | "clean"
  | "disputed"
  | "error"
  | "contradicted";

export interface DraftDispute {
  /** The claim as the draft states it, quoted closely enough to find. */
  claim: string;
  /** What checking actually showed. */
  finding: string;
  /** The command run, so a human can re-check rather than trust this. */
  evidence: string;
  /** `git` for a repository-state finding from a git command rather than the
   *  model fact-check; `repo` for a note about the check itself (no checkout
   *  of the doc's project was available, or a finding was set aside). Either
   *  is shown to a human, never weighed against the doc. */
  origin?: "git" | "repo";
  /** A model finding's form: the repository says otherwise, or the thing
   *  named is not there. */
  kind?: "contradicted" | "absent";
  /** The lines a `contradicted` finding rests on, quoted. */
  citations?: DisputeCitation[];
  /** For a `contradicted` finding about a value: the value the draft states and
   *  the value the cited line holds, as the verifier read them. */
  draftValue?: string;
  codeValue?: string;
  /** For an `absent` finding: the name searched for, and where. */
  symbol?: string;
  searched?: string[];
}

export interface DisputeCitation {
  file: string;
  line: number;
  quote: string;
}

export interface DraftVerification {
  verdict: DraftVerdict;
  disputes: DraftDispute[];
  /** The mainline commits the check read. */
  refs?: Array<{ repo: string; ref: string; sha: string }>;
  /** Model disputes discarded because their evidence did not hold at those commits. */
  dropped?: DroppedDisputes;
}

/** Options for one verification. */
export interface VerifyOptions {
  /**
   * Tell the verifier that a name simply absent from this repo is not a
   * mismatch. Set when checking an accepted doc, which may describe another
   * checkout or system; a draft distilled from this repo leaves it off.
   */
  absenceIsNotAMismatch?: boolean;
  /**
   * Further checkouts the doc is about, beyond `repoPath`: a global doc can
   * describe several projects. Each is readable by the verifier and named in
   * its prompt.
   */
  additionalRepos?: string[];
  /** The git, fetch and cache behind the mainline refresh. */
  mainline?: MainlineDeps;
  /** Runs the verifier model on a prompt with read access to `dirs`, returning
   *  its reply text, or null when the run failed. */
  runModel?: (prompt: string, dirs: string[]) => Promise<string | null>;
  /** Decides disputes the deterministic entailment rule leaves undecided
   *  (knowledge-dispute-evidence.ts); omitted, those are kept. */
  entailmentJudge?: EntailmentJudge;
}

const ABSENCE_RULE = `

A path, file, symbol or config value that is simply ABSENT from this
repository is NOT a mismatch: the document may describe another checkout or
system. Report only claims this repository actively contradicts.`;

function describeCheckout(s: MainlineSnapshot): string {
  return `${s.dir} (${s.ref.ref} at ${s.ref.sha.slice(0, 12)})`;
}

function repositoryLine(snapshots: readonly MainlineSnapshot[]): string {
  if (snapshots.length === 1) {
    return `The repository is checked out at ${describeCheckout(snapshots[0]!)}, its current mainline. Inspect it with absolute paths (it is not your working directory).`;
  }
  return `The draft describes these repositories, each checked out at its current mainline: ${snapshots.map(describeCheckout).join(", ")}. Inspect them with absolute paths (none is your working directory); a claim holds if it holds in the repository it is about.`;
}

const OUTPUT_SCHEMA = `Report ONLY mismatches, as JSON and nothing else. Every dispute carries its
evidence, and that evidence is re-checked mechanically against the same commit:
a dispute whose quote is not at the line it cites, whose quoted line holds the
same value the draft states, or whose "missing" symbol is found, is discarded.

{"disputes":[
  {"kind":"contradicted","claim":"<quoted from the draft>","finding":"<what the code actually says>","evidence":"<the command you ran>","citations":[{"file":"<absolute path>","line":<line number>,"quote":"<that line's text, copied exactly>"}],"draftValue":"<the value the draft states, if the claim is about a value>","codeValue":"<the value the quoted line holds>"},
  {"kind":"absent","claim":"<quoted from the draft>","finding":"<what you searched and did not find>","evidence":"<the search you ran>","symbol":"<the exact name searched for>","searched":["<absolute path of each file or directory searched>"]}
]}

- "contradicted": the repository says something other than the draft. Cite the
  line(s) that show it, each with its file, line number and text copied
  verbatim (no line-number prefix). The quoted line must CONTRADICT the claim:
  a line that differs in wording but holds the same value is not a mismatch.
- "absent": a file, symbol or value the draft names does not exist. Search the
  whole repository (rg) before saying so, and name the symbol and every file or
  directory searched.`;

function buildPrompt(slug: string, body: string, snapshots: readonly MainlineSnapshot[], opts: VerifyOptions = {}): string {
  return `You are fact-checking a generated documentation draft against the repository it describes. Be adversarial: you are useful only if you find things that are wrong.

${repositoryLine(snapshots)}

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
verified as correct is not worth reporting either.${opts.absenceIsNotAMismatch ? ABSENCE_RULE : ""}

${OUTPUT_SCHEMA}

If everything checkable holds up, reply with exactly: {"disputes":[]}`;
}

function parseCitations(raw: unknown): DisputeCitation[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((c) => {
    const cite = c as Partial<Record<keyof DisputeCitation, unknown>> | null;
    if (!cite || typeof cite.file !== "string" || typeof cite.quote !== "string") return [];
    return [{ file: cite.file, line: Number(cite.line), quote: cite.quote }];
  });
}

/**
 * Extracts the JSON object from a model reply. Kept lenient because a
 * verifier that "fails" on a stray sentence of preamble would silently
 * downgrade every draft to unverified, which reads identically to a clean
 * one in the UI unless the verdict is distinguished — hence the separate
 * `error` verdict rather than falling back to `clean`.
 */
export function parseDisputes(raw: string): DraftDispute[] | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as {
      disputes?: Array<Record<string, unknown>>;
    };
    if (!Array.isArray(parsed.disputes)) return null;

    return parsed.disputes
      .filter((d) => d && d.claim && d.finding)
      .slice(0, MAX_DISPUTES)
      .map((d) => {
        const dispute: DraftDispute = {
          claim: String(d.claim),
          finding: String(d.finding),
          evidence: String(d.evidence ?? ""),
        };
        if (d.kind === "contradicted" || d.kind === "absent") dispute.kind = d.kind;
        const citations = parseCitations(d.citations);
        if (citations.length > 0) dispute.citations = citations;
        if (typeof d.draftValue === "string" && typeof d.codeValue === "string") {
          dispute.draftValue = d.draftValue;
          dispute.codeValue = d.codeValue;
        }
        if (typeof d.symbol === "string" && d.symbol.trim()) dispute.symbol = d.symbol.trim();
        if (Array.isArray(d.searched)) {
          const searched = d.searched.filter((s): s is string => typeof s === "string" && s.trim() !== "");
          if (searched.length > 0) dispute.searched = searched;
        }
        return dispute;
      });
  } catch {
    return null;
  }
}

/** `text` with each snapshot's path replaced by the checkout it stands for. */
function unmapPaths(text: string, snapshots: readonly MainlineSnapshot[]): string {
  return snapshots.reduce((t, s) => t.split(s.root).join(s.ref.toplevel), text);
}

/** A dispute's paths rewritten from the snapshots to the checkouts they stand for. */
function unmapDispute(d: DraftDispute, snapshots: readonly MainlineSnapshot[]): DraftDispute {
  const un = (t: string) => unmapPaths(t, snapshots);
  return {
    ...d,
    claim: un(d.claim),
    finding: un(d.finding),
    evidence: un(d.evidence),
    ...(d.citations ? { citations: d.citations.map((c) => ({ ...c, file: un(c.file) })) } : {}),
    ...(d.searched ? { searched: d.searched.map(un) } : {}),
    ...(d.symbol ? { symbol: un(d.symbol) } : {}),
  };
}

/** The note recorded when the check could not read a repository's mainline. */
function mainlineNote(reason: string): DraftDispute {
  return {
    claim: reason,
    finding: "The fact-check could not read this repository's current mainline, and a verdict from a stale or local checkout would not describe it.",
    evidence: "git fetch origin <default-branch>",
    origin: "repo",
  };
}

/** The note recorded for a finding set aside because its evidence did not hold. */
export function droppedNote(reason: string): DraftDispute {
  return {
    claim: reason,
    finding:
      "A fact-check finding was set aside because its evidence did not hold at the verified commit; the doc is neither disputed nor verified by it.",
    evidence: "re-read of the cited evidence at the verified commit",
    origin: "repo",
  };
}

function unverifiable(slug: string, reason: string): DraftVerification {
  console.warn(`[draft-verify] ${slug}: ${reason}`);
  return { verdict: "unverifiable", disputes: [mainlineNote(reason)] };
}

/**
 * Fact-checks `body` against the current mainline of `repoPath` (and of any
 * further checkouts it is about). The model's disputes are kept only when
 * their quoted evidence holds at that commit. A doc whose primary repository's
 * mainline cannot be refreshed is `unverifiable`; a further repository that
 * cannot be is left out of the check, and a check with no dispute is then
 * `unverifiable` too. A check whose every dispute was dropped is `unverified`,
 * with the reasons as notes: it is never `clean`.
 */
export async function verifyDraft(
  slug: string,
  body: string,
  repoPath: string,
  opts: VerifyOptions = {}
): Promise<DraftVerification> {
  const mainline = opts.mainline ?? {};
  const primary = await refreshMainline(repoPath, mainline);
  if (!primary.ok) return unverifiable(slug, mainlineRefreshReason(repoPath, primary.reason));
  const refs: MainlineRef[] = [primary.ref];
  /** Why each further checkout the doc is about was left out of the check. */
  const missing: string[] = [];
  for (const repo of opts.additionalRepos ?? []) {
    const refreshed = await refreshMainline(repo, mainline);
    if (!refreshed.ok) {
      missing.push(mainlineRefreshReason(repo, refreshed.reason));
      console.warn(`[draft-verify] ${slug}: ${missing[missing.length - 1]}; left out of the check`);
    } else if (!refs.some((r) => r.clone === refreshed.ref.clone)) {
      refs.push(refreshed.ref);
    }
  }

  let held: MainlineSnapshots | null = null;
  try {
    held = await openSnapshots(refs, mainline);
    if (held.snapshots[0] === null) {
      return unverifiable(slug, mainlineRefreshReason(repoPath, `could not check out ${primary.ref.ref}`));
    }
    held.snapshots.forEach((s, i) => {
      if (s === null) missing.push(mainlineRefreshReason(refs[i]!.repo, `could not check out ${refs[i]!.ref}`));
    });
    const snapshots = held.snapshots.filter((s): s is MainlineSnapshot => s !== null);
    const reply = await (opts.runModel ?? runVerifierModel)(
      buildPrompt(slug, body, snapshots, opts),
      snapshots.map((s) => s.dir)
    );
    const verified = snapshots.map((s) => ({ repo: s.ref.repo, ref: s.ref.ref, sha: s.ref.sha }));
    const parsed = reply === null ? null : parseDisputes(reply);
    if (parsed === null) return { verdict: "error", disputes: [], refs: verified };

    const { kept, dropped } = await checkDisputeEvidence(
      parsed.map((d) => unmapDispute(d, snapshots)),
      snapshots.map((s) => s.ref),
      mainline,
      { entailmentJudge: opts.entailmentJudge }
    );
    if (dropped.count > 0) {
      console.warn(`[draft-verify] ${slug}: dropped ${dropped.count} dispute(s): ${dropped.reasons.join("; ")}`);
    }
    const withDropped = dropped.count > 0 ? { dropped } : {};
    if (kept.length > 0) return { verdict: "disputed", disputes: kept, refs: verified, ...withDropped };
    // Without a finding the doc is clean only if every repository it is about
    // was read, and the verifier raised nothing that was set aside.
    if (missing.length > 0) {
      console.warn(`[draft-verify] ${slug}: ${missing.join("; ")}`);
      return { verdict: "unverifiable", disputes: missing.map(mainlineNote), refs: verified, ...withDropped };
    }
    if (dropped.count > 0) {
      return { verdict: "unverified", disputes: dropped.reasons.map(droppedNote), refs: verified, dropped };
    }
    return { verdict: "clean", disputes: [], refs: verified };
  } catch (err) {
    console.error(`[draft-verify] ${slug} failed:`, err);
    return { verdict: "error", disputes: [] };
  } finally {
    held?.close();
  }
}

/** The verifier model's reply over `prompt`, with read access to `dirs`, or
 *  null when the run failed. */
async function runVerifierModel(prompt: string, dirs: string[]): Promise<string | null> {
  ensureInternalCwd(DRAFT_VERIFY_CWD);

  const proc = Bun.spawn(
    [
      "claude",
      "-p",
      prompt,
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
      ...dirs.flatMap((d) => ["--add-dir", d]),
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
      ...headlessSettingsArgs(),
      "--strict-mcp-config",
      "--output-format",
      "json",
    ],
    { cwd: DRAFT_VERIFY_CWD, stdout: "pipe", stderr: "pipe", env: withoutSlotEnv() }
  );

  const timer = setTimeout(() => proc.kill(), VERIFY_TIMEOUT_MS);

  try {
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    if (proc.exitCode !== 0) return null;
    const parsed = JSON.parse(stdout) as { result?: string; is_error?: boolean };
    return parsed.is_error || !parsed.result ? null : parsed.result;
  } catch (err) {
    console.error("[draft-verify] verifier run failed:", err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
