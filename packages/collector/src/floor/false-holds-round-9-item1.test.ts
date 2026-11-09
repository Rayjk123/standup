import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { attachSessionToLaunch, createLaunch, createSession, createStore, getAsk, setLaunchWorkerTokenHash, upsertProject } from "@standup/store";
import type { Ask } from "@standup/shared";
import { scratchDirFor, scratchRoot } from "@standup/shared/scratch";
import { generateOwnerSecrets } from "../owner-secret.js";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import { FLOOR_HOLD_ROUTE, FLOOR_WORKER_TOKEN_HEADER, workerTokenHash, type FloorConfig, type FloorHoldRequest, type FloorVerdict } from "./gate.js";
import type { AwsIdentity } from "./aws-identity.js";
import * as push from "../push.js";

/*
 * A worker's own launch dir below the scratch root (FloorConfig.scratchDir)
 * is its TMPDIR, so naming it literally reads and writes like $TMPDIR does.
 * Another launch's dir, the scratch root itself, a path that climbs out of
 * the own dir and a sibling sharing its name as a prefix stay protected.
 *
 * Two worlds: one where every path is canonical, and one shaped like a launch
 * config on a box whose home dir is a symlink (`/home/u` → `/data/home/u`):
 * the root is canonical, the scratch root and data dir are as written under
 * the linked home, and tmpDirs hold only the system temp dirs.
 */

const OWN_ID = "a6a6a6a6-0000-4000-8000-0000000000a6";
const OTHER_ID = "a7a7a7a7-0000-4000-8000-0000000000a7";
const INSTALL = join("/", "fake", "install");
const COMMON = join("/", "fake", "repo", ".git");

interface World {
  name: string;
  /** The home dir as the worker's environment names it. */
  home: string;
  /** Where the home dir really is. */
  realHome: string;
  /** Whether the config's tmpDirs list the own scratch dir. */
  scratchInTmpDirs: boolean;
}

const WORLDS: World[] = [
  { name: "canonical paths", home: join("/", "fake", "home"), realHome: join("/", "fake", "home"), scratchInTmpDirs: true },
  { name: "a linked home dir", home: join("/", "fake", "home"), realHome: join("/", "fake", "data", "home"), scratchInTmpDirs: false },
];

