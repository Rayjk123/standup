import { describe, expect, test } from "bun:test";
import { safeHref } from "./safeHref";

describe("safeHref", () => {
  test("keeps absolute http(s) URLs", () => {
    expect(safeHref("https://git.example.com/acme/app/pull/1")).toBe("https://git.example.com/acme/app/pull/1");
    expect(safeHref("HTTP://localhost:5173/x")).toBe("HTTP://localhost:5173/x");
    expect(safeHref("  https://x.test/  ")).toBe("https://x.test/");
  });

  test("drops every other scheme and non-strings", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref(" javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,<script>1</script>")).toBeNull();
    expect(safeHref("//evil.test/x")).toBeNull();
    expect(safeHref("/relative/path")).toBeNull();
    expect(safeHref("PR-123")).toBeNull();
    expect(safeHref("")).toBeNull();
    expect(safeHref(undefined)).toBeNull();
    expect(safeHref(null)).toBeNull();
  });
});
