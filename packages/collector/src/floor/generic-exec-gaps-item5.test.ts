import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "path";
import { classifyToolCall } from "./classify.js";
import type { FloorVerdict } from "./gate.js";
import { LIVE_PATH, ROOT, VIRTUAL, config, probes, scratchEnv, shape } from "./scratch-harness.js";

/*
 * A scratch harness in its own /tmp dir that only talks to an isolated
 * scratch collector: the script takes the port from LIVE_PORT (with a
 * default in its text) and calls one of the collector's routes on loopback,
 * and the run hands LIVE_PORT a port no collector of the owner's listens on,
 * in its own assignments or, under `env -i` and a complete isolation, by
 * leaving it to the script's default. The live ports (the default 17777,
 * every collectorPortSet port, the config's collectorUrl port), a port the
 * floor can't resolve, a default with the env not cleared, code that may
 * change the env first, and every loopback name on a live port still hold.
 */

setDefaultTimeout(120_000);

const SC = join("/", "tmp", "sc-4f9a");
const TS = join(SC, "probe.ts");
const SH = join(SC, "probe.sh");

const tsProbe = (fallback: string, route = "/api/asks", host = "127.0.0.1", head = "", read = `process.env.LIVE_PORT ?? "${fallback}"`) =>
  `${head}const LIVE_PORT = ${read};\nconst r = await fetch(\`http://${host}:\${LIVE_PORT}${route}\`);\nconsole.log(r.status, await r.text());\n`;
const shProbe = `#!/bin/sh\nLIVE_PORT="\${LIVE_PORT:-29777}"\ncurl -s "http://127.0.0.1:$LIVE_PORT/api/asks"\n`;

/** The item's run: `env -i` with the worker's PATH, a home under the script's dir, and LIVE_PORT. */
const minimal = (port: string | null, program = `bun ${TS}`) => `env -i PATH="$PATH" HOME=${SC}/home${port === null ? "" : ` LIVE_PORT=${port}`} ${program}`;
/** The same run with every dir Standup's code reads under the script's dir: a complete isolation. */
const full = (port: string | null, program = `bun ${TS}`, root = SC) => `${scratchEnv(root, '"$PATH"')}${port === null ? "" : ` LIVE_PORT=${port}`} ${program}`;

function bash(command: string): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, probes());
}

function category(command: string): string | null {
  const v = bash(command);
  return v.action === "hold" ? v.category : null;
}

let path: string | undefined;
beforeEach(() => {
  path = process.env.PATH;
  process.env.PATH = LIVE_PATH;
  VIRTUAL[TS] = tsProbe("29777");
  VIRTUAL[SH] = shProbe;
});
afterEach(() => {
  process.env.PATH = path;
  delete VIRTUAL[TS];
  delete VIRTUAL[SH];
});

describe("a /tmp probe that calls a scratch collector's route on a port from LIVE_PORT", () => {
  test("the item's run, LIVE_PORT=29777 in env -i's assignments: no hold", () => {
    expect(shape(bash(minimal("29777")))).toEqual({ action: "allow" });
  });

  test("the fully isolated run, LIVE_PORT=29777: no hold", () => {
    expect(shape(bash(full("29777")))).toEqual({ action: "allow" });
  });

  test("LIVE_PORT set without env -i: no hold", () => {
    expect(shape(bash(`LIVE_PORT=29777 bun ${TS}`))).toEqual({ action: "allow" });
  });

  test("the script's default, LIVE_PORT left unset under env -i and a complete isolation: no hold", () => {
    expect(shape(bash(full(null)))).toEqual({ action: "allow" });
    expect(shape(bash(minimal(null)))).toEqual({ action: "allow" });
    VIRTUAL[TS] = tsProbe("", "/api/asks", "127.0.0.1", "", `process.env.LIVE_PORT || '29777'`);
    expect(shape(bash(full(null)))).toEqual({ action: "allow" });
  });

  test("the root in $R from mktemp -d -p /tmp: no hold", () => {
    const command = `R=$(mktemp -d -p /tmp sc.XXXX) && ${full("29777", `bun ${TS}`, "$R")}`;
    expect(shape(bash(command))).toEqual({ action: "allow" });
  });

  test("/api/health, which names no collector route: no hold, as before", () => {
    VIRTUAL[TS] = tsProbe("29777", "/api/health");
    expect(shape(bash(minimal("29777")))).toEqual({ action: "allow" });
    expect(shape(bash(full(null)))).toEqual({ action: "allow" });
  });

  test("a curl script run by sh: no hold, as before", () => {
    expect(shape(bash(full("29777", `sh ${SH}`)))).toEqual({ action: "allow" });
  });
});

