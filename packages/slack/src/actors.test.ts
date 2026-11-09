// Actor reconciliation: fold a Slack answerer's slack:U… actor into their
// alias via users.info(profile.email), only when the email is at the configured
// identity email domain. Verifies the success path (email → alias →
// mergeActor), the domain gate (no domain merges no one; another domain or a
// subdomain is left unmerged), once-per-user dedup, a missing email leaving the
// actors unmerged, and graceful degradation when the workspace lacks the
// users:read* scopes — a SINGLE deduped reinstall hint, never a throw.
// Recording fakes stand in for the Slack web client and the collector, so no
// live call runs.

import { describe, expect, test } from "bun:test";
import { ActorReconciler, MISSING_SCOPE_HINT, aliasForEmail, type UsersInfoClient, type ActorMergeSink } from "./actors.js";
import { normalizeEmailDomain } from "./env.js";

const DOMAIN = "example.com";

interface Merge {
  fromId: string;
  intoId: string;
}

/** A collector fake that records every mergeActor call. */
function makeCollector(): { collector: ActorMergeSink; merges: Merge[] } {
  const merges: Merge[] = [];
  return {
    merges,
    collector: {
      mergeActor: async (fromId: string, intoId: string) => {
        merges.push({ fromId, intoId });
        return true;
      },
    },
  };
}

/** A users.info fake: return a canned profile per user, or throw a canned error. */
function makeWeb(
  behavior: (user: string) => { email?: string } | Error,
): { web: UsersInfoClient; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    web: {
      users: {
        info: async ({ user }: { user: string }) => {
          calls.push(user);
          const r = behavior(user);
          if (r instanceof Error) throw r;
          return { user: { profile: { email: r.email } } };
        },
      },
    },
  };
}

/** A Slack platform error the way @slack/web-api surfaces missing_scope. */
function missingScopeError(): Error {
  const err = new Error("An API error occurred: missing_scope") as Error & { data?: { error?: string } };
  err.data = { error: "missing_scope" };
  return err;
}

describe("ActorReconciler — success path", () => {
  test("resolves email → alias and merges the slack actor into it", async () => {
    const { web } = makeWeb(() => ({ email: "Alice@Example.com" }));
    const { collector, merges } = makeCollector();
    const r = new ActorReconciler(web, collector, DOMAIN);

    await r.reconcile("U123");

    expect(merges).toEqual([{ fromId: "slack:U123", intoId: "alice" }]); // local-part, lowercased
  });

  test("only attempts each user once per run (dedup)", async () => {
    const { web, calls } = makeWeb(() => ({ email: "a@example.com" }));
    const { collector, merges } = makeCollector();
    const r = new ActorReconciler(web, collector, DOMAIN);

    await r.reconcile("U1");
    await r.reconcile("U1");
    await r.reconcile("U1");

    expect(calls).toEqual(["U1"]); // one lookup
    expect(merges).toHaveLength(1);
  });

  test("a user with no email is left unmerged (no crash)", async () => {
    const { web } = makeWeb(() => ({ email: undefined }));
    const { collector, merges } = makeCollector();
    const r = new ActorReconciler(web, collector, DOMAIN);

    await r.reconcile("Unoemail");

    expect(merges).toHaveLength(0);
  });
});

