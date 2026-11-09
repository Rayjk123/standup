import { describe, expect, test } from "bun:test";
import { IMAGE_REFS_MAX, docImageSources } from "./doc-images.js";

describe("docImageSources", () => {
  const cases: Array<[string, string, string[]]> = [
    ["an inline image", "![alt](img/a.png)", ["img/a.png"]],
    ["a title is not part of the src", '![alt](img/a.png "A title")', ["img/a.png"]],
    ["an angle-bracket src may hold spaces", "![alt](<img/my shot.png>)", ["img/my shot.png"]],
    ["balanced parens in a src", "![alt](img/a(1).png)", ["img/a(1).png"]],
    ["backslash escapes are dropped", "![alt](img/a\\_b.png)", ["img/a_b.png"]],
    ["nested brackets in alt", "![a [b] c](x.png)", ["x.png"]],
    ["a full reference", "![alt][logo]\n\n[logo]: img/logo.png \"t\"", ["img/logo.png"]],
    ["a collapsed reference", "![Logo][]\n\n[logo]: <img/logo.png>", ["img/logo.png"]],
    ["a shortcut reference", "![logo]\n\n[logo]: img/logo.png", ["img/logo.png"]],
    ["a definition's destination may be on the next line", "![logo]\n\n[logo]:\n  img/logo.png", ["img/logo.png"]],
    ["a definition only a link uses is not an image", "[see][logo]\n\n[logo]: img/logo.png", []],
    ["a link is not an image", "[a](img/a.png)", []],
    ["an escaped bang is a link", "\\![a](img/a.png)", []],
    ["raw HTML is not rendered, so its img is not a source", '<img alt="x" src="img/a.png"> <IMG src=b.png>', []],
    ["fenced code is ignored", "```md\n![a](a.png)\n```\n~~~\n![b](b.png)\n~~~\n![c](c.png)", ["c.png"]],
    ["inline code is ignored", "`![a](a.png)` and ``![b](b.png)`` but ![c](c.png)", ["c.png"]],
    ["a code span closes only on a run of the same length", "``x ` ![a](a.png) ``  ![b](b.png)", ["b.png"]],
    ["an unmatched backtick run is text", "`` ![a](a.png)", ["a.png"]],
    ["an escaped backtick opens no span", "\\`![a](a.png)`", ["a.png"]],
    ["each src once, in order", "![a](b.png) ![a](a.png) ![b](b.png)", ["b.png", "a.png"]],
    ["an unclosed fence hides the rest", "```\n![a](a.png)", []],
    ["a bracket doesn't close across a blank line", "![a\n\nb](a.png)", []],
    ["absolute and data URLs are reported as written", "![a](https://x/y.png) ![b](data:image/png;base64,AA)", ["https://x/y.png", "data:image/png;base64,AA"]],
  ];
  for (const [name, body, want] of cases) {
    test(name, () => expect(docImageSources(body)).toEqual(want));
  }

  test(`at most ${IMAGE_REFS_MAX} image references are read`, () => {
    const body = Array.from({ length: IMAGE_REFS_MAX + 5 }, (_, i) => `![](i${i}.png)`).join(" ");
    const found = docImageSources(body);
    expect(found).toHaveLength(IMAGE_REFS_MAX);
    expect(found[0]).toBe("i0.png");
  });

  // Hostile bodies of about a megabyte each: every one must be read in time
  // linear in its length, not quadratic.
  const hostile: Array<[string, string]> = [
    ["many unclosed image openers", "![".repeat(500_000)],
    ["many images with unclosed destinations", "![a](".repeat(200_000)],
    ["many brackets that never close", "[".repeat(1_000_000)],
    ["nested brackets", "![".repeat(250_000) + "]".repeat(250_000)],
    ["many backtick runs of different lengths", Array.from({ length: 1400 }, (_, i) => "`".repeat(i + 1)).join(" ")],
    ["a long unclosed angle destination", "![a](<" + "x".repeat(1_000_000)],
    ["a long unclosed definition label", "[" + "a".repeat(1_000_000)],
    ["many definition-like lines", "[a]: \n".repeat(200_000)],
    ["many images and parens", "![a](((((".repeat(100_000)],
  ];
  for (const [name, body] of hostile) {
    test(`a hostile body is read in bounded time: ${name}`, () => {
      const started = performance.now();
      docImageSources(body);
      expect(performance.now() - started).toBeLessThan(500);
    });
  }
});
