import { expect, test, describe } from "bun:test";
import { statusBodyRefusal, statusBodyWarning, statusMarkers, statusTitleRefusal } from "./knowledge-status-guard.js";
import { exampleCorpProfile } from "./org-profile/fixtures/example-corp.js";
import { setActiveOrgProfile } from "./org-profile/load.js";

const NOW = new Date("2026-10-08T12:00:00Z");

describe("statusTitleRefusal", () => {
  test("refuses titles carrying a status marker", () => {
    for (const title of [
      "Retry fix REV-1234567",
      "Retry fix PR #482",
      "Sync client merged 3f9a2c1",
      "Backoff change in review PR #42",
      "Retry loop DEPLOYED",
      "Cache layer live-validated",
      "Cache layer Validated Live",
      "All tests pass at 3f9a2c1",
      "Importer: all tests passing in PR #42",
      "Cache invalidation (2026-10-06)",
      "Cache invalidation (proposed 2026-10-06)",
      "Cache invalidation (updated 2019-04-01)",
      "Cache invalidation (as of 2020-01-15)",
    ]) {
      expect(statusTitleRefusal(title, NOW)).not.toBeNull();
    }
  });

  test("accepts ordinary titles that only resemble a marker", () => {
    for (const title of [
      "ISO-8601 date parsing",
      "deploy order: CMK before IAM",
      "merge strategy",
      "Deployed-stage naming",
      "Merged config precedence",
      "Pull request (PR) etiquette",
      "Dates in 2026-10-06 format are parsed as UTC",
      "Branches merged into main trigger the pipeline",
      "REV-12 numbering",
      "PR #12 numbering",
      "SHA-256 digests merged into one manifest",
      "All tests pass for the importer only with a warm cache",
    ]) {
      expect(statusTitleRefusal(title, NOW)).toBeNull();
    }
  });

  test("accepts an older dated parenthetical with no status word, such as an AWS API version", () => {
    for (const title of [
      "IAM policy language (2012-10-17)",
      "S3 API (2006-03-01) path-style addressing",
      "DynamoDB API version (2012-08-10) quirks",
    ]) {
      expect(statusTitleRefusal(title, NOW)).toBeNull();
    }
  });

  test("a bare date reads as a status stamp for two years", () => {
    expect(statusTitleRefusal("Cache invalidation (2024-11-01)", NOW)).not.toBeNull();
    expect(statusTitleRefusal("Cache invalidation (2024-09-01)", NOW)).toBeNull();
  });

  test("the refusal names the markers, how to fix the title, and that renaming an existing doc is fine", () => {
    const refusal = statusTitleRefusal("Retry fix REV-1234567 (2026-10-06)", NOW)!;
    expect(refusal).toContain('"REV-1234567"');
    expect(refusal).toContain('"(2026-10-06)"');
    expect(refusal).toContain("name the subject instead");
    expect(refusal).toContain("Renaming the title is fine when updating an existing doc");
  });
});

describe("statusMarkers", () => {
  test("merge state counts only beside a SHA or review id", () => {
    expect(statusMarkers("merged 3f9a2c1", NOW)).toEqual(["merged"]);
    expect(statusMarkers("merged in PR #7", NOW)).toEqual(["merged"]);
    expect(statusMarkers("merged into main", NOW)).toEqual([]);
    expect(statusMarkers("merged 1234567", NOW)).toEqual([]);
  });

  test("a review id of any two-to-ten letter key with six or more digits is a marker, alone or beside merge state", () => {
    for (const id of ["AB-1234567", "REV-123456", "X1-9876543"]) {
      expect(statusMarkers(`Retry fix ${id}`, NOW)).toEqual([id]);
      expect(statusMarkers(`Backoff change merged in ${id}`, NOW)).toEqual([id, "merged"]);
    }
  });

  test("the org profile's review id marks merge state at any length; under the default profile a short one doesn't", () => {
    expect(statusMarkers("Backoff change in review R-42", NOW)).toEqual([]);
    setActiveOrgProfile(exampleCorpProfile());
    try {
      expect(statusMarkers("Backoff change in review R-42", NOW)).toEqual(["in review"]);
      expect(statusMarkers("merged in R-7", NOW)).toEqual(["merged"]);
      // The id alone is no marker, and ordinary prose stays clear.
      expect(statusMarkers("R-42 numbering", NOW)).toEqual([]);
      expect(statusMarkers("SHA-256 digests merged into one manifest", NOW)).toEqual([]);
      expect(statusTitleRefusal("Backoff change in review R-42", NOW)).not.toBeNull();
    } finally {
      setActiveOrgProfile();
    }
  });

  test("all tests pass counts only beside a SHA or review id", () => {
    expect(statusMarkers("all tests pass", NOW)).toEqual([]);
    expect(statusMarkers("all tests pass at 3f9a2c1", NOW)).toEqual(["all tests pass"]);
  });

  test("DEPLOYED is case-sensitive", () => {
    expect(statusMarkers("DEPLOYED", NOW)).toEqual(["DEPLOYED"]);
    expect(statusMarkers("Deployed and deployed", NOW)).toEqual([]);
  });

  test("a long line with many open parentheses is scanned quickly", () => {
    const line = `${"(".repeat(50_000)}2026-10-06${"x".repeat(50_000)}`;
    const startedAt = performance.now();
    statusMarkers(line, NOW);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });
});

describe("statusBodyRefusal", () => {
  test("refuses a body with two or more markers, naming them", () => {
    const refusal = statusBodyRefusal("The client backs off.\nDEPLOYED to beta (2026-10-06).", NOW);
    expect(refusal).toContain("2 status markers");
    expect(refusal).toContain('"DEPLOYED"');
    expect(refusal).toContain("reads as a status report");
    expect(statusBodyWarning("The client backs off.\nDEPLOYED to beta (2026-10-06).", NOW)).toBeNull();
  });

  test("merge state and its SHA must share a line", () => {
    expect(statusBodyRefusal("Branches merged here.\nSee 3f9a2c1 for the change.", NOW)).toBeNull();
  });

  test("a body with one marker or none is not refused", () => {
    expect(statusBodyRefusal("Introduced in REV-1234567; the retry loop backs off exponentially.", NOW)).toBeNull();
    expect(statusBodyRefusal("Deploy order matters: create the CMK before the IAM role.", NOW)).toBeNull();
  });
});

describe("statusBodyWarning", () => {
  test("warns on a body with a single marker", () => {
    const warning = statusBodyWarning("Introduced in REV-1234567; the retry loop backs off exponentially.", NOW);
    expect(warning).toContain("a status marker");
    expect(warning).toContain('"REV-1234567"');
  });

  test("a body with no marker draws no warning", () => {
    expect(statusBodyWarning("Deploy order matters: create the CMK before the IAM role.", NOW)).toBeNull();
    expect(
      statusBodyWarning('Policies use "Version": "2012-10-17" (2012-10-17).\nS3 API (2006-03-01) is path-style.', NOW)
    ).toBeNull();
  });
});
