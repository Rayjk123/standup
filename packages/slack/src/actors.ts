// Actor identity reconciliation for Slack users.
//
// A teammate who answers in Slack mints a `slack:U…` actor, while the same person
// driving sessions through the console mints an alias actor (the identity
// header's value). Folding the two together keeps one teammate from being
// counted as two collaborators (identity reconciliation / cost-by-user
// attribution). The only bridge Slack gives us is the user's email, read via
// `users.info` (needs the `users:read` + `users:read.email` scopes).
//
// An email's local-part is the person's alias only in an org whose mail domain
// maps one-to-one onto the aliases the identity header carries. So a merge
// happens only when the operator names that domain (SLACK_IDENTITY_EMAIL_DOMAIN,
// else the org profile's `identity.emailDomain`; see identityEmailDomainFrom in
// env.ts) and the email is at exactly that domain. With no domain configured, or
// with SLACK_IDENTITY_EMAIL_DOMAIN set to a value that is not a domain, nothing is
// merged: a Slack Connect guest or any member at another domain would otherwise
// be folded into whichever alias shares their local-part, and inherit that
// alias's attribution and project standing.
//
// Reconciliation is best-effort and never fatal: it runs once per user per run,
// a missing or off-domain email simply leaves the two actors unmerged, and a missing-scope
// failure (the app was installed before those scopes were granted) logs ONE
// operator hint to reinstall — deduped, not once per user — then keeps failing
// safe so a lookup error can never crash the event loop.

import { slackActor } from "./asks.js";

/** The `users.info` surface the reconciler needs — narrowed so a test needs no live web client. */
export interface UsersInfoClient {
  users: {
    info(args: { user: string }): Promise<{ user?: { profile?: { email?: string } } }>;
  };
}

/** The collector merge surface — narrowed to just the actor merge. */
export interface ActorMergeSink {
  mergeActor(fromId: string, intoId: string): Promise<unknown>;
}

/** The one-time hint shown when the workspace lacks the user-lookup scopes. */
export const MISSING_SCOPE_HINT =
  "[actors] Can't read Slack user emails (missing users:read / users:read.email), so Slack answerers stay counted as a separate collaborator instead of merging with their alias identity. Reinstall the app to grant the new scopes: reimport manifest.yaml, then OAuth & Permissions → Reinstall to Workspace.";

/**
 * A Slack Web API "missing_scope" platform error — surfaced either as the
 * structured `data.error` (`@slack/web-api`) or in the thrown message. Detected so
 * the reconciler can distinguish a fixable install problem (log the reinstall
 * hint once) from a transient per-user lookup failure.
 */
function isMissingScope(err: unknown): boolean {
  const dataError = (err as { data?: { error?: string } } | undefined)?.data?.error;
  if (dataError === "missing_scope") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /missing_scope/i.test(msg);
}

/** The startup note shown when no identity email domain is configured, so Slack actors stay unmerged. */
export const NO_EMAIL_DOMAIN_NOTE =
  "ℹ️  No identity email domain (SLACK_IDENTITY_EMAIL_DOMAIN is set to a value that is not a domain, or it is unset and the org profile names no identity.emailDomain), so Slack answerers stay separate collaborators from their console alias. Set SLACK_IDENTITY_EMAIL_DOMAIN or the org profile's identity.emailDomain to the mail domain whose addresses are <alias>@<domain> to merge them.";

/**
 * The alias an email names under `emailDomain` (normalized, see the env's
 * normalizeEmailDomain): its lowercased local-part when the address is at
 * exactly that domain (not a subdomain), else undefined.
 */
export function aliasForEmail(email: string | undefined, emailDomain: string | undefined): string | undefined {
  if (!email || !emailDomain) return undefined;
  const at = email.lastIndexOf("@");
  if (at <= 0) return undefined;
  const local = email.slice(0, at).trim().toLowerCase();
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (domain !== emailDomain || !local || local.includes("@")) return undefined;
  return local;
}

export class ActorReconciler {
  private readonly reconciled = new Set<string>();
  private warnedMissingScope = false;

  /**
   * `emailDomain` is the normalized identity email domain (normalizeEmailDomain);
   * undefined turns reconciliation off.
   */
  constructor(
    private readonly web: UsersInfoClient,
    private readonly collector: ActorMergeSink,
    private readonly emailDomain: string | undefined,
    private readonly warn: (message: string) => void = (m) => console.warn(m),
  ) {}

  /** Whether a merge can happen at all: an identity email domain is configured. */
  get enabled(): boolean {
    return this.emailDomain !== undefined;
  }

  /**
   * Fold `userId`'s `slack:U…` actor into their alias actor, once per user per
   * run, when their email is at the configured domain. Marks the user attempted
   * BEFORE the lookup so a transient failure isn't retried on every subsequent
   * event; a missing-scope failure logs the reinstall hint at most once across
   * all users. Does nothing (no lookup) when no domain is configured.
   */
  async reconcile(userId: string): Promise<void> {
    if (!this.enabled) return;
    if (this.reconciled.has(userId)) return;
    this.reconciled.add(userId);
    try {
      const info = await this.web.users.info({ user: userId });
      const alias = aliasForEmail(info.user?.profile?.email, this.emailDomain);
      if (alias) await this.collector.mergeActor(slackActor(userId), alias);
    } catch (err) {
      if (isMissingScope(err)) {
        if (this.warnedMissingScope) return;
        this.warnedMissingScope = true;
        this.warn(MISSING_SCOPE_HINT);
        return;
      }
      this.warn(`[actors] reconcile failed for ${userId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
