import { expect, test, describe } from "bun:test";
import { withTrustedDirs } from "./launcher.js";

/**
 * withTrustedDirs marks launch directories as trusted in a ~/.claude.json
 * object — pre-accepting the folder-trust dialog a launched agent can't click
 * through. It must set the flag without dropping other per-project state or
 * top-level config.
 */
describe("withTrustedDirs", () => {
  test("adds hasTrustDialogAccepted for a new dir", () => {
    const out = withTrustedDirs({}, ["/ws/a"]);
    expect(out.projects!["/ws/a"].hasTrustDialogAccepted).toBe(true);
  });

  test("preserves other per-project keys on an existing dir", () => {
    const out = withTrustedDirs(
      { projects: { "/ws/a": { history: [1, 2], hasTrustDialogAccepted: false } } },
      ["/ws/a"]
    );
    expect(out.projects!["/ws/a"].hasTrustDialogAccepted).toBe(true);
    expect(out.projects!["/ws/a"].history).toEqual([1, 2]);
  });

  test("leaves other projects and top-level config untouched", () => {
    const out = withTrustedDirs(
      { projects: { "/other": { hasTrustDialogAccepted: true } }, mcpServers: { x: 1 } },
      ["/ws/a", "/ws/b"]
    );
    expect(out.projects!["/other"].hasTrustDialogAccepted).toBe(true);
    expect(out.projects!["/ws/a"].hasTrustDialogAccepted).toBe(true);
    expect(out.projects!["/ws/b"].hasTrustDialogAccepted).toBe(true);
    expect(out.mcpServers).toEqual({ x: 1 });
  });

  test("does not mutate the input object", () => {
    const input = { projects: { "/ws/a": { hasTrustDialogAccepted: false } } };
    withTrustedDirs(input, ["/ws/a"]);
    expect(input.projects["/ws/a"].hasTrustDialogAccepted).toBe(false);
  });
});
