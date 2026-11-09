import { expect, test, describe } from "bun:test";
import type { KnowledgeDocFile, SearchResult } from "@standup/knowledge";
import {
  DUPLICATE_REJECT_COSINE,
  DUP_COSINE,
  DUP_COSINE_REWORDED,
  DUP_COSINE_STRICT,
  DUP_COSINE_TITLED,
  DUPLICATE_REJECT_LEXICAL_CONTAINMENT,
  DUPLICATE_REJECT_LEXICAL_JACCARD,
  DUPLICATE_REJECT_SIZE_RATIO,
  DUPLICATE_REJECT_TWO_WAY_CONTAINMENT,
  NEAR_DUP_CONTAINMENT_THRESHOLD,
  NEAR_DUP_LEXICAL_THRESHOLD,
  dupFeatures,
  duplicateRefusal,
  findNearestDocs,
  isDuplicate,
  isHighConfidenceDuplicate,
  isUpdateCandidate,
  lexicalOverlap,
  similarityOf,
  updateHint,
  valueDifferences,
  type DedupSubject,
  type NearestDoc,
} from "./knowledge-dedup.js";

/**
 * A labeled set shaped like the duplicate pairs measured on a real corpus —
 * synthetic text, but the cosine each pair was measured at and the same kind
 * of title/body overlap. Positives: byte copies, a light edit, paraphrased
 * copies under the same title, a fork of one doc under the same slug in another
 * project, a restatement under a reworded title. Negatives: sibling docs about
 * another component of the same system, a product spec and its implementation
 * doc, two docs about one subsystem.
 */
interface Pair {
  name: string;
  a: DedupSubject;
  b: DedupSubject;
  cosine: number;
  duplicate: boolean;
}

const retryBody =
  "The Slack mirror retries a failed post with exponential backoff, starting at 500ms and capped at 30s. " +
  "After five attempts the message is parked in the dead-letter table and surfaced on the Health panel.";

const PAIRS: Pair[] = [
  {
    name: "byte copy in a frozen copy project",
    a: { slug: "slack-mirror-retry-policy", title: "Slack mirror retry policy", body: retryBody },
    b: { slug: "slack-mirror-retry-policy", title: "Slack mirror retry policy", body: retryBody },
    cosine: 1,
    duplicate: true,
  },
  {
    name: "light edit",
    a: { slug: "retry-policy", title: "Slack mirror retry policy", body: retryBody },
    b: {
      slug: "retry-policy-v2",
      title: "Slack mirror retry policy",
      body: retryBody.replace("five attempts", "5 attempts").replace("Health panel", "health panel"),
    },
    cosine: 0.97,
    duplicate: true,
  },
  {
    name: "paraphrased copy under the same title",
    a: {
      slug: "answer-pipeline",
      title: "How the answer tool answers",
      body:
        "The answer tool retrieves knowledge docs and code matches, gates them on origin, verdict and confidence, " +
        "then synthesizes a cited answer with a small model; with synthesis off it returns the raw sources.",
    },
    b: {
      slug: "answer-pipeline",
      title: "How the answer tool answers",
      body:
        "The answer tool pulls matching docs plus grep hits from the repo, drops anything untrusted, disputed " +
        "or stale, and has a model write an answer citing them. Without a model it lists what it found.",
    },
    cosine: 0.885,
    duplicate: true,
  },
  {
    name: "fork of one design doc under the same slug in another project",
    a: {
      slug: "sealed-schemas",
      title: "Sealed API schemas for v1",
      body:
        "The upload, render and export operations are sealed for v1: request and response shapes may only " +
        "gain optional fields. Breaking changes wait for v2 and need a version bump of the model package.",
    },
    b: {
      slug: "sealed-schemas",
      title: "v1 sealed schemas",
      body:
        "For release one the upload/render/export shapes are sealed. Only optional fields may be added; " +
        "anything breaking is deferred to v2 together with a model version bump.",
    },
    cosine: 0.851,
    duplicate: true,
  },
  {
    name: "restatement of one workaround under a reworded title",
    a: {
      slug: "dev-server-needs-inotify-watch-limit",
      title: "The dev server requires a raised inotify watch limit on Linux",
      body:
        "On Linux the dev server fails with ENOSPC watcher errors unless the inotify watch limit is " +
        "raised above the default. Raise it with sysctl and restart the dev server.",
    },
    b: {
      slug: "linux-inotify-watch-workaround",
      title: "Linux inotify watch workaround",
      body:
        "File watching breaks on a default Linux install because the inotify watch limit is low. The fix is " +
        "a raised inotify limit (sysctl fs.inotify.max_user_watches) for the dev server.",
    },
    cosine: 0.924,
    duplicate: true,
  },
  {
    name: "sibling status docs for two components of one system",
    a: {
      slug: "render-service-di-verified",
      title: "Render service dependency injection verified",
      body:
        "The render service now wires its handlers through the injector; the record builders compile and " +
        "the render path was exercised against the staging stack.",
    },
    b: {
      slug: "catalog-service-di-done",
      title: "Catalog service dependency injection done",
      body:
        "The catalog service registry handlers moved to constructor injection; the upload and approve paths " +
        "build with the generated builders and pass their integration suite.",
    },
    cosine: 0.894,
    duplicate: false,
  },
  {
    name: "a product spec and its implementation doc",
    a: {
      slug: "always-on-orchestrator",
      title: "Always-on orchestrator implementation",
      body:
        "The orchestrator runs as a long-lived worker in the collector process, wakes on inbox events and " +
        "dispatches jobs through the launcher; its state lives in the persona tables.",
    },
    b: {
      slug: "product-always-on-orchestrator",
      title: "Product: an assistant that is always on",
      body:
        "Owners want one assistant that keeps working while they are away: it watches their sessions, answers " +
        "routine questions for them and only escalates what needs a decision.",
    },
    cosine: 0.909,
    duplicate: false,
  },
  {
    name: "two docs about one subsystem",
    a: {
      slug: "catalog-service-responsibilities",
      title: "Catalog service responsibilities",
      body:
        "The catalog service owns the registry, widget authoring and approvals; it never renders content " +
        "and exposes only the management API.",
    },
    b: {
      slug: "render-service-responsibilities",
      title: "Render service responsibilities",
      body:
        "The render service renders submitted widgets against published themes, caches results and reports " +
        "scorecards; it reads the registry but never writes to it.",
    },
    cosine: 0.854,
    duplicate: false,
  },
];