function setup(w: World) {
  const real = (p: string) => (p === w.home || p.startsWith(`${w.home}/`) ? w.realHome + p.slice(w.home.length) : p);
  const DATA = join(w.home, ".local", "share", "standup");
  const ROOT = real(join(DATA, "worktrees", "standup", "feat-1"));
  const SCRATCH = join(w.home, ".cache", "standup-scratch");
  const OWN = join(SCRATCH, OWN_ID);
  const OTHER = join(SCRATCH, OTHER_ID);
  const config: FloorConfig = {
    v: 1,
    collectorUrl: "http://127.0.0.1:17777",
    launchId: OWN_ID,
    root: ROOT,
    sharedBranches: ["main", "mainline"],
    personalAwsAccounts: [],
    worktreeRoots: [join(DATA, "worktrees")],
    waitSeconds: 60,
    standupDataDir: DATA,
    floorPaths: [join(INSTALL, "packages", "collector", "src", "floor")],
    installDir: INSTALL,
    protectedPaths: [join(DATA, "secrets"), SCRATCH],
    tmpDirs: w.scratchInTmpDirs ? ["/tmp", OWN] : ["/tmp", "/var/tmp"],
    scratchRoot: SCRATCH,
    scratchDir: OWN,
    workerToken: "x".repeat(64),
    replyPublicKey: "test",
  };
  /** Files, by real path. */
  const FILES: Record<string, string> = {
    [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
    [join(ROOT, "in.txt")]: "a\n",
    [join(ROOT, "file")]: "a\n",
    [real(join(OWN, "f"))]: "a\n",
    [real(join(OWN, "x.txt"))]: "a\n",
    [real(join(OTHER, "f"))]: "a\n",
    [real(join(SCRATCH, `${OWN_ID}x`, "f"))]: "a\n",
    [real(join(SCRATCH, `${OWN_ID}-evil`, "f"))]: "a\n",
    [join("/tmp", ".local", "share", "standup", "standup.db")]: "x",
    [join("/tmp", "a", "b", "c", "keep")]: "x",
  };
  /** Symlinks: path → where it points. */
  const LINKS: Record<string, string> = {
    [real(join(OWN, "out"))]: real(OTHER),
    ...(w.home !== w.realHome ? { [w.home]: w.realHome } : {}),
  };
  const dirs = new Set<string>(["/", "/tmp", "/var/tmp", ROOT, real(OWN), real(OTHER)]);
  for (const f of [...Object.keys(FILES), ...Object.keys(LINKS).map(real)]) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(join(ROOT, ".git"));
  for (const l of Object.keys(LINKS)) dirs.delete(l);
  const followed = (p: string): string => {
    for (let i = 0; i < 8; i++) {
      const link = Object.keys(LINKS).find((l) => p === l || p.startsWith(`${l}/`));
      if (link === undefined) return p;
      p = LINKS[link]! + p.slice(link.length);
    }
    return p;
  };
  const known = (p: string) => p in FILES || dirs.has(p);
  const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
  parseShellSnapshot("", defs);
  const probes: Partial<FloorProbes> = {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: (dir) => (followed(dir) === ROOT ? COMMON : null),
    readFile: (p) => (followed(p) in FILES ? { ok: true, text: FILES[followed(p)]! } : { ok: false, reason: "missing" }),
    exists: (p) => known(followed(p)),
    isDirectory: (p) => dirs.has(followed(p)),
    listDir: (p) => {
      const q = followed(p);
      if (!dirs.has(q)) return null;
      return [...new Set([...Object.keys(FILES), ...Object.keys(LINKS), ...dirs].filter((f) => f.startsWith(`${q === "/" ? "" : q}/`)).map((f) => f.slice(q.length + 1).split("/")[0]!))];
    },
    realpath: (p) => (known(followed(p)) ? followed(p) : null),
    lstat: (p) => {
      const parent = followed(p.slice(0, p.lastIndexOf("/")) || "/");
      const q = join(parent, p.slice(p.lastIndexOf("/") + 1));
      if (q in LINKS) return { symlink: true, file: false, nlink: 1 };
      return q in FILES ? { symlink: false, file: true, nlink: 1 } : dirs.has(q) ? { symlink: false, file: false, nlink: 2 } : null;
    },
    homeDir: () => w.home,
    env: (name) => (name === "HOME" ? w.home : name === "TMPDIR" ? OWN : undefined),
    shellDefinitions: () => defs,
    awsAccount: () => null,
    now: () => Date.now(),
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
  const bash = (command: string): FloorVerdict => classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, probes);
  return { real, ROOT, SCRATCH, OWN, OTHER, bash };
}

for (const w of WORLDS) {
  const { real, ROOT, SCRATCH, OWN, OTHER, bash } = setup(w);

  const expectAllowed = (command: string): void => {
    expect({ command, verdict: bash(command) }).toEqual({ command, verdict: { action: "allow" } });
  };

  const expectHeld = (command: string): void => {
    const v = bash(command);
    expect({ command, v }).toMatchObject({ command, v: { action: "hold", category: "floor-tamper" } });
    expect({ command, ownerReserved: v.action === "hold" && v.ownerReserved === true }).toEqual({ command, ownerReserved: true });
  };

  describe(`${w.name}: the worker's own launch dir named literally`, () => {
    test.each([
      `cd ${OWN} && ls`,
      `cd ${OWN}`,
      `ls ${OWN}`,
      `cat ${join(OWN, "f")}`,
      `sed -n 1p file > ${join(OWN, "x.txt")}`,
      `sed 's/a/b/' in.txt > ${join(OWN, "out.txt")}`,
      `sed -i 's/a/b/' ${join(OWN, "f")}`,
      `sed -n 1p ${join(OWN, "f")}`,
      `echo hi > ${join(OWN, "new.txt")}`,
      `cd ${OWN} && sed -n 1p f > x.txt`,
      `cp in.txt ${join(OWN, "copy.txt")}`,
      `ls ${OWN}/`,
      `ls ${OWN}/*`,
      `cd ${join(OWN, "..", OWN_ID)} && ls`,
      `sed -n 1p ../feat-1/in.txt > ${join(OWN, "x.txt")}`,
      `cd ${OWN} && ls ../${OWN_ID}`,
      `sed 's/a/b/' ./in.txt > ${join(OWN, "out.txt")}; ls ..`,
      `cp ../feat-1/in.txt ${join(OWN, "copy.txt")}`,
      `cd "${OWN}" && ls`,
      `cd ${OWN}/ && ls`,
      `cd '${OWN}' && ls -la`,
      `sed -n 1p file > "${join(OWN, "x.txt")}"`,
      `sed -n '1,20p' file > ${join(OWN, "x.txt")} 2>&1`,
      `sed -n 1p file | tee ${join(OWN, "x.txt")}`,
      `sed -i.bak 's/a/b/' ${join(OWN, "f")}`,
      `sed -i '' -e 's/a/b/' ${join(OWN, "f")}`,
      `sed -E 's/(a)\\.(b)/\\2/g' in.txt > ${join(OWN, "out.txt")}`,
      `sed -n '/start/,/end/p' in.txt > ${join(OWN, "out.txt")}`,
      `sed "s|a|b|" in.txt > ${join(OWN, "out.txt")}`,
      `cat > ${join(OWN, "x.txt")} <<'EOF'\nhello\nEOF`,
      `cd ${OWN} && sed -n 1p ${join(OWN, "f")} && cat x.txt`,
      `mkdir -p ${join(OWN, "sub")} && cd ${join(OWN, "sub")} && ls`,
      `ls ~/.cache/standup-scratch/${OWN_ID}`,
      `sed -n 1p file > $HOME/.cache/standup-scratch/${OWN_ID}/x.txt`,
      `cd ${OWN}; ls; cd -`,
      `cd ${OWN} && git -C ${ROOT} status`,
      `cd ${real(OWN)} && ls`,
      `sed -n 1p file > ${join(real(OWN), "x.txt")}`,
      `sed -i 's/a/b/' ${join(real(OWN), "f")}`,
      `cat "../feat-1/in.txt" > ${join(OWN, "x.txt")}`,
      `sed -n 1p "${ROOT}/../feat-1/in.txt" > ${join(OWN, "x.txt")}`,
      `node -e "console.log(require('path').dirname('/a/b'))" > ${join(OWN, "out.txt")}`,
      `python3 -c "import os; print(os.path.dirname('/a/b'))" > ${join(OWN, "out.txt")}`,
      `git log --format=%H -1 > ${join(OWN, "x.txt")} && dirname ${ROOT}`,
      `echo "a/b" | awk -F/ '{print $1}' > ${join(OWN, "x.txt")}; ls ${OWN}`,
      `cd ${OWN} && head -n 5 ../${OWN_ID}/f`,
      `grep -n a "../feat-1/in.txt" > ${join(OWN, "x.txt")}`,
      `sed -n 1p "../feat-1/in.txt" > ${join(OWN, "x.txt")}`,
    ])("is allowed: %p", (command) => {
      expectAllowed(command);
    });
  });

  describe(`${w.name}: the rest of the scratch root stays protected`, () => {
    test.each([
      `cat ${join(OTHER, "f")}`,
      `ls ${OTHER}`,
      `sed -n 1p file > ${join(OTHER, "x.txt")}`,
      `sed -i 's/a/b/' ${join(OTHER, "f")}`,
      `ls ${SCRATCH}`,
      `cat ${SCRATCH}/*/f`,
      `ls ${SCRATCH}/*`,
      `echo x > ${join(SCRATCH, "x.txt")}`,
      `cat ${OWN}/../${OTHER_ID}/f`,
      `sed -i 's/a/b/' ${OWN}/../${OTHER_ID}/f`,
      `cd ${OWN}/.. && ls`,
      `cd ${OWN} && cat ../${OTHER_ID}/f`,
      `cat ${join(SCRATCH, `${OWN_ID}x`, "f")}`,
      `sed -i 's/a/b/' ${join(SCRATCH, `${OWN_ID}-evil`, "f")}`,
      `cat ${OWN}*/f`,
      `cat ${join(OWN, "out", "f")}`,
      `echo x > ${join(OWN, "out", "f")}`,
      `cat ${join(real(OTHER), "f")}`,
      `ls ${real(SCRATCH)}`,
      `cat ${real(OWN)}/../${OTHER_ID}/f`,
      `cd ${OWN} && sed -n '1,5p' ../${OTHER_ID}/f`,
      `cd ${OWN} && sed -n '1,5p' "../${OTHER_ID}/f"`,
      `cd ${OWN} && node -e "console.log(require('fs').readdirSync(require('path').dirname(process.cwd())))"`,
      `node -e "console.log(require('fs').readdirSync(require('path').dirname(process.argv[1])))" ${join(OWN, "f")}`,
      `node -e "console.log(require('fs').readdirSync('${OWN}/..'))"`,
      `python3 -c "import os; print(os.listdir(os.path.dirname('${OWN}')))"`,
      // Code may climb from any string it is handed, so a climb in code keeps the mention.
      `node -e "console.log('a/b'.split('/'))" > ${join(OWN, "out.txt")}`,
      `cd ${OWN} && cat "../${OTHER_ID}/f"`,
      `cd ${OWN} && cp "../${OTHER_ID}/f" x.txt`,
      `cat "../x"; python3 -c 'import os; print(os.listdir("${OWN}/" + "../x"))'`,
      `cat "../x"; python3 -c 'import os; print(os.listdir("${OWN}" + "/.."))'`,
      `awk '{print}' "../${OTHER_ID}/f" > ${join(OWN, "x.txt")}`,
      `cd ${OWN} && sed -n 1p "../${OTHER_ID}/f" > x.txt`,
    ])("is held: %p", (command) => {
      expectHeld(command);
    });
  });

  describe(`${w.name}: cp --parents lands each source at its whole path below the dest`, () => {
    test.each([
      // Writes SCRATCH/feat-1/in.txt, beside the own dir.
      ["quoted, climbing out of the own dir", `cp --parents "../feat-1/in.txt" ${OWN}`],
      ["unquoted, climbing out of the own dir", `cp --parents ../feat-1/in.txt ${OWN}`],
      // Writes HOME/.local/share/standup/standup.db, the live DB.
      ["onto the live DB through the own dir", `cd /tmp/a/b/c && cp --parents "../../../.local/share/standup/standup.db" ${OWN}`],
      ["onto the live DB, unquoted", `cd /tmp/a/b/c && cp --parents ../../../.local/share/standup/standup.db ${OWN}/`],
      ["an option prefix of --parents", `cp --par ../feat-1/in.txt ${OWN}`],
      ["with -t", `cp --parents -t ${OWN} ../feat-1/in.txt`],
    ])("held: %s", (_name, command) => {
      expect({ command, action: bash(command).action }).toEqual({ command, action: "hold" });
    });

    test.each([`cp --parents in.txt ${OWN}`, `cp --parents ./in.txt ${OWN}/`])("allows %p, which stays below the own dir", (command) => {
      expectAllowed(command);
    });
  });
}

/*
 * The collector classifies a held call again under the config it builds for
 * the launch (serverFloorConfig), and the stricter hold wins: that config
 * names the same own scratch dir, so a mention of it adds no hold of its own.
 */
const realPush = { ...push };
mock.module("../push.js", () => ({ ...realPush, pushNotification: mock(async () => {}) }));
const routeDirs: string[] = [];
afterAll(() => {
  mock.module("../push.js", () => realPush);
  for (const d of routeDirs) rmSync(d, { recursive: true, force: true });
});
const { createServer } = await import("../server.js");
const noCredentials: AwsIdentity = { cached: () => null, resolve: async () => null };

function routeSetUp() {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "P", branch: "main", repos: [] });
  const root = mkdtempSync(join(tmpdir(), "floor-wt-"));
  routeDirs.push(root);
  const launchId = randomUUID();
  const sessionId = randomUUID();
  const workerToken = randomUUID() + randomUUID();
  createLaunch(store.db, { id: launchId, projectId: "p", task: "t", worktreePath: root, branch: "feature" });
  createSession(store.db, { id: sessionId, projectId: "p", title: "worker", cwd: root, status: "running" });
  attachSessionToLaunch(store.db, launchId, sessionId);
  setLaunchWorkerTokenHash(store.db, launchId, workerTokenHash(workerToken));
  const app = createServer(store, () => {}, null, undefined, undefined, "", "", {}, undefined, undefined, undefined, undefined, {
    ownerSecrets: generateOwnerSecrets(),
    awsIdentity: noCredentials,
  });
  /** The question of the ask a hook's destructive hold of `command` raises; the hold is then denied. */
  const question = async (command: string): Promise<string> => {
    const b: FloorHoldRequest = {
      session_id: sessionId,
      cwd: root,
      launch_id: launchId,
      request_id: `toolu_${randomUUID()}`,
      tool_name: "Bash",
      tool_input: { command },
      hold: { category: "destructive", ownerOnly: false, reason: "deletes outside the worktree", step: command },
      wait_s: 30,
    };
    const pending = app.request(FLOOR_HOLD_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json", [FLOOR_WORKER_TOKEN_HEADER]: workerToken },
      body: JSON.stringify(b),
    });
    let ask: Ask | null = null;
    for (let i = 0; i < 200 && !ask; i++) {
      const row = store.db.query("SELECT id FROM asks WHERE request_id = ?").get(b.request_id) as { id: string } | null;
      if (row) ask = getAsk(store.db, row.id)!;
      else await Bun.sleep(5);
    }
    if (!ask) throw new Error(`no ask for ${b.request_id}`);
    await app.request(`/api/asks/${ask.id}`, { method: "DELETE" });
    await pending;
    return ask.question;
  };
  return { launchId, question };
}

describe("the collector's re-classification of a held call naming the own scratch dir", () => {
  test("adds no hold for the own launch dir", async () => {
    const h = routeSetUp();
    const own = scratchDirFor(h.launchId);
    for (const command of [`cd ${own} && ls; rm -rf /tmp/elsewhere`, `sed -n 1p file > ${join(own, "x.txt")}; rm -rf /tmp/elsewhere`]) {
      const q = await h.question(command);
      expect({ command, q: q.split("\n")[0] }).toEqual({ command, q: expect.stringContaining("(destructive)") });
    }
  });

  test("holds another launch's dir as standup-ops, for Persona", async () => {
    const h = routeSetUp();
    const other = join(scratchRoot(), randomUUID());
    const q = await h.question(`cat ${join(other, "f")}; rm -rf /tmp/elsewhere`);
    expect(q.split("\n")[0]).toContain("(standup-ops)");
    expect(q).not.toContain("HIGH RISK");
  });
});
