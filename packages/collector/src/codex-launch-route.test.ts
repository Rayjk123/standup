import { expect, test, describe } from "bun:test";
import { randomUUID } from "crypto";
import { createStore, upsertProject } from "@standup/store";
import type { Store } from "@standup/store";
import { createServer } from "./server.js";

/**
 * POST /api/projects/:id/launch — the Codex model/effort validation the route
 * applies before any launch is created. Like the bootstrap-launch tests, a
 * *successful* launch is not free (worktree + setup + a real agent), so only the
 * validation paths are exercised here: they resolve before anything is created.
 *
 * The route validates `codexEffort` against the closed CODEX_EFFORTS set but
 * accepts `codexModel` as a free-form string (Codex model ids version with the
 * CLI). An accepted pair is proved by letting the request fall through to the
 * unknown-project 404 — reaching it means validation passed without a 400.
 */

function setUpStore(): { store: Store; projectId: string } {
  const store = createStore(":memory:");
  const projectId = `codex-launch-route-${randomUUID().slice(0, 8)}`;
  upsertProject(store.db, { id: projectId, name: "Codex Launch Route", branch: "main", repos: [] });
  return { store, projectId };
}

async function postLaunch(app: ReturnType<typeof createServer>, projectId: string, body: unknown) {
  return app.request(`/api/projects/${projectId}/launch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/projects/:id/launch — Codex model/effort validation", () => {
  test("an unknown Codex effort is rejected with 400", async () => {
    const { store, projectId } = setUpStore();
    const app = createServer(store, () => {}, null);

    const res = await postLaunch(app, projectId, { task: "do it", harness: "codex", codexEffort: "extreme" });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/effort/i);
    store.close();
  });

  test("a non-string codexModel is rejected with 400", async () => {
    const { store, projectId } = setUpStore();
    const app = createServer(store, () => {}, null);

    const res = await postLaunch(app, projectId, { task: "do it", harness: "codex", codexModel: 123 });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/codexModel/i);
    store.close();
  });

  test("a valid Codex effort is validated BEFORE the project lookup (unknown project still 400s on the effort)", async () => {
    const { store } = setUpStore();
    const app = createServer(store, () => {}, null);

    // Unknown project, but the bad effort is caught first — proving the codex
    // validation runs ahead of the 404.
    const res = await postLaunch(app, "no-such-project", { task: "do it", harness: "codex", codexEffort: "nope" });
    expect(res.status).toBe(400);
    store.close();
  });

  test("a free-form codexModel with a valid codexEffort passes validation (falls through to 404 on an unknown project)", async () => {
    const { store } = setUpStore();
    const app = createServer(store, () => {}, null);

    // An arbitrary model string is accepted (no allowlist); reaching the
    // unknown-project 404 proves neither codex field was rejected.
    const res = await postLaunch(app, "no-such-project", {
      task: "do it",
      harness: "codex",
      codexModel: "some-future-codex-model",
      codexEffort: "minimal",
    });
    expect(res.status).toBe(404);
    store.close();
  });

  test("every CODEX_EFFORTS level passes validation", async () => {
    const { store } = setUpStore();
    const app = createServer(store, () => {}, null);

    for (const effort of ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]) {
      const res = await postLaunch(app, "no-such-project", { task: "do it", harness: "codex", codexEffort: effort });
      // Passes the effort validation → falls through to the unknown-project 404.
      expect(res.status).toBe(404);
    }
    store.close();
  });
});