const runbook = (service: string) =>
  [
    `1. Page the ${service} on-call and post in #${service}-ops.`,
    `2. Drain the ${service} queue: \`svc drain ${service} --wait\`.`,
    `3. Restart the ${service} workers with \`svc restart ${service}\`.`,
    `4. Watch the ${service} error rate for ten minutes on the dashboard.`,
    `5. If errors persist, roll back the last ${service} deploy.`,
  ].join("\n");

PAIRS.push(
  {
    name: "two runbooks filled in from one template for different services",
    a: { slug: "runbook-ingest-restart", title: "Restart the ingest service", body: runbook("ingest") },
    b: { slug: "runbook-billing-restart", title: "Restart the billing service", body: runbook("billing") },
    cosine: 0.93,
    duplicate: false,
  },
  {
    name: "one incident described under two subjects, with the same values",
    a: {
      slug: "postgres-pool-exhaustion",
      title: "Postgres pool exhaustion",
      body:
        "Postgres pool exhaustion: the API opens a connection per request and the pool caps at 20, so under load " +
        "requests queue for 30s and time out. The postgres pool limit is set in api/config.ts; raise it with " +
        "the instance size, and reuse connections across a request.",
    },
    b: {
      slug: "database-connection-limit",
      title: "Database connection limit",
      body:
        "Database connection limit: the API opens a connection per request and the pool caps at 20, so under load " +
        "requests queue for 30s and time out. The database connection limit is set in api/config.ts; raise it " +
        "with the instance size, and reuse connections across a request.",
    },
    cosine: 0.944,
    duplicate: true,
  },
  {
    name: "token overlap with neither the title nor the embedding agreeing",
    a: { slug: "checklist-a", title: "Release checklist", body: runbook("checkout") },
    b: { slug: "oncall-guide", title: "On-call handbook", body: `${runbook("checkout")}\nEscalate after an hour.` },
    cosine: 0.8,
    duplicate: false,
  }
);

