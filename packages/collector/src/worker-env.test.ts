import { describe, expect, test } from "bun:test";
import { workerEnv } from "./worker-env.js";

describe("workerEnv", () => {
  test("drops the collector's own $TMUX and $TMUX_PANE and keeps the rest", () => {
    const env = workerEnv({ PATH: "/usr/bin", TMUX: "/tmp/tmux-1/default,123,0", TMUX_PANE: "%3", TMUX_TMPDIR: "/tmp/x", HOME: "/h" });
    expect(env.TMUX).toBeUndefined();
    expect(env.TMUX_PANE).toBeUndefined();
    expect(env).toMatchObject({ PATH: "/usr/bin", TMUX_TMPDIR: "/tmp/x", HOME: "/h" });
  });
});
