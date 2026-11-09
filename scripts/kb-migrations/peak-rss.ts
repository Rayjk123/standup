/**
 * Preloaded into a CLI run by large-db.test.ts (`bun --preload`): on exit,
 * writes the process's own peak RSS in bytes to PEAK_RSS_FILE. It reads
 * VmHWM from /proc/self/status, the high-water mark of the process's own
 * address space since exec. getrusage's maxrss (`resourceUsage().maxRSS`,
 * the parent's or the child's) also counts the address space forked from the
 * parent, so under a full suite it reads the test runner's own size. Only
 * this process is measured, not any it spawns; where /proc is missing
 * nothing is written, which the test reads as no peak reported.
 */

import { readFileSync, writeFileSync } from "fs";

const out = process.env.PEAK_RSS_FILE;
if (out) {
  process.on("exit", () => {
    let status = "";
    try {
      status = readFileSync("/proc/self/status", "utf8");
    } catch {
      return;
    }
    const kb = /^VmHWM:\s+(\d+) kB$/m.exec(status)?.[1];
    if (kb) writeFileSync(out, String(Number(kb) * 1024));
  });
}