describe("isDuplicate on the labeled set", () => {
  for (const p of PAIRS) {
    test(`${p.duplicate ? "duplicate" : "distinct"}: ${p.name}`, () => {
      expect(isDuplicate(dupFeatures(p.a, p.b, p.cosine))).toBe(p.duplicate);
    });
  }

  test("precision is 1 and every labeled duplicate is caught", () => {
    const predicted = PAIRS.map((p) => isDuplicate(dupFeatures(p.a, p.b, p.cosine)));
    const fp = PAIRS.filter((p, i) => predicted[i] && !p.duplicate).length;
    const fn = PAIRS.filter((p, i) => !predicted[i] && p.duplicate).length;
    expect({ fp, fn }).toEqual({ fp: 0, fn: 0 });
  });

  test("without an embedding provider only a lexical restatement counts", () => {
    expect(isDuplicate(dupFeatures(PAIRS[0]!.a, PAIRS[0]!.b, undefined))).toBe(true);
    expect(isDuplicate(dupFeatures(PAIRS[2]!.a, PAIRS[2]!.b, undefined))).toBe(false);
  });
});

describe("value differences", () => {
  test("a near-duplicate that corrects a value is reported with what changed", () => {
    const a = { slug: "region", title: "Deploy region", body: "The stack deploys to us-west-2 with 3 AZs." };
    const b = { slug: "region-old", title: "Deploy region", body: "The stack deploys to us-east-1 with 3 AZs." };
    expect(isDuplicate(dupFeatures(a, b, 0.976))).toBe(true);
    expect(valueDifferences(a.body, b.body)).toEqual(["us-west-2 here", "us-east-1 in the existing doc"]);
  });
});

describe("lexical signals", () => {
  test("containment is 0 when the sets differ widely in size", () => {
    const short = "backoff capped at thirty seconds";
    const long = `${short} ${"unrelated filler vocabulary words appear here many times ".repeat(4)}${Array.from(
      { length: 40 },
      (_, i) => `term${i}`
    ).join(" ")}`;
    expect(lexicalOverlap(short, long).containment).toBe(0);
  });

  test("similarityOf reports 1 for an identical copy", () => {
    expect(similarityOf(dupFeatures(PAIRS[0]!.a, PAIRS[0]!.b, 0.93))).toBe(1);
  });
});

function hit(projectId: string, slug: string, rawScore: number, score = 0.01): SearchResult {
  return {
    id: `${projectId}/${slug}`,
    projectId,
    slug,
    title: slug,
    excerpt: "",
    score,
    rawScore,
    source: "embedding",
    originClass: "agent",
    sourceKind: "code",
    generated: true,
  };
}

function file(slug: string, title: string, body: string, extra: Partial<KnowledgeDocFile> = {}): KnowledgeDocFile {
  return { slug, title, body, tags: [], updatedAt: new Date(), sourceKind: "code", ...extra };
}

describe("findNearestDocs", () => {
  const subject = PAIRS[0]!.a;

  test("searches the audience with the text arm weighted out and ranks by raw cosine", async () => {
    const calls: unknown[] = [];
    const nearest = await findNearestDocs(
      {
        search: async (_p, _q, options) => {
          calls.push(options);
          // The fused order favors the local project; the copy in another
          // project has the higher raw cosine.
          return [hit("p", "related", 0.8, 0.05), hit("other", "slack-mirror-retry-policy", 1, 0.01)];
        },
        readAcceptedDoc: async (pid, slug) =>
          pid === "other" ? file(slug, subject.title, subject.body) : file(slug, "Related", "something else entirely"),
      },
      "p",
      subject,
      { audience: { projectId: "p", user: "alice" } }
    );
    expect(calls[0]).toMatchObject({
      corpus: "all",
      audience: { projectId: "p", user: "alice" },
      textWeight: 0,
      embeddingWeight: 1,
    });
    expect(nearest.map((n) => `${n.projectId}/${n.slug}`)).toEqual(["other/slack-mirror-retry-policy", "p/related"]);
    expect(nearest[0]!.duplicate).toBe(true);
    expect(nearest[1]!.duplicate).toBe(false);
  });

  test("never matches the doc itself, an excluded doc, or a superseded copy", async () => {
    const nearest = await findNearestDocs(
      {
        search: async () => [
          hit("p", subject.slug, 1),
          hit("p", "replaced", 1),
          hit("q", "retired", 1),
        ],
        readAcceptedDoc: async (_pid, slug) => file(slug, subject.title, subject.body),
        getVerdict: (pid, slug) => (pid === "q" && slug === "retired" ? "superseded" : undefined),
      },
      "p",
      subject,
      { exclude: ["p/replaced"] }
    );
    expect(nearest).toEqual([]);
  });

  test("text-only search keeps the default weights and judges on token overlap alone", async () => {
    let options: unknown;
    const nearest = await findNearestDocs(
      {
        embeddingsEnabled: false,
        search: async (_p, _q, o) => {
          options = o;
          return [hit("p", "copy", 0.4)];
        },
        readAcceptedDoc: async (_pid, slug) => file(slug, subject.title, subject.body),
      },
      "p",
      subject
    );
    expect(options).toEqual({ corpus: "project", limit: 30 });
    expect(nearest[0]!.features.cosine).toBeUndefined();
    expect(nearest[0]!.duplicate).toBe(true);
  });

  test("marks a copy past the refusal bar and carries the doc's search id", async () => {
    const nearest = await findNearestDocs(
      {
        search: async () => [hit("p", "copy", 0.99), hit("p", "paraphrase", 0.93)],
        readAcceptedDoc: async (_pid, slug) =>
          slug === "copy" ? file(slug, subject.title, subject.body) : file(slug, subject.title, PARAPHRASE_BODY),
      },
      "p",
      { ...subject, slug: "new-slug" }
    );
    expect(nearest.map((n) => [n.id, n.duplicate, n.highConfidence])).toEqual([
      ["p/copy", true, true],
      ["p/paraphrase", true, false],
    ]);
  });
});

