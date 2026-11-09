import { expect, test, describe } from "bun:test";
import { validateCleanliness } from "./cleanliness.js";

/**
 * validateCleanliness is a pure scanner over a block of text. It reports
 * non-inclusive language (the hard user rules, with mandated replacements),
 * curated AI-tell / filler phrasing, and run-on sentences — every finding
 * carrying the exact match and its char offset, and the whole list sorted by
 * offset.
 */
describe("validateCleanliness", () => {
  test("returns an empty array for empty input", () => {
    expect(validateCleanliness("")).toEqual([]);
  });

  describe("inclusive-language", () => {
    const cases = [
      { text: "the master node", term: "master", suggestion: "primary/main/leader/controller" },
      { text: "the slave node", term: "slave", suggestion: "replica/secondary/follower/responder" },
      { text: "add to whitelist", term: "whitelist", suggestion: "allowlist/approved list/inclusion list" },
      { text: "on the blacklist", term: "blacklist", suggestion: "denylist/blocklist/exclusion list" },
      { text: "during whiteday windows", term: "whiteday", suggestion: "clear day(s)/allowed day(s)" },
      { text: "during blackday windows", term: "blackday", suggestion: "blocked day(s)" },
    ];

    for (const c of cases) {
      test(`flags "${c.term}" with its mandated replacement`, () => {
        const findings = validateCleanliness(c.text).filter(
          (f) => f.category === "inclusive-language"
        );
        expect(findings).toHaveLength(1);
        expect(findings[0].match.toLowerCase()).toBe(c.term);
        expect(findings[0].severity).toBe("high");
        expect(findings[0].suggestion).toBe(c.suggestion);
        expect(findings[0].message).toContain(c.suggestion);
      });
    }

    test("matches case-insensitively and preserves the original casing", () => {
      const findings = validateCleanliness("The MASTER branch").filter(
        (f) => f.category === "inclusive-language"
      );
      expect(findings).toHaveLength(1);
      expect(findings[0].match).toBe("MASTER");
    });

    test("matches the stem with a grammatical suffix", () => {
      const findings = validateCleanliness(
        "master's whitelisted blacklisting"
      ).filter((f) => f.category === "inclusive-language");
      expect(findings.map((f) => f.match)).toEqual([
        "master's",
        "whitelisted",
        "blacklisting",
      ]);
    });

    test("does not fire on words that merely share a prefix", () => {
      expect(validateCleanliness("masterful blacksmith")).toEqual([]);
    });

    test("reports every occurrence with its char offset", () => {
      const findings = validateCleanliness("master and master").filter(
        (f) => f.category === "inclusive-language"
      );
      expect(findings).toHaveLength(2);
      expect(findings.map((f) => f.index)).toEqual([0, 11]);
      expect(findings.every((f) => f.match === "master")).toBe(true);
    });

    test("counts an inflected term exactly once", () => {
      const findings = validateCleanliness("masters").filter(
        (f) => f.category === "inclusive-language"
      );
      expect(findings).toHaveLength(1);
      expect(findings[0].match).toBe("masters");
    });

    test("matches the e-dropping inflections of slave", () => {
      const matches = validateCleanliness("slaved slaving slaves slave's")
        .filter((f) => f.category === "inclusive-language")
        .map((f) => f.match);
      expect(matches).toEqual(["slaved", "slaving", "slaves", "slave's"]);
    });

    test("does not fire when the stem is glued to another word char", () => {
      const findings = validateCleanliness(
        "postmaster grandmaster enslaved"
      ).filter((f) => f.category === "inclusive-language");
      expect(findings).toHaveLength(0);
    });

    test("matches a curly-apostrophe possessive (U+2019)", () => {
      const findings = validateCleanliness("the master’s branch").filter(
        (f) => f.category === "inclusive-language"
      );
      expect(findings).toHaveLength(1);
      expect(findings[0].match).toBe("master’s");
    });
  });

  describe("ai-tell", () => {
    test("flags curated filler phrases", () => {
      const findings = validateCleanliness(
        "As an AI, I cannot delve into it."
      ).filter((f) => f.category === "ai-tell");
      const matches = findings.map((f) => f.match.toLowerCase());
      expect(matches).toContain("as an ai");
      expect(matches).toContain("i cannot");
      expect(matches).toContain("delve into");
      for (const f of findings) expect(f.severity).toBe("low");
    });

    test("matches a phrase that ends in a comma", () => {
      const findings = validateCleanliness("Furthermore, we shipped it.").filter(
        (f) => f.category === "ai-tell"
      );
      expect(findings.map((f) => f.match)).toContain("Furthermore,");
    });

    test("does not fire inside a larger word", () => {
      const findings = validateCleanliness("It has an aid station.").filter(
        (f) => f.category === "ai-tell"
      );
      expect(findings).toHaveLength(0);
    });

    test("matches a curly-apostrophe filler phrase (U+2019)", () => {
      const findings = validateCleanliness(
        "It’s worth noting that we shipped."
      ).filter((f) => f.category === "ai-tell");
      expect(findings.map((f) => f.match.toLowerCase())).toContain(
        "it’s worth noting that"
      );
    });
  });

  describe("long-sentence", () => {
    test("flags a sentence longer than 40 words", () => {
      const longSentence = `${Array(45).fill("word").join(" ")}.`;
      const findings = validateCleanliness(longSentence).filter(
        (f) => f.category === "long-sentence"
      );
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe("low");
      expect(findings[0].message).toContain("45 words");
      expect(findings[0].index).toBe(0);
    });

    test("does not flag a sentence at or below 40 words", () => {
      const at40 = `${Array(40).fill("word").join(" ")}.`;
      const short = "This is a short sentence.";
      expect(
        validateCleanliness(at40).filter((f) => f.category === "long-sentence")
      ).toHaveLength(0);
      expect(
        validateCleanliness(short).filter((f) => f.category === "long-sentence")
      ).toHaveLength(0);
    });

    test("does not split on a decimal number", () => {
      const sentence = `The value 3.14 recurs ${Array(45)
        .fill("more")
        .join(" ")} times.`;
      const findings = validateCleanliness(sentence).filter(
        (f) => f.category === "long-sentence"
      );
      expect(findings).toHaveLength(1);
    });

    test("reports a non-initial long sentence at its true offset", () => {
      const text = `Short first. ${Array(45).fill("word").join(" ")}.`;
      const findings = validateCleanliness(text).filter(
        (f) => f.category === "long-sentence"
      );
      expect(findings).toHaveLength(1);
      expect(findings[0].index).toBe(13);
      expect(text.slice(findings[0].index, findings[0].index + 4)).toBe("word");
    });
  });

  test("returns all findings sorted by index", () => {
    const findings = validateCleanliness(
      "Please whitelist this. In conclusion, we are done."
    );
    expect(findings.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < findings.length; i++) {
      expect(findings[i].index).toBeGreaterThanOrEqual(findings[i - 1].index);
    }
    expect(findings[0].match.toLowerCase()).toBe("whitelist");
    expect(findings[0].index).toBe(7);
  });

  test("carries no suggestion on ai-tell or long-sentence findings", () => {
    const aiTell = validateCleanliness("In conclusion, we win.").find(
      (f) => f.category === "ai-tell"
    );
    expect(aiTell?.suggestion).toBeUndefined();

    const longSentence = validateCleanliness(
      `${Array(45).fill("word").join(" ")}.`
    ).find((f) => f.category === "long-sentence");
    expect(longSentence?.suggestion).toBeUndefined();
  });

  test("orders findings deterministically when they share an offset", () => {
    const findings = validateCleanliness(
      `${Array(45).fill("master").join(" ")}.`
    );
    const atZero = findings.filter((f) => f.index === 0);
    expect(atZero.map((f) => f.category)).toEqual([
      "inclusive-language",
      "long-sentence",
    ]);
  });

  describe("performance (linear-time guard)", () => {
    test("a long run of terminators completes quickly", () => {
      const input = ".".repeat(50000) + "x";
      const start = performance.now();
      validateCleanliness(input);
      expect(performance.now() - start).toBeLessThan(500);
    });

    test("large normal prose completes quickly", () => {
      const input = "The quick brown fox jumps over the lazy dog. ".repeat(5000);
      const start = performance.now();
      validateCleanliness(input);
      expect(performance.now() - start).toBeLessThan(500);
    });
  });
});
