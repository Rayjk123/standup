import { describe, expect, test } from "bun:test";
import type { HtmlTagDescriptor, IndexHtmlTransformContext } from "vite";
import { themeHtml } from "./theme-html";
import { THEME_TOKENS_STYLE_ID, themeTokensCss } from "./src/components/theme";
import { THEME_BOOT_SCRIPT } from "./src/lib/themePreference";

type Handler = (html: string, ctx: IndexHtmlTransformContext) => HtmlTagDescriptor[] | undefined;

const handler = (themeHtml().transformIndexHtml as { handler: Handler }).handler;
const ctx = (filename: string) => ({ filename, path: "/" }) as IndexHtmlTransformContext;

describe("themeHtml", () => {
  test("puts the token CSS and the boot script in the console's <head>, after its <meta charset>", () => {
    const tags = handler("<html></html>", ctx("/repo/packages/web/index.html"))!;
    expect(tags.every((t) => t.injectTo === "head")).toBe(true);
    expect(tags.find((t) => t.tag === "style")).toMatchObject({ attrs: { id: THEME_TOKENS_STYLE_ID }, children: themeTokensCss() });
    expect(tags.find((t) => t.tag === "script")?.children).toBe(THEME_BOOT_SCRIPT);
  });

  test("leaves the mermaid frame page alone", () => {
    expect(handler("<html></html>", ctx("/repo/packages/web/mermaid-frame.html"))).toBeUndefined();
  });
});
