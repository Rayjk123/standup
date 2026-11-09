/**
 * Secret redaction for text published into the knowledge corpus. Every write
 * path that lands text in the corpus (native-memory mirrors, project-docs
 * ingest, propose/publish, drafts) passes the body through here first, because
 * the corpus is searchable across projects, injected into agents, and sent to a
 * remote embedding endpoint. Defense in depth, not a guarantee: the primary
 * control is that personal-layer docs never leave their owner's scope.
 *
 * Rules come in two tiers, picked by where the text lands (redactOptionsFor):
 *  - "signature" — run on ALL content, team docs included. Only formats that
 *    are a secret wherever they appear: provider tokens with a known prefix
 *    (`ghp_`, `xoxb-`, `sk-`, `glpat-`, `npm_`, `SG.`, `AIza`, `ya29.`, …),
 *    AWS access key ids and the secret access key labelled as one or written
 *    next to its key id, JWTs, PEM/PGP private key blocks, URL userinfo
 *    passwords, `Password=`/`Pwd=` and Azure `AccountKey=` in connection
 *    strings, `curl -u user:pass`, and Authorization Basic/Bearer headers.
 *  - "heuristic" — added for the "full" tier only, which is the personal
 *    layer and scope=global content: credential-named assignments (`key=value`,
 *    `key: value`, JSON including `\"`-escaped JSON, YAML block scalars), URL
 *    query and CLI-flag credentials, passwords stated in prose and a bare
 *    40-char AWS-secret-shaped run. These shapes also describe team data
 *    (`passwordPolicy: strict`, `sortKey: createdAt`), so a project-scoped doc
 *    is never put through them: there precision wins over recall.
 *
 * AWS account ids in account context (ARNs, labelled ids, `--account`, ECR
 * hosts) are redacted in every placement: the full tier turns them on by
 * default and redactOptionsFor adds them to the signature tier for
 * project-scoped team docs.
 *
 * In every tier a value that is a reference, a placeholder or code is never a
 * secret: a dotted identifier chain (`var.db_password`, `config.db.password`,
 * `process.env.X`, `random_password.db.result`), a call (`os.getenv(…)`,
 * `form.get("password")`), `await`/`new`, a template (`${X}`, `${{ secrets.X
 * }}`, `{{resolve:…}}`), `<…>`, and placeholder words (`YOUR_…`, `your-…`,
 * `example`, `changeme`, `xxx`, `***`). A separator never crosses a line break
 * and a value never runs onto the next line, except a YAML block scalar's
 * indented body.
 */

import { GLOBAL_PROJECT_ID } from "@standup/shared";
import { layerOf } from "./types.js";

/** Marker written into every redacted span so a reader sees the corpus scrubbed
 *  a secret rather than silently dropped content. */
export const REDACTED = "[REDACTED]";

/**
 * Which rules run: "signature" (the default) only high-precision secret
 * formats; "full" those plus the heuristic credential shapes and account ids.
 */
export type RedactTier = "signature" | "full";

export interface RedactOptions {
  /** Defaults to "signature". */
  tier?: RedactTier;
  /** Redact AWS account ids in account context. Defaults to on for the "full" tier only. */
  accountIds?: boolean;
  /**
   * Account ids to redact wherever they appear as a standalone number (when
   * account ids are redacted). Defaults to the comma-separated
   * `STANDUP_PERSONAL_ACCOUNT_IDS`.
   */
  knownAccountIds?: readonly string[];
}

/** One redacted span of the input: its offsets and the rule that matched. Never the value. */
export interface RedactionSpan {
  start: number;
  end: number;
  pattern: string;
}

export interface RedactionResult {
  text: string;
  /** Spans replaced with REDACTED. Never the secrets themselves. */
  redactions: number;
}

type Placement = { scope?: string; sourceKind?: string; slug?: string; projectId?: string };

/**
 * Whether a doc's placement calls for the "full" tier: true for the personal
 * layer (any scope=user doc, the home CLAUDE.md / rules mirrors) and for
 * scope=global content, including any doc homed in the reserved global corpus,
 * which reaches every project. False for project-scoped team docs, whose
 * account ids are still redacted (redactOptionsFor) but whose credential-shaped
 * team data is not put through the heuristic rules.
 */
export function accountIdsRedactedFor(doc: Placement): boolean {
  if (doc.scope === "global" || doc.projectId === GLOBAL_PROJECT_ID) return true;
  return layerOf(doc) === "personal";
}

/**
 * The redaction options a doc with this placement is written under: the
 * "full" tier for the personal layer and global content, and for
 * project-scoped team docs the "signature" tier plus the account-id rules. An
 * account id or an ARN carrying one is an identifier of a real environment
 * wherever it lands: the corpus is searched across projects and sent to a
 * remote embedding endpoint, and a doc names an account by its stage
 * ("the beta account") as well as by its number.
 */
export function redactOptionsFor(doc: Placement): RedactOptions {
  return accountIdsRedactedFor(doc) ? { tier: "full" } : { tier: "signature", accountIds: true };
}

/** The stricter of two placements' options: "full" when either calls for it,
 *  and account ids redacted when either redacts them. */
export function stricterRedactOptions(a: RedactOptions, b: RedactOptions): RedactOptions {
  if (a.tier === "full" || b.tier === "full") return { tier: "full" };
  return a.accountIds || b.accountIds ? { tier: "signature", accountIds: true } : { tier: "signature" };
}

