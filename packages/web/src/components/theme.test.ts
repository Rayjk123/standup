import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "fs";
import { join } from "path";
import { alpha, categoricalColors, hexAlpha, palettes, theme, themeTokensCss, tokenVar, type Palette, type ThemeToken } from "./theme";

/** WCAG 2.x relative luminance of a `#rrggbb` color. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** `fg` laid over `bg` at `a` opacity, as `#rrggbb`. */
function blend(fg: string, bg: string, a: number): string {
  const ch = (h: string, i: number) => parseInt(h.slice(i, i + 2), 16);
  return `#${[1, 3, 5].map((i) => Math.round(ch(fg, i) * a + ch(bg, i) * (1 - a)).toString(16).padStart(2, "0")).join("")}`;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const GROUNDS: ThemeToken[] = ["ground", "hover", "surface", "raised"];
const STATUS_TEXT: ThemeToken[] = ["running", "checkpoint", "stalled", "waiting", "done", "expert", "accent"];

function minContrast(p: Palette, fg: ThemeToken): number {
  return Math.min(...GROUNDS.map((bg) => contrast(p[fg], p[bg])));
}

describe("palettes", () => {
  test("the dark palette holds the console's dark colors", () => {
    expect(palettes.dark).toMatchObject({
      ground: "#12141a", hover: "#181b22", surface: "#1a1d25", raised: "#262a35",
      edge: "#2f3543", edgeSoft: "#20242f", text: "#e7e9ef", dim: "#8b90a0", faint: "#5b606e",
      running: "#4C9EF5", checkpoint: "#4fd39a", stalled: "#f59e0b", waiting: "#ff5c72",
      idle: "#454f63", done: "#4fd39a", expert: "#a78bfa", accent: "#f59e32", accentSoft: "#f59e3222",
      page: "#101520", pageText: "#E6EAF2",
    });
  });

  test("both palettes define the same tokens", () => {
    expect(Object.keys(palettes.light).sort()).toEqual(Object.keys(palettes.dark).sort());
    expect(categoricalColors.light).toHaveLength(categoricalColors.dark.length);
  });

  test("body text meets WCAG AA (4.5:1) on every ground in both palettes", () => {
    for (const p of [palettes.dark, palettes.light]) {
      for (const fg of ["text", "dim"] as const) expect(minContrast(p, fg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("every light text token, faint, idle and the status colors included, meets AA on every ground", () => {
    for (const fg of ["text", "dim", "faint", "idle", ...STATUS_TEXT] as ThemeToken[]) {
      expect({ fg, ratio: minContrast(palettes.light, fg) >= 4.5 }).toEqual({ fg, ratio: true });
    }
  });

  test("the ground reads on a filled status button in light", () => {
    for (const fill of STATUS_TEXT) expect(contrast(palettes.light.ground, palettes.light[fill])).toBeGreaterThanOrEqual(4.5);
  });

  test("light status text meets AA on its own tinted wash over every ground", () => {
    const p = palettes.light;
    for (const fg of STATUS_TEXT) {
      for (const bg of GROUNDS) {
        for (const byte of [0x14, 0x1f, 0x2e, 0x33]) {
          const ratio = contrast(p[fg], blend(p[fg], p[bg], byte / 255));
          expect({ fg, bg, byte, ok: ratio >= 4.5 }).toEqual({ fg, bg, byte, ok: true });
        }
      }
    }
  });

  test("light code tokens meet AA on the code background", () => {
    const p = palettes.light;
    for (const fg of ["codeText", "codeComment", "codeKeyword", "codeName", "codeFunction", "codeString", "codeNumber", "codeType", "codeOperator"] as ThemeToken[]) {
      expect({ fg, ok: contrast(p[fg], p.codeBg) >= 4.5 }).toEqual({ fg, ok: true });
    }
  });

  test("light categorical hues stay readable on white", () => {
    for (const c of categoricalColors.light) expect({ c, ok: contrast(c, "#ffffff") >= 3 }).toEqual({ c, ok: true });
  });
});

describe("tokens", () => {
  test("theme.X is the token's CSS variable", () => {
    expect(theme.ground).toBe("var(--su-ground)");
    expect(theme.edgeSoft).toBe("var(--su-edge-soft)");
    expect(tokenVar("accentSoft")).toBe("--su-accent-soft");
  });

  test("the token CSS holds both palettes, dark at :root and light under data-theme", () => {
    const css = themeTokensCss();
    expect(css).toContain(`:root,:root[data-theme="dark"]{--su-color-scheme:dark;`);
    expect(css).toContain(`:root[data-theme="light"]{--su-color-scheme:light;`);
    // The page keeps the browser's default color-scheme; only controls that ask follow the palette.
    expect(css).not.toMatch(/(^|[;{])color-scheme:/);
    expect(css).toContain("--su-ground:#12141a;");
    expect(css).toContain(`--su-ground:${palettes.light.ground};`);
  });

  test("alpha tints a variable with color-mix, from a byte or a fraction", () => {
    expect(alpha(theme.waiting, 0x44)).toBe("color-mix(in srgb, var(--su-waiting) 26.7%, transparent)");
    expect(alpha(theme.shadow, 0.35)).toBe("color-mix(in srgb, var(--su-shadow) 35%, transparent)");
  });

  test("no source tints a value with a hex suffix, which breaks on a token's variable", () => {
    // `${theme.running}1F` would be `var(--su-running)1F`: invalid CSS the browser drops.
    const src = join(import.meta.dir, "..");
    const offenders: string[] = [];
    for (const file of new Glob("**/*.{ts,tsx}").scanSync(src)) {
      if (/\.test\.tsx?$/.test(file)) continue;
      const text = readFileSync(join(src, file), "utf8");
      text.split("\n").forEach((line, i) => {
        if (/\$\{[^}]+\}[0-9a-fA-F]{2}\b/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  test("hexAlpha appends an alpha byte to a literal color", () => {
    expect(hexAlpha("#12141a", 0xb0)).toBe("#12141ab0");
    expect(hexAlpha("#12141a", 0.5)).toBe("#12141a80");
  });
});
