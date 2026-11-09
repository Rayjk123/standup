import { describe, expect, test } from "bun:test";
import { docContentCutOff, docFolderPaths, joinFrontmatter, splitFrontmatter } from "./docs.js";

describe("docContentCutOff", () => {
  test("passes a body whose last line with text matches, and names a missing or different one", () => {
    const cases: Array<[unknown, unknown, "ok" | "required" | "cut" | "content"]> = [
      ["# Title\nbody\nlast line", "last line", "ok"],
      ["# Title\nlast line\n\n  \n", "last line", "ok"],
      ["a\r\nlast line\r\n", "  last line ", "ok"],
      ["", "", "ok"],
      ["\n\n", "", "ok"],
      ["one line", "one line", "ok"],
      ["# Title\nbody\nlast li", "last line", "cut"],
      ["# Title\nbody", "last line", "cut"],
      ["", "last line", "cut"],
      ["last line\nmore", "last line", "cut"],
      ["# Title", undefined, "required"],
      ["# Title", 3, "required"],
      [42, "42", "content"],
    ];
    for (const [content, lastLine, want] of cases) {
      const why = docContentCutOff({ path: "a.md", content, last_line: lastLine }, "last_line");
      const got =
        why === null
          ? "ok"
          : why.startsWith("last_line is required")
            ? "required"
            : why.includes("does not end with last_line")
              ? "cut"
              : why === "content must be a string"
                ? "content"
                : why;
      expect([content, lastLine, got]).toEqual([content, lastLine, want]);
    }
  });

  test("refuses last_line anywhere but last, since a cut drops every argument after it", () => {
    const cases: Array<[Record<string, unknown>, boolean]> = [
      [{ path: "a.md", content: "x", if_revision: 2, last_line: "x" }, true],
      [{ last_line: "x", path: "a.md", content: "x" }, false],
      [{ path: "a.md", content: "x", last_line: "x", if_revision: 2 }, false],
      [{ path: "a.md", last_line: "```", content: "```\na\n```\n" }, false],
    ];
    for (const [args, ok] of cases) {
      const why = docContentCutOff(args, "last_line");
      expect([Object.keys(args), why === null || why]).toEqual([Object.keys(args), ok || expect.stringContaining("must be the last argument")]);
    }
  });
});

describe("docFolderPaths", () => {
  test("each folder's names from the root; a missing parent or a loop ends the path where it breaks", () => {
    const paths = docFolderPaths([
      { id: "c", parentId: "b", name: "c" },
      { id: "a", parentId: null, name: "a" },
      { id: "b", parentId: "a", name: "b" },
      { id: "orphan", parentId: "gone", name: "orphan" },
      { id: "x", parentId: "y", name: "x" },
      { id: "y", parentId: "x", name: "y" },
    ]);
    expect(paths.get("c")).toEqual(["a", "b", "c"]);
    expect(paths.get("a")).toEqual(["a"]);
    expect(paths.get("orphan")).toEqual(["orphan"]);
    expect(paths.get("x")).toEqual(["y", "x"]);
    expect(paths.get("gone")).toBeUndefined();
  });
});

describe("splitFrontmatter", () => {
  test("splits a YAML block off the front, and joinFrontmatter puts it back", () => {
    const body = "---\ntitle: Limits\ntags:\n  - authz\n- loose\n---\n# Limits\n";
    const { frontmatter, content } = splitFrontmatter(body);
    expect(frontmatter).toBe("---\ntitle: Limits\ntags:\n  - authz\n- loose\n---\n");
    expect(content).toBe("# Limits\n");
    expect(joinFrontmatter(frontmatter, content)).toBe(body);
  });

  test("a block that closes at the very end of the body is still frontmatter", () => {
    expect(splitFrontmatter("---\ntitle: x\n---")).toEqual({ frontmatter: "---\ntitle: x\n---", content: "" });
    expect(joinFrontmatter("---\ntitle: x\n---", "Hello\n")).toBe("---\ntitle: x\n---\nHello\n");
  });

  test("a leading pair of thematic breaks around prose is content, not frontmatter", () => {
    for (const body of ["---\nJust a sentence between rules.\n---\nMore.\n", "---\n\n---\nAfter two rules.\n", "---\ntitle: x\nand then prose\n---\n"]) {
      expect(splitFrontmatter(body)).toEqual({ frontmatter: "", content: body });
    }
  });

  test("a body with no leading fence is all content", () => {
    expect(splitFrontmatter("# Title\n\n---\nkey: value\n---\n")).toEqual({ frontmatter: "", content: "# Title\n\n---\nkey: value\n---\n" });
  });
});
