#!/usr/bin/env bun
// A stand-in for `claude` on a scratch collector, in three shapes:
//  - a Persona turn (`-p` with Persona's --mcp-config): it answers through the
//    collector's own Persona tool route, so every frame the console sees comes
//    from the real runtime. Each MSG-/ASK-/JOB- tag in the turn's "## From
//    <owner>" section picks a behaviour: a plain reply, an ask_user question, or
//    an open_job call (held for approval when STANDUP_PERSONA_HOLD=open_job).
//    Tags anywhere else in the prompt (worker events, approval results, the job
//    snapshot, a message's [re job …] label) are ignored, so a wake turn never
//    replays an old request. A turn that carries the owner's media (image
//    blocks, attachment lines, or a MEDIA- tag) replies with how many image
//    blocks it got and their labels. Any other turn with no MSG tag replies
//    [silent]. A turn sent as stream-json (--input-format stream-json) is read
//    from its JSONL user message; STANDUP_FAKE_CLAUDE_CAPTURE records each turn.
//  - any other `-p` call (titles, summaries): a fixed one-line result.
//  - a launched worker (interactive, no `-p`): draws Claude Code's composer
//    footer, so the launcher sees the pane ready, then idles.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";

const argv = process.argv.slice(2);

if (!argv.includes("-p")) {
  console.log("> \n  ? for shortcuts");
  setInterval(() => {}, 1 << 30);
} else if (!argv.includes("--mcp-config")) {
  await new Response(Bun.stdin.stream()).text();
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "scratch", session_id: "fake-session", total_cost_usd: 0 }));
} else {
  const cfgPath = argv[argv.indexOf("--mcp-config") + 1]!;
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8")).mcpServers.standup.env as {
    COLLECTOR_URL: string;
    STANDUP_PERSONA_TOKEN: string;
  };
  const stdinRaw = await new Response(Bun.stdin.stream()).text();

  // With --input-format stream-json the turn is one JSONL `user` message: the
  // prompt is its first text block, and each image block follows a `[label]` text block.
  type Block = { type: string; text?: string; source?: { type?: string; media_type?: string; data?: string } };
  let prompt = stdinRaw;
  let blocks: Block[] = [];
  if (argv.includes("--input-format") && argv[argv.indexOf("--input-format") + 1] === "stream-json") {
    const first = stdinRaw.split("\n").find((l) => l.trim().startsWith("{"));
    const msg = first ? (JSON.parse(first) as { message?: { content?: Block[] } }) : {};
    blocks = Array.isArray(msg.message?.content) ? msg.message!.content! : [];
    prompt = blocks.find((b) => b.type === "text")?.text ?? "";
  }
  const imageLabels: string[] = [];
  blocks.forEach((b, i) => {
    if (b.type !== "image") return;
    const prev = blocks[i - 1];
    const label = prev?.type === "text" && /^\[.*\]$/.test(prev.text ?? "") ? prev.text!.slice(1, -1) : "";
    imageLabels.push(label);
  });

  // STANDUP_FAKE_CLAUDE_CAPTURE: a directory each Persona turn is recorded in,
  // as turn-<n>.json (argv, stdin, a summary of the content blocks without
  // image data) and turn-<n>.stdin.jsonl (the exact stdin).
  const captureDir = process.env.STANDUP_FAKE_CLAUDE_CAPTURE;
  if (captureDir) {
    mkdirSync(captureDir, { recursive: true });
    const n = readdirSync(captureDir).filter((f) => /^turn-\d+\.json$/.test(f)).length + 1;
    const pathArgs = new Set(["--mcp-config", "--append-system-prompt-file", "--settings"]);
    const safeArgv = argv.map((a, i) => (i > 0 && pathArgs.has(argv[i - 1]!) ? "<path>" : a));
    const contentSummary = blocks.map((b) =>
      b.type === "image"
        ? { type: b.type, media_type: b.source?.media_type, base64Length: b.source?.data?.length ?? 0 }
        : { type: b.type, text: b.text }
    );
    writeFileSync(join(captureDir, `turn-${n}.json`), JSON.stringify({ argv: safeArgv, stdinRaw, contentSummary }, null, 2));
    writeFileSync(join(captureDir, `turn-${n}.stdin.jsonl`), stdinRaw);
  }

  const tool = async (name: string, args: Record<string, unknown>): Promise<void> => {
    await fetch(`${cfg.COLLECTOR_URL}/api/persona/tool`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-standup-persona-token": cfg.STANDUP_PERSONA_TOKEN },
      body: JSON.stringify({ name, arguments: args }),
    });
  };

  // The owner's own messages: the lines under "## From <owner>" up to the next section or fence.
  const ownerLines: string[] = [];
  let inOwner = false;
  for (const line of prompt.split("\n")) {
    if (line.startsWith("## ")) inOwner = line.startsWith("## From ");
    else if (line.startsWith("```")) inOwner = false;
    else if (inOwner) ownerLines.push(line.replace(/\[(?:re job|answers question) [^\]]*\]/g, ""));
  }
  const tags = ownerLines.join("\n").match(/\b(MSG|ASK|JOB)-[A-Za-z0-9]+/g) ?? [];
  const mediaTag = /\bMEDIA-[A-Za-z0-9]+/.test(ownerLines.join("\n"));
  const attachmentLines = ownerLines.filter((l) => /^\s+- attachment \d+:/.test(l));

  const replies: string[] = [];
  if (mediaTag || imageLabels.length > 0 || attachmentLines.length > 0) {
    replies.push(
      `Got your message with ${imageLabels.length} image block(s)${imageLabels.length ? `: ${imageLabels.join("; ")}` : ""}`
    );
  }
  for (const tag of tags) {
    if (tag.startsWith("ASK")) {
      await tool("ask_user", { question: `question ${tag}?`, options: ["yes", "no"] });
    } else if (tag.startsWith("JOB")) {
      await tool("open_job", { title: `job ${tag}`, goal: `goal ${tag}`, reason: `scratch repro ${tag}` });
    } else {
      replies.push(`echo ${tag}`);
    }
  }
  const result = replies.length > 0 ? replies.join("\n") : "[silent]";
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result, session_id: "fake-session", total_cost_usd: 0 }));
}
