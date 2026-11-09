import { readFileSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, normalize } from "path";
import type { CodeReviewLinkFormat } from "@standup/shared";
import { DEFAULT_ORG_PROFILE } from "./default.js";
import { repeatsGroup } from "./match.js";
import type {
  CheckoutToolRule,
  CredentialCliRule,
  OrgCliRule,
  OrgHttpClient,
  OrgHttpClientKind,
  OrgProfile,
  OrgRuleCategory,
  OrgWebFetchPages,
  OrgWrapperRule,
  ReviewWriteToolRule,
  SelfFiledToolRule,
} from "./types.js";

/** The env var naming the org profile file (an absolute path, or one under `~/`); unset, the file is ORG_PROFILE_FILENAME in the Standup config dir. */
export const ORG_PROFILE_ENV = "STANDUP_ORG_PROFILE";

/** The org profile's file name in the Standup config dir (`~/.config/standup`). */
export const ORG_PROFILE_FILENAME = "org-profile.json";

/**
 * The org profile file: STANDUP_ORG_PROFILE (a leading `~/` read as the home
 * dir), else `<home>/.config/standup/org-profile.json`. The collector reads
 * this path and the floor protects this same path, so a value that is still
 * relative is refused (loadOrgProfile) rather than resolved against a cwd.
 */
export function orgProfilePath(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  const set = env[ORG_PROFILE_ENV]?.trim();
  if (!set) return join(home, ".config", "standup", ORG_PROFILE_FILENAME);
  if (set === "~") return normalize(home);
  if (set.startsWith("~/")) return normalize(join(home, set.slice(2)));
  return isAbsolute(set) ? normalize(set) : set;
}

/** What loading a profile found: the profile in force, the file it read (null when there was none), and what it ignored. */
export interface OrgProfileLoad {
  profile: OrgProfile;
  path: string | null;
  /** Entries of the file that were ignored, each with why. Empty for a clean file or none. */
  errors: string[];
}

const RULE_CATEGORIES: readonly OrgRuleCategory[] = ["outward", "review", "destructive", "aws"];

const TOP_KEYS = new Set([
  "name",
  "internalHostSuffixes",
  "ownerHostPatterns",
  "sso",
  "credentialClis",
  "reviewClis",
  "outwardRules",
  "wrapperClis",
  "httpClients",
  "mcp",
  "webFetchDomains",
  "webFetchPages",
  "identity",
  "codeReview",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function compiles(source: string, flags = ""): boolean {
  try {
    new RegExp(source, flags);
    return true;
  } catch {
    return false;
  }
}

/** A list of non-empty trimmed strings at `path`, recording an error for anything else. */
function strings(v: unknown, path: string, errors: string[], check?: (s: string) => string | null): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    errors.push(`${path}: must be a list of strings`);
    return [];
  }
  const out: string[] = [];
  v.forEach((item, i) => {
    if (typeof item !== "string" || !item.trim()) {
      errors.push(`${path}[${i}]: must be a non-empty string`);
      return;
    }
    const problem = check?.(item.trim());
    if (problem) errors.push(`${path}[${i}]: ${problem}`);
    else out.push(item.trim());
  });
  return out;
}

/** The problem with a profile pattern: one that doesn't compile, or one that repeats a group (see repeatsGroup). */
function patternProblem(source: string, flags = ""): string | null {
  if (!compiles(source, flags)) return "is not a valid regular expression";
  if (repeatsGroup(source)) return "repeats a group ((…)*, (…)+ or (…){n}), which can backtrack without bound; repeat single characters or classes instead";
  return null;
}

const regexCheck = (s: string) => patternProblem(s, "i");

/** A home-relative path: no leading `/` or `~`, no `..` segment. */
const homeRelativeCheck = (s: string) =>
  s.startsWith("/") || s.startsWith("~") || s.split("/").includes("..") ? "must be relative to the home dir, without `..`" : null;

/** A DNS suffix: lower-case labels, no leading dot. */
const suffixCheck = (s: string) =>
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(s.replace(/^\./, "")) ? null : "is not a DNS suffix";

