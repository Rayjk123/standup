import { describe, expect, test } from "bun:test";
import { classifyToolCall, type FloorProbes } from "./classify.js";
import { decodeFloorConfig, encodeFloorConfig, type FloorConfig, type FloorVerdict } from "./gate.js";
import { buildLaunchFloorConfig } from "./launch.js";

/*
 * Connections to the public knowledge API's Unix socket, and reads of
 * STANDUP_PUBLIC_KB_SOCKET, are allowed wherever the socket is. A command
 * that hands curl or code a path in Standup's data dir keeps that dir's hold,
 * and a call to the collector's own port still holds.
 */

const HOME = "/home/tester";
const DATA = `${HOME}/.local/share/standup`;
const ROOT = `${DATA}/worktrees/standup/feat-1`;
const DEFAULT_SOCKET = `${DATA}/public/kb.sock`;

function configWith(socket: string): FloorConfig {
  return {
    v: 1,
    collectorUrl: "http://localhost:7777",
    launchId: "launch-1",
    root: ROOT,
    sharedBranches: ["main", "mainline"],
    personalAwsAccounts: [],
    waitSeconds: 60,
    standupDataDir: DATA,
    publicKnowledgeSocket: socket,
    floorPaths: ["/opt/standup/packages/collector/src/floor"],
    installDir: "/opt/standup",
    protectedPaths: [`${DATA}/secrets`],
    tmpDirs: ["/tmp"],
    workerToken: "x".repeat(64),
    replyPublicKey: "test",
  };
}

const DIRS = new Set<string>(["/", "/tmp", "/tmp/kbtest", HOME, `${HOME}/kb`, DATA, `${DATA}/public`, ROOT]);

function probes(): Partial<FloorProbes> {
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    readFile: () => ({ ok: false, reason: "missing" }),
    exists: (p) => DIRS.has(p),
    isDirectory: (p) => DIRS.has(p),
    listDir: () => [],
    realpath: (p) => (DIRS.has(p) ? p : null),
    homeDir: () => HOME,
    shellDefinitions: () => ({ aliases: new Map(), functions: new Map() }),
    awsAccount: () => null,
    now: () => Date.now(),
  };
}

function bash(command: string, socket: string, cwd = ROOT): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, configWith(socket), probes());
}

function expectAllowed(v: FloorVerdict): void {
  expect(v).toEqual({ action: "allow" });
}

describe("the public knowledge socket outside the data dir", () => {
  const TMP = "/tmp/kbtest/kb.sock";
  const cases: Array<[string, string]> = [
    ["curl --unix-socket <p>", `curl --unix-socket ${TMP} http://localhost/v1/knowledge`],
    ["curl --unix-socket=<p>", `curl --unix-socket=${TMP} http://kb/v1/knowledge`],
    ["curl -s --unix-socket <p> quoted", `curl -s --unix-socket "${TMP}" http://x/v1/search?q=floor`],
    ["socat UNIX-CONNECT:<p>", `socat - UNIX-CONNECT:${TMP}`],
    ["socat UNIX-CLIENT:<p>", `socat - UNIX-CLIENT:${TMP}`],
    ["socat UNIX:<p>", `socat STDIO UNIX:${TMP},crnl`],
    ["nc -U <p>", `nc -U ${TMP}`],
    ["ncat -U <p>", `printf 'GET / HTTP/1.0\\r\\n\\r\\n' | ncat -U ${TMP}`],
    ["netcat -U <p>", `netcat -U ${TMP}`],
    ["bun -e fetch unix", `bun -e 'console.log(await (await fetch("http://localhost/v1/knowledge", { unix: "${TMP}" })).text())'`],
    ["node -e net.connect", `node -e 'require("net").connect("${TMP}").end("GET / HTTP/1.0\\r\\n\\r\\n")'`],
    ["python -c socket.connect", `python3 -c 'import socket; s = socket.socket(socket.AF_UNIX); s.connect("${TMP}")'`],
  ];
  for (const [name, command] of cases) {
    test(`${name} is allowed`, () => expectAllowed(bash(command, TMP)));
  }

  test("a relative path resolved against the cwd is allowed", () => {
    expectAllowed(bash("curl --unix-socket kb.sock http://kb/v1/knowledge", TMP, "/tmp/kbtest"));
    expectAllowed(bash("cd /tmp/kbtest && nc -U ./kb.sock", TMP));
  });
});

