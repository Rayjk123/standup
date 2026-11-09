import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import {
  KnowledgeStore,
  isRejudgeQueued,
  isVerdictAdmissible,
  judgmentCounts,
  type SearchResult,
  type KnowledgeDocFile,
} from "@standup/knowledge";
import {
  ContradictionJudgeError,
  SUPERSEDE_MIN_CONFIDENCE,
  UNDECIDED_BASIS,
  applySupersessions,
  supersessionBlocker,
  type DocVerdictState,
  type Supersession,
  withJudgeDeadline,
  withJudgeRetry,
  withJudgmentLog,
  detectDuplicate,
  detectContradictions,
  flagContradictions,
  contradictionDispute,
  parseJudgeOutput,
  CONTRADICTION_CANDIDATE_FLOOR,
  CONTRADICTION_CANDIDATE_FLOOR_TEXT_ONLY,
  type ContradictionJudgment,
  type DocText,
} from "./knowledge-coherence.js";

/** A SearchResult fixture — only the fields the coherence checks read matter. */
function hit(slug: string, rawScore: number, projectId = "p"): SearchResult {
  return {
    id: `id-${slug}`,
    projectId,
    slug,
    title: slug,
    excerpt: "",
    score: rawScore,
    rawScore,
    source: "embedding",
    originClass: "owner",
    sourceKind: "code",
    generated: true,
  };
}

/** An accepted-doc file fixture — only title/body are read by the checks. */
function docFile(title: string, body: string): KnowledgeDocFile {
  return {
    slug: title,
    title,
    body,
    tags: [],
    updatedAt: new Date(),
    sourceKind: "code",
  };
}

describe("detectDuplicate", () => {
  test("semantic arm: a hit at/above the near-dup threshold is a duplicate", async () => {
    const result = await detectDuplicate(
      {
        search: async () => [hit("existing", 0.97)],
        readAcceptedDoc: async () => docFile("Existing", "totally different words here"),
      },
      "p",
      { slug: "candidate", title: "Candidate", body: "some body" }
    );
    expect(result.status).toBe("duplicate");
    if (result.status === "duplicate") expect(result.dupSlug).toBe("existing");
  });

  test("lexical arm: a token-overlapping hit is a duplicate even below the semantic bar", async () => {
    const body =
      "The collector distills a session transcript into a knowledge draft through the backend seam.";
    const result = await detectDuplicate(
      {
        // Low fused score — the semantic gate does NOT fire.
        search: async () => [hit("existing", 0.4)],
        readAcceptedDoc: async () => docFile("Distiller", body),
      },
      "p",
      { slug: "candidate", title: "Distiller", body }
    );
    expect(result.status).toBe("duplicate");
  });

  test("distinct: neither arm fires", async () => {
    const result = await detectDuplicate(
      {
        search: async () => [hit("existing", 0.5)],
        readAcceptedDoc: async () => docFile("Unrelated", "apples oranges bananas grapes"),
      },
      "p",
      { slug: "candidate", title: "Kubernetes", body: "pods deployments services ingress" }
    );
    expect(result.status).toBe("distinct");
  });

  test("excludes the candidate's own slug and any it replaces", async () => {
    const result = await detectDuplicate(
      {
        // The only hits are the doc itself and the doc it replaces — both excluded.
        search: async () => [hit("candidate", 0.99), hit("prior", 0.99)],
        readAcceptedDoc: async () => docFile("x", "y"),
      },
      "p",
      { slug: "candidate", title: "Candidate", body: "body" },
      ["prior"]
    );
    expect(result.status).toBe("distinct");
  });

  test("matches a duplicate in another project the audience can see", async () => {
    const seen: Array<{ corpus?: string; audience?: unknown }> = [];
    const result = await detectDuplicate(
      {
        search: async (_p, _q, options) => {
          seen.push({ corpus: options?.corpus, audience: options?.audience });
          return [hit("other", 0.99, "other-project")];
        },
        readAcceptedDoc: async () => docFile("x", "y"),
      },
      "p",
      { slug: "candidate", title: "Candidate", body: "body" },
      [],
      { projectId: "p" }
    );
    expect(result.status).toBe("duplicate");
    if (result.status === "duplicate") expect(result.dupProjectId).toBe("other-project");
    expect(seen[0]).toEqual({ corpus: "all", audience: { projectId: "p" } });
  });

  test("returns the nearest docs even when none is a duplicate", async () => {
    const result = await detectDuplicate(
      {
        search: async () => [hit("near", 0.6)],
        readAcceptedDoc: async () => docFile("Near", "apples oranges"),
      },
      "p",
      { slug: "candidate", title: "Kubernetes", body: "pods deployments services" }
    );
    expect(result.status).toBe("distinct");
    expect(result.nearest.map((n) => n.slug)).toEqual(["near"]);
  });
});

