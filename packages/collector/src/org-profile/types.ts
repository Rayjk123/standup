import type { CodeReviewLinkFormat } from "@standup/shared";

/**
 * An org profile: the organization-specific vocabulary the safety floor,
 * Persona's allow check and the code-review adapter read — which hosts are
 * internal, where the org's single sign-on keeps its cookie, which of its
 * CLIs act outward or write credentials, which of its MCP tools only read,
 * and how its code reviews are linked. Standup ships one neutral built-in
 * profile (DEFAULT_ORG_PROFILE); an org adds its own vocabulary with a
 * profile file (see loadOrgProfile). Every list in a loaded file is added to
 * the default's, never put in its place.
 *
 * Its CLI entries (review, credential, wrapper CLIs and CLI rules) only add
 * holds and readings on top of the floor's built-in ones, bar the one a review
 * CLI's own `review` hold stands in for. The entries that name what is safe
 * do allow more: read-only MCP tools, self-filed and checkout tools, WebFetch
 * domains and pages, the internal hosts the SSO cookie may be sent to, the
 * owner's own hosts ssh, scp and rsync may reach, and the account a
 * credential CLI's write pins for the AWS calls after it. An HTTP client
 * entry has its calls read as curl's are, what curl's reading allows
 * included (a write to loopback, a read of Standup's own API).
 *
 * Plain JSON data only: a launch's FloorConfig carries the resolved profile
 * to the floor hook, which never reads the file itself.
 */
export interface OrgProfile {
  /** The profile's name, shown in logs (`default`, `example.corp`). */
  name: string;
  /**
   * DNS suffixes of the org's internal hosts — the ones its single sign-on
   * signs in to (`example.corp` matches `example.corp` and every host under
   * it). A request there carries the SSO cookie the floor lets curl send.
   */
  internalHostSuffixes: string[];
  /**
   * Host globs of the owner's own machines (`{owner}-dev-*`), `{owner}`
   * replaced by the owner's login: ssh, scp and rsync to them are `owner-host`
   * holds. STANDUP_FLOOR_OWNER_HOSTS replaces them when set.
   */
  ownerHostPatterns: string[];
  sso: OrgSsoProfile;
  /**
   * CLIs that write cloud credentials for an account and role (see
   * CredentialCliRule). Like reviewClis, an entry adds its hold to the
   * floor's built-in reading of the call and never replaces it; a program the
   * floor has its own handler for (git, aws, curl, …) is read by that handler
   * alone.
   */
  credentialClis: CredentialCliRule[];
  /**
   * Programs that cut or revise a code review. Every invocation but a lone
   * `--help`, `-h` or `--version` is a Persona-decidable `review` hold; the
   * floor's built-in rules still read the call, and any other hold they find
   * (a deploy, a message) stands beside it.
   */
  reviewClis: string[];
  /** CLI rules beside the floor's built-in ones (see OrgCliRule). */
  outwardRules: OrgCliRule[];
  /**
   * The org's programs that run the rest of their arguments as a command
   * (see OrgWrapperRule): the floor reads that command as if it ran on its
   * own, on top of its built-in reading of the call.
   */
  wrapperClis: OrgWrapperRule[];
  /**
   * The org's own HTTP clients, which sign their requests in their own way
   * (see OrgHttpClient). A program the floor has its own handler for (curl,
   * wget, …) is read by that handler alone. An HTTP client is read as curl
   * and nothing else, so the loader refuses one that is also a review,
   * credential or wrapper CLI, or that an outward rule matches.
   */
  httpClients: OrgHttpClient[];
  mcp: OrgMcpProfile;
  /** Hosts WebFetch may read beside the floor's built-in documentation list; subdomains match. */
  webFetchDomains: string[];
  /** Public pages of a host WebFetch may read, though the host itself is not listed (see OrgWebFetchPages). */
  webFetchPages: OrgWebFetchPages[];
  identity: OrgIdentityProfile;
  codeReview: OrgCodeReviewProfile;
}

/** The org's single sign-on, as the floor guards it. */
export interface OrgSsoProfile {
  /**
   * Home-relative dirs that hold the SSO's session state (`.corp-sso`).
   * Reading inside one is held as a secret read; listing it reads only names.
   */
  dirs: string[];
  /**
   * Home-relative SSO cookie files (`.corp-sso/cookie`). curl may send one,
   * as its cookie file, to internal hosts only (internalHostSuffixes);
   * printing one is held for Persona.
   */
  cookieFiles: string[];
  /** CLIs that sign in to the SSO and refresh its cookie (`corp-sso-login`); a call that runs one touches credentials. */
  loginClis: string[];
}

/**
 * A credential-writing CLI: `<program> <subcommand…> [accountOption <id>] [roleOption <role>]`.
 * The floor reads a matching call as a credential write for the account and
 * role it names: a non-personal account with a role that isn't read-only is
 * an AWS hold.
 */