/**
 * The write-time refusal bar, on labelled pairs against one published doc.
 * Each row gives the cosine an embedding provider would report for the pair
 * (deterministic stand-ins for the class: copies 0.975–1, paraphrases
 * 0.93–0.985, related docs 0.78–0.84) and is judged twice — with that cosine and
 * with none (the text-search-only install, lexical signals alone).
 *  - TRUE DUPLICATE: the same body, give or take whitespace, markdown or title
 *    case → refused.
 *  - NEAR-PARAPHRASE: the same facts reworded, a section added, a value
 *    corrected → NOT refused; it takes today's near-duplicate path.
 *  - MERELY RELATED: same topic, different facts → not refused and not a
 *    duplicate: it publishes.
 */
const PUBLISHED: DedupSubject = {
  slug: "slack-mirror-retry-policy",
  title: "Slack mirror retry policy",
  body:
    "The Slack mirror retries a failed post with exponential backoff, starting at 500ms and capped at 30s. " +
    "After five attempts the message is parked in the dead-letter table and surfaced on the Health panel. " +
    "Parked messages are never retried automatically; the backoff state lives in the mirror worker's memory, " +
    "so a collector restart resets every attempt counter.",
};

const PARAPHRASE_BODY =
  "When posting to Slack fails, the mirror waits and tries again, doubling the delay from half a second up " +
  "to thirty seconds. A message that still fails after its fifth try lands in a dead-letter table that the " +
  "Health panel lists, and nothing re-sends it on its own. Attempt counts are kept only in memory.";

type DupClass = "TRUE DUPLICATE" | "NEAR-PARAPHRASE" | "MERELY RELATED";

interface RefusalCase {
  label: DupClass;
  name: string;
  candidate: DedupSubject;
  cosine: number;
}