describe("detectContradictions", () => {
  test("flags an opposing accepted doc the judge confirms", async () => {
    const judged: Array<[string, string]> = [];
    const contradictions = await detectContradictions(
      {
        search: async () => [hit("uses-bun", 0.8)],
        readAcceptedDoc: async () => docFile("Runtime", "The project runs on Node, never Bun."),
        judge: async (a, b): Promise<ContradictionJudgment> => {
          judged.push([a.slug, b.slug]);
          return { contradicts: true, reason: "one says Bun, the other says Node" };
        },
      },
      "p",
      { slug: "candidate", title: "Runtime", body: "The project runs on Bun." }
    );
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0]!.slug).toBe("uses-bun");
    expect(contradictions[0]!.reason).toContain("Bun");
    expect(judged).toEqual([["candidate", "uses-bun"]]);
  });

  test("never judges a playbook, so no resolution can touch one or carry its text", async () => {
    const judged: string[] = [];
    const contradictions = await detectContradictions(
      {
        search: async () => [{ ...hit("playbook-alice--deploys", 0.9), sourceKind: "playbook" as const }, hit("uses-bun", 0.8)],
        readAcceptedDoc: async () => docFile("Runtime", "The project runs on Node, never Bun."),
        judge: async (_a, b): Promise<ContradictionJudgment> => {
          judged.push(b.slug);
          return { contradicts: true, reason: "opposed" };
        },
      },
      "p",
      { slug: "candidate", title: "Runtime", body: "The project runs on Bun." }
    );
    expect(judged).toEqual(["uses-bun"]);
    expect(contradictions.map((c) => c.slug)).toEqual(["uses-bun"]);
  });

  test("returns nothing when the judge says the docs agree", async () => {
    const contradictions = await detectContradictions(
      {
        search: async () => [hit("related", 0.8)],
        readAcceptedDoc: async () => docFile("Related", "a compatible fact"),
        judge: async (): Promise<ContradictionJudgment> => ({ contradicts: false, reason: "" }),
      },
      "p",
      { slug: "candidate", title: "T", body: "b" }
    );
    expect(contradictions).toEqual([]);
  });

  test("does not judge hits below the candidate floor", async () => {
    let judgeCalls = 0;
    const contradictions = await detectContradictions(
      {
        search: async () => [hit("weak", CONTRADICTION_CANDIDATE_FLOOR - 0.01)],
        readAcceptedDoc: async () => docFile("Weak", "unrelated"),
        judge: async (): Promise<ContradictionJudgment> => {
          judgeCalls++;
          return { contradicts: true, reason: "x" };
        },
      },
      "p",
      { slug: "candidate", title: "T", body: "b" }
    );
    expect(judgeCalls).toBe(0);
    expect(contradictions).toEqual([]);
  });

  test("text-only mode judges a hit the hybrid floor would gate out", async () => {
    // A hit whose fused rawScore sits between the two floors — the ceiling an
    // FTS-only run can actually reach (rawScore <= textWeight = 0.4) but above
    // the text-only floor. With embeddings off it MUST reach the judge; the
    // hybrid floor (0.5) would silently gate it out and disable detection.
    const midScore = (CONTRADICTION_CANDIDATE_FLOOR_TEXT_ONLY + CONTRADICTION_CANDIDATE_FLOOR) / 2;
    expect(midScore).toBeLessThan(CONTRADICTION_CANDIDATE_FLOOR);
    expect(midScore).toBeGreaterThan(CONTRADICTION_CANDIDATE_FLOOR_TEXT_ONLY);
    let judgeCalls = 0;
    const contradictions = await detectContradictions(
      {
        search: async () => [hit("opposes", midScore)],
        readAcceptedDoc: async () => docFile("Runtime", "The project runs on Node, never Bun."),
        judge: async (): Promise<ContradictionJudgment> => {
          judgeCalls++;
          return { contradicts: true, reason: "Bun vs Node" };
        },
        embeddingsEnabled: false,
      },
      "p",
      { slug: "candidate", title: "Runtime", body: "The project runs on Bun." }
    );
    expect(judgeCalls).toBe(1);
    expect(contradictions).toHaveLength(1);
  });

  test("hybrid mode gates out a hit below the hybrid floor", async () => {
    // The same mid-band score, but with the embedding arm live: the hybrid floor
    // applies, so the weakly-recalled hit is not worth a model spawn.
    const midScore = (CONTRADICTION_CANDIDATE_FLOOR_TEXT_ONLY + CONTRADICTION_CANDIDATE_FLOOR) / 2;
    let judgeCalls = 0;
    const contradictions = await detectContradictions(
      {
        search: async () => [hit("weak", midScore)],
        readAcceptedDoc: async () => docFile("Weak", "unrelated"),
        judge: async (): Promise<ContradictionJudgment> => {
          judgeCalls++;
          return { contradicts: true, reason: "x" };
        },
        embeddingsEnabled: true,
      },
      "p",
      { slug: "candidate", title: "T", body: "b" }
    );
    expect(judgeCalls).toBe(0);
    expect(contradictions).toEqual([]);
  });

  test("text-only mode still gates out a hit below the text-only floor", async () => {
    let judgeCalls = 0;
    await detectContradictions(
      {
        search: async () => [hit("tooweak", CONTRADICTION_CANDIDATE_FLOOR_TEXT_ONLY - 0.01)],
        readAcceptedDoc: async () => docFile("Weak", "unrelated"),
        judge: async (): Promise<ContradictionJudgment> => {
          judgeCalls++;
          return { contradicts: true, reason: "x" };
        },
        embeddingsEnabled: false,
      },
      "p",
      { slug: "candidate", title: "T", body: "b" }
    );
    expect(judgeCalls).toBe(0);
  });

  test("skips a superseded candidate — a retired loser is not re-recalled as a conflict", async () => {
    let judgeCalls = 0;
    const contradictions = await detectContradictions(
      {
        search: async () => [hit("tombstoned", 0.9)],
        readAcceptedDoc: async () => docFile("Tombstoned", "The project runs on Node, never Bun."),
        judge: async (): Promise<ContradictionJudgment> => {
          judgeCalls++;
          return { contradicts: true, reason: "Bun vs Node" };
        },
        // The candidate was tombstoned by a prior auto-resolution.
        getDoc: () => ({ verdict: "superseded", disputes: [] }),
      },
      "p",
      { slug: "candidate", title: "Runtime", body: "The project runs on Bun." }
    );
    // No judge spawn, no fresh conflict — the churn loop is broken at the source.
    expect(judgeCalls).toBe(0);
    expect(contradictions).toEqual([]);
  });

  test("excludes the subject's own slug from the candidate set", async () => {
    let judgeCalls = 0;
    const contradictions = await detectContradictions(
      {
        search: async () => [hit("candidate", 0.99)],
        readAcceptedDoc: async () => docFile("Self", "self"),
        judge: async (): Promise<ContradictionJudgment> => {
          judgeCalls++;
          return { contradicts: true, reason: "x" };
        },
      },
      "p",
      { slug: "candidate", title: "T", body: "b" }
    );
    expect(judgeCalls).toBe(0);
    expect(contradictions).toEqual([]);
  });

  test("bounds judge spawns to at most 3 candidates", async () => {
    let judgeCalls = 0;
    await detectContradictions(
      {
        search: async () =>
          ["a", "b", "c", "d", "e"].map((s) => hit(s, 0.8)),
        readAcceptedDoc: async (_p, slug) => docFile(slug, `body ${slug}`),
        judge: async (): Promise<ContradictionJudgment> => {
          judgeCalls++;
          return { contradicts: false, reason: "" };
        },
      },
      "p",
      { slug: "candidate", title: "T", body: "b" }
    );
    expect(judgeCalls).toBe(3);
  });
});

