import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createStore, recordPersonaMediaShares, stageOwnerUpload } from "@standup/store";
import { floorQuestion } from "../floor/gate.js";
import type { FloorCategory } from "../floor/gate.js";
import { attachmentsDir } from "./attachments.js";
import { mediaProvenanceFor } from "./media-provenance.js";
import type { MediaProvenance } from "./media-provenance.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const MEDIA_REASON = "the owner's uploads are private media Persona forwarded; Persona decides whether this worker opens one";

/** A fake home with a data dir under it, an attachment passed to session "s1" and one that wasn't. */
function world() {
  const home = mkdtempSync(join(tmpdir(), "persona-provenance-"));
  dirs.push(home);
  const dataDir = join(home, ".local", "share", "standup");
  mkdirSync(attachmentsDir(dataDir), { recursive: true });
  const { db } = createStore(":memory:");
  const passedSha = "a".repeat(64);
  const otherSha = "b".repeat(64);
  const upload = (sha: string, name: string) =>
    stageOwnerUpload(db, { owner: "me", threadId: "t", sha256: sha, mimeType: "image/png", bytes: 1, name });
  const passed = upload(passedSha, "photo.png");
  upload(otherSha, "other.png");
  recordPersonaMediaShares(db, {
    key: "s1",
    owner: "me",
    files: [{ sha256: passedSha, attachmentId: passed.id }],
    at: "2026-10-09T10:00:00.000Z",
  });
  const dir = attachmentsDir(dataDir);
  return { db, home, dataDir, dir, passedSha, otherSha, passedId: passed.id };
}

/** The floor's question for a held call, as floorQuestion words it. */
function question(
  tool: string,
  input: Record<string, unknown>,
  opts: { category?: FloorCategory; reason?: string } = {}
): string {
  return floorQuestion(
    { toolName: tool, toolInput: input, cwd: "/w" },
    {
      category: opts.category ?? "standup-ops",
      ownerOnly: false,
      reason: opts.reason ?? `${tool} reads a file, which reads an owner media upload in persona-attachments: ${MEDIA_REASON}`,
      step: "x",
    }
  );
}

describe("mediaProvenanceFor", () => {
  test("passed only for exact folder paths, all passed, shown whole, and nothing else held", () => {
    const w = world();
    const p = `${w.dir}/${w.passedSha}.png`;
    const o = `${w.dir}/${w.otherSha}.png`;
    const homeRel = p.slice(w.home.length + 1);
    const PASSED: MediaProvenance = {
      passed: true,
      files: [{ attachmentId: w.passedId, name: "photo.png", sharedAt: "2026-10-09T10:00:00.000Z" }],
    };
    const NOT: MediaProvenance = { passed: false, reason: "not-passed" };
    const UNID: MediaProvenance = { passed: false, reason: "unidentified" };
    const bash = (command: string) => question("Bash", { command });
    const cases: Array<{ name: string; q: string; want: MediaProvenance | null }> = [
      { name: "Read of a passed file", q: question("Read", { file_path: p }), want: PASSED },
      { name: "cat of a passed file", q: bash(`cat '${p}'`), want: PASSED },
      { name: "~ form", q: bash(`cat ~/${homeRel}`), want: PASSED },
      { name: "$HOME form", q: bash(`cat "$HOME/${homeRel}"`), want: PASSED },
      { name: "a file not passed", q: question("Read", { file_path: o }), want: NOT },
      { name: "one passed + one unpassed", q: bash(`cat ${p} ${o}`), want: NOT },
      // (a) clipped
      { name: "a clipped call", q: bash(`cat ${p} # ${"x".repeat(4100)}`), want: UNID },
      // (b) globs, the bare folder, listing and recursive programs
      { name: "a * glob", q: bash(`cat ${w.dir}/*.png`), want: UNID },
      { name: "a ? glob beside a passed path", q: bash(`cat ${p} ${w.dir}/?.png`), want: UNID },
      { name: "a [ glob", q: bash(`cat ${p} /tmp/[ab]`), want: UNID },
      { name: "a { brace", q: bash(`cat ${p} /tmp/{a,b}`), want: UNID },
      { name: "${HOME} braces", q: bash(`cat \${HOME}/${homeRel}`), want: UNID },
      { name: "the bare folder", q: question("Read", { file_path: w.dir }), want: UNID },
      { name: "the folder with a slash", q: bash(`cat ${p}; cat ${w.dir}/`), want: UNID },
      ...["ls", "find", "du", "tree", "rsync -a", "tar cf x.tar", "zip x.zip", "rg photo"].map((prog) => ({
        name: prog,
        q: bash(`${prog} ${p}`),
        want: UNID,
      })),
      { name: "cp -r", q: bash(`cp -r ${p} /tmp/out`), want: UNID },
      { name: "grep -R", q: bash(`grep -R foo ${p}`), want: UNID },
      { name: "a piped ls", q: bash(`cat ${p} | ls`), want: UNID },
      // (c) a stored name outside the folder (perhaps a link), or not a whole name
      { name: "a passed name in /tmp", q: bash(`cat /tmp/${w.passedSha}.png`), want: UNID },
      { name: "a relative name", q: bash(`cat ${w.passedSha}.png`), want: UNID },
      { name: "a longer name in the folder", q: bash(`cat ${p}.bak`), want: UNID },
      { name: "no stored name at all", q: question("Read", { file_path: "/tmp/link" }), want: UNID },
      // (d) another finding beside the media read
      {
        name: "an (also …) finding",
        q: question("Bash", { command: `cat ${p}` }, {
          reason: `cat reads a file, which reads an owner media upload in persona-attachments: ${MEDIA_REASON} (also: it writes outside the worktree)`,
        }),
        want: UNID,
      },
      {
        name: "two media findings",
        q: question("Bash", { command: `cat ${p}` }, {
          reason: `cat reads a file, which reads an owner media upload in persona-attachments: ${MEDIA_REASON}; cat reads b, which reads an owner media upload in persona-attachments: ${MEDIA_REASON}`,
        }),
        want: UNID,
      },
      { name: "a tool that isn't a plain read", q: question("Grep", { pattern: "x", path: p }), want: UNID },
      // Not a media-read hold at all.
      { name: "another category", q: question("Bash", { command: `cat ${p}` }, { category: "destructive" }), want: null },
      { name: "the phrase only in the call", q: question("Bash", { command: `echo reads an owner media upload in persona-attachments ${p}` }, { category: "standup-ops", reason: "something else" }), want: null },
    ];
    for (const c of cases) {
      expect({ name: c.name, got: mediaProvenanceFor(w.db, "me", "s1", c.q, { dataDir: w.dataDir, home: w.home }) }).toEqual({
        name: c.name,
        got: c.want,
      });
    }
  });

  test("without a data dir, or for another owner or worker, nothing is vouched for", () => {
    const w = world();
    const q = question("Read", { file_path: `${w.dir}/${w.passedSha}.png` });
    expect(mediaProvenanceFor(w.db, "me", "s1", q, { home: w.home })).toEqual({ passed: false, reason: "unidentified" });
    expect(mediaProvenanceFor(w.db, "you", "s1", q, { dataDir: w.dataDir, home: w.home })).toEqual({ passed: false, reason: "not-passed" });
    expect(mediaProvenanceFor(w.db, "me", "s2", q, { dataDir: w.dataDir, home: w.home })).toEqual({ passed: false, reason: "not-passed" });
  });
});