export interface CredentialCliRule {
  program: string;
  /**
   * The operands that lead a credential write, one regex source per position,
   * each matched against the whole operand (`["cred\\w*", "refresh|renew"]`;
   * a plain word matches only itself). Empty: any invocation writes.
   */
  subcommand: string[];
  /** The option naming the account written for (`--account`). */
  accountOption?: string;
  /** Other spellings of the account option (`-a`). */
  accountAliases?: string[];
  /** The option naming the role (`--role`). */
  roleOption?: string;
  /** Other spellings of the role option (`-r`). */
  roleAliases?: string[];
  /** A bare 12-digit operand names the account when no account option does. */
  positionalAccount?: boolean;
  /** The option naming the CLI profile the credentials are written to (`--profile`): a later `aws --profile <it>` is read as that account. */
  profileOption?: string;
  /**
   * Operands that print the credentials instead, in the subcommand's last
   * position (the first, for a subcommand of one word or none), the operands
   * before it matching the subcommand's: held as floor-tamper.
   */
  printSubcommands?: string[];
  /** First operands after which `--` starts a command the CLI runs with the credentials (`run`, `exec`): that command is read too. */
  execSubcommands?: string[];
}

/**
 * A program that runs a command: `<program> [options] <command> [args…]`
 * (`corp-env --stage dev make test`). After the options (a word in
 * `valueOptions` takes the next word as its value, any other word starting
 * with `-` stands alone, `--` ends them) the rest is the command. A lone
 * remaining word with a space in it (`corp-each "make test"`) is read as a
 * shell command line. The wrapper is read as the org's build tool too:
 * started inside the Standup install, it holds as build tooling does
 * (`make` there), unless it only prints its help or version.
 */
export interface OrgWrapperRule {
  /** The program's name, a bare word. */
  program: string;
  /** Options that take the next word as their value (`--stage`, `-p`). */
  valueOptions?: string[];
}

/**
 * How an OrgHttpClient takes its command line and signs its requests:
 * - `curl-wrapper`: a wrapper that passes every argument to curl and adds
 *   the org's sign-in (its SSO cookie). It is read exactly as curl is: its
 *   URLs, proxies and reroutes, its writes, a `--aws-sigv4` request to AWS
 *   endpoints as an AWS call, and a read of Standup's own API.
 * - `curl-like`: a client of its own that signs in another way (a Kerberos
 *   ticket), takes curl's options, and takes the request's method as a bare
 *   operand too (`<client> POST <url>`). Its URLs, proxies, reroutes and
 *   writes are read as curl's; it is never read as an AWS call or a read of
 *   Standup's own API.
 */
export type OrgHttpClientKind = "curl-wrapper" | "curl-like";

/** An HTTP client of the org's (`corp-curl`), read as curl is (see OrgHttpClientKind). */
export interface OrgHttpClient {
  /** The program's name, a bare word. */
  program: string;
  kind: OrgHttpClientKind;
}

/** What a matching OrgCliRule holds the call as. */
export type OrgRuleCategory = "outward" | "review" | "destructive" | "aws";

/**
 * One CLI rule, read word by word from `<program> <args…>` (free text
 * masked), the words the floor's built-in CLI rules read: the program, then
 * its global options, then the subcommand's operands. The rule matches when
 * the program's name matches `program` and the first operands after the
 * global options match `subcommand`, one pattern per word. A rule applies
 * only where none of the built-in rules held the call, so a profile adds
 * holds and never changes one.
 *
 * Each pattern is a regex source matched against one whole word (a plain
 * word matches only itself) and may not repeat a group (`(…)*`, `(…)+`,
 * `(…){n}`): the loader refuses one that does, since such a pattern can
 * backtrack for longer than the floor's deadline on a word a worker writes.
 */
export interface OrgCliRule {
  /** The program's name (`terraform|tofu`). */
  program: string;
  /**
   * Global options that take the next word as their value (`-C`,
   * `--namespace`). Any other word starting with `-` before the subcommand
   * is read as an option on its own; `--` ends the options.
   */
  valueOptions?: string[];
  /** The subcommand's operands, one pattern per word (`["pr", "create|merge"]`). Empty: every invocation matches. */
  subcommand: string[];
  /** The subcommand's words may start at any word after the program, not only after its global options (`corp-deploy <pipeline> promote`). */
  anywhere?: boolean;
  category: OrgRuleCategory;
  /** The hold's reason, after the step (`deploys through the org's release tool`). */
  reason: string;
}

