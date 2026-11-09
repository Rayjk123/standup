// Redaction for anything pulled from a session and posted to Slack. Mirroring
// real Bash command lines, file paths, questions, and diffs is the highest leak
// surface in this adapter, so this runs on EVERY session-derived string (mirror
// cards, ask questions, feed lines, thread titles — see format.ts / mirror.ts).
// Best-effort defense in depth, not a guarantee; patterns favor high-signal
// secrets. Because content is re-rendered whole (never chunk-streamed), redact
// right before posting and a secret can't straddle two posts.

interface Rule {
  re: RegExp;
  replace: string;
}

const RULES: Rule[] = [
  // AWS access key ids and long temp keys.
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replace: "«AWS_KEY»" },
  { re: /\bASIA[0-9A-Z]{16}\b/g, replace: "«AWS_TEMP_KEY»" },
  // Slack tokens.
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replace: "«SLACK_TOKEN»" },
  { re: /\bxapp-[A-Za-z0-9-]{10,}\b/g, replace: "«SLACK_APP_TOKEN»" },
  // GitHub tokens.
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replace: "«GH_TOKEN»" },
  // Anthropic keys (sk-ant-…) — the credential most likely to appear in a
  // Claude Code session. Listed before the generic sk- rule; both allow hyphens.
  { re: /\bsk-ant-[A-Za-z0-9-]{16,}\b/g, replace: "«ANTHROPIC_KEY»" },
  { re: /\bsk-[A-Za-z0-9-]{16,}\b/g, replace: "«API_KEY»" },
  // Google API keys (canonically AIza + 35 chars; range for robustness).
  { re: /\bAIza[0-9A-Za-z_-]{30,44}\b/g, replace: "«GCP_KEY»" },
  // Bare JWTs (three base64url segments) — raw id_token/access_token echoes.
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\b/g, replace: "«JWT»" },
  // PEM private key blocks.
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replace: "«PRIVATE_KEY»" },
  // Bearer/authorization headers.
  { re: /\b(Authorization|Bearer)\b\s*[:=]?\s*[A-Za-z0-9._\-+/=]{16,}/gi, replace: "$1 «REDACTED»" },
  // key=value / key: value where the key NAME contains a sensitive word — the
  // full name (incl. prefixes/suffixes like AWS_SECRET_ACCESS_KEY, DB_PASSWORD,
  // GITHUB_TOKEN) is matched, so underscore-delimited env vars don't slip past
  // a word boundary (`_` is a regex word char).
  {
    re: /\b([\w.-]*?(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)[\w.-]*)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
    replace: "$1$2«REDACTED»",
  },
  // Credentials embedded in a URL (scheme://user:pass@host).
  { re: /(\b[a-z][a-z0-9+.-]*:\/\/)([^\s:@/]+):([^\s@/]+)@/gi, replace: "$1$2:«REDACTED»@" },
];

/** Scrub common secrets from a string before it's posted to Slack. */
export function redact(text: string): string {
  if (!text) return text;
  let out = text;
  for (const { re, replace } of RULES) out = out.replace(re, replace);
  return out;
}
