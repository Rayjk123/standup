// Pure formatting for the Persona ↔ Slack bridge: markdown → Slack text,
// message splitting, Slack text → plain text for Persona, thread-context
// capping, and the Block Kit for Persona replies, quick-reply buttons and
// approval cards. No I/O — everything here is unit-testable on its own.

import type { ApprovalCardInput, ApprovalCardSection, PersonaApproval, PersonaContextMessage } from "@standup/shared";
import {
  APPROVAL_STATUS_TEXT,
  approvalHeadline,
  approveLabel,
  consoleBaseUrl,
  describeApproval,
  isConsoleLinkPath,
  isLoopbackHost,
  withoutIds,
} from "@standup/shared";
import { redact } from "./redact.js";

export const PERSONA_OPTION_PREFIX = "persona_option:";
export const PERSONA_APPROVAL_PREFIX = "persona_approval:";
export const PERSONA_SHORTCUT_ID = "persona_send";

/** Longest chunk posted as one Slack message; well under the markdown block's 12k cap. */
export const SLACK_CHUNK_CHARS = 3500;
/** Slack allows at most 5 elements per actions block. */
const BUTTONS_PER_BLOCK = 5;
/** Slack's limits on a button's label and value. */
const BUTTON_LABEL_MAX = 75;
const BUTTON_VALUE_MAX = 2000;
/** Room left for the approval details code block inside a section (3000-char cap). */
const DETAILS_MAX = 2600;
/** Slack's cap on a section's (or a context element's) text. */
const SECTION_MAX = 3000;
/** Longest summary shown on an approval card; the rest is in the console. */
const SUMMARY_MAX = 1500;
/** Longest top-level `text` (notification / fallback) on an approval card. */
const APPROVAL_TEXT_MAX = 300;
/** Characters inserted after `@` so a broadcast keyword reads the same but never pings. */
const WORD_JOINER = "\u2060";

// ---- markdown → mrkdwn ------------------------------------------------------

/** Escape the three characters Slack's mrkdwn treats as control syntax. */
export function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Clip already-escaped mrkdwn to `max` chars with an ellipsis, never leaving a
 * partial `&amp;`-style entity at the cut.
 */
