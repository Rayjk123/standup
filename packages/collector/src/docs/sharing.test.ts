import { describe, expect, test } from "bun:test";
import type { DocAsset, DocDetail, DocFolder, SharedWithMe } from "@standup/shared";
import { docsHarness, png } from "./test-harness.js";

/*
 * Shareable docs: a doc marked shareable, or any doc in or below a folder
 * marked shareable, reads (read-only, at its latest revision) for every
 * signed-in user and lists under their "Shared with me"; nothing else of the
 * owner's does, unsharing hides it again, and only the owner writes.
 */

type H = ReturnType<typeof docsHarness>;

async function setUp(h: H) {
  const alice = h.as("alice");
  const bob = h.as("bob");
  const design = (await h.ok<{ folder: DocFolder }>("POST", "/api/docs/folders", alice, { parentId: null, name: "design" })).folder;
  const sub = (await h.ok<{ folder: DocFolder }>("POST", "/api/docs/folders", alice, { parentId: design.id, name: "sub" })).folder;
  const make = async (folderId: string | null, name: string, body = `# ${name}`) =>
    (await h.ok<{ doc: DocDetail }>("POST", "/api/docs", alice, { folderId, name, body })).doc;
  const plain = await make(null, "private.md", "PRIVATE");
  const nested = await make(sub.id, "nested.md");
  return { alice, bob, design, sub, plain, nested, make };
}

const sharedWith = async (h: H, who: Record<string, string>) => (await h.ok<{ shared: SharedWithMe[] }>("GET", "/api/docs/shared-with-me", who)).shared;

