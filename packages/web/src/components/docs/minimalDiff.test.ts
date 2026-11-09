import { describe, expect, test } from "bun:test";
import { lineDiff } from "@standup/shared";
import { MINIMAL_DIFF_MAX_CELLS, MINIMAL_DIFF_MAX_CHARS, minimalBody, minimalMarkdown, prepareMinimalDiff } from "./minimalDiff";

/** Lines added or removed between two texts. */
const changedLines = (a: string, b: string) => lineDiff(a, b).filter((l) => l.type !== "same").length;

// As stored: an unpadded table, bare underscores, a list straight after its paragraph.
const STORED = [
  "# Limits",
  "",
  "|Option|p99|",
  "|---|---|",
  "|API_KEY|19 ms|",
  "",
  "The check runs as API_KEY first.",
  "Then:",
  "- one",
  "- two",
  "",
  "Last paragraph.",
  "",
].join("\n");

// The same document the way the editor serializes it: padded table, escaped underscores, a blank line before the list.
const SERIALIZED = [
  "# Limits",
  "",
  "| Option   | p99   |",
  "| -------- | ----- |",
  "| API\\_KEY | 19 ms |",
  "",
  "The check runs as API\\_KEY first.",
  "Then:",
  "",
  "- one",
  "- two",
  "",
  "Last paragraph.",
  "",
].join("\n");

describe("minimalMarkdown", () => {
  test("a document nobody changed is written back byte for byte", () => {
    expect(minimalMarkdown(STORED, SERIALIZED)).toBe(STORED);
  });

  test("an edit to one paragraph rewrites only that paragraph", () => {
    const edited = SERIALIZED.replace("Last paragraph.", "Last paragraph, edited.");
    const out = minimalMarkdown(STORED, edited);
    expect(out).toBe(STORED.replace("Last paragraph.", "Last paragraph, edited."));
    expect(changedLines(STORED, out)).toBe(2);
    expect(changedLines(STORED, edited)).toBeGreaterThan(6);
  });

  test("an edit inside a table rewrites only that table", () => {
    const edited = SERIALIZED.replace("| API\\_KEY | 19 ms |", "| API\\_KEY | 18 ms |");
    const out = minimalMarkdown(STORED, edited);
    expect(out).toBe(
      ["# Limits", "", "| Option   | p99   |", "| -------- | ----- |", "| API\\_KEY | 18 ms |", "", "The check runs as API_KEY first.", "Then:", "- one", "- two", "", "Last paragraph.", ""].join("\n")
    );
  });

  test("an inserted block is written as the editor wrote it, between the stored ones", () => {
    const edited = SERIALIZED.replace("Last paragraph.", "A new paragraph.\n\nLast paragraph.");
    expect(minimalMarkdown(STORED, edited)).toBe(STORED.replace("Last paragraph.", "A new paragraph.\n\nLast paragraph."));
  });

  test("a deleted block goes, and the rest stays as stored", () => {
    const edited = SERIALIZED.replace("The check runs as API\\_KEY first.\nThen:\n\n- one\n- two\n\n", "");
    expect(minimalMarkdown(STORED, edited)).toBe(["# Limits", "", "|Option|p99|", "|---|---|", "|API_KEY|19 ms|", "", "Last paragraph.", ""].join("\n"));
  });

  test("an edit at the first or last block keeps the stored text around it", () => {
    const first = minimalMarkdown(STORED, SERIALIZED.replace("# Limits", "# Rate limits"));
    expect(first).toBe(STORED.replace("# Limits", "# Rate limits"));
    const appended = minimalMarkdown(STORED, `${SERIALIZED}\nAn appended line.\n`);
    expect(appended).toBe(`${STORED}\nAn appended line.\n`);
  });

  test("where a stored gap would change the meaning next to an edit, the editor's gap is used", () => {
    // Stored: a list straight after its paragraph. A paragraph inserted between them can't take that single newline.
    const out = minimalMarkdown("Para one\n- item\n", "Para one\n\nInserted\n\n- item\n");
    expect(out).toBe("Para one\n\nInserted\n\n- item\n");
  });

  test("the result always means what the editor's serialization means", () => {
    // Everything changed: nothing to keep, so the serialization stands.
    expect(minimalMarkdown("Old text.\n", "- a\n- b\n")).toBe("- a\n- b\n");
    expect(minimalMarkdown("", "New.\n")).toBe("New.\n");
    expect(minimalMarkdown("Gone.\n", "")).toBe("");
  });
});

