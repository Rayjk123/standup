import { expect, test, describe } from "bun:test";
import { createStore, setSetting, touchUser } from "@standup/store";
import { isMultiplayerMode, MULTIPLAYER_OVERRIDE_SETTING } from "./multiplayer.js";

/**
 * Multiplayer is what flips the launch default to a fresh worktree per project.
 * It's auto-detected once ≥2 distinct PEOPLE have connected through the gateway
 * (touchUser with viaTunnel), with a manual override that can force it either
 * way regardless of that count. Agent/MCP phone-home traffic carries no tunnel
 * header and must NOT count — see the regression test below.
 */

describe("isMultiplayerMode", () => {
  test("a fresh collector with no users is single-user", () => {
    const store = createStore(":memory:");
    expect(isMultiplayerMode(store.db)).toBe(false);
  });

  test("one connected alias is still single-user (today's behavior)", () => {
    const store = createStore(":memory:");
    touchUser(store.db, "alice", { viaTunnel: true });
    expect(isMultiplayerMode(store.db)).toBe(false);
  });

  test("a second distinct person flips it to multiplayer", () => {
    const store = createStore(":memory:");
    touchUser(store.db, "alice", { viaTunnel: true });
    touchUser(store.db, "bob", { viaTunnel: true });
    expect(isMultiplayerMode(store.db)).toBe(true);
  });

  test("re-touching the same alias does not count twice", () => {
    const store = createStore(":memory:");
    touchUser(store.db, "alice", { viaTunnel: true });
    touchUser(store.db, "alice", { viaTunnel: true });
    expect(isMultiplayerMode(store.db)).toBe(false);
  });

  test("a solo human's agent phone-home does not trip multiplayer", () => {
    // The reported false positive: a single human's browser arrives via the
    // tunnel (their user alias) while their own agents phone home under a different
    // host $USER / "local" with no tunnel header. That is ONE person, not two.
    const store = createStore(":memory:");
    touchUser(store.db, "alice", { viaTunnel: true }); // the human's browser
    touchUser(store.db, "devhost"); // their agent under the host $USER
    touchUser(store.db, "local"); // an agent env with no USER
    expect(isMultiplayerMode(store.db)).toBe(false);
  });

  test("override 'on' forces multiplayer before a second person connects", () => {
    const store = createStore(":memory:");
    touchUser(store.db, "alice", { viaTunnel: true });
    setSetting(store.db, MULTIPLAYER_OVERRIDE_SETTING, "on");
    expect(isMultiplayerMode(store.db)).toBe(true);
  });

  test("override 'off' forces single-user even with several people", () => {
    const store = createStore(":memory:");
    touchUser(store.db, "alice", { viaTunnel: true });
    touchUser(store.db, "bob", { viaTunnel: true });
    touchUser(store.db, "carol", { viaTunnel: true });
    setSetting(store.db, MULTIPLAYER_OVERRIDE_SETTING, "off");
    expect(isMultiplayerMode(store.db)).toBe(false);
  });

  test("an empty override falls back to auto-detection", () => {
    const store = createStore(":memory:");
    touchUser(store.db, "alice", { viaTunnel: true });
    touchUser(store.db, "bob", { viaTunnel: true });
    setSetting(store.db, MULTIPLAYER_OVERRIDE_SETTING, "");
    expect(isMultiplayerMode(store.db)).toBe(true);
  });
});