describe("ActorReconciler — the identity email domain gate", () => {
  test("with no domain configured nothing is looked up or merged", async () => {
    const { web, calls } = makeWeb(() => ({ email: "alice@example.com" }));
    const { collector, merges } = makeCollector();
    const r = new ActorReconciler(web, collector, undefined);

    await r.reconcile("U1");

    expect(r.enabled).toBe(false);
    expect(calls).toEqual([]);
    expect(merges).toEqual([]);
  });

  test("an email at another domain, or a subdomain, is not merged into the alias it shares a local-part with", async () => {
    const emails: Record<string, string> = {
      Uguest: "alice@other-domain.com",
      Usub: "alice@mail.example.com",
      Ulookalike: "alice@example.com.evil.test",
      Uhome: "bob@example.com",
    };
    const { web } = makeWeb((user) => ({ email: emails[user] }));
    const { collector, merges } = makeCollector();
    const r = new ActorReconciler(web, collector, DOMAIN);

    for (const user of Object.keys(emails)) await r.reconcile(user);

    expect(merges).toEqual([{ fromId: "slack:Uhome", intoId: "bob" }]);
  });

  test.each([
    ["alice@example.com", "example.com", "alice"],
    ["  Alice@EXAMPLE.com ", "example.com", "alice"],
    ["alice@other.com", "example.com", undefined],
    ["alice@sub.example.com", "example.com", undefined],
    ["@example.com", "example.com", undefined],
    ["alice", "example.com", undefined],
    ["a@b@example.com", "example.com", undefined],
    ["alice@example.com", undefined, undefined],
    [undefined, "example.com", undefined],
  ] as const)("aliasForEmail(%p, %p) is %p", (email, domain, expected) => {
    expect(aliasForEmail(email, domain)).toBe(expected);
  });

  test.each([
    ["example.com", "example.com"],
    [" @Example.COM ", "example.com"],
    ["", undefined],
    [undefined, undefined],
    ["localhost", undefined],
    ["example.com/path", undefined],
    ["*.example.com", undefined],
  ] as const)("normalizeEmailDomain(%p) is %p", (value, expected) => {
    expect(normalizeEmailDomain(value)).toBe(expected);
  });
});

describe("ActorReconciler — graceful degradation", () => {
  test("missing_scope logs the reinstall hint ONCE across many users, never throws", async () => {
    const { web } = makeWeb(() => missingScopeError());
    const { collector, merges } = makeCollector();
    const warnings: string[] = [];
    const r = new ActorReconciler(web, collector, DOMAIN, (m) => warnings.push(m));

    // Every user hits the scope error — but the operator sees one hint, not N.
    await r.reconcile("U1");
    await r.reconcile("U2");
    await r.reconcile("U3");

    expect(merges).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toBe(MISSING_SCOPE_HINT);
    expect(warnings[0]).toContain("Reinstall");
    expect(warnings[0]).toContain("users:read.email");
  });

  test("detects missing_scope from the message alone (no structured data)", async () => {
    const { web } = makeWeb(() => new Error("An API error occurred: missing_scope"));
    const { collector } = makeCollector();
    const warnings: string[] = [];
    const r = new ActorReconciler(web, collector, DOMAIN, (m) => warnings.push(m));

    await r.reconcile("U1");

    expect(warnings).toEqual([MISSING_SCOPE_HINT]);
  });

  test("a non-scope error is logged per user (not the reinstall hint) and never throws", async () => {
    const { web } = makeWeb(() => new Error("rate_limited"));
    const { collector, merges } = makeCollector();
    const warnings: string[] = [];
    const r = new ActorReconciler(web, collector, DOMAIN, (m) => warnings.push(m));

    await r.reconcile("U1");
    await r.reconcile("U2");

    expect(merges).toHaveLength(0);
    expect(warnings).toHaveLength(2); // once per user (each user is attempted once)
    for (const w of warnings) {
      expect(w).toContain("reconcile failed");
      expect(w).not.toBe(MISSING_SCOPE_HINT);
    }
  });

  test("a scope failure for one user still lets a later successful user merge", async () => {
    const { web } = makeWeb((user) => (user === "Ubad" ? missingScopeError() : { email: "ok@example.com" }));
    const { collector, merges } = makeCollector();
    const warnings: string[] = [];
    const r = new ActorReconciler(web, collector, DOMAIN, (m) => warnings.push(m));

    await r.reconcile("Ubad");
    await r.reconcile("Ugood");

    expect(warnings).toEqual([MISSING_SCOPE_HINT]);
    expect(merges).toEqual([{ fromId: "slack:Ugood", intoId: "ok" }]);
  });
});