/**
 * How surely a key names a credential. The key is split on `_`/`-`/`.` and
 * camelCase boundaries and lowercased. Only explicit secret names count — never
 * a bare `key` or `auth`, which in team docs name partition, sort, cache, S3 and
 * KMS keys and auth modes:
 *  - "password": the key ends in `password`/`passwd`/`passphrase` (`PGPASSWORD`,
 *    `dbPassword`), or is a compound ending in `pwd` (`DB_PWD`) or an env-var
 *    ending in `PASS` (`DB_PASS`). Any literal value is a secret;
 *  - "secret": a compound ending in `secret` (`client_secret`, `AWS_SECRET`), or
 *    a key ending in `key` after `secret`/`private` (`secret_key`,
 *    `aws_secret_access_key`, `private_key`). Any literal is a secret except a
 *    plain name (`existingSecret: db-credentials`, `ssh_private_key: id_ed25519`);
 *  - "weak": names a credential that is as often a placeholder, a reference or a
 *    pagination cursor — `api_key`/`apikey`, `access_key`, a `token`
 *    (`auth_token`, `GITHUB_TOKEN`, a bare `token`), `bearer`, a bare `secret`.
 *    Only a generated-looking value is a secret (highEntropyValue);
 *  - null: anything else — `passwordPolicy`, `TOKEN_FILE`, `nextToken`,
 *    `max_tokens`, `kms_key_id`, `secretKeys` and every other `…Key`.
 */
type KeyStrength = "password" | "secret" | "weak";

/** Words before `token` that make it a cursor or a count rather than a credential. */
const NON_CREDENTIAL_TOKEN_QUALIFIERS = new Set(["next", "page", "continuation", "pagination", "cursor", "resume", "start", "sync", "max"]);

/** The singular of a credential word, so `API_KEYS`/`AWS_SECRETS`/`FOO_TOKENS` name what their singulars do. */
const singular = (word: string) => (/^(?:apikeys|secrets|tokens|passwords)$/.test(word) ? word.slice(0, -1) : word);

function credentialKeyStrength(name: string): KeyStrength | null {
  const plural = /keys$/i.test(name);
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[_.-]+/)
    .filter(Boolean)
    .map((w) => singular(w.toLowerCase()));
  const last = words[words.length - 1];
  if (!last) return null;
  const before = words.slice(0, -1);
  const compound = before.length > 0;
  const envVar = /^[A-Z0-9_]+$/.test(name) && /[A-Z]/.test(name);
  if (/(?:password|passwd|passphrase)$/.test(last)) return "password";
  if (last === "pwd" && compound) return "password";
  if (last === "pass" && compound && envVar) return "password";
  if (last === "secret") return compound ? "secret" : "weak";
  // A plural `…Keys` key names a map of key names (`secretKeys:`), not a key —
  // except an upper-snake env var (`API_KEYS=`), which holds a list of them.
  if ((last === "key" || last === "keys" || last === "apikey") && (!plural || envVar)) {
    if (before.includes("secret") || before[before.length - 1] === "private") return "secret";
    const qualifier = before[before.length - 1];
    return last === "apikey" || qualifier === "api" || qualifier === "access" ? "weak" : null;
  }
  if (last === "token") return NON_CREDENTIAL_TOKEN_QUALIFIERS.has(before[before.length - 1] ?? "") ? null : "weak";
  if (last === "bearer") return "weak";
  return null;
}

/** Whether `name` — a key, an environment variable or a `--flag` — names a credential (credentialKeyStrength), so its value is one. */
export function isCredentialName(name: string): boolean {
  return credentialKeyStrength(name.trim().replace(/^-+/, "")) !== null;
}

/**
 * Values an assignment carries that are not secrets even under a credential
 * key: type annotations (`apiKey: string`, `password: str`), literals and YAML
 * null, keywords that open an expression (`await bcrypt.hash(…)`, `new
 * Secret(…)`), env-var references and an already redacted span. Leaving these
 * alone keeps code samples readable.
 */
const NON_SECRET_VALUE =
  /^(?:string|str|number|int|float|bool|boolean|bytes|dict|list|secretstr|undefined|null|nil|true|false|any|unknown|none|optional|required|empty|await|new|function|lambda|require|import|yield|typeof|this|self|~|\.{3}|…|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\[REDACTED\])[,;)`'".\]]*$/i;

/**
 * A reference to a value held elsewhere rather than the value: a dotted
 * identifier chain (`var.db_password`, `local.pw`, `config.db.password`,
 * `process.env.DB_PASSWORD`, `random_password.db.result`), a call
 * (`os.getenv("PW")`, `form.get("password")`), a template (`${cfg.pw}`,
 * `${{ secrets.DB_PASSWORD }}`, `{{resolve:secretsmanager:…}}`, `{{ vault_pw }}`,
 * `#{Octopus.Var}`), an index or generic (`config["db"]`, `Optional[str]`), a
 * query or format parameter (`?`, `$1`, `:password`, `@DbPassword`, `%s`,
 * `{0}`, `__DB_PASSWORD__`), a secret-store reference (`ENC[…]`, `vault:…`,
 * `ref+awssecrets://…`, an ARN), a constant's name (`SECRET_KEY`) or a value
 * made of quote characters only (`""`).
 */
