import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_COLLECTOR_PORT, DEFAULT_WS_PORT } from "./constants.js";
import {
  COLLECTOR_SLOTS,
  DEFAULT_VITE_PORT,
  DEFAULT_WEB_PORT,
  EXIT_BIND_FAILED,
  EXIT_FOREIGN_GATEWAY,
  GATEWAY_HOST,
  GATEWAY_REASON,
  GATEWAY_REASON_HEADER,
  SLOT_ENV_VARS,
  collectorPortSet,
  devFilePath,
  gatewayEnabled,
  publicPorts,
  restartRecordPath,
  slotPorts,
  vitePortFor,
  vitePortFromEnv,
} from "./topology.js";

describe("self-contained module", () => {
  test("has no relative imports, so Node can load it from vite's config", () => {
    const source = readFileSync(join(import.meta.dir, "topology.ts"), "utf8");
    expect(source).not.toMatch(/^\s*(import|export)\b[^;]*\bfrom\s+["']\.{1,2}\//m);
  });

  test("its default public ports match constants.ts", () => {
    expect(publicPorts({}).collector).toBe(DEFAULT_COLLECTOR_PORT);
    expect(publicPorts({}).ws).toBe(DEFAULT_WS_PORT);
  });
});

describe("vite port", () => {
  test("defaults to the public web port + 10000", () => {
    expect(DEFAULT_VITE_PORT).toBe(15173);
    expect(DEFAULT_VITE_PORT).toBe(vitePortFor(DEFAULT_WEB_PORT));
    expect(vitePortFor(41002)).toBe(51002);
    expect(vitePortFromEnv({})).toBe(DEFAULT_VITE_PORT);
    expect(vitePortFromEnv({ STANDUP_WEB_PORT: "41002" })).toBe(51002);
  });

  test("stays a valid port for a high web port", () => {
    expect(vitePortFor(55535)).toBe(65535);
    expect(vitePortFor(60000)).toBe(50000);
  });

  test("is outside the range another vite hops through when the web port is busy", () => {
    // Vite tries the next ports up from 5173 when it is taken.
    for (let port = DEFAULT_WEB_PORT; port < DEFAULT_WEB_PORT + 1000; port++) expect(DEFAULT_VITE_PORT).not.toBe(port);
  });

  test("collides with no default public or slot port", () => {
    const taken = new Set<number>([DEFAULT_WEB_PORT, ...collectorPortSet({})]);
    expect(taken.has(DEFAULT_VITE_PORT)).toBe(false);
    for (const slot of COLLECTOR_SLOTS) {
      const { http, ws } = slotPorts(DEFAULT_COLLECTOR_PORT, DEFAULT_WS_PORT, slot);
      expect([http, ws]).not.toContain(DEFAULT_VITE_PORT);
    }
  });

  test("STANDUP_VITE_PORT overrides the derived port; an unusable value falls back", () => {
    expect(vitePortFromEnv({ STANDUP_WEB_PORT: "41002", STANDUP_VITE_PORT: "41010" })).toBe(41010);
    expect(vitePortFromEnv({ STANDUP_WEB_PORT: "41002", STANDUP_VITE_PORT: "" })).toBe(51002);
    expect(vitePortFromEnv({ STANDUP_VITE_PORT: "nope" })).toBe(DEFAULT_VITE_PORT);
  });
});

describe("collectorPortSet", () => {
  test("holds the default public ports and both slots' ports", () => {
    const ports = collectorPortSet({});
    expect(ports.has(DEFAULT_COLLECTOR_PORT)).toBe(true);
    expect(ports.has(DEFAULT_WS_PORT)).toBe(true);
    for (const slot of COLLECTOR_SLOTS) {
      const { http, ws } = slotPorts(DEFAULT_COLLECTOR_PORT, DEFAULT_WS_PORT, slot);
      expect(ports.has(http)).toBe(true);
      expect(ports.has(ws)).toBe(true);
    }
    expect(ports.size).toBe(2 + 2 * COLLECTOR_SLOTS.length);
  });

  test("adds configured public ports and their slots, keeping the defaults", () => {
    const env = { COLLECTOR_PORT: "9100", WS_PORT: "9101" };
    const configured = publicPorts(env);
    const ports = collectorPortSet(env);
    for (const base of [publicPorts({}), configured]) {
      expect(ports.has(base.collector)).toBe(true);
      expect(ports.has(base.ws)).toBe(true);
      for (const slot of COLLECTOR_SLOTS) {
        const { http, ws } = slotPorts(base.collector, base.ws, slot);
        expect(ports.has(http)).toBe(true);
        expect(ports.has(ws)).toBe(true);
      }
    }
  });

  test("ignores the collector's own listen vars: slot ports come from the public ones", () => {
    expect(collectorPortSet({ STANDUP_LISTEN_PORT: "4444", STANDUP_LISTEN_WS_PORT: "4445" })).toEqual(collectorPortSet({}));
  });
});

describe("gatewayEnabled", () => {
  test("on when the bind host is unset or GATEWAY_HOST", () => {
    expect(gatewayEnabled({})).toBe(true);
    expect(gatewayEnabled({ STANDUP_BIND_HOST: "" })).toBe(true);
    expect(gatewayEnabled({ STANDUP_BIND_HOST: GATEWAY_HOST })).toBe(true);
    expect(gatewayEnabled({ STANDUP_BIND_HOST: ` ${GATEWAY_HOST} ` })).toBe(true);
    expect(gatewayEnabled({ STANDUP_GATEWAY: "1" })).toBe(true);
  });

  test("off for any other bind host, loopback or not", () => {
    for (const host of ["::1", "[::1]", "localhost", "127.0.0.2", "0.0.0.0"]) {
      expect(gatewayEnabled({ STANDUP_BIND_HOST: host })).toBe(false);
    }
  });

  test("off when STANDUP_GATEWAY=0", () => {
    expect(gatewayEnabled({ STANDUP_GATEWAY: "0" })).toBe(false);
    expect(gatewayEnabled({ STANDUP_GATEWAY: "0", STANDUP_BIND_HOST: GATEWAY_HOST })).toBe(false);
  });
});

describe("gateway contract constants", () => {
  test("exit codes are distinct and non-zero", () => {
    expect(EXIT_BIND_FAILED).toBe(1);
    expect(EXIT_FOREIGN_GATEWAY).toBe(3);
  });

  test("the reason header and its values", () => {
    expect(GATEWAY_REASON_HEADER).toBe("x-standup-gateway");
    expect(GATEWAY_REASON.noLeader).toBe("no-leader");
    expect(GATEWAY_REASON.holdTimeout).toBe("hold-timeout");
    expect(GATEWAY_REASON.heldCap).toBe("held-cap");
    const values = Object.values(GATEWAY_REASON);
    expect(new Set(values).size).toBe(values.length);
  });
});

test("devFilePath lives directly in the data dir", () => {
  expect(devFilePath("/data")).toBe("/data/dev.json");
});

test("restartRecordPath is the restart dir's current.json", () => {
  expect(restartRecordPath("/data")).toBe("/data/restart/current.json");
});

test("SLOT_ENV_VARS names the vars a collector reads its slot and listen ports from", () => {
  expect([...SLOT_ENV_VARS]).toEqual(["STANDUP_LISTEN_PORT", "STANDUP_LISTEN_WS_PORT", "STANDUP_COLLECTOR_SLOT"]);
});