describe("the public knowledge socket named by a glob, a variable or built-up text", () => {
  const TMP = "/tmp/kbtest/kb.sock";
  const cases: Array<[string, string]> = [
    ["curl --unix-socket with a ? glob", "curl --unix-socket /tmp/kbtest/kb.so? http://kb/v1/knowledge"],
    ["curl --unix-socket with a * glob", "curl --unix-socket /tmp/kbtest/kb.s* http://kb/v1/knowledge"],
    ["curl --unix-socket with a bracket glob", "curl --unix-socket /tmp/kbtest/kb.[s]ock http://kb/v1/knowledge"],
    ["curl --unix-socket= with a glob directory", "curl --unix-socket=/tmp/kb*/kb.sock http://kb/v1/knowledge"],
    ["nc -U with a glob", "nc -U /tmp/kbtest/*.sock"],
    ["socat UNIX-CONNECT: with a glob", "socat - UNIX-CONNECT:/tmp/kbtest/kb.so?"],
    ["curl --unix-socket a glob relative to the cwd", "cd /tmp/kbtest && curl --unix-socket ./k?.sock http://kb/v1/knowledge"],
    ["curl --unix-socket \"$STANDUP_PUBLIC_KB_SOCKET\"", 'curl --unix-socket "$STANDUP_PUBLIC_KB_SOCKET" http://kb/v1/knowledge'],
    ["curl --unix-socket ${STANDUP_PUBLIC_KB_SOCKET}", "curl --unix-socket ${STANDUP_PUBLIC_KB_SOCKET} http://kb/v1/knowledge"],
    ["printenv of the socket's variable", 'curl --unix-socket "$(printenv STANDUP_PUBLIC_KB_SOCKET)" http://kb/v1/knowledge'],
    ["python reading the socket's variable", `python3 -c 'import os, socket; socket.socket(socket.AF_UNIX).connect(os.environ["STANDUP_PUBLIC_KB_SOCKET"])'`],
    ["python environ.get of the socket's variable", `python3 -c 'import os; print(os.environ.get("STANDUP_PUBLIC_KB_SOCKET"))'`],
    ["python getenv of the socket's variable", `python3 -c 'import os; print(os.getenv("STANDUP_PUBLIC_KB_SOCKET"))'`],
    ["node process.env of the socket's variable", `node -e 'console.log(process.env.STANDUP_PUBLIC_KB_SOCKET)'`],
    ["bun process.env[] of the socket's variable", `bun -e 'console.log(process.env["STANDUP_PUBLIC_KB_SOCKET"])'`],
    ["echo $VAR", "echo $STANDUP_PUBLIC_KB_SOCKET"],
    ["a ${VAR:-default} expansion", 'curl --unix-socket "${STANDUP_PUBLIC_KB_SOCKET:-/tmp/none}" http://kb/v1/knowledge'],
    ["python joining the socket's path with +", `python3 -c 'import socket; s = socket.socket(socket.AF_UNIX); s.connect("/tmp/kbtest/" + "kb.sock")'`],
    ["python with a doubled slash", `python3 -c 'import socket; s = socket.socket(socket.AF_UNIX); s.connect("/tmp//kbtest/kb.sock")'`],
    ["python with os.path.join", `python3 -c 'import socket, os; socket.socket(socket.AF_UNIX).connect(os.path.join("/tmp", "kbtest", "kb.sock"))'`],
    ["node joining the socket's path with +", `node -e 'require("net").connect("/tmp/kbtest/kb"+".sock").end("GET / HTTP/1.0\\r\\n\\r\\n")'`],
    ["python on a heredoc", `python3 - <<'EOF'\nimport socket\ns = socket.socket(socket.AF_UNIX)\ns.connect("/tmp/kbtest/" + "kb.sock")\nEOF`],
    ["printenv piped to grep for the variable", 'curl --unix-socket "$(printenv | grep STANDUP_PUBLIC_KB_SOCKET | cut -d= -f2-)" http://kb/v1/knowledge'],
    ["env piped to grep for the variable", 'curl --unix-socket "$(env | grep STANDUP_PUBLIC_KB_SOCKET | cut -d= -f2-)" http://kb/v1/knowledge'],
    ["set piped to grep for the variable", "set | grep STANDUP_PUBLIC_KB_SOCKET"],
    ["export -p piped to grep for the variable", "export -p | grep STANDUP_PUBLIC_KB_SOCKET"],
    ["declare -p of the variable", "declare -p STANDUP_PUBLIC_KB_SOCKET"],
    ["grep -z over /proc/self/environ", "grep -z STANDUP_PUBLIC_KB_SOCKET /proc/self/environ"],
  ];
  for (const [name, command] of cases) {
    test(`${name} is allowed`, () => expectAllowed(bash(command, TMP)));
  }

  const negatives: Array<[string, string]> = [
    ["curl to docker.sock", "curl --unix-socket /var/run/docker.sock http://localhost/containers/json"],
    ["a glob in another directory", "curl --unix-socket /var/run/*.sock http://localhost/containers/json"],
    ["a socket glob in a sibling directory", "nc -U /tmp/other/*.sock"],
    ["listing the socket's directory by a glob", "ls -la /tmp/kbtest/*"],
    ["reading files in the socket's directory by a glob", "cat /tmp/kbtest/*.txt"],
    ["a glob in the socket's directory given to a flag that names no socket", "tar -cf out.tar /tmp/kbtest/kb.so?"],
    ["python connecting to docker.sock", `python3 -c 'import socket; socket.socket(socket.AF_UNIX).connect("/var/run/" + "docker.sock")'`],
    ["python naming only the socket's directory", `python3 -c 'print("/tmp/kbtest/" + "notes.txt")'`],
    ["searching the source for the variable's name", "rg -n STANDUP_PUBLIC_KB_SOCKET packages/collector/src"],
    ["a commit message naming the variable", 'git commit -m "Floor: holds a read of STANDUP_PUBLIC_KB_SOCKET, not a mention"'],
    ["git grep for the variable", "git grep -n STANDUP_PUBLIC_KB_SOCKET"],
    ["git log --grep for the variable", "git log --oneline --grep STANDUP_PUBLIC_KB_SOCKET"],
    ["git log --grep= for the variable", "git log --grep=STANDUP_PUBLIC_KB_SOCKET -5"],
    ["sed printing the lines that name it", "sed -n '/STANDUP_PUBLIC_KB_SOCKET/p' docs/design/public-knowledge-api.md"],
    ["bun test -t naming it", "bun test -t STANDUP_PUBLIC_KB_SOCKET"],
    ["an assignment before a command", "STANDUP_PUBLIC_KB_SOCKET=/tmp/other/kb.sock bun run dev"],
    ["an exported assignment", "export STANDUP_PUBLIC_KB_SOCKET=/tmp/other/kb.sock"],
    ["a commit message naming the variable and the word env", 'git commit -m "Floor: env dumps and STANDUP_PUBLIC_KB_SOCKET reads are held"'],
    ["env running a command after an assignment", "env STANDUP_PUBLIC_KB_SOCKET=/tmp/other/kb.sock bun run dev"],
    ["a grep through the docs that names env", "grep -rn 'env STANDUP_PUBLIC_KB_SOCKET' docs/design"],
  ];
  for (const [name, command] of negatives) {
    test(`${name} is not held for the knowledge socket`, () => {
      const v = bash(command, TMP);
      if (v.action === "hold") expect(v.reason).not.toContain("public knowledge API socket");
    });
  }

  test("with no socket configured, reading the variable is not held for it", () => {
    const v = bash('curl --unix-socket "$STANDUP_PUBLIC_KB_SOCKET" http://kb/v1/knowledge', "");
    if (v.action === "hold") expect(v.reason).not.toContain("public knowledge API socket");
  });
});