/** A host glob: DNS characters, `*` and the `{owner}` placeholder. */
const hostGlobCheck = (s: string) => (/^(?:[a-z0-9.*-]|\{owner\})+$/i.test(s) ? null : "must be a host glob (letters, digits, '.', '-', '*' and {owner})");

/** A program name: one word, no path. */
const programCheck = (s: string) => (/^[\w.+-]+$/.test(s) ? null : "must be a bare program name");

/** A regex source matched against a whole operand (anchored by the reader). */
const operandCheck = (s: string) => (compiles(`^(?:${s})$`) ? patternProblem(s) : "is not a valid regular expression");

/** A command-line option: `-a`, `--account`. */
const optionCheck = (s: string) => (/^-{1,2}[\w-]+$/.test(s) ? null : "must be an option such as --account");

/** An MCP input field name. */
const fieldCheck = (s: string) => (/^[\w-]+$/.test(s) ? null : "must be an input field name");

const CLI_RULE_SHAPE = "{program, valueOptions?, subcommand, anywhere?, category, reason}";

function cliRules(v: unknown, errors: string[]): OrgCliRule[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    errors.push(`outwardRules: must be a list of ${CLI_RULE_SHAPE}`);
    return [];
  }
  const out: OrgCliRule[] = [];
  v.forEach((r, i) => {
    const at = `outwardRules[${i}]`;
    if (!isRecord(r) || typeof r.program !== "string" || !r.program.trim() || !Array.isArray(r.subcommand) || typeof r.reason !== "string" || typeof r.category !== "string") {
      errors.push(`${at}: must be ${CLI_RULE_SHAPE}`);
      return;
    }
    if (!RULE_CATEGORIES.includes(r.category as OrgRuleCategory)) {
      errors.push(`${at}.category: must be one of ${RULE_CATEGORIES.join(", ")}`);
      return;
    }
    const local: string[] = [];
    const program = r.program.trim();
    const programProblem = operandCheck(program);
    if (programProblem) local.push(`${at}.program: ${programProblem}`);
    const subcommand = strings(r.subcommand, `${at}.subcommand`, local, operandCheck);
    const valueOptions = r.valueOptions === undefined ? undefined : strings(r.valueOptions, `${at}.valueOptions`, local, optionCheck);
    if (r.anywhere !== undefined && typeof r.anywhere !== "boolean") local.push(`${at}.anywhere: must be true or false`);
    errors.push(...local);
    if (local.length > 0) return;
    out.push({
      program,
      ...(valueOptions?.length ? { valueOptions } : {}),
      subcommand,
      ...(r.anywhere === true ? { anywhere: true } : {}),
      category: r.category as OrgRuleCategory,
      reason: r.reason.trim() || "acts outward",
    });
  });
  return out;
}

function credentialRules(v: unknown, errors: string[]): CredentialCliRule[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    errors.push("credentialClis: must be a list of {program, subcommand, accountOption?, roleOption?, printSubcommands?}");
    return [];
  }
  const out: CredentialCliRule[] = [];
  v.forEach((r, i) => {
    const at = `credentialClis[${i}]`;
    if (!isRecord(r) || typeof r.program !== "string" || programCheck(r.program)) {
      errors.push(`${at}.program: must be a bare program name`);
      return;
    }
    const local: string[] = [];
    const rule: CredentialCliRule = {
      program: r.program,
      subcommand: strings(r.subcommand, `${at}.subcommand`, local, operandCheck),
    };
    for (const key of ["accountOption", "roleOption", "profileOption"] as const) {
      if (r[key] === undefined) continue;
      if (typeof r[key] !== "string" || optionCheck(r[key] as string)) local.push(`${at}.${key}: must be an option such as --account`);
      else rule[key] = r[key] as string;
    }
    for (const key of ["accountAliases", "roleAliases"] as const) {
      if (r[key] !== undefined) rule[key] = strings(r[key], `${at}.${key}`, local, optionCheck);
    }
    if (r.positionalAccount !== undefined) {
      if (typeof r.positionalAccount !== "boolean") local.push(`${at}.positionalAccount: must be true or false`);
      else rule.positionalAccount = r.positionalAccount;
    }
    if (r.printSubcommands !== undefined) rule.printSubcommands = strings(r.printSubcommands, `${at}.printSubcommands`, local);
    if (r.execSubcommands !== undefined) rule.execSubcommands = strings(r.execSubcommands, `${at}.execSubcommands`, local);
    errors.push(...local);
    if (local.length === 0) out.push(rule);
  });
  return out;
}