describe("the live collector's ports, unknown ports and loopback names still hold", () => {
  test("LIVE_PORT naming a collector port or the config's collectorUrl port: held", () => {
    for (const port of ["17777", "17778", "7777"]) {
      expect({ port, held: category(full(port)) !== null }).toEqual({ port, held: true });
    }
  });

  test("the script's default a collector port, LIVE_PORT unset: collector-api", () => {
    for (const fallback of ["17777", "7777"]) {
      VIRTUAL[TS] = tsProbe(fallback);
      expect({ fallback, category: category(full(null)) }).toEqual({ fallback, category: "collector-api" });
    }
  });

  test("a port the floor can't resolve: held", () => {
    for (const port of ["$P", "$(cat /tmp/port)"]) {
      expect({ port, held: category(full(port)) !== null }).toEqual({ port, held: true });
    }
  });

  test("a port that isn't resolved, outside env -i: collector-api", () => {
    expect(category(`LIVE_PORT=$P bun ${TS}`)).toBe("collector-api");
    expect(category(`bun ${TS}`)).toBe("collector-api");
  });

  test("the default with the env not cleared, or under env -i without a complete isolation: collector-api", () => {
    expect(category(`bun ${TS}`)).toBe("collector-api");
    expect(category(`env -i PATH="$PATH" bun ${TS}`)).toBe("collector-api");
    expect(category(`env -i PATH="$PATH" HOME=/fake/home bun ${TS}`)).toBe("collector-api");
  });

  test("the default with an env file in the cwd, which Bun loads into an unset LIVE_PORT: collector-api", () => {
    VIRTUAL[join(ROOT, ".env")] = "LIVE_PORT=17777\n";
    try {
      expect(category(minimal(null))).toBe("collector-api");
      expect(category(full(null))).toBe("collector-api");
    } finally {
      delete VIRTUAL[join(ROOT, ".env")];
    }
  });

  test("code that may change the env first, reassign or shadow the constant, or load a module: collector-api", () => {
    const variants: Record<string, string> = {
      "an env write": tsProbe("29777", "/api/asks", "127.0.0.1", `process.env.LIVE_PORT = "17777";\n`),
      "Object.assign on the env": tsProbe("29777", "/api/asks", "127.0.0.1", `Object.assign(process.env, { LIVE_PORT: "17777" });\n`),
      "a computed process key": tsProbe("29777", "/api/asks", "127.0.0.1", `globalThis["process"].env.LIVE_PORT = "17777";\n`),
      "let, reassigned": tsProbe("29777").replace("const LIVE_PORT", "let LIVE_PORT").replace("const r", 'LIVE_PORT = "17777";\nconst r'),
      "a shadowing parameter": `const LIVE_PORT = process.env.LIVE_PORT ?? "29777";\nconst go = (LIVE_PORT: string) => fetch(\`http://127.0.0.1:\${LIVE_PORT}/api/asks\`);\nawait go("17777");\n`,
      "an imported module": tsProbe("29777", "/api/asks", "127.0.0.1", `import "./setup.ts";\n`),
    };
    for (const [name, text] of Object.entries(variants)) {
      VIRTUAL[TS] = text;
      expect({ name, category: category(full("29777")) }).toEqual({ name, category: "collector-api" });
    }
  });

  test("localhost, ::1 and 0.0.0.0 on a collector port: held", () => {
    for (const host of ["localhost", "[::1]", "0.0.0.0"]) {
      VIRTUAL[TS] = tsProbe("17777", "/api/asks", host);
      expect({ host, category: category(full(null)) }).toEqual({ host, category: "collector-api" });
      expect({ host, held: category(full("17777")) !== null }).toEqual({ host, held: true });
    }
  });
});