export function clipMrkdwn(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).replace(/&[a-z]*$/, "")}…`;
}

/** Plain-text clip with an ellipsis. */
function clipPlain(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Defuse broadcast mentions: `<!here>` / `<!channel>` / `<!everyone>` (in any
 * form, including `<!subteam^…>` group pings) and the bare `@here` / `@channel`
 * / `@everyone` keywords. They still read the same but notify nobody.
 */
export function neutralizeBroadcasts(s: string): string {
  return s
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/gi, (_m, k: string) => `@${WORD_JOINER}${k}`)
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_m, label?: string) => `@${WORD_JOINER}${(label ?? "group").replace(/^@/, "")}`)
    .replace(/(^|[^\w\u2060])@(here|channel|everyone)\b/gi, (_m, pre: string, k: string) => `${pre}@${WORD_JOINER}${k}`);
}

/** A markdown link label: brackets may nest one level (`[[label]]`). */
const MD_LABEL = String.raw`\[((?:[^\[\]\n]|\[[^\[\]\n]*\])*)\]`;
/** A markdown link destination with an optional title: `(url)`, `(url "t")`, `(<url with spaces>)`. */
const MD_DEST = String.raw`\(\s*(?:<([^<>\n]*)>|((?:[^\s()]|\([^\s()]*\))+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)`;
const INLINE_LINK = new RegExp(`(!?)${MD_LABEL}${MD_DEST}`, "g");
/** A reference definition line: `[ref]: url "title"`. */
const REF_DEF = /^ {0,3}\[([^\[\]\n]+)\]:[ \t]*(?:<([^<>\n]*)>|(\S+))(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?[ \t]*$/gm;
/** A reference use: `[label][ref]`, `[label][]` or the shortcut `[label]`. */
const REF_USE = new RegExp(`(!?)${MD_LABEL}(?:[ \\t]?\\[([^\\[\\]\\n]*)\\])?`, "g");
/** A Slack link with a label in any scheme: `<https://x|label>`, `<slack://open|label>`, `<mailto:a|b>`. */
const SLACK_LABELED_LINK = /<([a-z][a-z0-9+.-]*:[^|>\s]*)\|([^>]*)>/gi;

function shown(label: string, url: string, image: boolean): string {
  const text = label.trim() || (image ? "image" : "");
  return !text || text === url ? url : `${text} (${url})`;
}

function refName(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Show every link's real destination so a friendly label can't hide where a
 * link goes: inline markdown links and images in any form (titles, nested
 * brackets, `<…>` destinations), reference-style links and their definitions,
 * and Slack `<scheme:…|label>` links all become `label (url)`. Any `](` / `][`
 * left over is split with a zero-width space so no other link syntax survives.
 * Code spans and fences are left alone.
 */
export function revealLinks(s: string): string {
  const parts = s.split(/(```[\s\S]*?(?:```|$)|`[^`\n]+`)/g);
  const refs = new Map<string, string>();
  for (const part of parts) {
    if (part.startsWith("`")) continue;
    for (const m of part.matchAll(REF_DEF)) {
      const name = refName(m[1]!);
      if (!refs.has(name)) refs.set(name, m[2] ?? m[3]!);
    }
  }
  return parts
    .map((part) => {
      if (part.startsWith("`")) return part;
      let out = part
        .replace(REF_DEF, (_m, name: string, angle?: string, bare?: string) => `${name}: ${angle ?? bare}`)
        .replace(INLINE_LINK, (_m, bang: string, label: string, angle?: string, bare?: string) => shown(label, angle ?? bare ?? "", !!bang));
      if (refs.size) {
        out = out.replace(REF_USE, (m, bang: string, label: string, ref?: string) => {
          const url = refs.get(refName(ref || label));
          return url === undefined ? m : shown(label, url, !!bang);
        });
      }
      return out
        .replace(SLACK_LABELED_LINK, (_m, url: string, label: string) => shown(label, url, false))
        .replace(/\](?=[([])/g, "]\u200B");
    })
    .join("");
}

/** Convert one non-code stretch of GitHub markdown into Slack mrkdwn. */
function convertProse(s: string): string {
  const BOLD = "\u0001";
  let out = escapeMrkdwn(s);
  // Links and images first, so their brackets aren't read as emphasis.
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, url: string) => `<${url}|${alt || "image"}>`);
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => `<${url}|${label}>`);
  // Headings become bold lines.
  out = out.replace(/^#{1,6}\s+(.+?)\s*#*\s*$/gm, (_m, h: string) => `${BOLD}${h}${BOLD}`);
  // Bold (held as a placeholder so the italic pass doesn't eat it), italic, strike.
  out = out.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, `${BOLD}$1${BOLD}`);
  out = out.replace(/__(?=\S)([\s\S]*?\S)__/g, `${BOLD}$1${BOLD}`);
  out = out.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, "$1_$2_");
  out = out.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "~$1~");
  // Bulleted lists.
  out = out.replace(/^(\s*)[-*+]\s+/gm, "$1• ");
  // Horizontal rules.
  out = out.replace(/^\s*([-*_])(\s*\1){2,}\s*$/gm, "──────────");
  return out.replace(new RegExp(BOLD, "g"), "*");
}

/**
 * Convert GitHub-flavored markdown into Slack `mrkdwn`, leaving fenced and
 * inline code untouched (apart from escaping, which Slack also requires there).
 * Used as the plain-text fallback when a `markdown` block is rejected.
 */