describe("flagContradictions", () => {
  test("with nothing to tell the sides apart, marks both contradicted and undecided, not disputed", () => {
    const writes: Array<{ slug: string; verdict: string; disputes: unknown[] }> = [];
    const subject: DocText = { slug: "candidate", title: "T", body: "b" };
    const flagged = flagContradictions(
      {
        recordVerdict: (_p, slug, verdict, disputes) => writes.push({ slug, verdict, disputes }),
        getDoc: () => null,
      },
      "p",
      subject,
      [{ slug: "existing", reason: "they disagree on the runtime" }]
    );

    expect(flagged.sort()).toEqual(["candidate", "existing"]);
    const subjectWrite = writes.find((w) => w.slug === "candidate")!;
    expect(subjectWrite.verdict).toBe("contradicted");
    const subjectDispute = subjectWrite.disputes[0] as { claim: string; evidence: string };
    expect(subjectDispute.claim).toBe("Contradicts existing");
    expect(subjectDispute.evidence).toContain(UNDECIDED_BASIS);
    const otherWrite = writes.find((w) => w.slug === "existing")!;
    expect(otherWrite.verdict).toBe("contradicted");
    expect((otherWrite.disputes[0] as { claim: string }).claim).toBe("Contradicts candidate");
    // Contradicted and undecided, each side of a tied pair is admissible with its
    // conflict marker.
    expect(
      isVerdictAdmissible(
        { verdict: "contradicted", contradiction: { side: "undecided", counterparts: ["p/existing"] } },
        "inject"
      )
    ).toBe(true);
  });

  test("flags only the agent-written side when the other is owner-written", () => {
    const writes: Array<{ slug: string; verdict: string; disputes: unknown[] }> = [];
    const flagged = flagContradictions(
      {
        recordVerdict: (_p, slug, verdict, disputes) => writes.push({ slug, verdict, disputes }),
        getDoc: (_p, slug) => (slug === "existing" ? { originClass: "owner" } : { originClass: "agent" }),
      },
      "p",
      { slug: "candidate", title: "T", body: "b" },
      [{ slug: "existing", reason: "they disagree" }]
    );
    expect(flagged).toEqual(["candidate"]);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.verdict).toBe("contradicted");
    const d = writes[0]!.disputes[0] as { claim: string; evidence: string };
    expect(d.claim).toBe("Contradicts existing");
    expect(d.evidence).toContain("existing was kept");
  });

  test("the unverified side loses to the verified one, then the older to the newer", () => {
    const run = (states: Record<string, object>) => {
      const writes: string[] = [];
      flagContradictions(
        { recordVerdict: (_p, slug) => writes.push(slug), getDoc: (_p, slug) => states[slug] ?? null },
        "p",
        { slug: "a", title: "T", body: "b" },
        [{ slug: "b", reason: "r" }]
      );
      return writes;
    };
    const verified = { originClass: "agent", confidence: 1, lastVerifiedAt: new Date().toISOString() };
    const unverified = { originClass: "agent", confidence: 0.6 };
    expect(run({ a: verified, b: unverified })).toEqual(["b"]);
    expect(run({ a: unverified, b: verified })).toEqual(["a"]);
    expect(
      run({
        a: { ...unverified, generatedAt: "2026-09-01T00:00:00Z" },
        b: { ...unverified, generatedAt: "2026-10-01T00:00:00Z" },
      })
    ).toEqual(["a"]);
  });

  test("a git finding never counts against a doc in a contradiction", () => {
    const writes: string[] = [];
    flagContradictions(
      {
        recordVerdict: (_p, slug) => writes.push(slug),
        getDoc: (_p, slug) =>
          slug === "existing"
            ? {
                originClass: "owner",
                verdict: "disputed",
                disputes: [{ claim: "x is merged", finding: "not on the default branch", evidence: "git", origin: "git" }],
              }
            : { originClass: "agent" },
      },
      "p",
      { slug: "candidate", title: "T", body: "b" },
      [{ slug: "existing", reason: "r" }]
    );
    // The owner doc wins on provenance; its git finding is not weighed.
    expect(writes).toEqual(["candidate"]);
  });

  test("a doc whose own fact-check found refuted claims loses, whatever its provenance", () => {
    const writes: string[] = [];
    flagContradictions(
      {
        recordVerdict: (_p, slug) => writes.push(slug),
        getDoc: (_p, slug) =>
          slug === "existing"
            ? {
                originClass: "owner",
                verdict: "disputed",
                disputes: [{ claim: "abc1234 is not merged", finding: "HEAD contains it", evidence: "git" }],
              }
            : { originClass: "agent" },
      },
      "p",
      { slug: "candidate", title: "T", body: "b" },
      [{ slug: "existing", reason: "r" }]
    );
    expect(writes).toEqual(["existing"]);
  });

  test("writes nothing when there are no contradictions", () => {
    const writes: string[] = [];
    const flagged = flagContradictions(
      { recordVerdict: (_p, slug) => writes.push(slug), getDoc: () => null },
      "p",
      { slug: "candidate", title: "T", body: "b" },
      []
    );
    expect(flagged).toEqual([]);
    expect(writes).toEqual([]);
  });

  test("preserves a disputed opposing doc's fact-check findings instead of clobbering them", () => {
    const writes: Array<{ slug: string; verdict: string; disputes: unknown[] }> = [];
    // The opposing doc "existing" already carries three fact-check disputes and a
    // "disputed" verdict a human needs — the clobber the review flagged.
    const priorDisputes = [
      { claim: "does A", finding: "does not at HEAD", evidence: "rg A" },
      { claim: "does B", finding: "removed", evidence: "rg B" },
      { claim: "does C", finding: "renamed", evidence: "rg C" },
    ];
    flagContradictions(
      {
        recordVerdict: (_p, slug, verdict, disputes) => writes.push({ slug, verdict, disputes }),
        getDoc: (_p, slug) =>
          slug === "existing" ? { verdict: "disputed", disputes: priorDisputes } : null,
      },
      "p",
      { slug: "candidate", title: "T", body: "b" },
      [{ slug: "existing", reason: "they disagree on the runtime" }]
    );

    const otherWrite = writes.find((w) => w.slug === "existing")!;
    // The stronger, code-grounded verdict is kept, not downgraded.
    expect(otherWrite.verdict).toBe("disputed");
    const claims = (otherWrite.disputes as Array<{ claim: string }>).map((d) => d.claim);
    // All three fact-check findings survive, plus the new contradiction dispute.
    expect(claims).toEqual(["does A", "does B", "does C", "Contradicts candidate"]);
  });

  test("drops a superseded candidate so its tombstone is never re-flagged away", () => {
    const writes: Array<{ slug: string; verdict: string; disputes: unknown[] }> = [];
    const flagged = flagContradictions(
      {
        recordVerdict: (_p, slug, verdict, disputes) => writes.push({ slug, verdict, disputes }),
        // "retired" is a tombstoned loser; re-flagging it would strip its tombstone.
        getDoc: (_p, slug) =>
          slug === "retired" ? { verdict: "superseded", disputes: [] } : null,
      },
      "p",
      { slug: "candidate", title: "T", body: "b" },
      [{ slug: "retired", reason: "they disagree" }]
    );
    // The only candidate was superseded, so nothing is flagged — not the subject,
    // not the retired doc.
    expect(flagged).toEqual([]);
    expect(writes).toEqual([]);
  });

  test("does not stack a duplicate contradiction dispute on re-run", () => {
    const writes: Array<{ slug: string; verdict: string; disputes: unknown[] }> = [];
    // "existing" (agent-written) was already flagged contradicting the owner's
    // "candidate" on a prior pass.
    flagContradictions(
      {
        recordVerdict: (_p, slug, verdict, disputes) => writes.push({ slug, verdict, disputes }),
        getDoc: (_p, slug) =>
          slug === "existing"
            ? {
                originClass: "agent",
                verdict: "contradicted",
                disputes: [contradictionDispute("candidate", "old reason")],
              }
            : { originClass: "owner" },
      },
      "p",
      { slug: "candidate", title: "T", body: "b" },
      [{ slug: "existing", reason: "new reason" }]
    );

    const otherWrite = writes.find((w) => w.slug === "existing")!;
    expect(otherWrite.verdict).toBe("contradicted");
    // Same claim ("Contradicts candidate") — folded, not duplicated.
    expect(otherWrite.disputes).toHaveLength(1);
  });

  test("refuses to re-flag a SUBJECT that is already superseded (no tombstone strip)", () => {
    // The stale-snapshot revival bug: detection ran over a subject that a resolution
    // tombstoned since the snapshot was taken. Its LIVE verdict is "superseded".
    // Re-flagging it "contradicted" would fold onto — and thereby strip — its
    // "Superseded by X" tombstone, reviving a retired claim. flagContradictions must
    // no-op instead: neither the subject nor its (live) candidate is written.
    const writes: Array<{ slug: string; verdict: string; disputes: unknown[] }> = [];
    const flagged = flagContradictions(
      {
        recordVerdict: (_p, slug, verdict, disputes) => writes.push({ slug, verdict, disputes }),
        getDoc: (_p, slug) =>
          slug === "loser"
            ? { verdict: "superseded", disputes: [{ claim: "Superseded by winner", finding: "f", evidence: "e" }] }
            : null, // "winner" is live/clean
      },
      "p",
      { slug: "loser", title: "T", body: "b" }, // the tombstoned subject
      [{ slug: "winner", reason: "they disagree" }]
    );
    expect(flagged).toEqual([]);
    expect(writes).toEqual([]);
  });
});