function wrapperRules(v: unknown, errors: string[]): OrgWrapperRule[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    errors.push("wrapperClis: must be a list of {program, valueOptions?}");
    return [];
  }
  const out: OrgWrapperRule[] = [];
  v.forEach((r, i) => {
    const at = `wrapperClis[${i}]`;
    if (!isRecord(r) || typeof r.program !== "string" || programCheck(r.program)) {
      errors.push(`${at}.program: must be a bare program name`);
      return;
    }
    const local: string[] = [];
    for (const key of Object.keys(r)) if (key !== "program" && key !== "valueOptions") local.push(`${at}.${key}: not a wrapper field`);
    const valueOptions = r.valueOptions === undefined ? undefined : strings(r.valueOptions, `${at}.valueOptions`, local, optionCheck);
    errors.push(...local);
    if (local.length === 0) out.push({ program: r.program, ...(valueOptions?.length ? { valueOptions } : {}) });
  });
  return out;
}

const HTTP_CLIENT_KINDS: readonly OrgHttpClientKind[] = ["curl-wrapper", "curl-like"];

function httpClientRules(v: unknown, errors: string[]): OrgHttpClient[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    errors.push("httpClients: must be a list of {program, kind}");
    return [];
  }
  const out: OrgHttpClient[] = [];
  v.forEach((r, i) => {
    const at = `httpClients[${i}]`;
    if (!isRecord(r) || typeof r.program !== "string" || programCheck(r.program)) {
      errors.push(`${at}.program: must be a bare program name`);
      return;
    }
    const local: string[] = [];
    for (const key of Object.keys(r)) if (key !== "program" && key !== "kind") local.push(`${at}.${key}: not an HTTP client field`);
    if (!HTTP_CLIENT_KINDS.includes(r.kind as OrgHttpClientKind)) local.push(`${at}.kind: must be one of ${HTTP_CLIENT_KINDS.join(", ")}`);
    errors.push(...local);
    if (local.length === 0) out.push({ program: r.program, kind: r.kind as OrgHttpClientKind });
  });
  return out;
}

/**
 * The HTTP clients the profile also lists as a review, credential or wrapper
 * CLI, or matches with an outward rule. The floor reads an HTTP client as
 * curl and nothing else, so such an entry would lose that list's hold.
 */
function httpClientOverlaps(profile: OrgProfile): string[] {
  const out: string[] = [];
  for (const { program } of profile.httpClients) {
    const lists: string[] = [];
    if (profile.reviewClis.includes(program)) lists.push("reviewClis");
    if (profile.credentialClis.some((r) => r.program === program)) lists.push("credentialClis");
    if (profile.wrapperClis.some((r) => r.program === program)) lists.push("wrapperClis");
    if (
      profile.outwardRules.some((r) => {
        try {
          return new RegExp(`^(?:${r.program})$`).test(program);
        } catch {
          return false;
        }
      })
    )
      lists.push("outwardRules");
    if (lists.length > 0) out.push(`httpClients: ${program} is also in ${lists.join(", ")}; an HTTP client is read as curl only, so it can't carry that list's holds`);
  }
  return out;
}