/** The org's MCP servers, as the floor reads their tools. */
export interface OrgMcpProfile {
  /**
   * Tools known to only read, by server name (after any `plugin_<plugin>_`
   * prefix); `*` lists every tool of the server. Every MCP tool not listed
   * here, nor in STANDUP_FLOOR_READONLY_MCP, is held as outward.
   */
  readOnlyTools: Record<string, string[]>;
  /** Write tools that only change a code review's description (see ReviewWriteToolRule). */
  reviewWriteTools: ReviewWriteToolRule[];
  /** Tools that check a review's change out into a dir on this host (see CheckoutToolRule). */
  checkoutTools: CheckoutToolRule[];
  /**
   * Tools that file a new record for the caller alone — allowed when every
   * `selfFields` entry is unset or one of its values and every `unsetFields`
   * entry is unset; held as outward otherwise.
   */
  selfFiledTools: SelfFiledToolRule[];
  /** Plugin prefixes (`plugin_<name>_`) whose servers count as the org's known servers, as regex sources. */
  pluginPrefixes: string[];
}

/**
 * A write tool that only changes a code review's description, as a review
 * CLI's revise does: a Persona-decidable `review` hold rather than owner-only
 * outward.
 */
export interface ReviewWriteToolRule {
  server: string;
  tool: string;
  /** Narrows the rule to calls whose input `action` field has this value. */
  action?: string;
  /**
   * An input field whose value may name a file the server reads and posts
   * as the description. An absolute path there is read as a read of that
   * file (a secret, the database, a private path or the live data dir stays
   * held as such); a relative one, or a value that isn't text, is held as
   * outward, since the floor can't place the file the server would read.
   */
  fileField?: string;
}

/**
 * A tool that checks a review's change out into a new dir on this host and
 * reaches no one: allowed by default (it lands in the tool's own location),
 * and given `dirField`, read as files extracted to `<dirField>/<nameField or
 * defaultName>` — allowed on the worker's own ground, held where such a
 * write would be. A call whose review id doesn't match `idPattern`, or whose
 * dir or name isn't text, is held as unread.
 */
export interface CheckoutToolRule {
  server: string;
  tool: string;
  /** The input field holding the review id. */
  idField: string;
  /** A regex source the review id must match in full; group 1 is the id `{id}` stands for. */
  idPattern: string;
  /** The input field naming the dir the checkout is created below. */
  dirField: string;
  /** The input field naming the checkout's own dir below it. */
  nameField?: string;
  /** The checkout's dir name when `nameField` is unset; `{id}` is the review id. */
  defaultName: string;
}

/** A tool that files a record for its caller only (see OrgMcpProfile.selfFiledTools). */
export interface SelfFiledToolRule {
  server: string;
  tool: string;
  /** Input fields that name a person: unset, or one of the listed self values (`{assignee: ["currentUser"]}`). */
  selfFields: Record<string, string[]>;
  /** Input fields that must be unset (`delegate`, `watchers`). */
  unsetFields: string[];
}

/**
 * Pages of one host that WebFetch may read:
 * the URL is https or http on the default port, names `host` exactly (no
 * subdomain, no credentials), carries no query, and its path, with `.` and
 * `..` resolved, is plain word segments (no percent escapes) whose leading
 * ones match one of `paths`.
 */
export interface OrgWebFetchPages {
  /** The host, exactly (`www.example.corp`). */
  host: string;
  /**
   * Regex sources matched against the path's leading segments, joined by
   * `/` and without the leading `/` (`blog`, `[a-z0-9-]+/pricing`): the
   * match must end at a segment's end.
   */
  paths: string[];
}

/** How the org's people are named. */
export interface OrgIdentityProfile {
  /**
   * The email domain a bare user alias maps to (`example.corp`): co-author
   * trailers credit `<alias>@<domain>` when no other address is known.
   * Absent: a bare alias is credited only through an explicit email.
   */
  emailDomain?: string;
}

/** How the org's code reviews are cut and linked (read by the `generic` code-review adapter). */
export interface OrgCodeReviewProfile {
  /** What one review is called in prose (`code review`, `pull request`, `change`). */
  noun?: string;
  /**
   * Regex sources matching git remote URLs on the org's code host. A
   * checkout with such a remote has a code review to cut: its code_review
   * stage applies and its project gets the full pipeline preset.
   */
  remotePatterns: string[];
  /**
   * Regex sources matching a project's `provision` command (a workspace the
   * org's build tool creates). A project whose provision matches one is the
   * `generic` adapter's without pinning it: its review packets must link a
   * review and it gets the full pipeline preset.
   */
  provisionPatterns: string[];
  /** Regex sources matching a project's `launchSubdir`, read as provisionPatterns are (`^src/`). */
  launchSubdirPatterns: string[];
  /** How a review link reads (see CodeReviewLinkFormat). */
  linkFormat: CodeReviewLinkFormat;
  /**
   * The command a worker cuts a new review with; `{issueId}` and
   * `{descriptionFile}` are filled in, each shell-quoted. Absent: no command
   * is composed and the worker opens the review the repo's way.
   */
  cutCommand?: string;
  /** The command that revises review `{reviewId}` with `{descriptionFile}`. */
  reviseCommand?: string;
}
