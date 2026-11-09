import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { argsNamePort, createReviewTunnelSystem } from "./system.js";
import { msUntilNightly, reviewTunnelsEnabled } from "./index.js";
import { commandTunnelProvider } from "../tunnels/provider.js";

const logDir = mkdtempSync(join(tmpdir(), "standup-rt-sys-"));
const sys = createReviewTunnelSystem(
  logDir,
  commandTunnelProvider({ create: "/nonexistent/tunnelctl open {port} --name {name}", url: "https://{name}.tunnels.example.test", list: "/nonexistent/tunnelctl ls" })
);
const started: number[] = [];

afterAll(() => {
  for (const pid of started) sys.killGroup(pid);
});

describe("the real host", () => {
  test("spawns a detached process group, sees it alive, and kills the whole group", async () => {
    // A shell that starts a child: killing the group must take the child too.
    const pid = sys.spawn(["sh", "-c", "sleep 60 & echo started; wait"], { cwd: logDir, logFile: sys.logFile("t1", "serve"), credentials: false });
    started.push(pid);
    await Bun.sleep(200);
    expect(sys.isAlive(pid)).toBe(true);
    expect(sys.commandMentions(pid, 60)).toBe(true);
    expect(sys.commandMentions(pid, 6)).toBe(false);
    sys.killGroup(pid);
    for (let i = 0; i < 40 && sys.isAlive(pid); i++) await Bun.sleep(50);
    expect(sys.isAlive(pid)).toBe(false);
    expect(readFileSync(sys.logFile("t1", "serve"), "utf8")).toContain("started");
  });

  test("a group whose leader died is still found by its port and stopped", async () => {
    // The leader (sh) starts a child naming the "port", then is killed alone.
    const pid = sys.spawn(["sh", "-c", "sleep 4321 & wait"], { cwd: logDir, logFile: sys.logFile("t5", "serve"), credentials: false });
    started.push(pid);
    await Bun.sleep(200);
    process.kill(pid, "SIGKILL");
    for (let i = 0; i < 40 && sys.isAlive(pid); i++) await Bun.sleep(50);
    expect(sys.isAlive(pid)).toBe(false);
    expect(sys.groupMentions(pid, 4321)).toBe(true);
    expect(sys.groupMentions(pid, 432)).toBe(false);
    sys.killGroup(pid);
    for (let i = 0; i < 40 && sys.groupMentions(pid, 4321); i++) await Bun.sleep(50);
    expect(sys.groupMentions(pid, 4321)).toBe(false);
  });

  test("a branch build runs without the owner's credentials", async () => {
    process.env.AWS_PROFILE = "should-not-leak";
    try {
      const code = await sys.run(["sh", "-c", 'test -z "$AWS_PROFILE" && test "$AWS_CONFIG_FILE" = /dev/null'], {
        cwd: logDir,
        logFile: sys.logFile("t2", "setup"),
        timeoutMs: 10_000,
      });
      expect(code).toBe(0);
    } finally {
      delete process.env.AWS_PROFILE;
    }
  });

  test("run times out and reports -1", async () => {
    expect(await sys.run(["sleep", "30"], { cwd: logDir, logFile: sys.logFile("t3", "setup"), timeoutMs: 200 })).toBe(-1);
  });

  test("portFree and waitForPort see a listener on loopback", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
    const port = server.port!;
    try {
      expect(await sys.portFree(port)).toBe(false);
      expect(await sys.waitForPort(port, 2_000, process.pid)).toBe(true);
    } finally {
      server.stop(true);
    }
    expect(await sys.portFree(port)).toBe(true);
  });

  test("waitForPort gives up once the serve process exits", async () => {
    const pid = sys.spawn(["true"], { cwd: logDir, logFile: sys.logFile("t4", "serve"), credentials: false });
    await Bun.sleep(200);
    const free = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const port = free.port!;
    free.stop(true);
    expect(await sys.waitForPort(port, 5_000, pid)).toBe(false);
  });

  test("an unreachable tunnel CLI lists nothing rather than throwing", async () => {
    expect(await sys.listTunnels()).toBeNull();
  });
});

describe("helpers", () => {
  test("argsNamePort matches the port as a whole number", () => {
    expect(argsNamePort("vite --port 5201 --strictPort", 5201)).toBe(true);
    expect(argsNamePort("--port=5201", 5201)).toBe(true);
    expect(argsNamePort("http://127.0.0.1:5201/", 5201)).toBe(true);
    expect(argsNamePort("serve 52011", 5201)).toBe(false);
    expect(argsNamePort("t=152010", 5201)).toBe(false);
  });

  test("STANDUP_REVIEW_TUNNELS=0 turns opening off", () => {
    expect(reviewTunnelsEnabled({})).toBe(true);
    for (const v of ["0", "off", "false", "no"]) expect(reviewTunnelsEnabled({ STANDUP_REVIEW_TUNNELS: v })).toBe(false);
  });

  test("the nightly reconcile is scheduled for the next 03:00", () => {
    const at = new Date(2026, 9, 8, 2, 0, 0);
    expect(msUntilNightly(at)).toBe(3_600_000);
    expect(msUntilNightly(new Date(2026, 9, 8, 3, 0, 0))).toBe(24 * 3_600_000);
  });
});