function webFetchPageRules(v: unknown, errors: string[]): OrgWebFetchPages[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    errors.push("webFetchPages: must be a list of {host, paths}");
    return [];
  }
  const out: OrgWebFetchPages[] = [];
  v.forEach((r, i) => {
    const at = `webFetchPages[${i}]`;
    if (!isRecord(r) || typeof r.host !== "string" || suffixCheck(r.host) || r.host.startsWith(".")) {
      errors.push(`${at}.host: must be a host name`);
      return;
    }
    const local: string[] = [];
    if (!Array.isArray(r.paths) || r.paths.length === 0) local.push(`${at}.paths: must be a non-empty list of patterns`);
    const paths = Array.isArray(r.paths) ? strings(r.paths, `${at}.paths`, local, operandCheck) : [];
    errors.push(...local);
    if (local.length === 0) out.push({ host: r.host.toLowerCase(), paths });
  });
  return out;
}

function selfFiledRules(v: unknown, errors: string[]): SelfFiledToolRule[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    errors.push("mcp.selfFiledTools: must be a list of {server, tool, selfFields, unsetFields}");
    return [];
  }
  const out: SelfFiledToolRule[] = [];
  v.forEach((r, i) => {
    const at = `mcp.selfFiledTools[${i}]`;
    if (!isRecord(r) || typeof r.server !== "string" || typeof r.tool !== "string" || !r.server || !r.tool) {
      errors.push(`${at}: must name a server and a tool`);
      return;
    }
    const local: string[] = [];
    const selfFields: Record<string, string[]> = {};
    if (r.selfFields !== undefined) {
      if (!isRecord(r.selfFields)) local.push(`${at}.selfFields: must map field names to lists of values`);
      else for (const [field, values] of Object.entries(r.selfFields)) selfFields[field] = strings(values, `${at}.selfFields.${field}`, local);
    }
    const unsetFields = strings(r.unsetFields, `${at}.unsetFields`, local);
    errors.push(...local);
    if (local.length === 0) out.push({ server: r.server, tool: r.tool, selfFields, unsetFields });
  });
  return out;
}

function reviewWriteRules(v: unknown, errors: string[]): ReviewWriteToolRule[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    errors.push("mcp.reviewWriteTools: must be a list of {server, tool, action?, fileField?}");
    return [];
  }
  const out: ReviewWriteToolRule[] = [];
  v.forEach((r, i) => {
    const at = `mcp.reviewWriteTools[${i}]`;
    if (!isRecord(r) || typeof r.server !== "string" || typeof r.tool !== "string" || !r.server || !r.tool || (r.action !== undefined && typeof r.action !== "string")) {
      errors.push(`${at}: must be {server, tool, action?, fileField?}`);
      return;
    }
    if (r.fileField !== undefined && (typeof r.fileField !== "string" || fieldCheck(r.fileField))) {
      errors.push(`${at}.fileField: must be an input field name`);
      return;
    }
    out.push({
      server: r.server,
      tool: r.tool,
      ...(r.action !== undefined ? { action: r.action as string } : {}),
      ...(r.fileField !== undefined ? { fileField: r.fileField as string } : {}),
    });
  });
  return out;
}

function checkoutRules(v: unknown, errors: string[]): CheckoutToolRule[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    errors.push("mcp.checkoutTools: must be a list of {server, tool, idField, idPattern, dirField, nameField?, defaultName}");
    return [];
  }
  const out: CheckoutToolRule[] = [];
  v.forEach((r, i) => {
    const at = `mcp.checkoutTools[${i}]`;
    if (!isRecord(r) || typeof r.server !== "string" || typeof r.tool !== "string" || !r.server || !r.tool) {
      errors.push(`${at}: must name a server and a tool`);
      return;
    }
    const local: string[] = [];
    for (const key of ["idField", "dirField"] as const) {
      if (typeof r[key] !== "string" || fieldCheck(r[key] as string)) local.push(`${at}.${key}: must be an input field name`);
    }
    if (r.nameField !== undefined && (typeof r.nameField !== "string" || fieldCheck(r.nameField))) local.push(`${at}.nameField: must be an input field name`);
    if (typeof r.idPattern !== "string" || !r.idPattern) local.push(`${at}.idPattern: is not a valid regular expression`);
    else {
      const problem = patternProblem(r.idPattern);
      if (problem) local.push(`${at}.idPattern: ${problem}`);
    }
    if (typeof r.defaultName !== "string" || !r.defaultName.includes("{id}") || /[/\\]/.test(r.defaultName) || r.defaultName.split("{id}").join("x").startsWith(".")) {
      local.push(`${at}.defaultName: must be a dir name containing {id}, without a slash or a leading dot`);
    }
    errors.push(...local);
    if (local.length > 0) return;
    out.push({
      server: r.server,
      tool: r.tool,
      idField: r.idField as string,
      idPattern: r.idPattern as string,
      dirField: r.dirField as string,
      ...(r.nameField !== undefined ? { nameField: r.nameField as string } : {}),
      defaultName: r.defaultName as string,
    });
  });
  return out;
}

