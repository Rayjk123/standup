import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createStore, getOrCreatePersonaState } from "@standup/store";
import { buildTurnArgv, buildTurnStdin, createClaudeTurnRunner, isMediaRejection, isTransientTurnError, parseTurnOutput } from "./turn.js";
import type { TurnInput, TurnSpawn } from "./turn.js";
import { PersonaFleet } from "./fleet.js";
import { PersonaRuntime } from "./runtime.js";
import { resolvePersonaConfig } from "./config.js";

/** One stream-json line per event, as `claude -p --output-format stream-json --verbose` prints them. */
function stream(...events: unknown[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

const INIT = { type: "system", subtype: "init", session_id: "sid-1", tools: ["mcp__standup__list_projects"] };

function assistant(usage: Record<string, number>, parent: string | null = null) {
  return { type: "assistant", parent_tool_use_id: parent, session_id: "sid-1", message: { content: [], usage } };
}

function resultEvent(extra: Record<string, unknown> = {}) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "sid-1",
    result: "done",
    total_cost_usd: 0.12,
    // Cumulative over every model call of the turn.
    usage: { input_tokens: 4, cache_read_input_tokens: 12_158, cache_creation_input_tokens: 12_230, iterations: [] },
    ...extra,
  };
}

describe("parseTurnOutput — stream-json", () => {
  test("context tokens are the LAST main-thread call's prompt, not the turn's cumulative usage", () => {
    const out = stream(
      INIT,
      assistant({ input_tokens: 2, cache_creation_input_tokens: 12_158, cache_read_input_tokens: 0, output_tokens: 24 }),
      { type: "user", message: { content: [{ type: "tool_result" }] } },
      // A subagent's call is not Persona's context.
      assistant({ input_tokens: 90_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, "toolu_1"),
      assistant({ input_tokens: 2, cache_creation_input_tokens: 72, cache_read_input_tokens: 12_158, output_tokens: 5 }),
      resultEvent()
    );
    expect(parseTurnOutput(out, "", 0)).toEqual({
      ok: true,
      text: "done",
      sessionId: "sid-1",
      contextTokens: 12_232,
      costUsd: 0.12,
      inputTokens: 24_392,
      claudeSessionId: "sid-1",
    });
  });

  test("a reply written beside the turn's last tool call is kept when the final call adds no text", () => {
    const usage = { input_tokens: 2, cache_read_input_tokens: 100, output_tokens: 5 };
    const said = (id: string, content: unknown[], parent: string | null = null) => ({
      type: "assistant",
      parent_tool_use_id: parent,
      session_id: "sid-1",
      message: { id, content, usage },
    });
    const reply = "Launched a worker on the job and stopped the idle one.\n\nI'll report once its tests pass.";
    const turn = (final: unknown[], result: string) =>
      stream(
        INIT,
        said("m1", [{ type: "text", text: "Checking the board." }]),
        said("m1", [{ type: "tool_use", id: "t1", name: "mcp__standup__search_board", input: {} }]),
        { type: "user", message: { content: [{ type: "tool_result" }] } },
        said("m2", [{ type: "text", text: "Launched a worker on the job and stopped the idle one." }]),
        said("m2", [{ type: "text", text: "I'll report once its tests pass." }]),
        said("m2", [{ type: "tool_use", id: "t2", name: "mcp__standup__commit", input: {} }]),
        // A subagent's text is not Persona's reply.
        said("s1", [{ type: "text", text: "subagent notes" }], "t2"),
        { type: "user", message: { content: [{ type: "tool_result" }] } },
        said("m3", final),
        resultEvent({ result })
      );
    expect(parseTurnOutput(turn([], ""), "", 0)).toMatchObject({ ok: true, text: "", earlierText: reply });
    expect(parseTurnOutput(turn([{ type: "text", text: "\n" }], "\n"), "", 0)).toMatchObject({ ok: true, earlierText: reply });
    // A final call with text of its own, [silent] included, is the reply.
    const silent = parseTurnOutput(turn([{ type: "text", text: "[silent]" }], "[silent]"), "", 0);
    expect(silent).toMatchObject({ text: "[silent]" });
    expect(silent).not.toHaveProperty("earlierText");
    expect(parseTurnOutput(turn([{ type: "text", text: "Done." }], "Done."), "", 0)).toMatchObject({ text: "Done." });
    // A turn that wrote no text at all stays blank, which posts nothing.
    expect(parseTurnOutput(stream(INIT, said("m1", []), resultEvent({ result: "" })), "", 0)).not.toHaveProperty("earlierText");
    // The CLI's placeholder for a call with no content is not a reply.
    expect(parseTurnOutput(turn([{ type: "text", text: "(no content)" }], ""), "", 0)).toMatchObject({ earlierText: reply });
    // Nor is a message the CLI wrote itself.
    const synthetic = stream(
      INIT,
      said("m1", [{ type: "text", text: reply }]),
      said("m1", [{ type: "tool_use", id: "t1", name: "mcp__standup__commit", input: {} }]),
      { type: "user", message: { content: [{ type: "tool_result" }] } },
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: { id: "m2", model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] },
      },
      resultEvent({ result: "" })
    );
    expect(parseTurnOutput(synthetic, "", 0)).toMatchObject({ earlierText: reply });
    // A tool-only call after the reply (tagging it, say) leaves the reply in place.
    const taggedAfter = stream(
      INIT,
      said("m1", [{ type: "text", text: reply }]),
      said("m1", [{ type: "tool_use", id: "t1", name: "mcp__standup__commit", input: {} }]),
      { type: "user", message: { content: [{ type: "tool_result" }] } },
      said("m2", [{ type: "tool_use", id: "t2", name: "mcp__standup__tag_reply", input: {} }]),
      { type: "user", message: { content: [{ type: "tool_result" }] } },
      said("m3", []),
      resultEvent({ result: "" })
    );
    expect(parseTurnOutput(taggedAfter, "", 0)).toMatchObject({ ok: true, earlierText: reply });
  });

  test("the result's cost, billed tokens and main model are reported, on success and on failure", () => {
    const usage = { input_tokens: 10, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 90, output_tokens: 300 };
    const modelUsage = {
      "claude-haiku-4-5": { costUSD: 0.01 },
      "claude-opus-4-1": { costUSD: 0.4 },
    };
    expect(parseTurnOutput(stream(INIT, resultEvent({ usage, modelUsage, total_cost_usd: 0.41 })), "", 0)).toMatchObject({
      ok: true,
      costUsd: 0.41,
      inputTokens: 1_100,
      outputTokens: 300,
      model: "claude-opus-4-1",
    });
    expect(
      parseTurnOutput(stream(resultEvent({ is_error: true, result: "budget exceeded", usage, total_cost_usd: 2.5 })), "", 1)
    ).toEqual({ ok: false, error: "budget exceeded", costUsd: 2.5, inputTokens: 1_100, outputTokens: 300, claudeSessionId: "sid-1" });
    // No result event: nothing to report.
    expect(parseTurnOutput("garbage", "boom", 1)).toEqual({ ok: false, error: "boom" });
  });

  test("a lone --output-format json object still parses (last usage iteration, else the aggregate)", () => {
    const withIterations = JSON.stringify({
      result: "x",
      session_id: "s",
      usage: {
        input_tokens: 5,
        iterations: [
          { input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 },
          { input_tokens: 10, cache_read_input_tokens: 2000, cache_creation_input_tokens: 30 },
        ],
      },
    });
    const a = parseTurnOutput(withIterations, "", 0);
    expect(a.ok && a.contextTokens).toBe(2040);
    const aggregate = JSON.stringify({
      result: "x",
      session_id: "s",
      usage: { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 },
    });
    const b = parseTurnOutput(aggregate, "", 0);
    expect(b.ok && b.contextTokens).toBe(115);
  });

  test("errors: is_error, non-zero exit, garbage output, missing session id", () => {
    expect(parseTurnOutput(stream(resultEvent({ result: "Bedrock 403", is_error: true })), "", 1)).toEqual({
      ok: false,
      error: "Bedrock 403",
      costUsd: 0.12,
      inputTokens: 24_392,
      claudeSessionId: "sid-1",
    });
    expect(parseTurnOutput("not json", "boom happened\nmore", 1)).toEqual({ ok: false, error: "boom happened" });
    expect(parseTurnOutput(stream(INIT), "", 0)).toEqual({ ok: false, error: "claude exited 0 with no result" });
    expect(parseTurnOutput(JSON.stringify({ result: "x" }), "", 0)).toEqual({
      ok: false,
      error: "claude returned no session id",
    });
  });

  test("an unknown resumed session is flagged from errors[] / stderr, exactly as the CLI reports it", () => {
    const out = stream({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      session_id: "0000",
      num_turns: 0,
      errors: ["No conversation found with session ID: 0000"],
    });
    const viaErrors = parseTurnOutput(out, "", 1, { resumed: true });
    expect(viaErrors).toEqual({
      ok: false,
      error: "No conversation found with session ID: 0000",
      sessionNotFound: true,
      claudeSessionId: "0000",
    });
    const viaStderr = parseTurnOutput("", "No conversation found with session ID: abc", 1, { resumed: true });
    expect(!viaStderr.ok && viaStderr.sessionNotFound).toBe(true);
  });

  test("a successful reply that mentions a missing session is a normal reply, not sessionNotFound", () => {
    const text = "The worker's session 1a2b was not found in the feed, so I relaunched it.";
    const r = parseTurnOutput(stream(INIT, resultEvent({ result: text })), "", 0, { resumed: true });
    expect(r).toMatchObject({ ok: true, text, sessionId: "sid-1" });
  });

  test("a failed reply mentioning a missing session is a plain error when the CLI diagnostics do not say so", () => {
    const r = parseTurnOutput(
      stream(resultEvent({ is_error: true, result: "No conversation found for that ticket" })),
      "",
      1,
      { resumed: true }
    );
    expect(r).toEqual({
      ok: false,
      error: "No conversation found for that ticket",
      costUsd: 0.12,
      inputTokens: 24_392,
      claudeSessionId: "sid-1",
    });
  });

  test("without a resume id the not-found diagnostic is not treated as a stale session", () => {
    const r = parseTurnOutput("", "No conversation found with session ID: abc", 1);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.sessionNotFound).toBeFalsy();
  });
});