describe("the public knowledge socket under the home dir", () => {
  const SOCKET = "~/kb/kb.sock";
  const spellings = [`${HOME}/kb/kb.sock`, "~/kb/kb.sock", "$HOME/kb/kb.sock", "${HOME}/kb/kb.sock"];
  for (const p of spellings) {
    test(`curl --unix-socket ${p} is allowed`, () => expectAllowed(bash(`curl --unix-socket ${p} http://kb/v1/knowledge`, SOCKET)));
    test(`socat UNIX-CONNECT:${p} is allowed`, () => expectAllowed(bash(`socat - UNIX-CONNECT:${p}`, SOCKET)));
    test(`nc -U ${p} is allowed`, () => expectAllowed(bash(`nc -U ${p}`, SOCKET)));
  }

  test("a configured absolute path in its ~ spelling is allowed", () => {
    expectAllowed(bash("curl --unix-socket ~/kb/kb.sock http://kb/v1/knowledge", `${HOME}/kb/kb.sock`));
  });

  test("python naming the socket under $HOME is allowed", () => {
    expectAllowed(bash(`python3 -c 'import socket,os; socket.socket(socket.AF_UNIX).connect(os.path.expanduser("~/kb/kb.sock"))'`, SOCKET));
  });
});

describe("the default socket under the data dir", () => {
  for (const command of [`socat - UNIX-CONNECT:${DEFAULT_SOCKET}`, `nc -U ${DEFAULT_SOCKET}`]) {
    test(`${command.split(" ")[0]} to the default socket is allowed`, () => expectAllowed(bash(command, DEFAULT_SOCKET)));
  }

  for (const command of [`curl --unix-socket ${DEFAULT_SOCKET} http://kb/v1/knowledge`, `curl --unix-socket=${DEFAULT_SOCKET} http://kb/v1/knowledge`]) {
    test(`curl handed the default socket holds for a path in Standup's own data: ${command}`, () => {
      const v = bash(command, DEFAULT_SOCKET);
      expect(v.action).toBe("hold");
      if (v.action === "hold") {
        expect(v.category).toBe("standup-ops");
        expect(v.reason).toContain("in Standup's own data");
      }
    });
  }

  test("code naming a path in the data dir keeps its stricter floor-tamper hold", () => {
    const v = bash(`bun -e 'await fetch("http://localhost/", { unix: "${DEFAULT_SOCKET}" })'`, DEFAULT_SOCKET);
    expect(v.action).toBe("hold");
    if (v.action === "hold") {
      expect(v.category).toBe("floor-tamper");
      expect(v.reason).toContain("Standup's data dir");
    }
  });
});