function linkFormat(v: unknown, errors: string[]): CodeReviewLinkFormat {
  if (v === undefined) return {};
  if (!isRecord(v)) {
    errors.push("codeReview.linkFormat: must be {urlPattern?, idPattern?, urlTemplate?}");
    return {};
  }
  const out: CodeReviewLinkFormat = {};
  for (const key of ["urlPattern", "idPattern"] as const) {
    if (v[key] === undefined) continue;
    const problem = typeof v[key] === "string" ? patternProblem(v[key] as string, "i") : "is not a valid regular expression";
    if (problem) errors.push(`codeReview.linkFormat.${key}: ${problem}`);
    else out[key] = v[key] as string;
  }
  if (v.urlTemplate !== undefined) {
    if (typeof v.urlTemplate !== "string" || !/^https?:\/\/\S*\{id\}/.test(v.urlTemplate)) errors.push("codeReview.linkFormat.urlTemplate: must be an http(s) URL containing {id}");
    else out.urlTemplate = v.urlTemplate;
  }
  return out;
}

/**
 * The profile a parsed file describes, merged over `base` (the built-in
 * default): every list is appended to the base's, every map merged key by
 * key, and scalar fields (`name`, the code-review noun and commands, the
 * email domain) replace the base's. Entries that don't validate are dropped,
 * each recorded in `errors`.
 */