export function markdownToMrkdwn(md: string): string {
  const parts = md.split(/(```[\s\S]*?(?:```|$))/g);
  return parts
    .map((part) => {
      if (part.startsWith("```")) {
        // Slack ignores a fence's language tag poorly — drop it.
        return escapeMrkdwn(part.replace(/^```[^\n`]*\n/, "```\n"));
      }
      return part
        .split(/(`[^`\n]+`)/g)
        .map((seg) => (seg.startsWith("`") && seg.endsWith("`") && seg.length > 1 ? escapeMrkdwn(seg) : convertProse(seg)))
        .join("");
    })
    .join("");
}

// ---- splitting --------------------------------------------------------------

/**
 * Split text into chunks of at most `max` chars, preferring paragraph, then
 * line, then word boundaries. A chunk that ends inside a ``` fence is closed
 * and the next chunk reopens it, so code blocks render in every piece.
 */
export function splitForSlack(text: string, max = SLACK_CHUNK_CHARS): string[] {
  const body = text.trim();
  if (body.length <= max) return body ? [body] : [];
  const chunks: string[] = [];
  let rest = body;
  let reopen = "";
  while (rest.length > 0) {
    const room = max - reopen.length - 4; // leave space for a closing fence
    if (reopen.length + rest.length <= max) {
      chunks.push(reopen + rest);
      break;
    }
    let cut = rest.lastIndexOf("\n\n", room);
    if (cut < room * 0.5) cut = rest.lastIndexOf("\n", room);
    if (cut < room * 0.5) cut = rest.lastIndexOf(" ", room);
    if (cut <= 0) cut = room;
    let piece = reopen + rest.slice(0, cut).trimEnd();
    rest = rest.slice(cut).replace(/^\s+/, "");
    const fences = (piece.match(/```/g) ?? []).length;
    if (fences % 2 === 1) {
      piece += "\n```";
      reopen = "```\n";
    } else {
      reopen = "";
    }
    chunks.push(piece);
  }
  return chunks.filter((c) => c.trim().length > 0);
}

// ---- Slack → plain text -------------------------------------------------------

/**
 * Turn Slack message text into the plain text Persona reads: drop the bot's own
 * mention, render user/channel mentions and links readably, and decode the
 * entity escapes Slack applies to `&`, `<`, `>`.
 *
 * Without `names` the text is the owner's own words, which Persona trusts, so
 * nothing someone else chose may appear in it: user, group and channel
 * mentions render as their stable ids (`@U123`, `#C123`), never a display
 * name or label. With `names` (other people's messages, read as untrusted
 * context) mentions render as names.
 */
export function slackToPlain(text: string, botUserId?: string, names?: (userId: string) => string | undefined): string {
  let out = text;
  if (botUserId) out = out.replace(new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, "g"), "");
  const owner = !names;
  out = out
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/g, (_m, id: string, label?: string) => `@${owner ? id : label ?? names?.(id) ?? id}`)
    .replace(/<#([CG][A-Z0-9]+)\|([^>]*)>/g, (_m, id: string, name: string) => `#${owner ? id : name || id}`)
    .replace(/<#([CG][A-Z0-9]+)>/g, "#$1")
    .replace(/<!subteam\^([A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id: string, label?: string) => (owner || !label ? `@${id}` : label))
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<((?:https?|mailto):[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  return out.replace(/[ \t]{2,}/g, " ").trim();
}

// ---- thread context -----------------------------------------------------------

export interface ContextCaps {
  /** Most messages sent as context in one go. */
  maxItems: number;
  /** Total characters across all context texts. */
  maxChars: number;
  /** Characters kept per message. */
  maxItemChars: number;
}

/** First-visit caps from the spec: up to the last 30 messages, ≤ 8,000 chars. */
export const DEFAULT_CONTEXT_CAPS: ContextCaps = { maxItems: 30, maxChars: 8000, maxItemChars: 2000 };

/**
 * Keep the NEWEST messages that fit: at most `maxItems`, each clipped to
 * `maxItemChars`, dropping the oldest until the total fits `maxChars`. Messages
 * whose ts is in `pinned` (e.g. a forwarded message and its thread root) are
 * always kept and the middle is trimmed instead. Input and output are
 * oldest-first.
 */
export function capContext(
  messages: PersonaContextMessage[],
  caps: ContextCaps = DEFAULT_CONTEXT_CAPS,
  pinned: ReadonlySet<string> = new Set(),
): PersonaContextMessage[] {
  const clipped = messages.map((m) => ({ ...m, text: clipPlain(m.text, caps.maxItemChars) }));
  const isPinned = (m: PersonaContextMessage) => !!m.ts && pinned.has(m.ts);
  const keep = new Set<PersonaContextMessage>();
  let total = 0;
  for (const m of clipped) {
    if (!isPinned(m) || keep.size >= caps.maxItems) continue;
    keep.add(m);
    total += m.text.length;
  }
  for (let i = clipped.length - 1; i >= 0; i--) {
    const m = clipped[i]!;
    if (keep.has(m) || isPinned(m)) continue;
    if (keep.size >= caps.maxItems || total + m.text.length > caps.maxChars) break;
    keep.add(m);
    total += m.text.length;
  }
  return clipped.filter((m) => keep.has(m));
}

// ---- Block Kit ------------------------------------------------------------------

type Block = Record<string, unknown>;

/** A Persona message chunk as a `markdown` block. */
export function personaMarkdownBlocks(chunk: string): Block[] {
  return [{ type: "markdown", text: chunk }];
}

/**
 * Already-escaped mrkdwn as `section` blocks, split at paragraph, line or word
 * boundaries so each stays within Slack's 3000-char section cap and nothing
 * is clipped.
 */
export function mrkdwnSections(text: string): Block[] {
  return splitForSlack(text, SECTION_MAX).map((piece) => ({ type: "section", text: { type: "mrkdwn", text: clipMrkdwn(piece, SECTION_MAX) } }));
}

/**
 * Defuse user mentions: `<@U…>` / `<@W…>` (with or without a label) become a
 * plain `@U…` that notifies nobody, except the owner's own id, which Persona
 * may ping in the owner's threads.
 */
export function neutralizeUserPings(s: string, ownerSlackId?: string): string {
  return s.replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_m, id: string) => (id === ownerSlackId ? `<@${id}>` : `@${id}`));
}

/**
 * A console link Slack can open, from `url` as Persona wrote it: a console
 * path (`/docs/<id>`, `/review/<id>`) gets `base` in front of it, and one
 * already absolute on a loopback host — reachable only from the console's own
 * machine — is re-pointed at `base`. Anything else, including a
 * protocol-relative `//host` link, is left as it is.
 */
function consoleLinkFor(url: string, base: string): string | undefined {
  const relative = url.startsWith("/") && !url.startsWith("//");
  if (!relative && !/^https?:\/\//i.test(url)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url, "http://console.invalid");
  } catch {
    return undefined;
  }
  // Both the path as written and the path the URL parser resolves it to must
  // be a console page, so a dot segment can't reach another console route.
  const written = relative ? url.split(/[?#]/)[0]! : parsed.pathname;
  if (!isConsoleLinkPath(written) || !isConsoleLinkPath(parsed.pathname)) return undefined;
  if (!relative && !isLoopbackHost(parsed.host)) return undefined;
  return `${base}${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/**
 * Points Persona's console links — `/docs/<id>` and `/review/<id>`, relative
 * or on a loopback host — at the console `origin`, so they open from Slack.
 * Every other link and all code are left alone, and without a usable origin
 * the text comes back unchanged.
 */
export function absoluteConsoleLinks(s: string, origin: string | undefined): string {
  const base = consoleBaseUrl(origin);
  if (!base) return s;
  return s
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]+`)/g)
    .map((part) =>
      part.startsWith("`")
        ? part
        : part.replace(INLINE_LINK, (m, bang: string, label: string, angle?: string, bare?: string) => {
            const url = consoleLinkFor(angle ?? bare ?? "", base);
            return url ? `${bang}[${label}](${url})` : m;
          })
    )
    .join("");
}

/**
 * Persona text made safe to post anywhere: secrets scrubbed, broadcast,
 * group and user mentions defused (the owner's own mention aside), and every
 * link's real URL shown.
 */
export function personaOutboundText(text: string, ownerSlackId?: string): string {
  return revealLinks(neutralizeUserPings(neutralizeBroadcasts(redact(text)), ownerSlackId));
}

/**
 * The text a quick-reply button shows: redacted, whitespace collapsed (so
 * padding can't push part of an option out of view) and clipped to Slack's
 * label limit.
 */
export function optionLabel(option: string): string {
  return clipPlain(neutralizeBroadcasts(redact(option)).replace(/\s+/g, " ").trim(), BUTTON_LABEL_MAX);
}

/**
 * Quick-reply buttons for a Persona question, ≤ 5 per actions block. A
 * button's value is exactly its visible label: a tap sends the owner's words,
 * so nothing the owner can't see may ride along. The question's message id,
 * when given, rides in the action id instead, so a tap is linked to the
 * question it answers.
 */
export function optionBlocks(threadId: string, options: string[], messageId?: string): Block[] {
  const question = messageId ? `${OPTION_MESSAGE_SEP}${messageId}` : "";
  const blocks: Block[] = [];
  for (let start = 0; start < options.length; start += BUTTONS_PER_BLOCK) {
    blocks.push({
      type: "actions",
      elements: options.slice(start, start + BUTTONS_PER_BLOCK).map((opt, j) => {
        const i = start + j;
        const label = optionLabel(opt) || `Option ${i + 1}`;
        return {
          type: "button",
          action_id: `${PERSONA_OPTION_PREFIX}${threadId}:${i}${question}`,
          text: { type: "plain_text", text: label, emoji: true },
          value: label.slice(0, BUTTON_VALUE_MAX),
        };
      }),
    });
  }
  return blocks;
}

/** The context line that replaces a quick-reply card's buttons once the owner picks one. */
export function optionChosenBlock(userId: string, value: string): Block {
  const shown = clipMrkdwn(escapeMrkdwn(neutralizeBroadcasts(value)), 200);
  return { type: "context", elements: [{ type: "mrkdwn", text: `↩️ <@${userId}> chose: *${shown}*` }] };
}

/** A job a Persona reply references: its id and, when known, its title. */
export interface PersonaJobRef {
  jobId: string;
  title?: string;
}

/** Most jobs named on a reply's job line; the rest are counted. */
export const JOB_REFS_SHOWN = 4;
/** Longest job title shown on the job line. */
const JOB_TITLE_MAX = 40;
/** How much of a job id the job line shows. */
const JOB_ID_SHORT = 8;

/**
 * The context line under a Persona reply naming the jobs it references, e.g.
 * "Jobs: Knowledge audit `3f2a9c1d` · Checkout currency `8be01a77`": each title
 * redacted, defused, escaped and clipped, then the job's short id (the id
 * alone when the title is unknown); at most JOB_REFS_SHOWN, then "+N more".
 * Undefined when there are no jobs.
 */
export function jobRefsBlock(refs: PersonaJobRef[]): Block | undefined {
  const seen = new Set<string>();
  const unique = refs.filter((r) => r.jobId && !seen.has(r.jobId) && seen.add(r.jobId));
  if (!unique.length) return undefined;
  const parts = unique.slice(0, JOB_REFS_SHOWN).map((r) => {
    const id = `\`${escapeMrkdwn(r.jobId.slice(0, JOB_ID_SHORT).replace(/[`\s]/g, ""))}\``;
    const plain = clipPlain(neutralizeBroadcasts(redact(r.title ?? "")).replace(/[`*_~]/g, "").replace(/\s+/g, " ").trim(), JOB_TITLE_MAX);
    return plain ? `${escapeMrkdwn(plain)} ${id}` : id;
  });
  const more = unique.length - JOB_REFS_SHOWN;
  if (more > 0) parts.push(`+${more} more`);
  const text = `${unique.length === 1 ? "Job" : "Jobs"}: ${parts.join(" · ")}`;
  return { type: "context", elements: [{ type: "mrkdwn", text: clipMrkdwn(text, SECTION_MAX) }] };
}

/** Separates an option button's index from the id of the question it answers. */
const OPTION_MESSAGE_SEP = "~";

/** Parse `persona_option:<threadId>:<i>`, optionally `…:<i>~<messageId>`. */
export function parseOptionAction(actionId: string): { threadId: string; index: number; messageId?: string } | null {
  if (!actionId.startsWith(PERSONA_OPTION_PREFIX)) return null;
  const rest = actionId.slice(PERSONA_OPTION_PREFIX.length);
  const sep = rest.lastIndexOf(":");
  if (sep <= 0) return null;
  const tail = rest.slice(sep + 1);
  const marker = tail.indexOf(OPTION_MESSAGE_SEP);
  const indexText = marker >= 0 ? tail.slice(0, marker) : tail;
  if (!/^\d+$/.test(indexText)) return null;
  const index = Number.parseInt(indexText, 10);
  const messageId = marker >= 0 ? tail.slice(marker + 1) : "";
  return { threadId: rest.slice(0, sep), index, ...(messageId ? { messageId } : {}) };
}

/** Parse `persona_approval:<id>:approve|deny`. */
export function parseApprovalAction(actionId: string): { approvalId: string; decision: "approve" | "deny" } | null {
  if (!actionId.startsWith(PERSONA_APPROVAL_PREFIX)) return null;
  const rest = actionId.slice(PERSONA_APPROVAL_PREFIX.length);
  const sep = rest.lastIndexOf(":");
  if (sep <= 0) return null;
  const decision = rest.slice(sep + 1);
  if (decision !== "approve" && decision !== "deny") return null;
  return { approvalId: rest.slice(0, sep), decision };
}

/** Plain text as safe mrkdwn: redacted, defused and escaped. */
function safeMrkdwn(text: string): string {
  return escapeMrkdwn(neutralizeBroadcasts(redact(text)));
}

/**
 * The card's content sections as mrkdwn blocks — commands in code blocks,
 * everything else as a quote — sharing DETAILS_MAX between them, so the card
 * stays readable in a phone's notification shade; `clipped` says whether
 * anything was cut.
 */
function approvalSections(sections: ApprovalCardSection[]): { blocks: Block[]; clipped: boolean } {
  const blocks: Block[] = [];
  let budget = DETAILS_MAX;
  let clipped = false;
  for (const s of sections) {
    if (budget <= 40) {
      clipped = true;
      break;
    }
    const body = s.code ? safeMrkdwn(s.text).replace(/```/g, "ˋˋˋ") : safeMrkdwn(s.text);
    const shown = clipMrkdwn(body, budget);
    clipped ||= shown !== body;
    budget -= shown.length;
    const text = s.code ? `\`\`\`${shown}\`\`\`` : shown.split("\n").map((line) => `>${line}`).join("\n");
    blocks.push({ type: "section", text: { type: "mrkdwn", text: clipMrkdwn(`*${safeMrkdwn(s.label)}*\n${text}`, SECTION_MAX) } });
  }
  return { blocks, clipped };
}

const STATUS_EMOJI: Record<PersonaApproval["status"], string> = {
  pending: "⏳",
  approved: "✅",
  denied: "🚫",
  executed: "✅",
  failed: "⚠️",
  expired: "⌛",
  superseded: "↪️",
};

const STATUS_LINE = Object.fromEntries(
  Object.entries(APPROVAL_STATUS_TEXT).map(([status, text]) => [status, `${STATUS_EMOJI[status as PersonaApproval["status"]]} ${text}`])
) as Record<PersonaApproval["status"], string>;

const CARD_HEADER: Record<PersonaApproval["status"], string> = { ...STATUS_LINE, pending: "🔐 Persona needs your approval" };

/** Who must decide an approval card: its approver when it names one, else its owner. */
export type RoutedApproval = { owner: string; approver?: string | null };

/** The alias who decides `approval`: its approver, else its owner. */
export function approvalDecider(approval: RoutedApproval): string {
  return approval.approver || approval.owner;
}

/**
 * The owner whose Persona raised an approval someone else decides (a guest's
 * hold escalated to the host), so the card can say whose it is; undefined when
 * the owner decides it.
 */
export function approvalOrigin(approval: Partial<RoutedApproval>): string | undefined {
  return approval.approver && approval.owner && approval.approver !== approval.owner ? approval.owner : undefined;
}

/** The card's one-line `text` (notification and fallback), headed by its status. */
export function approvalText(approval: ApprovalCardInput & Partial<RoutedApproval> & { status?: PersonaApproval["status"] }): string {
  const origin = approvalOrigin(approval);
  const from = origin ? ` (from ${clipMrkdwn(escapeMrkdwn(origin), 100)}'s Persona)` : "";
  return `${CARD_HEADER[approval.status ?? "pending"]}${from}: ${clipMrkdwn(safeMrkdwn(describeApproval(approval).headline), APPROVAL_TEXT_MAX)}`;
}

/**
 * What a decided card adds under its status: why it was replaced, or why it
 * failed. A result that only reports the action's ids says nothing more.
 */
function decidedDetail(approval: PersonaApproval): string {
  if (!approval.result || (approval.status !== "failed" && approval.status !== "superseded")) return "";
  return clipMrkdwn(safeMrkdwn(withoutIds(approval.result)), 1500);
}

/**
 * The approval card for the owner's DM, in plain English: what Persona wants
 * to do, why it needs the owner, the exact content approving runs (the brief,
 * message or command), and Approve/Deny while pending; the decided state
 * replaces the buttons once it isn't. Every section is escaped and clipped
 * under Slack's limits; when anything was cut the card links the console.
 */
export function approvalCardBlocks(approval: PersonaApproval & Partial<RoutedApproval>, webUrl: string): Block[] {
  const card = describeApproval(approval);
  const headline = clipMrkdwn(safeMrkdwn(card.headline), SUMMARY_MAX);
  let clipped = headline.endsWith("…");
  const blocks: Block[] = [
    { type: "section", text: { type: "mrkdwn", text: `*${CARD_HEADER[approval.status]}*\n${headline}` } },
  ];
  const origin = approvalOrigin(approval);
  if (origin) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `From *${clipMrkdwn(escapeMrkdwn(origin), 100)}*'s Persona` }] });
  }
  for (const [label, text] of [["Why I'm asking", card.why], ["My reason", card.note]] as const) {
    if (!text) continue;
    const shown = clipMrkdwn(safeMrkdwn(text), 1000);
    clipped ||= shown.endsWith("…");
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `*${label}:* ${shown}` }] });
  }
  const sections = approvalSections(card.sections);
  clipped ||= sections.clipped;
  blocks.push(...sections.blocks);
  if (approval.status === "pending" && card.expiresAt) {
    const epoch = Math.floor(Date.parse(card.expiresAt) / 1000);
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `⏳ Decide by <!date^${epoch}^{date_short_pretty} {time}|${card.expiresAt}>: after that the hold times out and the call is denied.`,
        },
      ],
    });
  }
  if (approval.status === "pending") {
    blocks.push(approvalButtons(approval));
  } else {
    const by = approval.decidedBy ? ` by ${clipMrkdwn(escapeMrkdwn(approval.decidedBy), 100)}` : "";
    const detail = decidedDetail(approval);
    clipped ||= detail.endsWith("…");
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `${STATUS_LINE[approval.status]}${by}${detail ? `\n${detail}` : ""}` }] });
  }
  if (clipped) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `Clipped — <${webUrl}|full details in the console>` }] });
  }
  return blocks;
}