describe("contradictionDispute", () => {
  test("falls back to a default finding when the judge gave no reason", () => {
    const d = contradictionDispute("other", "");
    expect(d.claim).toBe("Contradicts other");
    expect(d.finding.length).toBeGreaterThan(0);
    expect(d.evidence).toContain("other");
  });
});

describe("parseJudgeOutput", () => {
  test("parses a well-formed contradicting judgment", () => {
    expect(parseJudgeOutput('{"contradicts": true, "reason": "opposite"}')).toEqual({
      contradicts: true,
      reason: "opposite",
      method: "llm",
    });
  });

  test("tolerates prose around the JSON object", () => {
    const out = parseJudgeOutput('Here is my answer:\n{"contradicts": false, "reason": ""}\nDone.');
    expect(out.contradicts).toBe(false);
    expect(out.error).toBeUndefined();
  });

  test("an unreadable reply is a judge error, never a judged 'no'", () => {
    for (const raw of ["not json at all", '{"contradicts": "yes"}', ""]) {
      const out = parseJudgeOutput(raw);
      expect(out.contradicts).toBe(false);
      expect(out.error).toContain("unparseable");
    }
  });
});

describe("judge errors", () => {
  const subject: DocText = { slug: "s", title: "T", body: "b" };
  const failing = async (): Promise<ContradictionJudgment> => ({
    contradicts: false,
    reason: "",
    error: "exit 1: 403 Forbidden",
  });

  test("detection throws when every judged candidate errored, so the subject is not read as clean", async () => {
    await expect(
      detectContradictions(
        {
          search: async () => [hit("x", 0.9), hit("y", 0.9)],
          readAcceptedDoc: async () => docFile("x", "y"),
          judge: failing,
        },
        "p",
        subject
      )
    ).rejects.toBeInstanceOf(ContradictionJudgeError);
  });

  test("detection does not throw when some candidates answered and others errored", async () => {
    const found = await detectContradictions(
      {
        search: async () => [hit("bad", 0.9), hit("fine", 0.9)],
        readAcceptedDoc: async () => docFile("x", "y"),
        judge: async (_a, b) => (b.slug === "bad" ? failing() : { contradicts: false, reason: "" }),
      },
      "p",
      subject
    );
    expect(found).toEqual([]);
  });

  test("a deadline skips the remaining pairs without calling the judge", async () => {
    let t = 0;
    let calls = 0;
    const judge = withJudgeDeadline(
      async () => {
        calls++;
        t += 100;
        return { contradicts: false, reason: "" };
      },
      150,
      () => t
    );
    await judge(subject, subject);
    await judge(subject, subject);
    const third = await judge(subject, subject);
    expect(calls).toBe(2);
    expect(third).toMatchObject({ final: true });
  });

  test("a pair the deadline leaves unjudged is recorded and queued, not retried", async () => {
    const db = new Database(":memory:");
    new KnowledgeStore(db);
    let calls = 0;
    const judge = withJudgmentLog(
      withJudgeDeadline(
        withJudgeRetry(async () => (calls++, { contradicts: false, reason: "" }), { sleep: async () => {} }),
        0
      ),
      db
    );
    const out = await judge({ ...subject, projectId: "p" }, { slug: "x", title: "t", body: "b", projectId: "p" });
    expect(calls).toBe(0);
    expect(out.error).toContain("time budget");
    expect(judgmentCounts(db)).toMatchObject({ judge_error: 1, queued: 1 });
  });

  test("a skipped judgment is neither retried nor recorded", async () => {
    const db = new Database(":memory:");
    new KnowledgeStore(db);
    let calls = 0;
    const judge = withJudgmentLog(
      withJudgeRetry(
        async () => {
          calls++;
          return { contradicts: false, reason: "", error: "budget", skipped: true };
        },
        { sleep: async () => {} }
      ),
      db
    );
    await judge({ ...subject, projectId: "p" }, { slug: "x", title: "t", body: "b", projectId: "p" });
    expect(calls).toBe(1);
    expect(judgmentCounts(db)).toEqual({
      contradicts: 0,
      supersedes: 0,
      complementary: 0,
      consistent: 0,
      judge_error: 0,
      queued: 0,
    });
  });

  test("detection keeps a confirmed contradiction when another candidate errored", async () => {
    const found = await detectContradictions(
      {
        search: async () => [hit("bad", 0.9), hit("good", 0.9)],
        readAcceptedDoc: async () => docFile("x", "y"),
        judge: async (_a, b) =>
          b.slug === "bad" ? failing() : { contradicts: true, reason: "opposite" },
      },
      "p",
      subject
    );
    expect(found.map((c) => c.slug)).toEqual(["good"]);
  });

  test("detection hands the judge both docs' projects", async () => {
    const seen: Array<[string | undefined, string | undefined]> = [];
    await detectContradictions(
      {
        search: async () => [hit("x", 0.9)],
        readAcceptedDoc: async () => docFile("x", "y"),
        judge: async (a, b) => {
          seen.push([a.projectId, b.projectId]);
          return { contradicts: false, reason: "" };
        },
      },
      "p",
      subject
    );
    expect(seen).toEqual([["p", "p"]]);
  });

  test("withJudgeRetry retries an error with backoff and returns the first answer", async () => {
    const delays: number[] = [];
    let calls = 0;
    const judge = withJudgeRetry(
      async () => (++calls < 3 ? failing() : { contradicts: true, reason: "r" }),
      { attempts: 3, baseDelayMs: 10, sleep: async (ms) => void delays.push(ms) }
    );
    const out = await judge(subject, subject);
    expect(out).toMatchObject({ contradicts: true, attempts: 3 });
    expect(delays).toEqual([10, 20]);
  });

  test("withJudgeRetry gives up after the bounded attempts with the error", async () => {
    let calls = 0;
    const judge = withJudgeRetry(async () => (calls++, failing()), { attempts: 2, sleep: async () => {} });
    const out = await judge(subject, subject);
    expect(calls).toBe(2);
    expect(out.error).toContain("403");
    expect(out.attempts).toBe(2);
  });

  test("withJudgmentLog records answers and errors, and queues a subject the judge failed on", async () => {
    const db = new Database(":memory:");
    new KnowledgeStore(db);
    const a: DocText = { ...subject, projectId: "p" };
    await withJudgmentLog(async () => ({ contradicts: false, reason: "" }), db)(a, {
      slug: "ok",
      title: "t",
      body: "b",
      projectId: "p",
    });
    await withJudgmentLog(failing, db)(a, { slug: "bad", title: "t", body: "b", projectId: "p" });
    expect(judgmentCounts(db)).toMatchObject({ contradicts: 0, consistent: 1, judge_error: 1, queued: 1 });
    expect(isRejudgeQueued(db, "p", "s")).toBe(true);
    // The failed pair answering later settles the queue.
    await withJudgmentLog(async () => ({ contradicts: true, reason: "r" }), db)(a, {
      slug: "bad",
      title: "t",
      body: "b",
      projectId: "p",
    });
    expect(judgmentCounts(db)).toMatchObject({ contradicts: 1, consistent: 1, judge_error: 0, queued: 0 });
  });

  test("withJudgmentLog records the supersedes and complementary relations, which settle the queue", async () => {
    const db = new Database(":memory:");
    new KnowledgeStore(db);
    const a: DocText = { ...subject, projectId: "p" };
    await withJudgmentLog(failing, db)(a, { slug: "x", title: "t", body: "b", projectId: "p" });
    expect(isRejudgeQueued(db, "p", "s")).toBe(true);
    await withJudgmentLog(async () => ({ contradicts: false, relation: "supersedes", newer: "a", reason: "r" }), db)(
      a,
      { slug: "x", title: "t", body: "b", projectId: "p" }
    );
    await withJudgmentLog(async () => ({ contradicts: false, relation: "complementary", reason: "r" }), db)(a, {
      slug: "y",
      title: "t",
      body: "b",
      projectId: "p",
    });
    expect(judgmentCounts(db)).toMatchObject({ supersedes: 1, complementary: 1, judge_error: 0, queued: 0 });
    expect(isRejudgeQueued(db, "p", "s")).toBe(false);
  });
});