export function mergeOrgProfile(base: OrgProfile, raw: unknown): { profile: OrgProfile; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(raw)) return { profile: base, errors: ["the profile must be a JSON object"] };
  for (const key of Object.keys(raw)) if (!TOP_KEYS.has(key)) errors.push(`${key}: not a profile field`);

  const sso = isRecord(raw.sso) ? raw.sso : {};
  if (raw.sso !== undefined && !isRecord(raw.sso)) errors.push("sso: must be an object");
  const mcp = isRecord(raw.mcp) ? raw.mcp : {};
  if (raw.mcp !== undefined && !isRecord(raw.mcp)) errors.push("mcp: must be an object");
  const identity = isRecord(raw.identity) ? raw.identity : {};
  if (raw.identity !== undefined && !isRecord(raw.identity)) errors.push("identity: must be an object");
  const codeReview = isRecord(raw.codeReview) ? raw.codeReview : {};
  if (raw.codeReview !== undefined && !isRecord(raw.codeReview)) errors.push("codeReview: must be an object");

  const readOnlyTools: Record<string, string[]> = {};
  for (const [server, tools] of Object.entries(base.mcp.readOnlyTools)) readOnlyTools[server] = [...tools];
  if (mcp.readOnlyTools !== undefined) {
    if (!isRecord(mcp.readOnlyTools)) errors.push("mcp.readOnlyTools: must map server names to lists of tool names");
    else
      for (const [server, tools] of Object.entries(mcp.readOnlyTools)) {
        readOnlyTools[server] = [...new Set([...(readOnlyTools[server] ?? []), ...strings(tools, `mcp.readOnlyTools.${server}`, errors)])];
      }
  }

  const scalar = (v: unknown, path: string): string | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== "string" || !v.trim()) {
      errors.push(`${path}: must be a non-empty string`);
      return undefined;
    }
    return v.trim();
  };
  const name = scalar(raw.name, "name");
  const emailDomain = scalar(identity.emailDomain, "identity.emailDomain");
  if (emailDomain && suffixCheck(emailDomain)) errors.push("identity.emailDomain: is not a DNS name");
  const noun = scalar(codeReview.noun, "codeReview.noun");
  const cutCommand = scalar(codeReview.cutCommand, "codeReview.cutCommand");
  const reviseCommand = scalar(codeReview.reviseCommand, "codeReview.reviseCommand");

  const profile: OrgProfile = {
    name: name ?? base.name,
    internalHostSuffixes: [
      ...base.internalHostSuffixes,
      ...strings(raw.internalHostSuffixes, "internalHostSuffixes", errors, suffixCheck).map((s) => s.replace(/^\./, "").toLowerCase()),
    ],
    ownerHostPatterns: [...base.ownerHostPatterns, ...strings(raw.ownerHostPatterns, "ownerHostPatterns", errors, hostGlobCheck)],
    sso: {
      dirs: [...base.sso.dirs, ...strings(sso.dirs, "sso.dirs", errors, homeRelativeCheck)],
      cookieFiles: [...base.sso.cookieFiles, ...strings(sso.cookieFiles, "sso.cookieFiles", errors, homeRelativeCheck)],
      loginClis: [...base.sso.loginClis, ...strings(sso.loginClis, "sso.loginClis", errors, programCheck)],
    },
    credentialClis: [...base.credentialClis, ...credentialRules(raw.credentialClis, errors)],
    reviewClis: [...base.reviewClis, ...strings(raw.reviewClis, "reviewClis", errors, programCheck)],
    outwardRules: [...base.outwardRules, ...cliRules(raw.outwardRules, errors)],
    wrapperClis: [...base.wrapperClis, ...wrapperRules(raw.wrapperClis, errors)],
    httpClients: [...base.httpClients, ...httpClientRules(raw.httpClients, errors)],
    mcp: {
      readOnlyTools,
      reviewWriteTools: [...base.mcp.reviewWriteTools, ...reviewWriteRules(mcp.reviewWriteTools, errors)],
      checkoutTools: [...base.mcp.checkoutTools, ...checkoutRules(mcp.checkoutTools, errors)],
      selfFiledTools: [...base.mcp.selfFiledTools, ...selfFiledRules(mcp.selfFiledTools, errors)],
      pluginPrefixes: [...base.mcp.pluginPrefixes, ...strings(mcp.pluginPrefixes, "mcp.pluginPrefixes", errors, regexCheck)],
    },
    webFetchDomains: [
      ...base.webFetchDomains,
      ...strings(raw.webFetchDomains, "webFetchDomains", errors, suffixCheck).map((d) => d.toLowerCase()),
    ],
    webFetchPages: [...base.webFetchPages, ...webFetchPageRules(raw.webFetchPages, errors)],
    identity: { ...base.identity, ...(emailDomain && !suffixCheck(emailDomain) ? { emailDomain: emailDomain.toLowerCase() } : {}) },
    codeReview: {
      ...base.codeReview,
      ...(noun ? { noun } : {}),
      ...(cutCommand ? { cutCommand } : {}),
      ...(reviseCommand ? { reviseCommand } : {}),
      remotePatterns: [...base.codeReview.remotePatterns, ...strings(codeReview.remotePatterns, "codeReview.remotePatterns", errors, regexCheck)],
      provisionPatterns: [...base.codeReview.provisionPatterns, ...strings(codeReview.provisionPatterns, "codeReview.provisionPatterns", errors, regexCheck)],
      launchSubdirPatterns: [...base.codeReview.launchSubdirPatterns, ...strings(codeReview.launchSubdirPatterns, "codeReview.launchSubdirPatterns", errors, regexCheck)],
      linkFormat: { ...base.codeReview.linkFormat, ...linkFormat(codeReview.linkFormat, errors) },
    },
  };
  errors.push(...httpClientOverlaps(profile));
  return { profile, errors };
}

