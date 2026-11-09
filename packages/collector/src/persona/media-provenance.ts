import type { Database } from "bun:sqlite";
import { realpathSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";
import { PERSONA_ATTACHMENTS_DIRNAME } from "@standup/shared";
import { findPersonaMediaShare, getLaunchBySession, getPersonaAttachment, launchShareKey } from "@standup/store";
import { floorCategoryOf } from "../floor/gate.js";
import { attachmentsDir } from "./attachments.js";

/**
 * The collector's word, on a floor hold of a worker reading an owner upload,
 * on whether Persona passed that file to that worker (mediaIds). Persona
 * can't check that itself: frames and model copies never reach its prompt,
 * stored paths can be found by listing, and its memory of a brief is no
 * proof. The hold's question is worker-influenced text, so it is read only
 * for the stored files it names, and conservatively: anything the collector
 * can't pin to exact files in the persona-attachments folder (a clipped
 * call, a glob, a listing, a name outside the folder, another finding beside
 * the media read) is "unidentified", never "passed". The answer travels in a
 * field of its own.
 */

/** What the floor's reason says of a read of an owner upload (in its head line, under category standup-ops). */
const MEDIA_READ_MARK = `reads an owner media upload in ${PERSONA_ATTACHMENTS_DIRNAME}`;

/** A stored copy's file name: its sha256 and a stored media extension. */
const STORED_NAME = /\b([0-9a-f]{64})\.(?:png|jpg|gif|webp|mp4|mov|webm)(?=$|[\s'"`;&|)<>])/g;
/** What must follow a mention of the folder: `/` and a stored copy's whole name. */
const STORED_PATH_TAIL = /^\/[0-9a-f]{64}\.(?:png|jpg|gif|webp|mp4|mov|webm)(?=$|[\s'"`;&|)<>])/;

/** The floor question's head: tool name and category. */
const QUESTION_HEAD = /^Safety floor held a (\S+) call \(([a-z-]+)\): /;

/** Tools whose held call can be judged a plain read of the files it names. */
const READING_TOOLS: ReadonlySet<string> = new Set(["Read", "Bash"]);

/** Shell programs that list, search or copy whole trees: a call using one may reach more than it names. */
const TREE_PROGRAMS = /(?:^|[\s;&|(`$'"])(?:ls|find|du|tree|rsync|tar|zip|unzip|rg|fd|locate)(?=$|[\s;&|)`'"])/;
const RECURSIVE_COPY_OR_GREP = /(?:^|[\s;&|(`$'"])(?:cp|grep|egrep|fgrep|scp)\s+(?:\S+\s+)*?-(?:-recursive\b|[A-Za-z]*[rRa])/;

/** One file the held call names that was passed to the worker. */
export interface ProvenanceFile {
  attachmentId: string;
  name: string;
  sharedAt: string;
}

export type MediaProvenance =
  | { passed: true; files: ProvenanceFile[] }
  | { passed: false; reason: "not-passed" | "unidentified" };

const UNIDENTIFIED: MediaProvenance = { passed: false, reason: "unidentified" };

/** Whether `question` is the floor's hold on reading an owner upload (judged on its head line alone). */
export function isMediaReadHold(question: string): boolean {
  const head = question.split("\n", 1)[0] ?? "";
  return floorCategoryOf(question) === "standup-ops" && head.includes(MEDIA_READ_MARK);
}

/** The parts floorQuestion writes: head line, the call's words (as shown), and whether those were clipped. */
function questionParts(question: string): { tool: string; head: string; call: string; clipped: boolean } | null {
  const head = question.split("\n", 1)[0] ?? "";
  const m = QUESTION_HEAD.exec(head);
  if (!m) return null;
  const body = question.slice(head.length);
  if (!body.startsWith("\n\n")) return null;
  const end = body.lastIndexOf("\n\ncwd: ");
  if (end < 2) return null;
  const call = body.slice(2, end);
  return { tool: m[1]!, head, call, clipped: call.endsWith("…") };
}

/** The strings of a call's input: a Bash command as it is, another tool's JSON input by its string values. */
function callStrings(tool: string, call: string): string[] | null {
  if (tool === "Bash") return [call];
  try {
    const parsed = JSON.parse(call) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return Object.values(parsed as Record<string, unknown>).filter((v): v is string => typeof v === "string");
  } catch {
    return null;
  }
}

/** `path` as given and, when it exists, as resolved through its symlinks. */
function spellingsOf(path: string): string[] {
  const out = new Set([resolve(path)]);
  try {
    out.add(realpathSync(path));
  } catch {
    // Not there yet: only the given spelling can name it.
  }
  return [...out];
}

/**
 * The spellings of the persona-attachments folder a call may use: absolute
 * (as configured and resolved), and from home as `~/…` or `$HOME/…`. (`${HOME}`
 * is a brace, which the glob check refuses anyway.)
 */
function folderSpellings(dataDir: string, home: string): string[] {
  const dirs = spellingsOf(attachmentsDir(dataDir));
  const out = new Set<string>(dirs);
  for (const dir of dirs) {
    for (const h of spellingsOf(home)) {
      if (!dir.startsWith(`${h}/`)) continue;
      const rel = dir.slice(h.length + 1);
      out.add(`~/${rel}`);
      out.add(`$HOME/${rel}`);
    }
  }
  return [...out];
}

/**
 * The stored files `text` names, each only as an exact path in the
 * persona-attachments folder; null when any mention of a stored name or of
 * the folder is anything else (a name elsewhere, which may be a link; the
 * bare folder; a partial path).
 */
function namedFiles(text: string, folders: readonly string[]): string[] | null {
  const shas: string[] = [];
  for (const m of text.matchAll(STORED_NAME)) {
    const at = m.index!;
    if (!folders.some((f) => text.slice(at - f.length - 1, at) === `${f}/`)) return null;
    shas.push(m[1]!);
  }
  // Every mention of the folder must lead straight to one of those names.
  let from = 0;
  for (;;) {
    const at = text.indexOf(PERSONA_ATTACHMENTS_DIRNAME, from);
    if (at < 0) break;
    const rest = text.slice(at + PERSONA_ATTACHMENTS_DIRNAME.length);
    if (!STORED_PATH_TAIL.test(rest)) return null;
    from = at + PERSONA_ATTACHMENTS_DIRNAME.length;
  }
  return shas;
}

/**
 * The provenance of the stored files a media-read hold of `sessionId` names,
 * or null when `question` isn't one. "passed" only when the hold is purely
 * the media read of a Read or Bash call shown in full, with no glob, listing
 * or recursive program, naming each file by its exact path in the
 * persona-attachments folder of `dataDir`, and every one was passed by
 * `owner`'s Persona to that session (or to the launch it runs). Otherwise
 * "not-passed" (an exactly named file wasn't passed) or "unidentified".
 */
export function mediaProvenanceFor(
  db: Database,
  owner: string,
  sessionId: string,
  question: string,
  opts: { dataDir?: string; home?: string } = {}
): MediaProvenance | null {
  if (!isMediaReadHold(question)) return null;
  const parts = questionParts(question);
  if (!parts || !opts.dataDir) return UNIDENTIFIED;
  // Another finding beside the media read, or a clipped call, can't be vouched for.
  if (parts.head.includes("(also") || parts.head.split(MEDIA_READ_MARK).length !== 2) return UNIDENTIFIED;
  if (parts.clipped || !READING_TOOLS.has(parts.tool)) return UNIDENTIFIED;
  const strings = callStrings(parts.tool, parts.call);
  if (!strings) return UNIDENTIFIED;
  const text = strings.join("\n");
  if (/[*?[{]/.test(text)) return UNIDENTIFIED;
  if (parts.tool === "Bash" && (TREE_PROGRAMS.test(text) || RECURSIVE_COPY_OR_GREP.test(text))) return UNIDENTIFIED;
  const named = namedFiles(text, folderSpellings(opts.dataDir, opts.home ?? homedir()));
  if (!named || named.length === 0) return UNIDENTIFIED;

  const launch = getLaunchBySession(db, sessionId);
  const keys = [sessionId, ...(launch ? [launchShareKey(launch.id)] : [])];
  const files: ProvenanceFile[] = [];
  for (const sha of new Set(named)) {
    const share = findPersonaMediaShare(db, owner, keys, sha);
    if (!share) return { passed: false, reason: "not-passed" };
    if (files.some((f) => f.attachmentId === share.attachmentId)) continue;
    files.push({
      attachmentId: share.attachmentId,
      name: getPersonaAttachment(db, share.attachmentId)?.name ?? "upload",
      sharedAt: share.sharedAt,
    });
  }
  return { passed: true, files };
}