describe("judge relations", () => {
  test("parseJudgeOutput reads each of the four relations", () => {
    const cases: Array<[string, Partial<ContradictionJudgment>]> = [
      ['{"relation":"contradicts","newer":null,"confidence":0.9,"reason":"r"}', { contradicts: true, relation: "contradicts", confidence: 0.9 }],
      ['{"relation":"supersedes","newer":"B","confidence":0.95,"reason":"r"}', { contradicts: false, relation: "supersedes", newer: "b", confidence: 0.95 }],
      ['{"relation":"complementary","newer":null,"reason":"r"}', { contradicts: false, relation: "complementary" }],
      ['Answer: {"relation":"Consistent","reason":""}', { contradicts: false, relation: "consistent" }],
    ];
    for (const [raw, expected] of cases) {
      const out = parseJudgeOutput(raw);
      expect(out.error).toBeUndefined();
      expect(out).toMatchObject(expected);
    }
    // A supersession with no usable `newer` keeps the relation without a side.
    expect(parseJudgeOutput('{"relation":"supersedes","newer":"C","reason":"r"}').newer).toBeUndefined();
    // An out-of-range confidence is left out.
    expect(parseJudgeOutput('{"relation":"contradicts","confidence":7,"reason":"r"}').confidence).toBeUndefined();
  });

  test("garbage and unknown relations are judge errors", () => {
    for (const raw of ['{"relation":"maybe"}', '{"relation":3}', '{"reason":"no verdict"}', "{not json}", "nothing"]) {
      const out = parseJudgeOutput(raw);
      expect(out.contradicts).toBe(false);
      expect(out.error).toContain("unparseable");
    }
  });

  test("only `contradicts` is a contradiction; a supersession is carried alongside", async () => {
    const relations: Record<string, ContradictionJudgment> = {
      c: { contradicts: true, relation: "contradicts", reason: "opposite" },
      s: { contradicts: false, relation: "supersedes", newer: "a", confidence: 0.9, reason: "s is the plan, the subject the outcome" },
      m: { contradicts: false, relation: "complementary", reason: "different steps" },
      k: { contradicts: false, relation: "consistent", reason: "" },
    };
    const found = await detectContradictions(
      {
        search: async () => ["c", "s", "m", "k"].map((slug) => hit(slug, 0.9)),
        readAcceptedDoc: async (_p, slug) => docFile(slug, "body"),
        judge: async (_a, b) => relations[b.slug]!,
      },
      "p",
      { slug: "subject", title: "T", body: "b" },
      [],
      { maxJudged: 4 }
    );
    expect(found.map((c) => c.slug)).toEqual(["c"]);
    expect(found.supersessions).toEqual([
      { olderSlug: "s", newerSlug: "subject", confidence: 0.9, reason: "s is the plan, the subject the outcome" },
    ]);
  });
});

