import type { OrgProfile } from "./types.js";

/**
 * The built-in org profile: no org-specific vocabulary — no internal hosts,
 * no SSO, no org CLIs, no MCP tool known to only read, no review link format
 * beyond "any http(s) URL". What it does list are the generic outward steps
 * every install holds: pushing, publishing, releasing and changing clusters,
 * infrastructure or registries. The floor's own built-in rules hold each of
 * these already, with finer reasons; the profile's copies apply only where a
 * built-in rule didn't hold the call (see OrgCliRule). AWS calls are not
 * listed: the floor's account-aware AWS rules hold an AWS change unless it
 * runs in a listed personal account (STANDUP_PERSONAL_AWS_ACCOUNTS), and a
 * profile rule would hold that one too.
 */
export const DEFAULT_ORG_PROFILE: OrgProfile = Object.freeze({
  name: "default",
  internalHostSuffixes: [],
  ownerHostPatterns: [],
  // The cloud CLIs' own credential and SSO token stores (`.aws/sso/cache`,
  // `.azure`, `.config/gcloud`, …) are held for every profile by the floor's
  // home-credentials list; the profile names only an org's own SSO.
  sso: {
    dirs: [],
    cookieFiles: [],
    loginClis: [],
  },
  credentialClis: [],
  reviewClis: [],
  wrapperClis: [],
  httpClients: [],
  // Each rule reads the program's global options (an option on its own,
  // `--opt=value`, or one of the program's value-taking options and its
  // value) and then the subcommand, so `git stash push` or `kubectl get pods
  // delete` never reads as a push or a delete.
  outwardRules: [
    {
      program: "git",
      valueOptions: ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"],
      subcommand: ["push"],
      category: "outward",
      reason: "pushes to a remote",
    },
    ...[
      ["pr", "create|merge|close|reopen|edit|comment|review|ready"],
      ["release", "create|upload|edit|delete"],
      ["repo", "create|delete|edit|rename|archive"],
    ].map((subcommand) => ({
      program: "gh",
      valueOptions: ["-R", "--repo"],
      subcommand,
      category: "outward" as const,
      reason: "acts on a pull request, release or repository on GitHub",
    })),
    {
      program: "kubectl|oc",
      valueOptions: ["-n", "--namespace", "--context", "--kubeconfig", "--cluster", "--user", "-s", "--server", "--token"],
      subcommand: ["apply|delete|create|replace|patch|scale|rollout|edit|drain|cordon|label|annotate"],
      category: "outward",
      reason: "changes a cluster",
    },
    {
      program: "terraform|tofu|terragrunt",
      subcommand: ["apply|destroy|import"],
      category: "outward",
      reason: "changes infrastructure",
    },
    {
      program: "npm|pnpm|yarn|bun",
      subcommand: ["publish"],
      category: "outward",
      reason: "publishes a package",
    },
    ...[["push"], ["image", "push"]].map((subcommand) => ({
      program: "docker|podman|nerdctl|finch",
      valueOptions: ["-H", "--host", "-c", "--context", "--config", "-l", "--log-level"],
      subcommand,
      category: "outward" as const,
      reason: "pushes an image to a registry",
    })),
  ],
  mcp: {
    readOnlyTools: {},
    reviewWriteTools: [],
    checkoutTools: [],
    selfFiledTools: [],
    pluginPrefixes: [],
  },
  webFetchDomains: [],
  webFetchPages: [],
  identity: {},
  codeReview: {
    remotePatterns: [],
    provisionPatterns: [],
    launchSubdirPatterns: [],
    linkFormat: {},
  },
}) as OrgProfile;
