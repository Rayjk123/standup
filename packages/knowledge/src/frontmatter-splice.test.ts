import { describe, expect, test } from "bun:test";
import matter from "gray-matter";
import { frontmatterBody, spliceBody, spliceFrontmatter } from "./frontmatter-splice.js";

const FILE = [
  "---",
  "# provenance is stamped by the ingest",
  "title: Deploy runbook",
  "last_verified_at: 2026-08-16",
  "tags: [deploy, beta]",
  "related:",
  "  - proj/other",
  "  - proj/third",
  "summary: >",
  "  folded text",
  "  over two lines",
  "scope: project # team-owned",
  "---",
  "",
  "The body.",
  "",
].join("\n");

describe("spliceFrontmatter", () => {
  test("replaces only the named key's line; comments, dates, flow lists and block scalars stay byte for byte", () => {
    const out = spliceFrontmatter(FILE, { scope: "global" });
    expect(out).toBe(FILE.replace("scope: project # team-owned", "scope: global"));
  });

  test("adds a missing key before the closing delimiter", () => {
    const out = spliceFrontmatter(FILE, { owner_user: "alice" });
    expect(out).toBe(FILE.replace("scope: project # team-owned\n---", "scope: project # team-owned\nowner_user: alice\n---"));
  });

  test("removes a key, with its continuation lines, for null or undefined", () => {
    const out = spliceFrontmatter(FILE, { related: null, summary: undefined });
    expect(out).toBe(FILE.replace("related:\n  - proj/other\n  - proj/third\n", "").replace("summary: >\n  folded text\n  over two lines\n", ""));
  });

  test("a multi-line value becomes the one new line", () => {
    const out = spliceFrontmatter(FILE, { related: ["proj/x", "global/y"] });
    expect(out).toContain('related: ["proj/x", "global/y"]\nsummary: >');
    expect(out).not.toContain("proj/other");
    expect(matter(out).data.related).toEqual(["proj/x", "global/y"]);
  });

  test("a block sequence written at the key's own indent is replaced too", () => {
    const raw = "---\nrelated:\n- a\n- b\ntitle: T\n---\nbody\n";
    expect(spliceFrontmatter(raw, { related: null })).toBe("---\ntitle: T\n---\nbody\n");
  });

  test("quotes a value YAML would read as something else, and reads every value back", () => {
    const patch = {
      a: "plain words",
      b: "2026-10-05T00:00:00.000Z",
      c: "yes",
      d: "has: colon",
      e: "has # hash",
      f: "123",
      g: "line\nbreak",
      h: 0.25,
      i: false,
      j: "",
      k: "[REDACTED] value",
    };
    const out = spliceFrontmatter("---\ntitle: T\n---\nbody\n", patch);
    expect(out).toContain("a: plain words\n");
    expect(out).toContain("h: 0.25\n");
    const data = matter(out).data;
    for (const [key, value] of Object.entries(patch)) expect(data[key]).toEqual(value);
  });

  test("keeps CRLF line breaks", () => {
    const raw = "---\r\ntitle: T\r\nscope: project\r\n---\r\n\r\nbody\r\n";
    expect(spliceFrontmatter(raw, { scope: "user", owner_user: "bob" })).toBe(
      "---\r\ntitle: T\r\nscope: user\r\nowner_user: bob\r\n---\r\n\r\nbody\r\n"
    );
  });

  test("a file with no front matter gains one only when something is set", () => {
    expect(spliceFrontmatter("just a body\n", { scope: null })).toBe("just a body\n");
    const out = spliceFrontmatter("just a body\n", { scope: "global" });
    expect(out).toBe("---\nscope: global\n---\njust a body\n");
    expect(matter(out).content).toBe("just a body\n");
  });

  test("a duplicate key is collapsed to the one patched line; a quoted key is matched", () => {
    expect(spliceFrontmatter("---\nscope: a\nscope: b\n---\nx", { scope: "c" })).toBe("---\nscope: c\n---\nx");
    expect(spliceFrontmatter("---\n\"scope\": a\n---\nx", { scope: "c" })).toBe("---\nscope: c\n---\nx");
  });

  test("an empty patch, or a front matter closed at end of file, keeps the bytes", () => {
    expect(spliceFrontmatter(FILE, {})).toBe(FILE);
    expect(spliceFrontmatter("---\ntitle: T\n---", { scope: "global" })).toBe("---\ntitle: T\nscope: global\n---");
  });

  test("refuses a key it cannot write as a plain top-level key", () => {
    expect(() => spliceFrontmatter(FILE, { "a: b": "x" })).toThrow();
  });
});

describe("spliceBody / frontmatterBody", () => {
  test("replaces only the body, as gray-matter splits it", () => {
    expect(frontmatterBody(FILE)).toBe(matter(FILE).content);
    const out = spliceBody(FILE, "\nNew body.\n");
    expect(out).toBe(FILE.replace("\nThe body.\n", "\nNew body.\n"));
    expect(spliceBody("---\ntitle: T\n---", "b")).toBe("---\ntitle: T\n---\nb");
  });

  test("a file with no front matter is all body", () => {
    expect(frontmatterBody("plain\n")).toBe("plain\n");
    expect(spliceBody("plain\n", "other\n")).toBe("other\n");
  });
});

describe("byte-order mark", () => {
  const BOM = "\uFEFF";

  test("a BOM before the opening delimiter is kept and the front matter is still patched in place", () => {
    const out = spliceFrontmatter(BOM + FILE, { scope: "global" });
    expect(out).toBe(BOM + FILE.replace("scope: project # team-owned", "scope: global"));
    expect(matter(out.slice(1)).data.scope).toBe("global");
  });

  test("the body of a BOM-led file is the text after its front matter", () => {
    expect(frontmatterBody(BOM + FILE)).toBe("\nThe body.\n");
    expect(spliceBody(BOM + FILE, "New.\n")).toBe(BOM + FILE.replace("\nThe body.\n", "New.\n"));
  });

  test("a BOM-led file with no front matter gains one after the BOM", () => {
    expect(spliceFrontmatter(`${BOM}Just text.\n`, { scope: "user" })).toBe(`${BOM}---\nscope: user\n---\nJust text.\n`);
    expect(spliceBody(`${BOM}Just text.\n`, "Other.\n")).toBe(`${BOM}Other.\n`);
  });
});