function approvalButtons(approval: PersonaApproval): Block {
  return {
    type: "actions",
    elements: [
      {
        type: "button",
        style: "primary",
        action_id: `${PERSONA_APPROVAL_PREFIX}${approval.id}:approve`,
        text: { type: "plain_text", text: approveLabel(approval) },
        value: approval.id,
      },
      {
        type: "button",
        style: "danger",
        action_id: `${PERSONA_APPROVAL_PREFIX}${approval.id}:deny`,
        text: { type: "plain_text", text: "Deny" },
        value: approval.id,
      },
    ],
  };
}

/**
 * A minimal card for when Slack rejects the full one: the summary as plain
 * text (which Slack never parses for mentions or links), the console link,
 * and the buttons while pending.
 */
export function approvalFallbackBlocks(approval: PersonaApproval & Partial<RoutedApproval>, webUrl: string): Block[] {
  const origin = approvalOrigin(approval);
  const from = origin ? `\nFrom ${clipPlain(neutralizeBroadcasts(origin), 100)}'s Persona` : "";
  const plain = `${CARD_HEADER[approval.status]}${from}\n${clipPlain(neutralizeBroadcasts(redact(approvalHeadline(approval))), SUMMARY_MAX)}`;
  const blocks: Block[] = [
    { type: "section", text: { type: "plain_text", text: plain, emoji: true } },
    { type: "context", elements: [{ type: "mrkdwn", text: `<${webUrl}|Full details in the console>` }] },
  ];
  if (approval.status === "pending") blocks.push(approvalButtons(approval));
  return blocks;
}

/**
 * The pointer left in the channel thread an approval was raised from. It
 * names no details — the thread is shared, and the action itself is only for
 * the decider's eyes — just that a decision is pending in their DM, then how
 * it went.
 */
export function approvalPointerText(approval: Pick<PersonaApproval, "status">, deciderSlackId: string): string {
  if (approval.status === "pending") return `⏳ Waiting on <@${deciderSlackId}>'s approval — the details are in their DM.`;
  return `${STATUS_LINE[approval.status]}.`;
}