const REFERENCE_VALUE =
  /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)+(?:[(\[]|[!;,)\]]*$)|^[A-Za-z_$][\w$.]*\s*[([]|^\$\{|^#\{|^\{\{|^\$\(|^["'`]*$|^(?:\?|\$\d+|:[A-Za-z_]\w*|@[A-Za-z_][\w.]*|%[sd]|\{\d*\}|__[A-Za-z0-9_]+__)[,;)\]]*$|^(?:ENC\[|vault:|ref\+|arn:)|^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

/**
 * A placeholder written where a secret goes in docs and samples: `<your-token>`,
 * `YOUR_API_KEY`, `your-key-here`, `example-key`, `changeme`, `xxxx`, `****`,
 * `%DB_PASSWORD%`. The placeholder word leads the value (or is all of it), so
 * a real secret with one run into it (`Changeme123!`, `Hunter2-Your-Pass`) and
 * a sample key with EXAMPLE run into it are still treated as secrets.
 */
const PLACEHOLDER_VALUE =
  /^(?:your|my)[-_ ]|^<.*>$|^(?:example|sample)(?:$|[-_ .])|^change[-_]?me$|^(?:placeholder|redacted|dummy)(?:$|[-_ .])|^x{3,}$|x{4,}|\*{3,}|^%[A-Za-z_]+%$|^(?:todo|tbd|secret|password|passwd|pass|token|key|user|username)$/i;

/** Whether a value is a reference, placeholder or literal keyword — never a secret in any tier. */
function nonSecretValue(value: string): boolean {
  return value.length === 0 || NON_SECRET_VALUE.test(value) || REFERENCE_VALUE.test(value) || PLACEHOLDER_VALUE.test(value);
}

/**
 * An unquoted value shaped like code or a path rather than a secret: a call,
 * template, block or pipe (`hash(a|b)`, `${cfg.key}`, `` `x` ``), a YAML tag
 * (`!Ref DbPassword`), or a file path. A secret with those characters in a doc
 * is written quoted, which is matched separately.
 */
const CODE_SHAPED_VALUE = /[(){}`|<>]|^~?\/|^\.{1,2}\/|^!/;

/** Shapes a generated-looking value can take that are not secrets: UUIDs (KMS key ids), KMS aliases, ARNs, regions. */
const NON_SECRET_SHAPED =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^mrk-[0-9a-f]{32}$|^alias\/|^arn:|\b[a-z]{2}(?:-gov)?-[a-z]+-\d\b/i;

/**
 * Whether a value under a WEAK key reads as a generated secret: at least 20
 * characters mixing letters and digits, and not a UUID, KMS alias, ARN, region,
 * path or a name made of words (`user:123:profile`, `data/2026/10/file.parquet`,
 * `tenant-42-shard-a`), which are identifiers.
 */
function highEntropyValue(value: string): boolean {
  if (value.length < 20 || !/\d/.test(value) || !/[A-Za-z]/.test(value)) return false;
  if (NON_SECRET_SHAPED.test(value)) return false;
  const words = value.split(/[-_.:/#@ ]+/).filter((segment) => /^[A-Za-z]{3,}$/.test(segment));
  return words.length < 2 && !/\/[a-z]{3,}(?:\/|\.|$)/.test(value);
}

/** A plain lowercase name joined by `-`/`_`/`.` (`db-credentials`, `id_ed25519`): a resource or file name, not a secret. */
const NAME_VALUE = /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/;

/** Leading words that make a value prose about a password ("Password: must be 12+ chars") rather than one. */
const PROSE_LEAD = new Set(
  "a an the is are was be must should will can may not no never see set use uses stored managed rotated kept lives via from in on at by for to of with without required needed".split(
    " "
  )
);

/** Whether `value` (unquoted inner text or quoted contents) under a key of `strength` is a secret. */
function credentialValueIsSecret(strength: KeyStrength, value: string): boolean {
  if (nonSecretValue(value)) return false;
  if (strength === "weak") return highEntropyValue(value);
  if (strength === "secret" && NAME_VALUE.test(value) && !highEntropyValue(value)) return false;
  // PascalCase words (`AccessKeySecretOutput`, `DbPasswordParam`) name a resource or a class.
  if (/^(?:[A-Z][a-z]+){2,}$/.test(value)) return false;
  return true;
}

/**
 * The text after a strong unquoted value that continues it: further
 * space-separated words on the same line, each whole and not followed by `:` or
 * `=` (the next setting's key).
 */
const VALUE_CONTINUATION = /^(?:[ \t]+[^\s;,&(){}[\]"'`#=:]+(?![^\s;,&(){}[\]"'`#]|[:=]))+/;

/**
 * Per line of one input, where its `;`-separated connection-string settings
 * are: the end of the first `Key=value;` setting and the start of the last
 * `;Key=` that opens one. Computed once per input and line, so the check each
 * credential match makes is constant time.
 */
interface LineSettings {
  firstClose: number;
  lastOpen: number;
}
let settingsInput: string | null = null;
let settingsByLine = new Map<number, LineSettings>();

function lineSettings(input: string, lineStart: number): LineSettings {
  if (settingsInput !== input) {
    settingsInput = input;
    settingsByLine = new Map();
  }
  const known = settingsByLine.get(lineStart);
  if (known) return known;
  const lineEnd = lineEndOf(input, lineStart);
  let firstClose = Infinity;
  let lastOpen = -1;
  let keyBeforeEq = false;
  let wordRun = false;
  for (let i = lineStart; i < lineEnd; i++) {
    const c = input[i];
    if (c === "=") {
      if (wordRun) keyBeforeEq = true;
    } else if (c === ";") {
      if (keyBeforeEq && firstClose === Infinity) firstClose = i;
      if (/^;[ \t]*[A-Za-z][\w ]*=/.test(input.slice(i, Math.min(lineEnd, i + 64)))) lastOpen = i;
    }
    wordRun = /[A-Za-z0-9_ ]/.test(c) ? wordRun || /[A-Za-z0-9_]/.test(c) : false;
  }
  const out = { firstClose, lastOpen };
  settingsByLine.set(lineStart, out);
  return out;
}

/** Whether the value at `start` sits in a `;`-separated connection string: a setting closes before its key on its line, or one follows it. */
function inConnectionString(input: string, keyStart: number, start: number): boolean {
  const lineStart = input.lastIndexOf("\n", keyStart - 1) + 1;
  const settings = lineSettings(input, lineStart);
  return settings.firstClose < keyStart || settings.lastOpen >= start;
}

/** Trailing characters that close the surrounding syntax or sentence rather than belong to an unquoted value. */
function trimValueEnd(value: string): string {
  let out = value;
  for (;;) {
    const last = out[out.length - 1];
    const opener = last === "}" ? "{" : last === ")" ? "(" : last === "]" ? "[" : null;
    if (opener && !out.includes(opener)) out = out.slice(0, -1);
    else if (last === "," || last === "." || last === ";") out = out.slice(0, -1);
    else return out;
  }
}

/**
 * Whether an unquoted value is an identifier in code — a variable an object
 * literal, a dict or a call argument passes (`{ password: hashed }`,
 * `{"password": pw}`, `f(password=pw)`): a bare identifier closed by `}`, `)`
 * or `,` on a line that opens a `{` or `(` before its key.
 */
function identifierInCode(input: string, keyStart: number, value: string, valueEnd: number): boolean {
  if (!/^[A-Za-z_$][\w$]*$/.test(value) || !/^[ \t]*[,})]/.test(input.slice(valueEnd, valueEnd + 16))) return false;
  const lineStart = input.lastIndexOf("\n", keyStart - 1) + 1;
  return /[{(]/.test(input.slice(lineStart, keyStart));
}

/**
 * The span of the unquoted credential value captured at `[start, end)` of
 * `input` (a run of non-space, non-quote characters), or null to leave it.
 *  - a weak key's value is one token, ending at `;`, `,`, `&` or `}`;
 *  - a strong (password/secret) key's value ends at whitespace — `&`, `,` and
 *    `;` are password characters — except in a `;`-separated connection string,
 *    where `;` ends it. One written YAML/prose style (`continues`: a `:` or
 *    spaced `=` separator, `passphrase: correct horse battery staple`) runs on
 *    through the following words of the line, unless its first word makes it
 *    prose about the credential ("must be 12+ chars").
 */
function unquotedValueSpan(
  strength: KeyStrength,
  input: string,
  keyStart: number,
  start: number,
  end: number,
  continues: boolean
): [number, number] | null {
  let raw = input.slice(start, end);
  if (strength === "weak") raw = raw.split(/[;,&}]/)[0];
  else if (inConnectionString(input, keyStart, start)) {
    raw = raw.split(";")[0];
    // A connection-string value that runs on past a space is prose (`Password=see vault;`).
    if (raw.length === end - start && /^[ \t]+[^\s;]/.test(input.slice(end, end + 2))) return null;
  } else raw = trimValueEnd(raw);
  if (raw.length === 0 || /^[:=]/.test(raw) || CODE_SHAPED_VALUE.test(raw) || !credentialValueIsSecret(strength, raw)) return null;
  if (identifierInCode(input, keyStart, raw, start + raw.length)) return null;
  const valueEnd = start + raw.length;
  if (!continues || strength === "weak" || valueEnd !== end) return [start, valueEnd];
  const rest = VALUE_CONTINUATION.exec(input.slice(valueEnd, lineEndOf(input, valueEnd)))?.[0] ?? "";
  if (rest && PROSE_LEAD.has(raw.toLowerCase())) return null;
  return [start, valueEnd + rest.length];
}

/** A YAML block-scalar indicator (`|`, `>-`, `|+2`) alone on the rest of its line, optionally with a comment. */
const BLOCK_SCALAR = /^[|>][-+0-9]*[ \t]*(?:#[^\n]*)?$/;

/**
 * The span of a YAML block scalar's body under a credential key
 * (`password: |` / `private_key: >-` and the indented lines after it): from the
 * first content character to the end of the last line indented deeper than the
 * key's line, or null when there is none or it is not a secret.
 */
function blockScalarSpan(strength: KeyStrength, input: string, keyStart: number, lineEnd: number): [number, number] | null {
  const lineStart = input.lastIndexOf("\n", keyStart - 1) + 1;
  const keyIndent = /^[ \t]*/.exec(input.slice(lineStart))![0].length;
  let cursor = lineEnd + 1;
  let first = -1;
  let last = -1;
  while (lineEnd !== -1 && cursor <= input.length) {
    const next = input.indexOf("\n", cursor);
    const lineStop = next === -1 ? input.length : next;
    const line = input.slice(cursor, lineStop).replace(/\r$/, "");
    if (line.trim() !== "") {
      const indent = /^[ \t]*/.exec(line)![0].length;
      if (indent <= keyIndent) break;
      if (first === -1) first = cursor + indent;
      last = cursor + line.length;
    }
    if (next === -1) break;
    cursor = next + 1;
  }
  if (first === -1) return null;
  const content = input.slice(first, last);
  const firstLine = content.split("\n")[0].trim();
  if (nonSecretValue(firstLine)) return null;
  if (strength === "weak" && !highEntropyValue(content.replace(/\s+/g, ""))) return null;
  return [first, last];
}

/** One redaction rule: a named pattern and the span(s) of each match to redact. */
interface RedactionRule {
  name: string;
  pattern: RegExp;
  /** The [start, end) to redact for a match, or null to leave it. Defaults to the whole match. */
  span?: (m: RegExpExecArray) => [number, number] | null;
  /**
   * Where to resume scanning after a match whose span was left. Defaults to the
   * end of the match; an assignment resumes at its value, which can itself
   * hold an assignment (`env: PASSWORD=…`, `User Id=admin;Password=…`).
   */
  resume?: (m: RegExpExecArray) => number;
  /**
   * Match over the text with full-width digits (U+FF10–U+FF19) read as ASCII:
   * an account id written in them is still an account id. Each is one UTF-16
   * unit, like its ASCII digit, so spans stay offsets into the text.
   */
  wideDigits?: boolean;
}

const FULL_WIDTH_DIGIT = /[\uFF10-\uFF19]/g;

/** `text` with full-width digits replaced by their ASCII digits, offsets unchanged. */
export function foldWideDigits(text: string): string {
  return text.replace(FULL_WIDTH_DIGIT, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
}

/** The span of capture group `g` (the pattern must carry the `d` flag). */
const group =
  (g: number) =>
  (m: RegExpExecArray): [number, number] | null =>
    m.indices?.[g] ?? null;

/** The span of capture group `g` unless its text is a reference or placeholder. */
const literalGroup =
  (g: number) =>
  (m: RegExpExecArray): [number, number] | null =>
    m[g] === undefined || nonSecretValue(m[g]) ? null : (m.indices?.[g] ?? null);

/**
 * An account id as a standalone number: 12 digits, or three groups of four or
 * four groups of three split by dashes, spaces or dots. Interpolated as
 * capture group 1 of the labeled rule, so its separators are groups 2 and 3.
 */
const ACCOUNT_ID = String.raw`\d{12}|\d{4}([-. ])\d{4}\2\d{4}|\d{3}([-. ])\d{3}\3\d{3}\3\d{3}`;
/** Not followed by a word char or a dash (a UUID group, a longer number). */
const STANDALONE_AFTER = String.raw`(?![\w-])`;

/** A 40-character run of the base64 alphabet, the shape of an AWS secret access key. */
const BARE_SECRET = String.raw`(?<![A-Za-z0-9/+=])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])`;

/**
 * Whether a 40-character run reads as a random key rather than a git SHA, a
 * word or a path: mixed case and digits, not all hex, and no `/`-separated
 * segment that is a lowercase word (`src`, `packages`).
 */
function looksRandom(run: string): boolean {
  if (/^[0-9a-f]+$/i.test(run)) return false;
  if (run.split("/").some((segment) => /^[a-z]{3,}$/.test(segment))) return false;
  const count = (re: RegExp) => run.match(re)?.length ?? 0;
  return count(/[A-Z]/g) >= 2 && count(/[a-z]/g) >= 2 && count(/[0-9]/g) >= 1;
}

/** Whether a base64 string decodes to `user:password` credentials. */
function base64Credentials(value: string): boolean {
  try {
    return /^[^:\s]*:\S/.test(atob(value));
  } catch {
    return false;
  }
}

/** Query parameters that carry a credential whatever their value looks like (presigned-URL signatures and tokens). */
const SIGNED_QUERY_PARAM = /^(?:x-amz-signature|x-amz-security-token|signature|sig)$/i;

/** PEM / PGP armor header names a private key body may open with. */
const ARMOR_HEADER = /^(?:Proc-Type|DEK-Info|Version|Comment|Hash|Charset|MessageID):/;

/**
 * The end of the private key body that follows a BEGIN line ending at `from`:
 * the lines after it (split by line breaks, or by `\n` escapes in a JSON
 * string), indented or not, that are base64, armor headers or blank, up to the
 * last base64 line — or null when no base64 line of 8+ characters follows.
 */
function privateKeyBodyEnd(input: string, from: number): number | null {
  const separator = /\r?\n|\\n/y;
  let cursor = from;
  let end: number | null = null;
  for (;;) {
    separator.lastIndex = cursor;
    const sep = separator.exec(input);
    if (!sep) return end;
    const lineStart = cursor + sep[0].length;
    const rest = /^[^\r\n\\]*/.exec(input.slice(lineStart, lineStart + 4096))![0];
    const indent = rest.length - rest.trimStart().length;
    const line = rest.trim();
    // A base64 run, alone on its line or closing the string it is quoted in (`…AASC"}`).
    const run = /^([A-Za-z0-9+/=]+)(["'`,}\]]*)$/.exec(line);
    if (run && (run[1].length >= 8 || (end !== null && run[1].length >= 4))) {
      end = lineStart + indent + run[1].length;
      if (run[2]) return end;
    } else if (line !== "" && !ARMOR_HEADER.test(line)) {
      return end;
    }
    cursor = lineStart + rest.length;
  }
}

/** High-precision secret formats, run on all content. */
const SIGNATURE_RULES: readonly RedactionRule[] = [
  {
    name: "private-key",
    pattern: /-----BEGIN[ A-Z0-9]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END[ A-Z0-9]*PRIVATE KEY(?: BLOCK)?-----/g,
  },
  // A private key whose END line is missing: the BEGIN line and the key body
  // after it (privateKeyBodyEnd). A BEGIN line with no body after it is not a key.
  {
    name: "private-key-unterminated",
    pattern: /-----BEGIN[ A-Z0-9]*PRIVATE KEY(?: BLOCK)?-----/g,
    span: (m) => {
      const end = privateKeyBodyEnd(m.input, m.index + m[0].length);
      return end === null ? null : [m.index, end];
    },
  },
  { name: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  // The secret access key labelled as one (`aws_secret_access_key = …`,
  // `"SecretAccessKey": "…"`, `aws configure set aws_secret_access_key …`).
  {
    name: "aws-secret-access-key",
    pattern:
      /(?<![A-Za-z0-9])(?:aws[_ -]?)?secret[_ -]?access[_ -]?key(?:[ \t]*\[[^\]\n]*\])?\\?["']?(?:[ \t]*[:=][ \t]*|[ \t]+)\\?["']?([A-Za-z0-9/+=]{16,})(?![A-Za-z0-9/+=])/dgi,
    // A CloudFormation logical name (`AccessKeySecretOutput`) is words, not a key.
    span: (m) => (/^(?:[A-Z][a-z]+)+$/.test(m[1]) ? null : literalGroup(1)(m)),
  },
  // The secret access key written after its key id on the same or the next line
  // (a credentials CSV row, `AKIA… / wJal…`).
  {
    name: "aws-secret-access-key-paired",
    pattern: new RegExp(String.raw`\b(?:AKIA|ASIA)[A-Z0-9]{16}\b[^\n]{0,100}?(?:\n[^\n]{0,100}?)?(${BARE_SECRET})`, "dg"),
    span: (m) => (/^[0-9a-f]+$/i.test(m[1]) ? null : m.indices![1]),
  },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { name: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { name: "gitlab-token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { name: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36,}\b/g },
  { name: "stripe-key", pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: "sendgrid-key", pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g },
  { name: "slack-token", pattern: /\bxox[abposre]-[A-Za-z0-9-]{10,}/g },
  { name: "slack-app-token", pattern: /\bxapp-\d-[A-Za-z0-9-]{10,}/g },
  { name: "slack-webhook", pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g },
  { name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
  { name: "google-oauth-token", pattern: /\bya29\.[0-9A-Za-z_-]{20,}/g },
  // OpenAI / Anthropic-style secret keys: `sk-ant-…`, `sk-proj-…`, `sk-svcacct-…`
  // with 20+ key characters, or a bare `sk-…` whose 20+ carry a digit, so a
  // kebab-case name is not one.
  { name: "sk-key", pattern: /\bsk-(?:(?:ant|proj|svcacct|admin)-|(?=[A-Za-z0-9_-]*\d))[A-Za-z0-9_-]{20,}/g },
  // The password segment of a URL userinfo (`scheme://user:secret@host`, and
  // the password-only `scheme://:secret@host`).
  {
    name: "url-password",
    pattern: /\b[a-z][a-z0-9+.\-]{0,30}:\/\/[^\s:/@]*:([^\s@/]+)@/dgi,
    span: literalGroup(1),
  },
  // `Password=`/`Pwd=` in a `;`-separated ADO/JDBC/ODBC connection string. The
  // value ends at `;`, a quote or the end of the line; an ODBC `{…}` value is
  // taken whole. A template (`{{…}}`, `#{…}`, `[parameters('pw')]`), a query or
  // format parameter (`@pw`, `{0}`, `%s`) and prose (a value with spaces) are
  // not a password.
  {
    name: "connection-string-password",
    pattern: /(?<=^|[;"'\s{])(?:password|pwd)[ \t]*=[ \t]*(\{\{[^\n]*?\}\}|\{[^}\n]*\}|[^;"'\n]+)/dgim,
    span: (m) => {
      const [start] = m.indices![1];
      if (!inConnectionString(m.input, m.index, start)) return null;
      const value = m[1].replace(/[ \t]+$/, "");
      const inner = /^\{[^{]/.test(value) ? value.slice(1, -1) : value;
      if (value.startsWith("{{") || /\s/.test(value) || /^[[(]/.test(value) || nonSecretValue(value) || CODE_SHAPED_VALUE.test(inner) || nonSecretValue(inner)) {
        return null;
      }
      return [start, start + value.length];
    },
  },
  // An Azure storage / Service Bus key in a connection string.
  {
    name: "azure-account-key",
    pattern: /(?<![A-Za-z0-9])(?:AccountKey|SharedAccessKey)[ \t]*=[ \t]*([A-Za-z0-9+/]{20,}={0,2})(?![A-Za-z0-9+/=])/dg,
    span: group(1),
  },
  // `curl -u user:password` / `--user user:password`.
  {
    name: "curl-user-password",
    pattern: /\bcurl\b(?:[^\n]|\\\r?\n){0,400}?(?<=\s)(?:-u|--user)(?:[ \t]+|=)(["']?)[^\s:"'\x60]*:([^\s"'\x60]+)\1/dg,
    span: literalGroup(2),
  },
  // An Authorization header with Basic credentials (base64 of `user:pass`) or a Bearer token.
  {
    name: "basic-auth",
    pattern: /\bauthorization\\?["']?[ \t]*[:=][ \t]*\\?["']?basic[ \t]+([A-Za-z0-9+/]{8,}={0,2})(?![A-Za-z0-9+/=])/dgi,
    span: (m) => (base64Credentials(m[1]) ? m.indices![1] : null),
  },
  {
    name: "authorization-bearer",
    pattern: /\bauthorization\\?["']?[ \t]*[:=][ \t]*\\?["']?bearer[ \t]+([A-Za-z0-9._~+/=\-]{16,})/dgi,
    span: (m) => (/\d/.test(m[1]) && !nonSecretValue(m[1]) ? m.indices![1] : null),
  },
];

/**
 * The value of a `key: value` / `key = value` assignment: `\"`-escaped,
 * double-quoted (with `\"` escapes inside), single-quoted, or an unquoted run.
 */
const ASSIGNMENT_VALUE = String.raw`\\"(?:[^"\\\n]|\\[^"\n])*\\"|"(?:[^"\\\n]|\\.)*"|'[^'\n]*'|[^\s"'\x60]+`;

/** Credential shapes that also describe team data: run for the "full" tier only. */
const HEURISTIC_RULES: readonly RedactionRule[] = [
  { name: "aws-secret-access-key-bare", pattern: new RegExp(BARE_SECRET, "g"), span: (m) => (looksRandom(m[0]) ? [m.index, m.index + 40] : null) },
  // A credential in a URL query (`?access_token=…`, `&password=…`,
  // `X-Amz-Signature=…`). A value in a URL is never prose, so a weak name needs
  // only 8+ characters mixing letters and digits.
  {
    name: "url-query-credential",
    pattern: /[?&]([A-Za-z][\w.-]*)=([^&#\s"'<>)\]]+)/dg,
    span: (m) => {
      const value = m[2];
      if (nonSecretValue(value)) return null;
      const strength = SIGNED_QUERY_PARAM.test(m[1]) ? "weak" : credentialKeyStrength(m[1]);
      if (!strength) return null;
      if (strength === "weak" && !(value.length >= 8 && /\d/.test(value) && /[A-Za-z]/.test(value))) return null;
      return m.indices![2];
    },
  },
  { name: "bearer-token", pattern: /\bbearer[ \t]+([A-Za-z0-9._~+/=\-]{16,})/dgi, span: (m) => (/\d/.test(m[1]) ? m.indices![1] : null) },
  // `aws configure set aws_session_token <value>`: a credential set positionally.
  {
    name: "aws-configure-set",
    pattern: /\baws[ \t]+configure[ \t]+set[ \t]+(?:[\w-]+\.)?([A-Za-z_]+)[ \t]+("[^"\n]*"|'[^'\n]*'|\S+)/dg,
    span: (m) => {
      const strength = credentialKeyStrength(m[1]);
      if (!strength) return null;
      const [start, end] = m.indices![2];
      if (m[2][0] === '"' || m[2][0] === "'") return credentialValueIsSecret("secret", m[2].slice(1, -1)) ? [start + 1, end - 1] : null;
      return unquotedValueSpan("secret", m.input, m.index, start, end, false);
    },
  },
  // A CLI flag naming a credential: `--password hunter2`, `--client-secret=…`.
  {
    name: "cli-flag-credential",
    pattern: /(?<![\w-])--([A-Za-z][\w-]*)(?:=|[ \t]+)("[^"\n]*"|'[^'\n]*'|[^\s"'-][^\s"']*)/dg,
    span: (m) => {
      const strength = credentialKeyStrength(m[1]);
      if (!strength) return null;
      const [start, end] = m.indices![2];
      if (m[2][0] === '"' || m[2][0] === "'") return credentialValueIsSecret(strength, m[2].slice(1, -1)) ? [start + 1, end - 1] : null;
      return unquotedValueSpan(strength, m.input, m.index, start, end, false);
    },
    resume: (m) => m.indices![2][0],
  },
  // The MySQL client's attached password flag: `mysql -u root -pS3cret`.
  {
    name: "mysql-password-flag",
    pattern: /\b(?:mysql|mysqldump|mysqladmin|mysqlimport|mysqlshow|mariadb)\b[^\n]*?(?<=\s)-p(["']?)([^\s"']+)\1/dg,
    span: (m) => (credentialValueIsSecret("password", m[2]) ? m.indices![2] : null),
  },
  // A `key: value` / `key = value` assignment whose key names a credential
  // (credentialKeyStrength): the key stays visible and the value is redacted.
  // The separator stays on the key's line; a quoted value (including a
  // `\"`-escaped one inside a JSON string) is redacted inside its quotes, a
  // YAML block scalar over its indented body (blockScalarSpan), and an
  // unquoted one per unquotedValueSpan. A key that is a path segment
  // (`/etc/passwd:`) is not a key.
  {
    name: "credential-assignment",
    pattern: new RegExp(
      String.raw`(?<![A-Za-z0-9_/\\])([A-Za-z0-9]+(?:[_.-][A-Za-z0-9]+){0,12})(\\?["']?[ \t]*[:=][ \t]*)(${ASSIGNMENT_VALUE})`,
      "dg"
    ),
    span: (m) => {
      const strength = credentialKeyStrength(m[1]);
      if (!strength) return null;
      const [start, end] = m.indices![3];
      const value = m[3];
      const escaped = value.startsWith('\\"');
      if (escaped || value[0] === '"' || value[0] === "'") {
        const q = escaped ? 2 : 1;
        if (value.length < 2 * q) return null;
        return credentialValueIsSecret(strength, value.slice(q, -q)) ? [start + q, end - q] : null;
      }
      const separator = m[2];
      if (separator.includes(":") && BLOCK_SCALAR.test(m.input.slice(start, lineEndOf(m.input, start)))) {
        return blockScalarSpan(strength, m.input, m.index, lineEndOf(m.input, start));
      }
      return unquotedValueSpan(strength, m.input, m.index, start, end, separator.includes(":") || /=[ \t]/.test(separator));
    },
    // A template value (`'{{resolve:…}}'`, `${…}`) is skipped whole; any other
    // value is rescanned, since it can hold the credential assignment itself.
    resume: (m) => (/^\\?["']?(?:\{\{|\$\{)/.test(m[3]) ? m.indices![3][1] : m.indices![3][0]),
  },
  // A credential passed as a name/value pair: a Kubernetes env entry
  // (`- name: DB_PASSWORD` then `value: …` on the next line) or an ECS /
  // CloudFormation `{"Name": "DB_PASSWORD", "Value": "…"}` object.
  {
    name: "name-value-credential",
    pattern:
      /\bname["']?[ \t]*:[ \t]*["']?([A-Za-z][\w.-]*)["']?[ \t]*(?:,[ \t]*|\r?\n[ \t]*)["']?value["']?[ \t]*:[ \t]*("(?:[^"\\\n]|\\.)*"|'[^'\n]*'|[^\s"',}]+)/dgi,
    span: (m) => {
      const strength = credentialKeyStrength(m[1]);
      if (!strength) return null;
      const [start, end] = m.indices![2];
      const quoted = m[2][0] === '"' || m[2][0] === "'";
      const value = quoted ? m[2].slice(1, -1) : m[2];
      if (!quoted && CODE_SHAPED_VALUE.test(value)) return null;
      if (!credentialValueIsSecret(strength, value)) return null;
      return quoted ? [start + 1, end - 1] : [start, end];
    },
  },
  // A password stated in prose ("my password is hunter2", "the PIN was 'tiger'"):
  // a password's value when it is quoted or is 4+ chars carrying a digit or
  // symbol, so "the password is required" stays; a PIN or passcode only when
  // quoted, so "the PIN is 0000" in a test plan stays.
  {
    name: "password-prose",
    pattern: /\b(password|passwd|passphrase|passcode|pin)[ \t]+(?:is|was)[ \t]+(?:(["'`])([^"'`\n]+)\2|([^\s"'`]+))/dgi,
    span: (m) => {
      if (m[3] !== undefined) return nonSecretValue(m[3]) ? null : m.indices![3];
      if (/^(?:pin|passcode)$/i.test(m[1])) return null;
      const value = m[4].replace(/[.,;:?)]+$/, "");
      // A hyphenated phrase ("case-sensitive", "single-use") describes the password.
      if (value.length < 4 || nonSecretValue(value) || CODE_SHAPED_VALUE.test(value) || /^[a-z]+(?:-[a-z]+)+$/i.test(value)) return null;
      if (!/[\d\W_]/.test(value)) return null;
      const start = m.indices![4][0];
      return [start, start + value.length];
    },
  },
];

/** The offset of the line break ending the line that holds `offset`, or the end of `text`. */
function lineEndOf(text: string, offset: number): number {
  const end = text.indexOf("\n", offset);
  return end === -1 ? text.length : end;
}

const ACCOUNT_RULES: readonly RedactionRule[] = [
  {
    name: "account-id-arn",
    pattern: /\barn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:(\d{12})(?=:)/dg,
    span: group(1),
    wideDigits: true,
  },
  {
    name: "account-id-labeled",
    pattern: new RegExp(
      String.raw`(?<![A-Za-z0-9_])(?:aws_account_id|--account(?:-id)?|account[ _-]?ids?|accounts?|acct|owner[ _-]?id)(?![A-Za-z])` +
        String.raw`(?:\s+(?:is|was|number|no\.?|id))?[\s"'\x60:=#(\[*_]{0,6}(${ACCOUNT_ID})${STANDALONE_AFTER}`,
      "dgi"
    ),
    span: group(1),
    wideDigits: true,
  },
  // An ECR registry host: `<account>.dkr.ecr.<region>.amazonaws.com`.
  {
    name: "account-id-ecr",
    pattern: /(?<![\w-])(\d{12})\.dkr\.ecr\./dg,
    span: group(1),
    wideDigits: true,
  },
];

function knownAccountIds(opts: RedactOptions): string[] {
  const ids = opts.knownAccountIds ?? (process.env.STANDUP_PERSONAL_ACCOUNT_IDS ?? "").split(",");
  return ids.map((id) => id.replace(/\D/g, "")).filter((id) => id.length === 12);
}

/**
 * A rule matching each configured personal account id: bare, or in groups of
 * four or of three split by dashes, spaces or dots, and also when run into a
 * word (`role_111122223333`) — but never inside a longer number or glued to a
 * dash.
 */
function knownAccountIdRule(ids: readonly string[]): RedactionRule | null {
  if (ids.length === 0) return null;
  const groupings = (id: string) => [
    [id.slice(0, 4), id.slice(4, 8), id.slice(8)],
    [id.slice(0, 3), id.slice(3, 6), id.slice(6, 9), id.slice(9)],
  ];
  const alternatives = ids.flatMap((id) => [
    id,
    ...["-", " ", "."].flatMap((sep) => groupings(id).map((parts) => parts.join(sep === "." ? "\\." : sep))),
  ]);
  return {
    name: "account-id-known",
    pattern: new RegExp(`(?<![\\d-])(?:${alternatives.join("|")})(?![\\d-])`, "g"),
    wideDigits: true,
  };
}

function rulesFor(opts: RedactOptions): RedactionRule[] {
  const full = opts.tier === "full";
  const rules = [...SIGNATURE_RULES, ...(full ? HEURISTIC_RULES : [])];
  if (!(opts.accountIds ?? full)) return rules;
  const known = knownAccountIdRule(knownAccountIds(opts));
  return [...rules, ...ACCOUNT_RULES, ...(known ? [known] : [])];
}

/**
 * Every span `redactSecrets` would replace in `text`, in offset order, as
 * offsets into `text` plus the rule name — never the matched value. Rules run
 * in priority order over the original text; a span overlapping one an earlier
 * rule already claimed is dropped, and a span that is already REDACTED is not
 * counted, so the result is stable under re-redaction.
 */
export function findRedactions(text: string, opts: RedactOptions = {}): RedactionSpan[] {
  const claimed: RedactionSpan[] = [];
  const overlaps = (start: number, end: number) => claimed.some((s) => start < s.end && s.start < end);
  const folded = foldWideDigits(text);
  for (const rule of rulesFor(opts)) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    const subject = rule.wideDigits ? folded : text;
    for (let m = pattern.exec(subject); m !== null; m = pattern.exec(subject)) {
      if (m[0].length === 0) pattern.lastIndex++;
      const range = rule.span ? rule.span(m) : ([m.index, m.index + m[0].length] as [number, number]);
      const [start, end] = range ?? [0, 0];
      if (!range || end <= start || text.slice(start, end) === REDACTED || overlaps(start, end)) {
        if (rule.resume) pattern.lastIndex = Math.max(rule.resume(m), m.index + 1);
        continue;
      }
      claimed.push({ start, end, pattern: rule.name });
      pattern.lastIndex = Math.max(pattern.lastIndex, end);
    }
  }
  return claimed.sort((a, b) => a.start - b.start);
}

/** `text` with each span replaced by REDACTED. */
export function applyRedactions(text: string, spans: readonly RedactionSpan[]): string {
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start) + REDACTED;
    cursor = span.end;
  }
  return out + text.slice(cursor);
}

/**
 * Scrubs secret shapes out of `text` and counts the spans it replaced (see the
 * module comment for what each tier matches). Idempotent: redacting
 * already-redacted text changes nothing.
 */
export function redactSecretsWithCount(text: string, opts: RedactOptions = {}): RedactionResult {
  const spans = findRedactions(text, opts);
  return { text: applyRedactions(text, spans), redactions: spans.length };
}

/** redactSecretsWithCount's text alone. */
export function redactSecrets(text: string, opts: RedactOptions = {}): string {
  return redactSecretsWithCount(text, opts).text;
}