const REFUSAL_CASES: RefusalCase[] = [
  { label: "TRUE DUPLICATE", name: "identical", candidate: { ...PUBLISHED, slug: "retry-copy" }, cosine: 1 },
  {
    label: "TRUE DUPLICATE",
    name: "whitespace-only change",
    candidate: { ...PUBLISHED, slug: "retry-copy", body: PUBLISHED.body.replace(/\. /g, ".\n\n  ") + "\n" },
    cosine: 0.995,
  },
  {
    label: "TRUE DUPLICATE",
    name: "markdown-only change (heading, bold, code spans, bullets)",
    candidate: {
      ...PUBLISHED,
      slug: "retry-copy",
      body:
        "## Retry policy\n\n" +
        "- The **Slack mirror** retries a failed post with exponential backoff, starting at `500ms` and capped at `30s`.\n" +
        "- After five attempts the message is parked in the `dead-letter` table and surfaced on the *Health panel*.\n" +
        "- Parked messages are never retried automatically; the backoff state lives in the mirror worker's memory, " +
        "so a collector restart resets every attempt counter.",
    },
    cosine: 0.985,
  },
  {
    label: "TRUE DUPLICATE",
    name: "same body, title case changed",
    candidate: { ...PUBLISHED, slug: "retry-copy", title: "SLACK MIRROR RETRY POLICY" },
    cosine: 0.998,
  },
  {
    label: "NEAR-PARAPHRASE",
    name: "same facts reworded",
    candidate: { slug: "retry-reworded", title: "Slack mirror retry policy", body: PARAPHRASE_BODY },
    cosine: 0.93,
  },
  {
    label: "NEAR-PARAPHRASE",
    name: "a section added",
    candidate: {
      ...PUBLISHED,
      slug: "retry-with-replay",
      body:
        `${PUBLISHED.body}\n\n## Replaying parked messages\n` +
        "Operators replay a parked message from the Health panel's replay button; a replay keeps the original " +
        "ordering and resets that message's attempt counter before the first retry.",
    },
    cosine: 0.96,
  },
  {
    label: "NEAR-PARAPHRASE",
    name: "a value corrected",
    candidate: { ...PUBLISHED, slug: "retry-cap-fix", body: PUBLISHED.body.replace("capped at 30s", "capped at 60s") },
    cosine: 0.985,
  },
  {
    label: "MERELY RELATED",
    name: "same subsystem, different facts",
    candidate: {
      slug: "slack-mirror-batching",
      title: "Slack mirror batching",
      body:
        "The Slack mirror batches outgoing posts per channel, flushing every 2s or at 20 messages, and splits " +
        "a message longer than 40,000 characters into threaded replies. Batches are keyed by channel id.",
    },
    cosine: 0.84,
  },
  {
    label: "MERELY RELATED",
    name: "same topic word, another component",
    candidate: {
      slug: "slack-oauth-scopes",
      title: "Slack app OAuth scopes",
      body:
        "The Slack app requests chat:write, channels:history and users:read; installing it into a workspace " +
        "needs an admin, and a missing scope surfaces as missing_scope on the first post.",
    },
    cosine: 0.78,
  },
];