/** A profile with nothing in it: the base a carried profile is read over, so nothing is added to it. */
const EMPTY_ORG_PROFILE: OrgProfile = {
  name: "",
  internalHostSuffixes: [],
  ownerHostPatterns: [],
  sso: { dirs: [], cookieFiles: [], loginClis: [] },
  credentialClis: [],
  reviewClis: [],
  outwardRules: [],
  wrapperClis: [],
  httpClients: [],
  mcp: { readOnlyTools: {}, reviewWriteTools: [], checkoutTools: [], selfFiledTools: [], pluginPrefixes: [] },
  webFetchDomains: [],
  webFetchPages: [],
  identity: {},
  codeReview: { remotePatterns: [], provisionPatterns: [], launchSubdirPatterns: [], linkFormat: {} },
};

/**
 * A resolved profile carried in a launch's FloorConfig, read back exactly:
 * throws when any entry doesn't validate, so a malformed config is refused
 * rather than classified with part of its vocabulary.
 */
export function readCarriedOrgProfile(raw: unknown): OrgProfile {
  const { profile, errors } = mergeOrgProfile(EMPTY_ORG_PROFILE, raw);
  if (errors.length > 0) throw new Error(`malformed org profile: ${errors.join("; ")}`);
  return profile;
}

/** Reads a file's text, or undefined when it doesn't exist. */
export type OrgProfileReader = (path: string) => string | undefined;

const readIfPresent: OrgProfileReader = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
};

/**
 * The built-in default with the profile file (orgProfilePath) merged over
 * it. No file: the default alone. A relative path, or a file that can't be
 * read or isn't JSON, gives the default, with the problem in `errors`; an entry that doesn't
 * validate is left out, with why in `errors`. activeOrgProfile refuses any
 * load with errors.
 */
export function loadOrgProfile(
  opts: { env?: Record<string, string | undefined>; home?: string; read?: OrgProfileReader } = {}
): OrgProfileLoad {
  const path = orgProfilePath(opts.env ?? process.env, opts.home ?? homedir());
  if (!isAbsolute(path)) return { profile: DEFAULT_ORG_PROFILE, path, errors: [`${ORG_PROFILE_ENV} must be an absolute path (or start with ~/), not ${JSON.stringify(path)}`] };
  let text: string | undefined;
  try {
    text = (opts.read ?? readIfPresent)(path);
  } catch (e) {
    return { profile: DEFAULT_ORG_PROFILE, path, errors: [`could not read ${path}: ${(e as Error).message}`] };
  }
  if (text === undefined) return { profile: DEFAULT_ORG_PROFILE, path: null, errors: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { profile: DEFAULT_ORG_PROFILE, path, errors: [`${path} is not valid JSON: ${(e as Error).message}`] };
  }
  const { profile, errors } = mergeOrgProfile(DEFAULT_ORG_PROFILE, raw);
  return { profile, path, errors };
}

/**
 * A profile file that is present but can't be read, isn't JSON, or has an
 * entry that doesn't validate. Applying the rest of it would drop the holds
 * the bad entries add, so no profile is in force until the file is fixed.
 */
export class OrgProfileError extends Error {
  constructor(
    readonly path: string,
    readonly errors: readonly string[]
  ) {
    super(`the org profile ${path} has ${errors.length === 1 ? "an error" : `${errors.length} errors`} (fix or remove it): ${errors.join("; ")}`);
    this.name = "OrgProfileError";
  }
}

let active: OrgProfile | undefined;

/**
 * The collector's org profile, loaded once (loadOrgProfile). A launch's
 * FloorConfig carries it to the floor hook. Throws OrgProfileError while the
 * profile file has any error: the collector refuses to start on it (see
 * index.ts), and every later read, a launch's included, throws again.
 */
export function activeOrgProfile(): OrgProfile {
  if (active) return active;
  const load = loadOrgProfile();
  if (load.errors.length > 0) throw new OrgProfileError(load.path ?? orgProfilePath(), load.errors);
  if (load.path) console.log(`[org-profile] loaded "${load.profile.name}" from ${load.path}`);
  active = load.profile;
  return active;
}

/** Replaces the collector's org profile (a test's fixture), or with no argument drops it so the next read loads again. */
export function setActiveOrgProfile(profile?: OrgProfile): void {
  active = profile;
}
