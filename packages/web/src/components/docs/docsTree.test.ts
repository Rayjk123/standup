import { describe, expect, test } from "bun:test";
import type { DocAsset, DocFolder, DocSummary, DocTree } from "@standup/shared";
import {
  assetForSrc,
  canMove,
  folderPath,
  imageResolutionKey,
  imageSources,
  isSelfOrDescendant,
  relativeSrc,
} from "./docsTree";

const AT = "2026-10-01T00:00:00.000Z";
const folder = (id: string, parentId: string | null, name: string): DocFolder => ({ id, parentId, name, createdAt: AT, updatedAt: AT });
const doc = (id: string, folderId: string | null, name: string): DocSummary => ({ id, folderId, name, revision: 1, bytes: 1, createdAt: AT, updatedAt: AT });
const asset = (id: string, folderId: string | null, name: string): DocAsset => ({
  id,
  folderId,
  name,
  mime: "image/png",
  bytes: 1,
  createdAt: AT,
  url: `/api/docs/assets/${id}`,
});

// notes/ (f1) ⊃ authz/ (f2) ⊃ deep/ (f3); shared/ (f4) at the root.
const TREE: DocTree = {
  folders: [folder("f1", null, "notes"), folder("f2", "f1", "authz"), folder("f3", "f2", "deep"), folder("f4", null, "shared")],
  docs: [doc("d1", "f2", "sentinel.md"), doc("d2", null, "top.md")],
  assets: [asset("a1", "f2", "diagram.png"), asset("a2", "f4", "chart.png"), asset("a3", "f2", "logo small.png"), asset("a4", null, "root.png")],
};

describe("docs tree helpers", () => {
  test("imageSources lists each inline image's src, bare or in angle brackets", () => {
    const body = "![a](x.png) text ![b](<logo small.png>) and ![c]( screens/home.png \"t\")\n[link](y.png) ![](z.gif)";
    expect(imageSources(body)).toEqual(["x.png", "logo small.png", "screens/home.png", "z.gif"]);
  });

  test("imageSources undoes backslash escapes, as the editor writes a name with parentheses", () => {
    expect(imageSources("![](shot%20\\(2\\).png) ![](a\\_b.png) ![](c\\d.png)")).toEqual(["shot%20(2).png", "a_b.png", "c"]);
    const tree = { ...TREE, assets: [...TREE.assets, asset("a6", "f2", "shot (2).png")] };
    expect(imageResolutionKey(tree, "f2", "![](shot%20\\(2\\).png)")).toContain("a6");
  });

  test("imageResolutionKey changes only when one of the doc's own images resolves differently", () => {
    const body = "![d](diagram.png) ![m](missing.png)";
    const key = imageResolutionKey(TREE, "f2", body);
    const unrelated = { ...TREE, assets: [...TREE.assets, asset("a5", "f2", "other.png")] };
    expect(imageResolutionKey(unrelated, "f2", body)).toBe(key);
    const added = { ...TREE, assets: [...TREE.assets, asset("a6", "f2", "missing.png")] };
    expect(imageResolutionKey(added, "f2", body)).not.toBe(key);
    const replaced = { ...TREE, assets: TREE.assets.map((a) => (a.id === "a1" ? asset("a9", "f2", "diagram.png") : a)) };
    expect(imageResolutionKey(replaced, "f2", body)).not.toBe(key);
  });

  test("folderPath names a folder's ancestors from the root down", () => {
    expect(folderPath(TREE, "f3")).toEqual(["notes", "authz", "deep"]);
    expect(folderPath(TREE, null)).toEqual([]);
    expect(folderPath(TREE, "missing")).toEqual([]);
  });

  test("isSelfOrDescendant follows parents up to the root", () => {
    expect(isSelfOrDescendant(TREE, "f3", "f1")).toBe(true);
    expect(isSelfOrDescendant(TREE, "f1", "f1")).toBe(true);
    expect(isSelfOrDescendant(TREE, "f4", "f1")).toBe(false);
    expect(isSelfOrDescendant(TREE, null, "f1")).toBe(false);
  });

  test("canMove refuses a folder into itself or its descendants, and a no-op move", () => {
    expect(canMove(TREE, { kind: "folder", id: "f1" }, "f3")).toBe(false);
    expect(canMove(TREE, { kind: "folder", id: "f1" }, "f1")).toBe(false);
    expect(canMove(TREE, { kind: "folder", id: "f2" }, "f1")).toBe(false);
    expect(canMove(TREE, { kind: "folder", id: "f2" }, null)).toBe(true);
    expect(canMove(TREE, { kind: "folder", id: "f3" }, "f4")).toBe(true);
    expect(canMove(TREE, { kind: "doc", id: "d1" }, "f2")).toBe(false);
    expect(canMove(TREE, { kind: "doc", id: "d1" }, null)).toBe(true);
    expect(canMove(TREE, { kind: "asset", id: "a4" }, "f3")).toBe(true);
    expect(canMove(TREE, { kind: "doc", id: "missing" }, null)).toBe(false);
  });

  test("assetForSrc resolves a src relative to the doc's folder", () => {
    expect(assetForSrc(TREE, "f2", "diagram.png")?.id).toBe("a1");
    expect(assetForSrc(TREE, "f2", "./diagram.png")?.id).toBe("a1");
    expect(assetForSrc(TREE, "f2", "logo%20small.png")?.id).toBe("a3");
    expect(assetForSrc(TREE, "f2", "../../shared/chart.png")?.id).toBe("a2");
    expect(assetForSrc(TREE, "f3", "../diagram.png?v=2")?.id).toBe("a1");
    expect(assetForSrc(TREE, null, "root.png")?.id).toBe("a4");
    expect(assetForSrc(TREE, "f2", "missing.png")).toBeNull();
    expect(assetForSrc(TREE, "f2", "https://example.com/diagram.png")).toBeNull();
    expect(assetForSrc(TREE, "f2", "/diagram.png")).toBeNull();
    expect(assetForSrc(TREE, null, "../root.png")).toBeNull();
  });

  test("relativeSrc escapes a name so the markdown link parses and resolves back", () => {
    expect(relativeSrc("logo small.png")).toBe("logo%20small.png");
    expect(assetForSrc(TREE, "f2", relativeSrc("logo small.png"))?.id).toBe("a3");
  });
});
