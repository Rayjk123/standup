import { spawn } from "child_process";

export interface HeadlessOptions {
  model: string;
  cwd?: string;
  timeoutMs?: number;
}

/**
 * Runs `claude -p` (print mode) with the prompt on stdin and returns stdout.
 * The Bedrock-backed CLI needs the AWS profile and the Bedrock switch passed
 * explicitly; a spawned process does not pick up the profile the collector was
 * started under, and without them the runtime answers 403.
 */
export function runClaudeHeadless(prompt: string, opts: HeadlessOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", "--model", opts.model, "--output-format", "text"], {
      cwd: opts.cwd,
      env: {
        ...process.env,
        AWS_PROFILE: process.env.STANDUP_AWS_PROFILE ?? process.env.AWS_PROFILE ?? "default",
        CLAUDE_CODE_USE_BEDROCK: "1",
      },
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs ?? 120_000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`claude -p exited ${code}: ${err.slice(0, 400)}`));
    });
    child.stdin.end(prompt);
  });
}
