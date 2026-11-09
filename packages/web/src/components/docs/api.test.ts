import { describe, expect, test } from "bun:test";
import { DOC_TOOL_IMAGE_MAX_BYTES } from "@standup/shared";
import { DocsRequestError, getTree, imageFileName, imageUploadRefusal, writeImage } from "./api";

describe("docs api", () => {
  test("a tree read answered with a page that isn't the tree's JSON fails instead of reading as empty", async () => {
    const saved = globalThis.fetch;
    try {
      for (const body of ["<!doctype html><title>Sign in</title>", "{}", "null"]) {
        globalThis.fetch = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
        await expect(getTree()).rejects.toBeInstanceOf(DocsRequestError);
      }
      globalThis.fetch = (async () => new Response(JSON.stringify({ folders: [] }), { status: 200 })) as unknown as typeof fetch;
      expect(await getTree()).toEqual({ folders: [], docs: [], assets: [] });
    } finally {
      globalThis.fetch = saved;
    }
  });

  test("an image upload is refused up front for a type a doc can't hold or a file over the cap", () => {
    const file = (type: string, size: number, name = "shot.png") => new File([new Uint8Array(size)], name, { type });
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp", "IMAGE/PNG"]) expect(imageUploadRefusal(file(type, 10))).toBeNull();
    expect(imageUploadRefusal(file("image/png", DOC_TOOL_IMAGE_MAX_BYTES))).toBeNull();
    for (const type of ["", "image/svg+xml", "image/bmp", "text/plain", "application/pdf"]) {
      expect(imageUploadRefusal(file(type, 10, "notes.txt"))).toBe(`"notes.txt" isn't an image a doc can hold: use a PNG, JPEG, GIF or WebP.`);
    }
    expect(imageUploadRefusal(file("image/png", DOC_TOOL_IMAGE_MAX_BYTES + 1))).toBe(`"shot.png" is 10.0 MB; an image can be at most 10 MB.`);
    expect(imageUploadRefusal(file("image/png", 12 * 1024 * 1024))).toBe(`"shot.png" is 12.0 MB; an image can be at most 10 MB.`);
  });

  test("an image is stored under its own name, given its type's extension when its own isn't one of that type's", () => {
    const cases: [name: string, type: string, stored: string][] = [
      ["shot.png", "image/png", "shot.png"],
      ["Photo.JPEG", "image/jpeg", "Photo.JPEG"],
      ["clip", "image/gif", "clip.gif"],
      ["scan.heic", "image/webp", "scan.webp"],
      ["photo.jpg", "image/png", "photo.png"],
      ["v1.2", "image/png", "v1.png"],
      ["", "image/png", "image.png"],
      ["  ", "image/jpeg", "image.jpg"],
      ["a/b\\c\u0001.png", "image/png", "a-b-c-.png"],
      [`${"x".repeat(300)}.png`, "image/png", `${"x".repeat(184)}.png`],
      [`${"x".repeat(183)}😀😀.png`, "image/png", `${"x".repeat(183)}.png`],
      [`${"x".repeat(182)}😀😀.png`, "image/png", `${"x".repeat(182)}😀.png`],
      [`${"😀".repeat(150)}.png`, "image/png", `${"😀".repeat(92)}.png`],
    ];
    for (const [name, type, stored] of cases) expect(imageFileName(new File([new Uint8Array(1)], name, { type }))).toBe(stored);
  });

  test("an image is written as JSON to the doc tools' write-image route, its bytes in base64", async () => {
    const saved = globalThis.fetch;
    const sent: { url: string; init: RequestInit }[] = [];
    try {
      globalThis.fetch = (async (url: string, init: RequestInit) => {
        sent.push({ url, init });
        return new Response(JSON.stringify({ asset: { id: "a1", path: "notes/a.png", url: "/api/docs/assets/a1", mime: "image/png", bytes: 3 } }));
      }) as unknown as typeof fetch;
      const written = await writeImage(["notes", "a.png"], "f1", new Blob([Uint8Array.from([0x89, 0x50, 0x4e])], { type: "image/png" }));
      expect(written).toMatchObject({ id: "a1", path: "notes/a.png", url: "/api/docs/assets/a1" });
      expect(sent).toHaveLength(1);
      expect(sent[0]!.url).toBe("/api/docs/write-image");
      expect(sent[0]!.init.method).toBe("POST");
      expect((sent[0]!.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
      expect(JSON.parse(sent[0]!.init.body as string)).toEqual({ path: "notes/a.png", folderId: "f1", unique: true, data: "iVBO" });
      globalThis.fetch = (async () => new Response(JSON.stringify({ error: "the image is over 10 MB" }), { status: 413 })) as unknown as typeof fetch;
      await expect(writeImage(["a.png"], null, new Blob([new Uint8Array(1)]))).rejects.toThrow("the image is over 10 MB");
    } finally {
      globalThis.fetch = saved;
    }
  });
});