describe("supersessions", () => {
  const verifiedNewer: DocVerdictState = {
    originClass: "agent",
    lastVerifiedAt: "2026-10-01T00:00:00Z",
    generatedAt: "2026-10-01T00:00:00Z",
  };
  const olderAgent: DocVerdictState = { originClass: "agent", generatedAt: "2026-08-01T00:00:00Z" };
  const s: Supersession = { olderSlug: "old", newerSlug: "new", confidence: 0.9, reason: "the plan shipped" };

  test("the older doc is retired only when the judge is confident and the newer doc verified", () => {
    const table: Array<[string, Supersession, DocVerdictState | null, DocVerdictState | null, boolean]> = [
      ["confident, verified newer", s, olderAgent, verifiedNewer, true],
      ["low confidence", { ...s, confidence: SUPERSEDE_MIN_CONFIDENCE - 0.1 }, olderAgent, verifiedNewer, false],
      ["unverified newer", s, olderAgent, { ...verifiedNewer, lastVerifiedAt: undefined }, false],
      ["disputed newer", s, olderAgent, { ...verifiedNewer, verdict: "disputed" }, false],
      ["owner-written older", s, { ...olderAgent, originClass: "owner" }, verifiedNewer, false],
      ["older already superseded", s, { ...olderAgent, verdict: "superseded" }, verifiedNewer, false],
      ["write times say the reverse", s, { ...olderAgent, generatedAt: "2026-10-05T00:00:00Z" }, verifiedNewer, false],
    ];
    for (const [name, sup, older, newer, retires] of table) {
      expect([name, supersessionBlocker(sup, older, newer) === null]).toEqual([name, retires]);
    }
  });

  test("applySupersessions tombstones the older doc, keeping its fact findings and dropping its edges", () => {
    const writes: Array<{ slug: string; verdict: string; disputes: unknown[] }> = [];
    const states: Record<string, DocVerdictState> = {
      old: {
        ...olderAgent,
        verdict: "contradicted",
        disputes: [
          { claim: "x is 3", finding: "x is 4", evidence: "rg x" },
          contradictionDispute("new", "they differ"),
        ],
      },
      new: verifiedNewer,
    };
    const retired = applySupersessions(
      { recordVerdict: (_p, slug, verdict, disputes) => writes.push({ slug, verdict, disputes }), getDoc: (_p, slug) => states[slug] ?? null },
      "p",
      [s]
    );
    expect(retired).toEqual(["old"]);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.verdict).toBe("superseded");
    expect((writes[0]!.disputes as Array<{ claim: string }>).map((d) => d.claim)).toEqual(["x is 3", "Superseded by new"]);
  });

  test("a recorded-only supersession writes nothing; flagContradictions applies a confident one", () => {
    const writes: string[] = [];
    const deps = {
      recordVerdict: (_p: string, slug: string) => void writes.push(slug),
      getDoc: (_p: string, slug: string) => (slug === "new" ? verifiedNewer : slug === "old" ? olderAgent : null),
    };
    const weak = Object.assign([], { supersessions: [{ ...s, confidence: 0.5 }] });
    expect(flagContradictions(deps, "p", { slug: "new", title: "T", body: "b" }, weak)).toEqual([]);
    expect(writes).toEqual([]);
    const strong = Object.assign([], { supersessions: [s] });
    // The retirement is not a contradiction flag, so nothing is reported as contradicting.
    expect(flagContradictions(deps, "p", { slug: "new", title: "T", body: "b" }, strong)).toEqual([]);
    expect(writes).toEqual(["old"]);
  });
});
