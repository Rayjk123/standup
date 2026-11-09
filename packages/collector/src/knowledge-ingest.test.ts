import { expect, test, describe } from "bun:test";
import {
  htmlToText,
  extractHtmlTitle,
  slugify,
  deriveIngestSlug,
  buildIngestBody,
  isIngestableUrl,
  normalizeIngestSourceKind,
  MAX_INGEST_BODY_CHARS,
} from "./knowledge-ingest.js";
import { isValidSlug } from "@standup/knowledge";

describe("htmlToText", () => {
  test("drops script/style/head and keeps prose across block boundaries", () => {
    const html = `<!DOCTYPE html><html><head><title>x</title><style>.a{color:red}</style></head>
      <body><script>evil()</script><h1>Guest Checkout</h1><p>First para.</p><p>Second para.</p></body></html>`;
    const text = htmlToText(html);
    expect(text).not.toMatch(/evil\(\)/);
    expect(text).not.toMatch(/color:red/);
    expect(text).toContain("Guest Checkout");
    expect(text).toContain("First para.");
    expect(text).toContain("Second para.");
    // Block boundaries become newlines, not a single run-on line.
    expect(text).toMatch(/First para\.\s*\n\s*Second para\./);
  });

  test("decodes entities and collapses whitespace", () => {
    expect(htmlToText("<p>a &amp; b &lt;c&gt; &#39;q&#39;</p>")).toBe("a & b <c> 'q'");
    expect(htmlToText("<p>lots   of\t\tspace</p>")).toBe("lots of space");
  });

  test("turns <br> into newlines", () => {
    expect(htmlToText("one<br>two<br/>three")).toBe("one\ntwo\nthree");
  });
});

describe("extractHtmlTitle", () => {
  test("prefers <title>, decoding entities", () => {
    expect(extractHtmlTitle("<html><head><title>Spec &amp; Notes</title></head></html>")).toBe(
      "Spec & Notes"
    );
  });
  test("falls back to first <h1>", () => {
    expect(extractHtmlTitle("<body><h1>The Heading</h1></body>")).toBe("The Heading");
  });
  test("undefined when neither present", () => {
    expect(extractHtmlTitle("<body><p>no title</p></body>")).toBeUndefined();
  });
});

describe("slugify", () => {
  test("produces a valid slug from arbitrary text", () => {
    const s = slugify("Guest Checkout — Spec (v2)!");
    expect(s).toBe("guest-checkout-spec-v2");
    expect(isValidSlug(s)).toBe(true);
  });
  test("caps length at 64 and stays valid", () => {
    const s = slugify("a".repeat(200));
    expect(s.length).toBeLessThanOrEqual(64);
    expect(isValidSlug(s)).toBe(true);
  });
  test("returns empty when nothing usable", () => {
    expect(slugify("!!! ---")).toBe("");
    expect(slugify("")).toBe("");
  });
});

describe("deriveIngestSlug", () => {
  test("explicit slug wins", () => {
    expect(deriveIngestSlug("https://x.test/a/b", { explicitSlug: "My Slug", title: "T" })).toBe(
      "my-slug"
    );
  });
  test("falls back to title, then URL path segment, then hostname", () => {
    expect(deriveIngestSlug("https://x.test/a/b", { title: "Great Doc" })).toBe("great-doc");
    expect(deriveIngestSlug("https://x.test/docs/guest-checkout")).toBe("guest-checkout");
    expect(deriveIngestSlug("https://wiki.example.test/")).toBe("wiki-example-test");
  });
  test("skips unusable trailing segments", () => {
    // last segment "!!!" is unusable → uses the previous meaningful one.
    expect(deriveIngestSlug("https://x.test/real-doc/%21%21%21")).toBe("real-doc");
  });
});

describe("buildIngestBody", () => {
  test("prefixes a source-provenance line", () => {
    const body = buildIngestBody("hello world", "https://x.test/doc", "2026-01-01T00:00:00.000Z");
    expect(body).toContain("> Ingested from https://x.test/doc on 2026-01-01T00:00:00.000Z");
    expect(body).toContain("hello world");
  });
  test("truncates an oversized body with a visible marker", () => {
    const body = buildIngestBody("x".repeat(MAX_INGEST_BODY_CHARS + 500), "https://x.test", "t");
    expect(body).toContain("_[truncated at ingest]_");
    expect(body.length).toBeLessThan(MAX_INGEST_BODY_CHARS + 300);
  });
  test("no truncation marker when within budget", () => {
    expect(buildIngestBody("short", "https://x.test", "t")).not.toContain("truncated");
  });
});

describe("isIngestableUrl", () => {
  test("accepts http(s), rejects other schemes and garbage", () => {
    expect(isIngestableUrl("https://x.test/a")).toBe(true);
    expect(isIngestableUrl("http://x.test")).toBe(true);
    expect(isIngestableUrl("file:///etc/passwd")).toBe(false);
    expect(isIngestableUrl("ftp://x.test")).toBe(false);
    expect(isIngestableUrl("not a url")).toBe(false);
  });
});

describe("normalizeIngestSourceKind", () => {
  test("defaults to product, honors spec, rejects code/garbage down to product", () => {
    expect(normalizeIngestSourceKind(undefined)).toBe("product");
    expect(normalizeIngestSourceKind("spec")).toBe("spec");
    expect(normalizeIngestSourceKind("product")).toBe("product");
    // code/decision/runbook are not ingest kinds — fold to product.
    expect(normalizeIngestSourceKind("code")).toBe("product");
    expect(normalizeIngestSourceKind("garbage")).toBe("product");
  });
});