describe("who can read a doc", () => {
  test("a doc that isn't shareable stays invisible to everyone but its owner", async () => {
    const h = docsHarness();
    const { alice, bob, plain } = await setUp(h);
    expect((await h.call("GET", `/api/docs/${plain.id}`, bob)).status).toBe(404);
    expect((await h.call("GET", `/api/docs/${plain.id}/comments`, bob)).status).toBe(404);
    expect(await sharedWith(h, bob)).toEqual([]);
    const own = await h.ok<{ doc: DocDetail }>("GET", `/api/docs/${plain.id}`, alice);
    expect(own.doc.readOnly).toBeUndefined();
    // The owner's own docs never list as shared with them.
    await h.ok("PUT", `/api/docs/${plain.id}/shareable`, alice, { shareable: true });
    expect(await sharedWith(h, alice)).toEqual([]);
  });

  test("a shareable doc reads for another signed-in user, read-only and at its latest revision", async () => {
    const h = docsHarness();
    const { alice, bob, plain } = await setUp(h);
    await h.ok("PUT", `/api/docs/${plain.id}/shareable`, alice, { shareable: true });
    const read = (await h.ok<{ doc: DocDetail }>("GET", `/api/docs/${plain.id}`, bob)).doc;
    expect(read).toMatchObject({ id: plain.id, name: "private.md", body: "PRIVATE", readOnly: { owner: "alice", images: {} } });
    expect(read.share).toBeUndefined();
    await h.ok("PATCH", `/api/docs/${plain.id}`, alice, { body: "EDITED", baseRevision: plain.revision });
    expect((await h.ok<{ doc: DocDetail }>("GET", `/api/docs/${plain.id}`, bob)).doc.body).toBe("EDITED");
    expect(await sharedWith(h, bob)).toEqual([{ owner: "alice", docs: [{ id: plain.id, path: "private.md", updatedAt: expect.any(String) }] }]);
  });

  test("every doc in or below a shareable folder reads, including one added later; the owner sees which folder shares it", async () => {
    const h = docsHarness();
    const { alice, bob, design, sub, plain, nested, make } = await setUp(h);
    await h.ok("PUT", `/api/docs/folders/${design.id}/shareable`, alice, { shareable: true });
    expect((await h.call("GET", `/api/docs/${nested.id}`, bob)).status).toBe(200);
    const later = await make(sub.id, "later.md");
    expect((await h.call("GET", `/api/docs/${later.id}`, bob)).status).toBe(200);
    expect((await h.call("GET", `/api/docs/${plain.id}`, bob)).status).toBe(404);
    expect((await sharedWith(h, bob))[0]!.docs.map((d) => d.path)).toEqual(["design/sub/later.md", "design/sub/nested.md"]);
    expect((await h.ok<{ doc: DocDetail }>("GET", `/api/docs/${nested.id}`, alice)).doc.shareableVia).toBe("design");
    // The tree shows the owner which folder is shareable.
    const tree = await h.ok<{ folders: DocFolder[] }>("GET", "/api/docs/tree", alice);
    expect(tree.folders.find((f) => f.id === design.id)?.shareable).toBe(true);
    expect(tree.folders.find((f) => f.id === sub.id)?.shareable).toBeUndefined();
  });

  test("Shared with me shows no unshared folder's name: a path starts at the shareable folder, or is the doc's own name", async () => {
    const h = docsHarness();
    const { alice, bob, sub, nested, make } = await setUp(h);
    await h.ok("PUT", `/api/docs/${nested.id}/shareable`, alice, { shareable: true });
    expect((await sharedWith(h, bob))[0]!.docs.map((d) => d.path)).toEqual(["nested.md"]);
    await h.ok("PUT", `/api/docs/folders/${sub.id}/shareable`, alice, { shareable: true });
    await make(sub.id, "other.md");
    expect((await sharedWith(h, bob))[0]!.docs.map((d) => d.path)).toEqual(["sub/nested.md", "sub/other.md"]);
  });

  test("unsharing the doc or its folder hides it again at once", async () => {
    const h = docsHarness();
    const { alice, bob, design, plain, nested } = await setUp(h);
    await h.ok("PUT", `/api/docs/${plain.id}/shareable`, alice, { shareable: true });
    await h.ok("PUT", `/api/docs/folders/${design.id}/shareable`, alice, { shareable: true });
    await h.ok("PUT", `/api/docs/${plain.id}/shareable`, alice, { shareable: false });
    await h.ok("PUT", `/api/docs/folders/${design.id}/shareable`, alice, { shareable: false });
    for (const id of [plain.id, nested.id]) {
      expect((await h.call("GET", `/api/docs/${id}`, bob)).status).toBe(404);
      expect((await h.call("POST", `/api/docs/${id}/comments`, bob, { body: "?", anchor: { quote: "x", prefix: "", suffix: "" } })).status).toBe(404);
    }
    expect(await sharedWith(h, bob)).toEqual([]);
  });

  test("a reader can't write, delete, rename, move or reshare the doc", async () => {
    const h = docsHarness();
    const { alice, bob, design, plain } = await setUp(h);
    await h.ok("PUT", `/api/docs/${plain.id}/shareable`, alice, { shareable: true });
    const tries: Array<[string, string, unknown]> = [
      ["PATCH", `/api/docs/${plain.id}`, { body: "HACKED", baseRevision: plain.revision }],
      ["PATCH", `/api/docs/${plain.id}`, { name: "renamed.md" }],
      ["PATCH", `/api/docs/${plain.id}`, { folderId: null }],
      ["DELETE", `/api/docs/${plain.id}`, undefined],
      ["PUT", `/api/docs/${plain.id}/shareable`, { shareable: false }],
      ["PUT", `/api/docs/folders/${design.id}/shareable`, { shareable: true }],
      ["PUT", `/api/shares/doc/${plain.id}`, { enabled: true }],
    ];
    for (const [method, path, body] of tries) {
      const res = await h.call(method, path, bob, body);
      expect([403, 404]).toContain(res.status);
    }
    const doc = (await h.ok<{ doc: DocDetail }>("GET", `/api/docs/${plain.id}`, alice)).doc;
    expect(doc).toMatchObject({ name: "private.md", body: "PRIVATE", folderId: null, shareable: true });
    expect(doc.share?.enabled).toBe(false);
    // Persona and workers never reach another user's doc through the console routes.
    expect((await h.call("GET", `/api/docs/${plain.id}`, h.persona())).status).toBe(403);
  });

  test("a reader loads only the images the shared doc's body shows, and only through that doc", async () => {
    const h = docsHarness();
    const alice = h.as("alice");
    const bob = h.as("bob");
    const folder = (await h.ok<{ folder: DocFolder }>("POST", "/api/docs/folders", alice, { parentId: null, name: "f" })).folder;
    const upload = async (name: string, fill: number) => {
      const res = await h.app.request(`/api/docs/assets?folderId=${folder.id}&name=${name}`, {
        method: "POST",
        headers: { "content-type": "image/png", ...alice },
        body: png(60, fill),
      });
      return ((await res.json()) as { asset: DocAsset }).asset;
    };
    const shown = await upload("shown.png", 1);
    const hidden = await upload("hidden.png", 2);
    const doc = (await h.ok<{ doc: DocDetail }>("POST", "/api/docs", alice, { folderId: folder.id, name: "d.md", body: "![a diagram](shown.png)" })).doc;
    await h.ok("PUT", `/api/docs/${doc.id}/shareable`, alice, { shareable: true });
    const read = (await h.ok<{ doc: DocDetail }>("GET", `/api/docs/${doc.id}`, bob)).doc;
    expect(read.readOnly!.images).toEqual({ "shown.png": { url: `/api/docs/assets/${shown.id}?doc=${doc.id}`, mime: "image/png" } });
    expect((await h.call("GET", `/api/docs/assets/${shown.id}?doc=${doc.id}`, bob)).status).toBe(200);
    expect((await h.call("GET", `/api/docs/assets/${shown.id}`, bob)).status).toBe(404);
    expect((await h.call("GET", `/api/docs/assets/${hidden.id}?doc=${doc.id}`, bob)).status).toBe(404);
    await h.ok("PUT", `/api/docs/${doc.id}/shareable`, alice, { shareable: false });
    expect((await h.call("GET", `/api/docs/assets/${shown.id}?doc=${doc.id}`, bob)).status).toBe(404);
  });
});
