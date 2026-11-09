import { describe, expect, test } from "bun:test";
import { DEFAULT_PIPELINE, PipelineConfigError, resolvePipeline, validateDefinition } from "./pipeline.js";
import {
  REVIEW_TUNNEL_PROJECT_SEEDS,
  REVIEW_TUNNEL_RESERVED_SUFFIXES,
  mergeReviewTunnelConfig,
  reviewTunnelActive,
  reviewTunnelName,
  reviewTunnelSeed,
  splitCommand,
  tunnelSlug,
  validateReviewTunnelConfig,
  type ReviewTunnelConfig,
} from "./review-tunnel.js";

/** A project's built-in layer, as a seed would set it: only where and how its UI is served. */
const SEED: ReviewTunnelConfig = {
  dir: "packages/ui",
  setup: "npm ci --ignore-scripts --no-audit --no-fund",
  setupSkipIf: "node_modules",
  serve: "node node_modules/.bin/vite --host 127.0.0.1 --port {port} --strictPort",
};

describe("validateReviewTunnelConfig", () => {
  test.each([
    ["a full valid layer", { serve: "vite --port {port}", dir: "src/UI", portRange: [5200, 5210], ttlHours: 6, namePattern: "<owner>-<job-slug>" }, []],
    ["an empty layer", {}, []],
    ["just turned off", { enabled: false }, []],
    ["serve without {port}", { serve: "vite" }, ["reviewTunnel.serve: must contain {port}, where the allocated port goes"]],
    ["an unterminated quote", { serve: "vite '{port}" }, ["reviewTunnel.serve: has an unterminated quote"]],
    ["a dir that climbs out", { dir: "../elsewhere" }, ['reviewTunnel.dir: must be a relative path without ".."']],
    ["an absolute dir", { dir: "/etc" }, ['reviewTunnel.dir: must be a relative path without ".."']],
    ["a reversed range", { portRange: [5300, 5200] }, ["reviewTunnel.portRange: must be [low, high], ports from 1024 to 65535 with low <= high"]],
    ["a privileged port", { portRange: [80, 90] }, ["reviewTunnel.portRange: must be [low, high], ports from 1024 to 65535 with low <= high"]],
    ["a pattern without the owner prefix", { namePattern: "<job-slug>" }, ['reviewTunnel.namePattern: must start with "<owner>-" (the tunnel CLI prefixes the host user)']],
    ["an unknown name token", { namePattern: "<owner>-<branch>" }, ["reviewTunnel.namePattern: unknown token (use <owner>, <job-slug>, <user>, <launch>)"]],
    ["a shell-ish allow list", { allow: "group:a; rm -rf" }, ["reviewTunnel.allow: must be a comma-separated list of users or <kind>:<group> entries"]],
    ["a region with shell text", { region: "eu-west-1;id" }, ['reviewTunnel.region: must be a region name such as eu-west-1 (lower-case letters, digits and "-")']],
    ["a zero TTL", { ttlHours: 0 }, ["reviewTunnel.ttlHours: must be a number of hours above 0 and at most 336"]],
    ["an unknown field", { command: "x" }, ["reviewTunnel.command: unknown review tunnel field"]],
  ])("%s", (_name, layer, expected) => {
    expect(validateReviewTunnelConfig(layer)).toEqual(expected);
  });

  test("every seed is valid, and the example seed too", () => {
    for (const seed of Object.values(REVIEW_TUNNEL_PROJECT_SEEDS)) expect(validateReviewTunnelConfig(seed)).toEqual([]);
    expect(validateReviewTunnelConfig(SEED)).toEqual([]);
  });
});

describe("seeds", () => {
  test("Standup ships none: no project gets one", () => {
    expect(Object.keys(REVIEW_TUNNEL_PROJECT_SEEDS)).toEqual([]);
    expect(reviewTunnelSeed("standup")).toBeUndefined();
    expect(reviewTunnelSeed(undefined)).toBeUndefined();
  });

  test("a seed is a copy: editing it leaves the table alone", () => {
    const table = { "example-app": { ...SEED, portRange: [5200, 5299] as [number, number] } };
    const seed = reviewTunnelSeed("example-app", table)!;
    expect(seed).toEqual(table["example-app"]);
    seed.serve = "changed {port}";
    seed.portRange![0] = 1;
    expect(table["example-app"].serve).toContain("vite");
    expect(table["example-app"].portRange).toEqual([5200, 5299]);
  });
});

