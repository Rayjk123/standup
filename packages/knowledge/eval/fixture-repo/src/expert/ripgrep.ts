import { spawn } from "child_process";

/** Resolved from PATH; when ripgrep is not installed the spawn fails with ENOENT. */
export const RG_BINARY = "rg";

export interface RgMatch {
  path: string;
  line: number;
  text: string;
}

export function runRipgrep(pattern: string, cwd: string, maxMatches = 50): Promise<RgMatch[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(RG_BINARY, ["--json", "--max-count", "5", "-e", pattern, "."], { cwd });
    const matches: RgMatch[] = [];
    let buf = "";
    child.on("error", reject);
    child.stdout.on("data", (d) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const ev = JSON.parse(line);
        if (ev.type === "match" && matches.length < maxMatches) {
          matches.push({ path: ev.data.path.text, line: ev.data.line_number, text: ev.data.lines.text });
        }
      }
    });
    child.on("close", () => resolve(matches));
  });
}
