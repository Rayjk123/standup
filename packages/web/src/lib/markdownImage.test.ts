import { expect, test, describe } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownRenderer } from "../components/MarkdownRenderer";
import { markdownImage } from "./markdownImage";

function render(text: string, allowRemoteImages?: boolean): string {
  return renderToStaticMarkup(createElement(MarkdownRenderer, { children: text, allowRemoteImages }));
}

describe("markdownImage", () => {
  test("an http(s) image becomes a link by default, never a fetch", () => {
    expect(markdownImage("https://x.example/?d=secret", "chart")).toEqual({
      kind: "link",
      href: "https://x.example/?d=secret",
      label: "image: chart",
    });
    expect(markdownImage("http://x.example/a.png", "")).toEqual({
      kind: "link",
      href: "http://x.example/a.png",
      label: "image",
    });
  });

  test("a data: URI or other non-http source is text only, even when opted in", () => {
    expect(markdownImage("data:image/png;base64,AAAA", "x")).toEqual({
      kind: "text",
      label: "image: x (data:image/png;base64,AAAA)",
    });
    expect(markdownImage("data:image/png;base64,AAAA", "x", true).kind).toBe("text");
    expect(markdownImage("javascript:alert(1)", undefined, true).kind).toBe("text");
    expect(markdownImage("/local.png", "x", true).kind).toBe("text");
    expect(markdownImage(undefined, undefined)).toEqual({ kind: "text", label: "image" });
  });

  test("the opt-in renders an http(s) image inline", () => {
    expect(markdownImage("https://x.example/a.png", " chart ", true)).toEqual({
      kind: "img",
      src: "https://x.example/a.png",
      alt: "chart",
    });
  });
});

describe("Markdown images", () => {
  test("a remote image renders as a link with no <img> by default", () => {
    const html = render("see ![chart](https://x.example/?d=secret)");
    expect(html).not.toContain("<img");
    expect(html).toContain('href="https://x.example/?d=secret"');
    expect(html).toContain("[image: chart]");
  });

  test("a data: image renders as text with no <img>", () => {
    const html = render("![x](data:image/png;base64,AAAA)");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<a ");
    expect(html).toContain("[image: x");
  });

  test("allowRemoteImages renders the <img>", () => {
    const html = render("![chart](https://x.example/a.png)", true);
    expect(html).toContain('<img src="https://x.example/a.png" alt="chart"');
  });
});
