// Per-user notification routing: which kinds of Persona update leave the
// console, through which channels, and on which conditions. Every message is
// always in the owner's console thread; a route adds Slack DM and ntfy push.
//
// Prefs layer like the delivery pipeline's config: the defaults, then the
// user's global layer, then the user's layer for a project. The brief (time,
// on/off) and the timezone are user-level only — the brief covers every
// project — so a project layer may override only the per-kind routes of
// updates about that project's jobs.

/** The kinds of update a user routes. */
export const NOTIFY_KINDS = ["decision", "progress", "done", "brief"] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

/** Where an update goes beyond the console thread, which always has it. */
export const NOTIFY_CHANNELS = ["slack", "push"] as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

/**
 * The conditions each kind may notify on:
 * - decision: `always` (approvals and questions) or `approvals_only`;
 * - progress: `always`, `needs_you` (only updates about a job waiting on the
 *   user), or `never`;
 * - done: `always` or `failures_only` (a job closed failed or cancelled);
 * - brief: `actionable` (silent when nothing changed and nothing waits on the
 *   user) or `always`.
 */
export const NOTIFY_CONDITIONS = {
  decision: ["always", "approvals_only"],
  progress: ["always", "needs_you", "never"],
  done: ["always", "failures_only"],
  brief: ["actionable", "always"],
} as const satisfies Record<NotifyKind, readonly string[]>;
export type NotifyCondition<K extends NotifyKind = NotifyKind> = (typeof NOTIFY_CONDITIONS)[K][number];

export interface NotifyRoute<K extends NotifyKind = NotifyKind> {
  channels: NotifyChannel[];
  when: NotifyCondition<K>;
}

export interface NotifyPrefs {
  routes: { [K in NotifyKind]: NotifyRoute<K> };
  brief: {
    /** Unset: on, unless the user still runs a recurring report schedule of their own (see the brief's switch-over). */
    enabled?: boolean;
    /** Local time of day, `HH:MM`, in `timezone`. */
    time: string;
  };
  /** IANA zone the brief time is in; unset: the host's owner timezone. */
  timezone?: string;
}

/** One stored layer: any subset of the prefs. */
export interface NotifyOverride {
  routes?: { [K in NotifyKind]?: { channels?: NotifyChannel[]; when?: NotifyCondition<K> } };
  brief?: { enabled?: boolean; time?: string };
  timezone?: string;
}

export const DEFAULT_BRIEF_TIME = "08:30";

export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = {
  routes: {
    decision: { channels: ["slack", "push"], when: "always" },
    progress: { channels: [], when: "needs_you" },
    done: { channels: [], when: "always" },
    brief: { channels: ["slack"], when: "actionable" },
  },
  brief: { time: DEFAULT_BRIEF_TIME },
};

/** The kinds a project layer may route; the brief is user-level only. */
export const PROJECT_NOTIFY_KINDS: readonly NotifyKind[] = ["decision", "progress", "done"];

/** How a Persona message was routed, stored on the message so Slack replays it the same way. */
export interface PersonaMessageNotify {
  kind: NotifyKind;
  channels: NotifyChannel[];
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Whether `tz` names a zone this runtime knows. */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** `HH:MM` as hour and minute, or null when malformed. */
export function parseBriefTime(time: string): { hour: number; minute: number } | null {
  const m = TIME_RE.exec(time);
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
}

/**
 * Checks a layer before it is stored. A project layer (`projectLayer`) may
 * set only the routes of PROJECT_NOTIFY_KINDS. Returns the layer with only the
 * known fields kept, or every problem found.
 */
export function validateNotifyOverride(
  raw: unknown,
  opts: { projectLayer?: boolean } = {}
): { ok: true; value: NotifyOverride } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (!isObject(raw)) return { ok: false, errors: ["the override must be an object"] };
  const value: NotifyOverride = {};
  for (const key of Object.keys(raw)) {
    if (key !== "routes" && key !== "brief" && key !== "timezone") errors.push(`unknown field: ${key}`);
  }

  if (raw.routes !== undefined) {
    if (!isObject(raw.routes)) errors.push("routes must be an object");
    else {
      const routes: Record<string, { channels?: NotifyChannel[]; when?: string }> = {};
      for (const [kind, route] of Object.entries(raw.routes)) {
        if (!(NOTIFY_KINDS as readonly string[]).includes(kind)) {
          errors.push(`unknown update kind: ${kind}`);
          continue;
        }
        if (opts.projectLayer && !PROJECT_NOTIFY_KINDS.includes(kind as NotifyKind)) {
          errors.push(`routes.${kind} is set for every project at once, not per project`);
          continue;
        }
        if (!isObject(route)) {
          errors.push(`routes.${kind} must be an object`);
          continue;
        }
        const out: { channels?: NotifyChannel[]; when?: string } = {};
        for (const key of Object.keys(route)) {
          if (key !== "channels" && key !== "when") errors.push(`routes.${kind}: unknown field ${key}`);
        }
        if (route.channels !== undefined) {
          if (
            !Array.isArray(route.channels) ||
            !route.channels.every((c) => (NOTIFY_CHANNELS as readonly string[]).includes(c as string))
          ) {
            errors.push(`routes.${kind}.channels must list only ${NOTIFY_CHANNELS.join(", ")}`);
          } else out.channels = [...new Set(route.channels as NotifyChannel[])];
        }
        if (route.when !== undefined) {
          const allowed = NOTIFY_CONDITIONS[kind as NotifyKind] as readonly string[];
          if (typeof route.when !== "string" || !allowed.includes(route.when)) {
            errors.push(`routes.${kind}.when must be one of ${allowed.join(", ")}`);
          } else out.when = route.when;
        }
        routes[kind] = out;
      }
      value.routes = routes as NotifyOverride["routes"];
    }
  }