describe("minimalMarkdown on large documents", () => {
  test("a 20,000-block doc with one block edited saves quickly and stays minimal", () => {
    const blocks = Array.from({ length: 20_000 }, (_, i) => `P_${i}`);
    const stored = `${blocks.join("\n\n")}\n`;
    // The editor's serialization as loaded, then after an edit to one block.
    const loaded = `${blocks.map((b) => b.replace("_", "\\_")).join("\n\n")}\n`;
    const edited = loaded.replace("P\\_10000\n", "P\\_10000 edited\n");
    // As the doc pane does once the doc loads, ahead of any save.
    prepareMinimalDiff(stored, loaded);
    const began = performance.now();
    const out = minimalMarkdown(stored, edited, loaded);
    const took = performance.now() - began;
    expect(out).toBe(stored.replace("P_10000\n", "P\\_10000 edited\n"));
    // Line for line, only the edited block's line differs.
    const before = stored.split("\n");
    const after = out.split("\n");
    expect(after).toHaveLength(before.length);
    expect(after.filter((line, i) => line !== before[i])).toEqual(["P\\_10000 edited"]);
    expect(took).toBeLessThan(1000);

    // The next edit builds on this save: the saved text and serialization are known, so it is as quick.
    const again = edited.replace("P\\_19000\n", "P\\_19000 edited\n");
    const began2 = performance.now();
    const out2 = minimalMarkdown(out, again, edited);
    expect(performance.now() - began2).toBeLessThan(1000);
    expect(out2).toBe(out.replace("P_19000\n", "P\\_19000 edited\n"));
  });

  test("without the previous serialization the same edit is still minimal", () => {
    const blocks = Array.from({ length: 2000 }, (_, i) => `Q_${i}`);
    const stored = `${blocks.join("\n\n")}\n`;
    const edited = `${blocks.map((b, i) => (i === 1000 ? "Q\\_1000 edited" : b.replace("_", "\\_"))).join("\n\n")}\n`;
    expect(minimalMarkdown(stored, edited)).toBe(stored.replace("Q_1000\n", "Q\\_1000 edited\n"));
  });

  test("a previous serialization that doesn't match the stored text is not trusted", () => {
    const stored = "One_a\n\nTwo_b\n\nThree_c\n";
    // Claims to be the serialization of something else.
    const wrong = "Other\n\nTwo\\_b\n\nThree\\_c\n";
    const edited = "One\\_a\n\nTwo\\_b edited\n\nThree\\_c\n";
    expect(minimalMarkdown(stored, edited, wrong)).toBe("One_a\n\nTwo\\_b edited\n\nThree_c\n");
  });

  test("an edit that joins two lists in a large doc saves them as the one list the editor has", () => {
    // Large enough to be checked around the change rather than whole.
    const filler = Array.from({ length: 9000 }, (_, i) => `F_${i}`);
    const stored = `${["- a", "Para_x", "- b", ...filler].join("\n\n")}\n`;
    const loaded = `${["- a", "Para\\_x", "- b", ...filler.map((f) => f.replace("_", "\\_"))].join("\n\n")}\n`;
    prepareMinimalDiff(stored, loaded);
    // Deleting the paragraph makes the two lists one (loose) list.
    const edited = loaded.replace("Para\\_x\n\n", "");
    const out = minimalMarkdown(stored, edited, loaded);
    expect(stored.length).toBeGreaterThan(64 * 1024);
    expect(out.startsWith("- a\n\n- b\n\nF_0\n\nF_1")).toBe(true);
  });

  test("a changed middle too large to align is written as the editor wrote it, the shared ends as stored", () => {
    // Every block differs from the stored one between an unchanged first and last block.
    const n = 2100;
    const stored = ["# Head", ...Array.from({ length: n }, (_, i) => `old_${i}`), "Tail_end"].join("\n\n") + "\n";
    const middle = Array.from({ length: n }, (_, i) => `new\\_${i}`);
    const edited = ["# Head", ...middle, "Tail\\_end"].join("\n\n") + "\n";
    expect((n + 1) * (n + 1)).toBeGreaterThan(MINIMAL_DIFF_MAX_CELLS);
    expect(minimalMarkdown(stored, edited)).toBe(["# Head", ...middle, "Tail_end"].join("\n\n") + "\n");
  });

  test("a body over the size limit is saved as the editor wrote it", () => {
    const stored = `${"a_b ".repeat(MINIMAL_DIFF_MAX_CHARS / 4)}\n\nTail.\n`;
    const edited = `${"a\\_b ".repeat(MINIMAL_DIFF_MAX_CHARS / 4)}\n\nTail, edited.\n`;
    expect(minimalMarkdown(stored, edited)).toBe(edited);
  });
});

describe("minimalBody", () => {
  test("puts the frontmatter back and keeps the stored blocks", () => {
    const stored = "---\ntitle: Limits\n---\n# T\n\nA_b stays.\n";
    expect(minimalBody(stored, "---\ntitle: Limits\n---\n", "# T\n\nA\\_b stays.\n\nNew.\n")).toBe("---\ntitle: Limits\n---\n# T\n\nA_b stays.\n\nNew.\n");
  });

  test("a body that was only frontmatter gets its first content on a new line", () => {
    expect(minimalBody("---\ntitle: x\n---", "---\ntitle: x\n---", "Hello\n")).toBe("---\ntitle: x\n---\nHello\n");
  });
});