describe("write-time refusal bar", () => {
  test("sits strictly above every isDuplicate threshold", () => {
    for (const bar of [DUP_COSINE_STRICT, DUP_COSINE, DUP_COSINE_TITLED, DUP_COSINE_REWORDED]) {
      expect(DUPLICATE_REJECT_COSINE).toBeGreaterThan(bar);
    }
    expect(DUPLICATE_REJECT_LEXICAL_JACCARD).toBeGreaterThan(NEAR_DUP_LEXICAL_THRESHOLD);
    expect(DUPLICATE_REJECT_LEXICAL_CONTAINMENT).toBeGreaterThan(NEAR_DUP_CONTAINMENT_THRESHOLD);
  });

  for (const variant of ["with an embedding", "lexical only"] as const) {
    describe(variant, () => {
      for (const c of REFUSAL_CASES) {
        const features = () => dupFeatures(c.candidate, PUBLISHED, variant === "lexical only" ? undefined : c.cosine);
        test(`${c.label}: ${c.name} → ${c.label === "TRUE DUPLICATE" ? "refused" : "not refused"}`, () => {
          const f = features();
          expect(isHighConfidenceDuplicate(f)).toBe(c.label === "TRUE DUPLICATE");
          if (c.label === "MERELY RELATED") expect(isDuplicate(f)).toBe(false);
          if (isHighConfidenceDuplicate(f)) expect(isDuplicate(f)).toBe(true);
        });
      }
    });
  }

  test("near-paraphrases above isDuplicate's own bar still go to today's near-duplicate path", () => {
    const sectionAdded = REFUSAL_CASES.find((c) => c.name === "a section added")!;
    const f = dupFeatures(sectionAdded.candidate, PUBLISHED, sectionAdded.cosine);
    expect(isDuplicate(f)).toBe(true);
    expect(isHighConfidenceDuplicate(f)).toBe(false);
  });

  test("on the labelled isDuplicate set it refuses only the copies: the byte copy and the notation-only edit", () => {
    const refused = PAIRS.filter((p) => isHighConfidenceDuplicate(dupFeatures(p.a, p.b, p.cosine))).map((p) => p.name);
    expect(refused).toEqual(["byte copy in a frozen copy project", "light edit"]);
  });

  test("a long doc copied for its first 2000 characters with a section added after them is not refused", () => {
    const paragraph =
      "The ingest worker reads batches from the queue, validates each record against the schema, " +
      "writes accepted records to the warehouse and parks rejected ones in the review table. ";
    let body = "";
    while (body.length < 2400) body += paragraph;
    const published = { slug: "ingest-worker", title: "Ingest worker pipeline", body };
    const added =
      "\n\n## Backpressure\n\nWhen the warehouse lags, the worker pauses polling, drains its local buffer, " +
      "emits a throttling event for the operators dashboard, and resumes once replication catches up again.";
    const candidate = { slug: "ingest-worker-notes", title: "Ingest worker pipeline", body: body + added };
    expect(`${candidate.title}\n${candidate.body}`.slice(0, 2000)).toBe(
      `${published.title}\n${published.body}`.slice(0, 2000)
    );

    // The truncated query embeds like the published doc: a copy's cosine.
    const f = dupFeatures(candidate, published, 0.995);
    expect(isDuplicate(f)).toBe(true);
    expect(f.titleSimilarity).toBe(1);
    expect(f.twoWayContainment).toBeLessThan(DUPLICATE_REJECT_TWO_WAY_CONTAINMENT);
    expect(isHighConfidenceDuplicate(f)).toBe(false);
    expect(isHighConfidenceDuplicate(dupFeatures(candidate, published, undefined))).toBe(false);
  });

  test("a section repeating the doc's own vocabulary is caught by the full-text size ratio", () => {
    const sentence = "Restart the ingest worker after a schema change so it reloads the validator. ";
    const body = sentence.repeat(20);
    const published = { slug: "restart", title: "Restart the ingest worker", body };
    const candidate = { slug: "restart-2", title: "Restart the ingest worker", body: body + sentence.repeat(5) };
    const f = dupFeatures(candidate, published, 0.995);
    expect(f.twoWayContainment).toBe(1);
    expect(f.sizeRatio).toBeLessThan(DUPLICATE_REJECT_SIZE_RATIO);
    expect(isHighConfidenceDuplicate(f)).toBe(false);
    // A whitespace-only change keeps both full-text signals at a copy's level.
    const respaced = { ...published, slug: "restart-3", body: body.replace(/\. /g, ".\n") };
    const copy = dupFeatures(respaced, published, 0.995);
    expect(copy.sizeRatio).toBe(1);
    expect(isHighConfidenceDuplicate(copy)).toBe(true);
  });

  test("an edit that changes a named value is never refused, at any cosine", () => {
    const a = { slug: "region", title: "Deploy region", body: "The stack deploys to us-west-2 with 3 AZs." };
    const b = { slug: "region-old", title: "Deploy region", body: "The stack deploys to us-east-1 with 3 AZs." };
    expect(isHighConfidenceDuplicate(dupFeatures(a, b, 0.995))).toBe(false);
    expect(isHighConfidenceDuplicate(dupFeatures(a, b, undefined))).toBe(false);
  });

  test("a related doc in the 0.80 band is an update candidate; one below it, or a duplicate, is not", () => {
    const related = REFUSAL_CASES.filter((c) => c.label === "MERELY RELATED");
    expect(related.map((c) => isUpdateCandidate(dupFeatures(c.candidate, PUBLISHED, c.cosine)))).toEqual([true, false]);
    const copy = REFUSAL_CASES[0]!;
    expect(isUpdateCandidate(dupFeatures(copy.candidate, PUBLISHED, copy.cosine))).toBe(false);
  });
});

describe("refusal and hint text", () => {
  const near = (projectId: string): NearestDoc => ({
    id: `${projectId}/slack-mirror-retry-policy`,
    projectId,
    slug: "slack-mirror-retry-policy",
    title: "Slack mirror retry policy",
    similarity: 1,
    duplicate: true,
    highConfidence: true,
    features: dupFeatures(PUBLISHED, PUBLISHED, 1),
    differences: [],
  });

  test("names the doc and the update call, with its project only when it lives elsewhere", () => {
    expect(duplicateRefusal("p", near("p"))).toEqual({
      ok: false,
      published: false,
      refused: "duplicate",
      duplicateOf: { project: "p", slug: "slack-mirror-retry-policy", id: "p/slack-mirror-retry-policy", title: "Slack mirror retry policy" },
      message:
        'This duplicates p/slack-mirror-retry-policy. Update that doc instead: call propose_knowledge with slug "slack-mirror-retry-policy".',
    });
    expect(duplicateRefusal("p", near("global")).message).toBe(
      'This duplicates global/slack-mirror-retry-policy. Update that doc instead: call propose_knowledge with slug ' +
        '"slack-mirror-retry-policy", project "global".'
    );
  });

  test("the update hint suggests the close doc", () => {
    expect(updateHint("p", near("p"))).toBe(
      'Close to p/slack-mirror-retry-policy — consider updating it instead: propose_knowledge with slug "slack-mirror-retry-policy".'
    );
  });
});
