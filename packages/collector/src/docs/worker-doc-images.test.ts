import { describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { DOC_BODY_MAX_BYTES, PERSONA_ATTACHMENT_MAX_BYTES } from "@standup/shared";
import { findDocAssetByPath, findDocByPath } from "@standup/store";
import { HOST, docsHarness, png } from "./test-harness.js";

/*
 * POST /api/docs/write with images: a worker names image files on this host,
 * each checked like Persona's write_doc images (readImageForAttachment),
 * stored beside the doc, and the doc written after them.
 */

type Written = { doc: { id: string; path: string; revision: number }; images: Array<{ path: string; src: string }> };

function file(root: string, rel: string, bytes: Uint8Array | string): string {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

describe("a worker's doc write with images", () => {
  test("stores each image beside the doc and writes the doc embedding it; the owner reads the image back", async () => {
    const h = docsHarness();
    const shot = png(120, 4);
    const home = file(h.root, "run/screens/home.png", shot);
    const catalog = file(h.root, "run/catalog page.png", png(90, 5));
    const content = "# Report\n\n![Home](screens/home.png)\n\n![Catalog](catalog%20page.png)";
    const written = await h.ok<Written>("POST", "/api/docs/write", h.worker("alice"), {
      path: "reports/run.md",
      content,
      images: [{ file: home, src: "screens/home.png" }, { file: catalog }],
    });
    expect(written.images).toEqual([
      { path: "reports/screens/home.png", src: "screens/home.png" },
      { path: "reports/catalog page.png", src: "catalog%20page.png" },
    ]);
    expect(written.doc).toMatchObject({ path: "reports/run.md", revision: 1 });
    expect(findDocByPath(h.store.db, "alice", ["reports", "run.md"])?.body).toBe(content);
    const asset = findDocAssetByPath(h.store.db, "alice", ["reports", "screens", "home.png"]);
    expect(asset).toMatchObject({ mime: "image/png", bytes: shot.length });
    expect(findDocAssetByPath(h.store.db, "alice", ["reports", "catalog page.png"])).toBeTruthy();
  });

  test("the host owner's worker's images are served from the asset URL the Docs tab renders", async () => {
    const h = docsHarness();
    const shot = png(64, 9);
    const path = file(h.root, "a.png", shot);
    await h.ok<Written>("POST", "/api/docs/write", h.worker(HOST), { path: "d.md", content: "![A](a.png)", images: [{ file: path }] });
    const tree = await h.ok<{ assets: Array<{ id: string; name: string }> }>("GET", "/api/docs/tree", h.owner());
    const id = tree.assets.find((a) => a.name === "a.png")!.id;
    const served = await h.app.request(`/api/docs/assets/${id}`, { headers: h.owner() });
    expect(served.status).toBe(200);
    expect(Buffer.from(await served.arrayBuffer()).equals(Buffer.from(shot))).toBe(true);
  });

  test("a bad file is refused with its reason, and nothing is stored or written", async () => {
    const h = docsHarness();
    const good = file(h.root, "ok.png", png());
    const cases: Array<[string, string, RegExp]> = [
      ["not an image", file(h.root, "fake.png", "just text, not a png"), /is not a PNG, JPEG, GIF or WebP image \(checked by content\)/],
      ["too big", file(h.root, "big.png", new Uint8Array(PERSONA_ATTACHMENT_MAX_BYTES + 1)), /images over 10\.0 MB can't be attached/],
      ["credentials location", file(h.home, ".aws/looks-like.png", png()), /refused: that path is under a location Standup never reads images from/],
      ["missing", join(h.root, "nope.png"), /no such file/],
      ["wrong extension", file(h.root, "shot.txt", png()), /only \.png, \.jpg, \.jpeg, \.gif and \.webp images can be attached/],
    ];
    for (const [label, bad, why] of cases) {
      const res = await h.call("POST", "/api/docs/write", h.worker("alice"), {
        path: "d.md",
        content: "x",
        images: [{ file: good, src: "a.png" }, { file: bad, src: "b.png" }],
      });
      const body = (await res.json()) as { error: string };
      expect({ label, status: res.status }).toEqual({ label, status: 400 });
      expect({ label, error: body.error }).toEqual({ label, error: expect.stringMatching(why) });
      expect(body.error).toContain("image 2 of 2 (b.png)");
      expect(body.error).toContain("The doc was not written.");
    }
    expect(findDocByPath(h.store.db, "alice", ["d.md"])).toBeNull();
    expect(findDocAssetByPath(h.store.db, "alice", ["a.png"])).toBeNull();
  });

  test("a bad images list or src is refused before anything is read", async () => {
    const h = docsHarness();
    const good = file(h.root, "ok.png", png());
    const cases: Array<[unknown, string]> = [
      ["x.png", "images must be a list of {file, src}"],
      [[{ src: "a.png" }], "images[0].file is required"],
      [[{ file: good, src: "../../out.png" }], "must be a path relative to the doc's folder"],
      [[{ file: good, src: "a.md" }], "ending in .png"],
      [[{ file: good, src: "a.png" }, { file: good, src: "./a.png" }], "names the same image as an earlier one"],
      [Array.from({ length: 51 }, (_, i) => ({ file: good, src: `${i}.png` })), "at most 50 images"],
    ];
    for (const [images, why] of cases) {
      const res = await h.call("POST", "/api/docs/write", h.worker("alice"), { path: "d.md", content: "x", images });
      expect({ why, status: res.status }).toEqual({ why, status: 400 });
      expect(((await res.json()) as { error: string }).error).toContain(why);
    }
    expect(findDocByPath(h.store.db, "alice", ["d.md"])).toBeNull();
  });

  test("a stale ifRevision is refused before any image is replaced", async () => {
    const h = docsHarness();
    const v1 = file(h.root, "v1.png", png(80, 1));
    const v2 = file(h.root, "v2.png", png(80, 2));
    const first = await h.ok<Written>("POST", "/api/docs/write", h.worker("alice"), { path: "d.md", content: "![](a.png)", images: [{ file: v1, src: "a.png" }] });
    const before = findDocAssetByPath(h.store.db, "alice", ["a.png"])!.id;
    const res = await h.call("POST", "/api/docs/write", h.worker("alice"), {
      path: "d.md",
      content: "y",
      ifRevision: first.doc.revision + 4,
      images: [{ file: v2, src: "a.png" }],
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain(`the doc is at revision ${first.doc.revision}`);
    expect(findDocAssetByPath(h.store.db, "alice", ["a.png"])!.id).toBe(before);
  });

  test("images only go with a worker's credential: Persona and a person are refused", async () => {
    const h = docsHarness();
    const good = file(h.root, "ok.png", png());
    for (const headers of [h.persona(), h.owner()]) {
      const res = await h.call("POST", "/api/docs/write", headers, { path: "d.md", content: "x", images: [{ file: good }] });
      expect(res.status).toBe(403);
    }
    // Without images, or with none, the same callers write as before.
    await h.ok("POST", "/api/docs/write", h.persona(), { path: "d.md", content: "x" });
    await h.ok("POST", "/api/docs/write", h.owner(), { path: "e.md", content: "x", images: [] });
  });

  test("a guest's worker stores only images inside its own worktree; the host's worker may name any allowed path", async () => {
    const h = docsHarness();
    const elsewhere = mkdtempSync(join(tmpdir(), "docs-elsewhere-"));
    try {
      const outside = file(elsewhere, "host-shot.png", png(70, 3));
      const inside = file(h.root, "run/own.png", png(70, 4));
      const refused = await h.call("POST", "/api/docs/write", h.worker("alice"), { path: "d.md", content: "x", images: [{ file: outside }] });
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toContain("this worker stores only images inside its own worktree or scratch dirs");
      expect(findDocAssetByPath(h.store.db, "alice", ["host-shot.png"])).toBeNull();
      // A hard link into its worktree names the same outside file.
      const linked = join(h.root, "run/linked.png");
      linkSync(outside, linked);
      const viaLink = await h.call("POST", "/api/docs/write", h.worker("alice"), { path: "d.md", content: "x", images: [{ file: linked }] });
      expect(viaLink.status).toBe(400);
      expect(((await viaLink.json()) as { error: string }).error).toContain("has other hard links");
      await h.ok("POST", "/api/docs/write", h.worker("alice"), { path: "d.md", content: "x", images: [{ file: inside }] });
      expect(findDocAssetByPath(h.store.db, "alice", ["own.png"])).toBeTruthy();
      await h.ok("POST", "/api/docs/write", h.worker(HOST), { path: "d.md", content: "x", images: [{ file: outside }] });
      expect(findDocAssetByPath(h.store.db, HOST, ["host-shot.png"])).toBeTruthy();
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("a body over the doc cap is refused before any image is stored", async () => {
    const h = docsHarness();
    const good = file(h.root, "ok.png", png());
    const res = await h.call("POST", "/api/docs/write", h.worker("alice"), {
      path: "d.md",
      content: "x".repeat(DOC_BODY_MAX_BYTES + 1),
      images: [{ file: good }],
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe(`the doc is over ${DOC_BODY_MAX_BYTES} bytes`);
    expect(findDocAssetByPath(h.store.db, "alice", ["ok.png"])).toBeNull();
  });
});