const INPUT: TurnInput = {
  prompt: "p".repeat(200_000),
  systemPrompt: "SYSTEM PROMPT TEXT",
  resumeSessionId: "sid-9",
  model: "opus",
  effort: "medium",
  timeoutMs: 60_000,
};

describe("buildTurnArgv", () => {
  test("no built-in tools, only the Standup MCP; prompt and system prompt never on argv", () => {
    const argv = buildTurnArgv(INPUT, {
      claudeBin: "claude",
      systemPromptPath: "/x/system-prompt.md",
      mcpConfigPath: "/x/mcp-config.json",
      settingsArgs: ["--settings", "/x/settings.json"],
    });
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
    expect(argv[argv.indexOf("--allowedTools") + 1]).toBe("mcp__standup");
    expect(argv).not.toContain("Read");
    expect(argv[argv.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(argv).toContain("--verbose");
    expect(argv[argv.indexOf("--append-system-prompt-file") + 1]).toBe("/x/system-prompt.md");
    expect(argv).not.toContain("--append-system-prompt");
    expect(argv[argv.indexOf("--resume") + 1]).toBe("sid-9");
    expect(argv.join(" ")).not.toContain("SYSTEM PROMPT TEXT");
    expect(argv.join(" ")).not.toContain("ppppp");
    expect(argv.slice(-2)).toEqual(["--settings", "/x/settings.json"]);
  });

  test("--input-format stream-json only when the turn shows images", () => {
    const paths = { claudeBin: "claude", systemPromptPath: "/s", mcpConfigPath: "/m", settingsArgs: [] };
    const cases: Array<{ images?: TurnInput["images"]; want: boolean }> = [
      { want: false },
      { images: [], want: false },
      { images: [{ mimeType: "image/png", base64: "AAAA", label: "msg m · attachment 1 · a.png" }], want: true },
    ];
    for (const c of cases) {
      const argv = buildTurnArgv({ ...INPUT, ...(c.images ? { images: c.images } : {}) }, paths);
      expect(argv.includes("--input-format")).toBe(c.want);
      if (c.want) expect(argv[argv.indexOf("--input-format") + 1]).toBe("stream-json");
    }
  });
});

describe("transient turn errors", () => {
  test("credential, throttling, service and network failures are transient; failures of the request or turn are not", () => {
    const cases: Array<[string, boolean]> = [
      [
        "AWS authentication failed · refresh your AWS credentials (SSO sign-in, access keys, API key or proxy token) and retry · if credentials are current, check AWS permissions and model access · API Error: 403",
        true,
      ],
      ["Failed to authenticate. API Error: 403 The security token included in the request is expired", true],
      ["ExpiredTokenException: The security token included in the request is expired", true],
      ["UnrecognizedClientException: The security token included in the request is invalid", true],
      ["API Error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"invalid x-api-key\"}}", true],
      ["API Error: 429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"}}", true],
      ["ThrottlingException: Too many requests, please wait before trying again", true],
      ["API Error: 529 Overloaded", true],
      ["API Error: 500 Internal server error", true],
      ["API Error: 503 Service Unavailable", true],
      ["ServiceUnavailableException: Bedrock is unable to process your request", true],
      ["API Error: Connection error.", true],
      ["fetch failed: getaddrinfo EAI_AGAIN bedrock-runtime.us-west-2.amazonaws.com", true],
      ["connect ECONNREFUSED 127.0.0.1:443", true],
      ["session 7f413a2b-0000 failed: socket hang up", true],
      ["API Error: Request timed out.", true],
      ["CredentialsProviderError: Could not load credentials from any providers", true],
      ["Unable to locate credentials. You can configure credentials by running \"aws configure\".", true],
      ["ModelTimeoutException: Model has timed out in processing the request", true],
      ["ModelStreamErrorException: The stream ended unexpectedly", true],
      ["API Error: 408 Request Timeout", true],
      ["UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error", true],
      ["TypeError: terminated: other side closed", true],
      ["turn timed out after 900s", false],
      ["API Error: 400 Could not process image", false],
      ["API Error: 413 Request Entity Too Large", false],
      ["Prompt is too long", false],
      ["API Error: 404 model: claude-nope not found", false],
      ["No conversation found with session ID: abc", false],
      ["claude exited 1 with no result", false],
      ["refusing to run Persona: HOME is not set", false],
      ["TypeError: x is undefined\n    at run (cli.js:503:12)", false],
      ["the tool reported a timeout limit of 500 rows", false],
    ];
    for (const [text, want] of cases) expect({ text, transient: isTransientTurnError(text) }).toEqual({ text, transient: want });
  });

  test("a failed turn is flagged transient from all its diagnostics, never from the model's reply", () => {
    // The CLI's own error report (is_error) is read.
    const report = parseTurnOutput(
      stream(INIT, resultEvent({ is_error: true, result: "AWS authentication failed · refresh your AWS credentials · API Error: 403" })),
      "",
      1
    );
    expect(report).toMatchObject({ ok: false, transient: true });
    // A cause past stderr's first line still counts, though `error` shows only that line.
    const late = parseTurnOutput("", "(node:1) Warning: something deprecated\nCredentialsProviderError: Could not load credentials from any providers", 1);
    expect(late).toMatchObject({ ok: false, error: "(node:1) Warning: something deprecated", transient: true });
    // On a non-zero exit without is_error the result is the model's reply: not read.
    const reply = parseTurnOutput(
      stream(INIT, resultEvent({ is_error: false, result: "The proxy was throttling us; Bad Gateway twice." })),
      "",
      1
    );
    expect(reply.ok).toBe(false);
    expect(reply).not.toHaveProperty("transient");
    expect(parseTurnOutput(stream(INIT, resultEvent({ is_error: true, result: "Prompt is too long" })), "", 1)).not.toHaveProperty("transient");
  });
});

describe("media rejections", () => {
  test("the API's refusals over images or request size are recognized; other errors are not", () => {
    const cases: Array<[string, boolean]> = [
      ["API Error: 400 messages.3.content.2.image.source.base64: image exceeds 5 MB maximum: 6291456 bytes > 5242880 bytes", true],
      ["API Error: 400 messages.0.content.1.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels", true],
      ["API Error: 400 Could not process image", true],
      ["API Error: 400 Too many images and documents: 101 > 100", true],
      ["ValidationException: A maximum of 20 images can be provided per request", true],
      ["API Error: 413 Request Entity Too Large", true],
      ["API Error: 413 {\"type\":\"error\",\"error\":{\"type\":\"request_too_large\",\"message\":\"Request exceeds the maximum size\"}}", true],
      ["ValidationException: Input image is invalid", true],
      ["API Error: 413 Request too large", true],
      ["API Error: 529 Overloaded", false],
      ["TypeError: x is undefined\n    at run (cli.js:413:12)", false],
      ["session 7f413a2b-0000 failed: socket hang up", false],
      ["Error code 4130 from the proxy", false],
      ["the screenshot shows an upload form", false],
      ["API Error: 401 authentication_error", false],
      ["claude exited 1 with no result", false],
      ["No conversation found with session ID: abc", false],
      ["Prompt is too long", false],
    ];
    for (const [text, want] of cases) expect({ text, rejected: isMediaRejection(text) }).toEqual({ text, rejected: want });
  });

  test("a failed turn that names such a refusal is flagged mediaRejected", () => {
    const failed = parseTurnOutput(
      stream(INIT, resultEvent({ is_error: true, subtype: "error_during_execution", result: "API Error: 400 Could not process image" })),
      "",
      1
    );
    expect(failed).toMatchObject({ ok: false, mediaRejected: true });
    const fromStderr = parseTurnOutput("", "API Error: 413 Request Entity Too Large", 1);
    expect(fromStderr).toMatchObject({ ok: false, mediaRejected: true });
    const other = parseTurnOutput(stream(INIT, resultEvent({ is_error: true, result: "API Error: 529 Overloaded" })), "", 1);
    expect(other.ok === false && other.mediaRejected).toBeFalsy();
    // A model reply quoting the phrase is not the API refusing anything.
    const quoted = parseTurnOutput(
      stream(INIT, resultEvent({ is_error: true, subtype: "error_max_turns", result: 'The worker said "Could not process image" twice.' })),
      "",
      1
    );
    expect(quoted.ok === false && quoted.mediaRejected).toBeFalsy();
    const frame = parseTurnOutput("", "TypeError: boom\n    at x (cli.js:413:12)", 1);
    expect(frame.ok === false && frame.mediaRejected).toBeFalsy();
  });
});

describe("buildTurnStdin", () => {
  test("plain prompt without images; one stream-json user message with a label before each image", () => {
    expect(buildTurnStdin({ prompt: "hello" })).toBe("hello");
    expect(buildTurnStdin({ prompt: "hello", images: [] })).toBe("hello");
    const stdin = buildTurnStdin({
      prompt: "hello",
      images: [
        { mimeType: "image/png", base64: "UE5H", label: "msg m1 · attachment 1 · a.png" },
        { mimeType: "image/jpeg", base64: "SlBH", label: "msg m1 · attachment 2 · frame 1/5 at 1.3 s" },
      ],
    });
    expect(stdin.endsWith("\n")).toBe(true);
    expect(stdin.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(stdin)).toEqual({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          { type: "text", text: "[msg m1 · attachment 1 · a.png]" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "UE5H" } },
          { type: "text", text: "[msg m1 · attachment 2 · frame 1/5 at 1.3 s]" },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "SlBH" } },
        ],
      },
    });
  });
});

