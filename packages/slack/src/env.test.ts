import { afterEach, describe, expect, test } from "bun:test";
import { consoleOriginWarning, loadEnv } from "./env.js";

const KEYS = ["STANDUP_WEB_URL", "STANDUP_CONSOLE_ORIGIN", "SLACK_PERSONA_USERS"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function withEnv(vars: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  return loadEnv();
}

describe("console origin", () => {
  test("STANDUP_WEB_URL wins, STANDUP_CONSOLE_ORIGIN is the fallback", () => {
    expect(
      withEnv({ STANDUP_WEB_URL: "https://web.example", STANDUP_CONSOLE_ORIGIN: "https://origin.example" }).consoleOrigin
    ).toBe("https://web.example");
    const fallback = withEnv({ STANDUP_CONSOLE_ORIGIN: "https://origin.example" });
    expect(fallback.consoleOrigin).toBe("https://origin.example");
    expect(fallback.webUrl).toBe("https://origin.example");
  });

  test("neither set: no console origin, while webUrl keeps its local default", () => {
    const env = withEnv({ STANDUP_WEB_URL: "  " });
    expect(env.consoleOrigin).toBeUndefined();
    expect(env.consoleOriginUnusable).toBe(false);
    expect(env.webUrl).toBe("http://localhost:5173");
  });

  test("a value the link builders refuse is flagged, and webUrl still carries it", () => {
    const env = withEnv({ STANDUP_WEB_URL: "https://web.example/?t=1" });
    expect(env.consoleOrigin).toBeUndefined();
    expect(env.consoleOriginUnusable).toBe(true);
    expect(env.webUrl).toBe("https://web.example/?t=1");
    // A usable fallback is taken instead of being masked by the bad value.
    const fallback = withEnv({ STANDUP_WEB_URL: "web.example", STANDUP_CONSOLE_ORIGIN: "https://origin.example" });
    expect(fallback.consoleOrigin).toBe("https://origin.example");
    expect(fallback.consoleOriginUnusable).toBe(false);
  });

  test("a startup warning for an unusable value, or for Persona users listed without an origin", () => {
    expect(consoleOriginWarning({ personaUsers: ["bob"], consoleOrigin: undefined })).toContain("STANDUP_WEB_URL");
    expect(consoleOriginWarning({ personaUsers: ["bob"], consoleOrigin: "https://web.example" })).toBeUndefined();
    expect(consoleOriginWarning({ personaUsers: [], consoleOrigin: undefined })).toBeUndefined();
    // The warning reads its argument only, never the ambient environment.
    withEnv({ STANDUP_WEB_URL: "https://web.example" });
    expect(consoleOriginWarning({ personaUsers: [], consoleOrigin: undefined })).toBeUndefined();
    expect(consoleOriginWarning({ personaUsers: [], consoleOrigin: undefined, consoleOriginUnusable: true })).toContain("unusable");
    expect(consoleOriginWarning({ personaUsers: [], consoleOrigin: "https://web.example", consoleOriginUnusable: true })).toBeUndefined();
  });
});