describe("layering through resolvePipeline", () => {
  const seedLayer = { reviewTunnel: SEED };

  test("no layer configures a tunnel: the definition carries none", () => {
    expect(resolvePipeline(DEFAULT_PIPELINE, [{}, null]).definition.reviewTunnel).toBeUndefined();
  });

  test("user global < project seed < user project, field by field", () => {
    const global = { reviewTunnel: { ttlHours: 4, allow: "bob", region: "us-west-2" } };
    const project = { reviewTunnel: { allow: "group:team", portRange: [6000, 6009] as [number, number] } };
    const { definition } = resolvePipeline(DEFAULT_PIPELINE, [global, seedLayer, project]);
    expect(definition.reviewTunnel).toEqual({
      // The seed's own fields…
      serve: seedLayer.reviewTunnel.serve,
      dir: seedLayer.reviewTunnel.dir,
      setup: seedLayer.reviewTunnel.setup,
      setupSkipIf: seedLayer.reviewTunnel.setupSkipIf,
      // …the user's global choices the seed doesn't set…
      ttlHours: 4,
      region: "us-west-2",
      // …and the user's project layer over both.
      allow: "group:team",
      portRange: [6000, 6009],
    });
  });

  test("a seed field the user's project layer sets is the user's", () => {
    const project = { reviewTunnel: { serve: "python3 -m http.server {port}", dir: "web" } };
    const tunnel = resolvePipeline(DEFAULT_PIPELINE, [null, seedLayer, project]).definition.reviewTunnel!;
    expect(tunnel.serve).toBe("python3 -m http.server {port}");
    expect(tunnel.dir).toBe("web");
  });

  test("a user's global layer can supply defaults a seedless project inherits", () => {
    const global = { reviewTunnel: { ttlHours: 2 } };
    const project = { reviewTunnel: { serve: "python3 -m http.server {port}" } };
    const tunnel = resolvePipeline(DEFAULT_PIPELINE, [global, null, project]).definition.reviewTunnel!;
    expect(tunnel).toEqual({ ttlHours: 2, serve: "python3 -m http.server {port}" });
    expect(reviewTunnelActive(tunnel)).toBe(true);
  });

  test("a user's project layer can turn the seed off", () => {
    const tunnel = resolvePipeline(DEFAULT_PIPELINE, [null, seedLayer, { reviewTunnel: { enabled: false } }]).definition.reviewTunnel;
    expect(reviewTunnelActive(tunnel)).toBe(false);
  });

  test("an invalid layer is refused with the field named", () => {
    try {
      resolvePipeline(DEFAULT_PIPELINE, [{ reviewTunnel: { serve: "vite" } }]);
      throw new Error("expected a PipelineConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(PipelineConfigError);
      expect((e as PipelineConfigError).errors).toEqual(["layer[0].reviewTunnel.serve: must contain {port}, where the allocated port goes"]);
    }
  });

  test("validateDefinition checks a frozen definition's tunnel too", () => {
    expect(validateDefinition({ ...DEFAULT_PIPELINE, reviewTunnel: { portRange: [1, 2] } })).toContain(
      "reviewTunnel.portRange: must be [low, high], ports from 1024 to 65535 with low <= high"
    );
  });

  test("the merged definition is independent of the layers", () => {
    const project = { reviewTunnel: { portRange: [6000, 6009] as [number, number] } };
    const { definition } = resolvePipeline(DEFAULT_PIPELINE, [project]);
    project.reviewTunnel.portRange[0] = 1;
    expect(definition.reviewTunnel!.portRange).toEqual([6000, 6009]);
  });
});

describe("mergeReviewTunnelConfig", () => {
  test("undefined fields don't erase lower ones; nothing set is undefined", () => {
    expect(mergeReviewTunnelConfig([{ serve: "a {port}" }, { serve: undefined, dir: "x" }])).toEqual({ serve: "a {port}", dir: "x" });
    expect(mergeReviewTunnelConfig([null, undefined, {}])).toBeUndefined();
  });
});

describe("splitCommand", () => {
  test.each([
    ["node node_modules/.bin/vite --port {port}", ["node", "node_modules/.bin/vite", "--port", "{port}"]],
    [`sh -c "echo hi; rm x"`, ["sh", "-c", "echo hi; rm x"]],
    ["a 'b c' d\\ e", ["a", "b c", "d e"]],
    ["  spaced   out  ", ["spaced", "out"]],
    [`empty "" arg`, ["empty", "", "arg"]],
    ["$HOME `id` *", ["$HOME", "`id`", "*"]],
  ])("%s", (command, argv) => {
    expect(splitCommand(command)).toEqual(argv);
  });

  test("an unterminated quote is null", () => {
    expect(splitCommand(`echo "x`)).toBeNull();
  });
});

describe("reviewTunnelName", () => {
  const vars = { hostUser: "alice", jobSlug: "Checkout editor: currency chips!", user: "alice", launchId: "0f3c9a1e-aaaa" };

  test("<owner>-<job-slug> slugs the job title under the host user", () => {
    expect(reviewTunnelName("<owner>-<job-slug>", vars)).toEqual({
      name: "alice-checkout-editor-currency-chips",
      suffix: "checkout-editor-currency-chips",
    });
  });

  test("other tokens and literal text", () => {
    expect(reviewTunnelName("<owner>-rv-<user>-<launch>", vars).name).toBe("alice-rv-alice-0f3c9a1e");
  });

  test.each(["standup", "Standup", "STANDUP"])("a job titled %p never lands on the console's tunnel", (title) => {
    const { name } = reviewTunnelName("<owner>-<job-slug>", { ...vars, jobSlug: title });
    expect(name).not.toBe("alice-standup");
    expect(name).toBe("alice-standup-review");
  });

  test("the built-in reserved suffixes are Standup's own only", () => {
    expect([...REVIEW_TUNNEL_RESERVED_SUFFIXES]).toEqual(["standup"]);
    expect(reviewTunnelName("<owner>-<job-slug>", { ...vars, jobSlug: "preview" }).name).toBe("alice-preview");
  });

  test("the name fits a DNS label", () => {
    const { name } = reviewTunnelName("<owner>-<job-slug>-<user>-<launch>", { ...vars, jobSlug: "x".repeat(200), user: "y".repeat(80) });
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(/^[a-z0-9-]+$/);
    expect(name.endsWith("-")).toBe(false);
  });

  test("an empty slug falls back to review", () => {
    expect(reviewTunnelName("<owner>-<job-slug>", { ...vars, jobSlug: "!!!" }).name).toBe("alice-review");
  });

  test("tunnelSlug lower-cases and joins words with -", () => {
    expect(tunnelSlug("Hello, World")).toBe("hello-world");
  });
});