describe("createClaudeTurnRunner", () => {
  const origSpawn = Bun.spawn;
  const origConfigDir = process.env.CLAUDE_CONFIG_DIR;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "standup-persona-turn-"));
    // No user settings file here, so nothing is forwarded or written elsewhere.
    process.env.CLAUDE_CONFIG_DIR = dir;
  });
  afterEach(() => {
    Bun.spawn = origSpawn;
    if (origConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = origConfigDir;
    rmSync(dir, { recursive: true, force: true });
  });

  test("the prompt goes on stdin; the system prompt and MCP config are 0600 files in a 0700 cwd", async () => {
    let seenArgv: string[] = [];
    let seenStdin = "";
    Bun.spawn = ((argv: string[], opts: { stdin: Blob }) => {
      seenArgv = argv;
      const stdinRead = opts.stdin.text().then((t) => (seenStdin = t));
      return {
        stdout: new Blob([stream(INIT, resultEvent())]).stream(),
        stderr: new Blob([""]).stream(),
        exited: stdinRead.then(() => 0),
        exitCode: 0,
        kill: () => {},
      };
    }) as unknown as typeof Bun.spawn;
    const cwd = join(dir, "persona");
    const runner = createClaudeTurnRunner({ cwd, collectorUrl: "http://127.0.0.1:1", token: "tok-secret" });
    const result = await runner(INPUT);
    expect(result).toMatchObject({ ok: true, sessionId: "sid-1" });
    expect(seenStdin).toBe(INPUT.prompt);
    expect(statSync(cwd).mode & 0o777).toBe(0o700);
    const sysPath = seenArgv[seenArgv.indexOf("--append-system-prompt-file") + 1]!;
    expect(readFileSync(sysPath, "utf8")).toBe("SYSTEM PROMPT TEXT");
    expect(statSync(sysPath).mode & 0o777).toBe(0o600);
    const mcpPath = seenArgv[seenArgv.indexOf("--mcp-config") + 1]!;
    expect(statSync(mcpPath).mode & 0o777).toBe(0o600);
    const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
    expect(mcp.mcpServers.standup.command).toBe(process.execPath);
    expect(mcp.mcpServers.standup.env.STANDUP_PERSONA_TOKEN).toBe("tok-secret");
    expect(seenArgv.join(" ")).not.toContain("tok-secret");
  });

  test("a turn with images writes the stream-json user message to stdin", async () => {
    let seenArgv: string[] = [];
    let seenStdin = "";
    Bun.spawn = ((argv: string[], opts: { stdin: Blob }) => {
      seenArgv = argv;
      const stdinRead = opts.stdin.text().then((t) => (seenStdin = t));
      return {
        stdout: new Blob([stream(INIT, resultEvent())]).stream(),
        stderr: new Blob([""]).stream(),
        exited: stdinRead.then(() => 0),
        exitCode: 0,
        kill: () => {},
      };
    }) as unknown as typeof Bun.spawn;
    const runner = createClaudeTurnRunner({ cwd: join(dir, "persona"), collectorUrl: "http://127.0.0.1:1", token: "t" });
    const images = [{ mimeType: "image/png" as const, base64: "UE5H", label: "msg m · attachment 1 · a.png" }];
    expect(await runner({ ...INPUT, images })).toMatchObject({ ok: true });
    expect(seenArgv[seenArgv.indexOf("--input-format") + 1]).toBe("stream-json");
    expect(seenStdin).toBe(buildTurnStdin({ prompt: INPUT.prompt, images }));
    expect(JSON.parse(seenStdin).message.content[0]).toEqual({ type: "text", text: INPUT.prompt });
  });

  test("an unusable cwd is refused before anything is written", async () => {
    let spawned = false;
    Bun.spawn = (() => {
      spawned = true;
      throw new Error("must not spawn");
    }) as unknown as typeof Bun.spawn;
    const cwd = join(dir, "not-a-dir");
    writeFileSync(cwd, "");
    const runner = createClaudeTurnRunner({ cwd, collectorUrl: "http://x", token: "t" });
    const result = await runner(INPUT);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("refusing to run Persona");
    expect(spawned).toBe(false);
  });

  test("a group-writable cwd we own (umask 002) is tightened to 0700 and the turn runs", async () => {
    Bun.spawn = (() => ({
      stdout: new Blob([stream(INIT, resultEvent())]).stream(),
      stderr: new Blob([""]).stream(),
      exited: Promise.resolve(0),
      exitCode: 0,
      kill: () => {},
    })) as unknown as typeof Bun.spawn;
    const cwd = join(dir, "shared");
    mkdirSync(cwd);
    chmodSync(cwd, 0o775);
    const runner = createClaudeTurnRunner({ cwd, collectorUrl: "http://x", token: "t" });
    expect(await runner(INPUT)).toMatchObject({ ok: true });
    expect(statSync(cwd).mode & 0o777).toBe(0o700);
    expect(statSync(join(cwd, "mcp-config.json")).mode & 0o777).toBe(0o600);
  });

  test("a timed-out turn is SIGTERMed, then SIGKILLed, and returns even if its pipes never close", async () => {
    const signals: string[] = [];
    Bun.spawn = (() => ({
      // Streams that never end, like a grandchild holding the pipes open.
      stdout: new ReadableStream({ start() {} }),
      stderr: new ReadableStream({ start() {} }),
      exited: new Promise(() => {}),
      exitCode: null,
      kill: (sig?: string) => signals.push(sig ?? "SIGTERM"),
    })) as unknown as typeof Bun.spawn;
    const runner = createClaudeTurnRunner({
      cwd: join(dir, "persona"),
      collectorUrl: "http://x",
      token: "t",
      killGraceMs: 10,
    });
    const started = Date.now();
    const result = await runner({ ...INPUT, timeoutMs: 20 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result).toEqual({ ok: false, error: "turn timed out after 0s" });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("killRunning kills each running turn's process group, and only while it runs", async () => {
    const killed: number[] = [];
    const ends = new Map<number, () => void>();
    const spawnOptions: Array<{ detached: boolean }> = [];
    let nextPid = 4_242;
    const spawn: TurnSpawn = (_argv, options) => {
      spawnOptions.push(options);
      const pid = nextPid++;
      let end!: () => void;
      const ended = new Promise<void>((resolve) => (end = resolve));
      ends.set(pid, end);
      const pipe = () =>
        new ReadableStream<Uint8Array>({
          async start(controller) {
            await ended;
            controller.close();
          },
        });
      return { pid, stdout: pipe(), stderr: pipe(), exited: ended.then(() => 137), exitCode: 137, kill: () => {} };
    };
    const runner = createClaudeTurnRunner({
      cwd: join(dir, "persona"),
      collectorUrl: "http://x",
      token: "t",
      spawn,
      killGroup: (pid) => {
        killed.push(pid);
        ends.get(pid)?.();
      },
    });
    expect(runner.killRunning!()).toBe(0);
    const turns = [runner(INPUT), runner(INPUT)];
    for (let i = 0; i < 50 && spawnOptions.length < 2; i++) await Bun.sleep(5);
    expect(spawnOptions.map((o) => o.detached)).toEqual([true, true]);

    expect(runner.killRunning!()).toBe(2);
    expect(killed).toEqual([4_242, 4_243]);
    for (const result of await Promise.all(turns)) {
      expect(result).toEqual({ ok: false, error: "turn killed on shutdown", killed: true });
    }
    // Finished turns are forgotten: nothing left to kill.
    expect(runner.killRunning!()).toBe(0);
    expect(killed).toEqual([4_242, 4_243]);
  });
});

describe("Persona shutdown", () => {
  test("stopping the fleet kills the running turns of every user's runtime", () => {
    const store = createStore(":memory:");
    try {
      getOrCreatePersonaState(store.db, "alice");
      const killedFor: string[] = [];
      const fleet = new PersonaFleet({
        db: store.db,
        host: "host",
        create: (owner, shared) =>
          new PersonaRuntime({
            db: store.db,
            owner,
            host: shared.host,
            turnSlots: shared.turnSlots,
            config: resolvePersonaConfig({}),
            broadcast: () => {},
            turnRunner: Object.assign(async () => ({ ok: true as const, text: "[silent]", sessionId: "s" }), {
              killRunning: () => {
                killedFor.push(owner);
                return 1;
              },
            }),
          }),
      });
      expect(fleet.getOrCreate("alice")).toBeDefined();
      fleet.hold();
      expect(fleet.isHeld).toBe(true);
      // A forced exit kills the turns alone.
      expect(fleet.killTurns()).toBe(2);
      expect(killedFor.sort()).toEqual(["alice", "host"]);
      killedFor.length = 0;
      fleet.stop();
      expect(killedFor.sort()).toEqual(["alice", "host"]);
    } finally {
      store.db.close();
    }
  });
});