  if (raw.brief !== undefined) {
    if (opts.projectLayer) errors.push("the brief is set for every project at once, not per project");
    else if (!isObject(raw.brief)) errors.push("brief must be an object");
    else {
      const brief: { enabled?: boolean; time?: string } = {};
      for (const key of Object.keys(raw.brief)) {
        if (key !== "enabled" && key !== "time") errors.push(`brief: unknown field ${key}`);
      }
      if (raw.brief.enabled !== undefined) {
        if (typeof raw.brief.enabled !== "boolean") errors.push("brief.enabled must be true or false");
        else brief.enabled = raw.brief.enabled;
      }
      if (raw.brief.time !== undefined) {
        if (typeof raw.brief.time !== "string" || !parseBriefTime(raw.brief.time)) errors.push("brief.time must be HH:MM (24-hour)");
        else brief.time = raw.brief.time;
      }
      value.brief = brief;
    }
  }

  if (raw.timezone !== undefined) {
    if (opts.projectLayer) errors.push("the timezone is set for every project at once, not per project");
    else if (typeof raw.timezone !== "string" || !isValidTimezone(raw.timezone)) errors.push("timezone must be an IANA zone, e.g. America/New_York");
    else value.timezone = raw.timezone;
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

/**
 * The prefs in force: DEFAULT_NOTIFY_PREFS with each layer applied in order,
 * later layers winning field by field. A malformed field in a stored layer is
 * ignored rather than failing the resolve.
 */
export function resolveNotifyPrefs(layers: Array<NotifyOverride | null | undefined>): NotifyPrefs {
  const routes = Object.fromEntries(
    NOTIFY_KINDS.map((k) => [k, { channels: [...DEFAULT_NOTIFY_PREFS.routes[k].channels], when: DEFAULT_NOTIFY_PREFS.routes[k].when }])
  ) as unknown as NotifyPrefs["routes"];
  const out: NotifyPrefs = { routes, brief: { ...DEFAULT_NOTIFY_PREFS.brief } };
  layers.forEach((layer, i) => {
    if (!layer) return;
    const projectLayer = i > 0;
    const checked = validateNotifyOverride(layer, { projectLayer });
    // A stored layer that no longer validates as a whole still applies its valid fields.
    const valid = checked.ok ? checked.value : salvage(layer, projectLayer);
    for (const kind of NOTIFY_KINDS) {
      const r = valid.routes?.[kind];
      if (!r) continue;
      const route = out.routes[kind] as NotifyRoute;
      if (r.channels) route.channels = [...r.channels];
      if (r.when) route.when = r.when;
    }
    if (valid.brief?.enabled !== undefined) out.brief.enabled = valid.brief.enabled;
    if (valid.brief?.time) out.brief.time = valid.brief.time;
    if (valid.timezone) out.timezone = valid.timezone;
  });
  return out;
}

/** The fields of a stored layer that validate one at a time. */
function salvage(layer: NotifyOverride, projectLayer: boolean): NotifyOverride {
  const out: NotifyOverride = {};
  const keep = (candidate: NotifyOverride): NotifyOverride | null => {
    const r = validateNotifyOverride(candidate, { projectLayer });
    return r.ok ? r.value : null;
  };
  for (const kind of NOTIFY_KINDS) {
    const route = layer.routes?.[kind];
    if (!route) continue;
    for (const field of ["channels", "when"] as const) {
      if (route[field] === undefined) continue;
      const ok = keep({ routes: { [kind]: { [field]: route[field] } } });
      if (ok?.routes?.[kind]) out.routes = { ...out.routes, [kind]: { ...out.routes?.[kind], ...ok.routes[kind] } };
    }
  }
  for (const field of ["enabled", "time"] as const) {
    if (layer.brief?.[field] === undefined) continue;
    const ok = keep({ brief: { [field]: layer.brief[field] } });
    if (ok?.brief) out.brief = { ...out.brief, ...ok.brief };
  }
  if (layer.timezone !== undefined && keep({ timezone: layer.timezone })) out.timezone = layer.timezone;
  return out;
}

/** What is known about an update when deciding whether its kind's condition holds. */
export interface NotifyFacts {
  /** decision: the update is a held action awaiting approval (not a question). */
  approval?: boolean;
  /** progress: a job the update is about is waiting on the user. */
  needsYou?: boolean;
  /** done: a job the update reports closed failed or cancelled. */
  failed?: boolean;
}

/**
 * The channels beyond the console an update of `kind` goes to under `prefs`:
 * the route's channels when its condition holds, none when it doesn't. The
 * brief's `actionable` condition is applied where the brief is assembled.
 */
export function notifyChannelsFor(prefs: NotifyPrefs, kind: NotifyKind, facts: NotifyFacts = {}): NotifyChannel[] {
  const route = prefs.routes[kind] as NotifyRoute;
  const holds = (() => {
    switch (route.when) {
      case "approvals_only":
        return !!facts.approval;
      case "needs_you":
        return !!facts.needsYou;
      case "never":
        return false;
      case "failures_only":
        return !!facts.failed;
      default:
        return true;
    }
  })();
  return holds ? [...route.channels] : [];
}