describe("Standup's own data and the collector's port still hold beside the socket", () => {
  const TMP = "/tmp/kbtest/kb.sock";

  test("a POST to the collector's port holds", () => {
    expect(bash("curl -s -X POST -d '{}' http://localhost:7777/api/knowledge", TMP).action).toBe("hold");
  });

  test("a write to Standup's database holds", () => {
    expect(bash(`echo x > ${DATA}/standup.db`, TMP).action).toBe("hold");
  });
});

describe("other sockets keep their own verdicts", () => {
  test("curl --unix-socket to docker.sock is not held for the knowledge socket", () => {
    const v = bash("curl --unix-socket /var/run/docker.sock http://localhost/containers/json", "/tmp/kbtest/kb.sock");
    if (v.action === "hold") expect(v.reason).not.toContain("public knowledge API socket");
  });

  test("a socket whose name only begins with the knowledge socket's is not it", () => {
    const v = bash("nc -U /tmp/kbtest/kb.sock.bak", "/tmp/kbtest/kb.sock");
    if (v.action === "hold") expect(v.reason).not.toContain("public knowledge API socket");
  });

  test("ordinary work in the worktree stays allowed", () => {
    expect(bash("bun test", "/tmp/kbtest/kb.sock")).toEqual({ action: "allow" });
  });
});

describe("FloorConfig.publicKnowledgeSocket", () => {
  const input = { launchId: "launch-1", root: ROOT, workerToken: "x".repeat(64), replyPublicKey: "test" };

  test("the launch config carries the default socket when no env names one", () => {
    const config = buildLaunchFloorConfig(input, { DB_PATH: `${DATA}/standup.db` });
    expect(config.publicKnowledgeSocket).toBe(DEFAULT_SOCKET);
  });

  test("the launch config carries STANDUP_PUBLIC_KB_SOCKET whether or not the listener is on", () => {
    const off = buildLaunchFloorConfig(input, { DB_PATH: `${DATA}/standup.db`, STANDUP_PUBLIC_KB_SOCKET: "/tmp/kbtest/kb.sock" });
    expect(off.publicKnowledgeSocket).toBe("/tmp/kbtest/kb.sock");
    const on = buildLaunchFloorConfig(input, { DB_PATH: `${DATA}/standup.db`, STANDUP_PUBLIC_KB: "1", STANDUP_PUBLIC_KB_SOCKET: "/tmp/kbtest/kb.sock" });
    expect(on.publicKnowledgeSocket).toBe("/tmp/kbtest/kb.sock");
  });

  test("it survives encoding, and a malformed one is refused", () => {
    expect(decodeFloorConfig(encodeFloorConfig(configWith("/tmp/kbtest/kb.sock"))).publicKnowledgeSocket).toBe("/tmp/kbtest/kb.sock");
    expect(() => decodeFloorConfig(encodeFloorConfig({ ...configWith(""), publicKnowledgeSocket: 7 as unknown as string }))).toThrow();
    expect(() => decodeFloorConfig(encodeFloorConfig(configWith("")))).toThrow();
  });
});
