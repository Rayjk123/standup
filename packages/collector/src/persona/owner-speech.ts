/**
 * Which words of an owner message are the owner's own request. An owner
 * pastes chat logs, quotes a worker, forwards a channel message or drops in
 * a code snippet; none of that is the owner asking Persona for anything. The
 * policy reads a memory request only from what is left once these are taken
 * out (withoutInlineCode, withoutOtherVoices), and only from a clause that
 * asks in the owner's own voice (isDirectRequest).
 */

/** Stands in for an inline code span: no letters, so it carries no words, and the clause stays one. */
const CODE_PLACEHOLDER = " ⟨⟩ ";

/** An inline code span: one or more backticks, the code, and the same run closing it, on one line. */
const INLINE_CODE = /(`+)[^`\n]+?\1/g;
/** An indented code line: four spaces or a tab before anything else. */
const INDENTED_LINE = /^(?: {4,}|\t)[^\n]*/gm;

/**
 * `text` with inline code spans and indented code lines taken out. Run before
 * backticks are folded into apostrophes.
 */
export function withoutInlineCode(text: string): string {
  return text.replace(INLINE_CODE, CODE_PLACEHOLDER).replace(INDENTED_LINE, "\n");
}

/** Verbs that report what someone else said. */
const SPEECH_VERB = String.raw`(?:said|says|wrote|writes|replied|replies|suggested|suggests|proposed|proposes|posted|posts|commented|comments|claimed|claims|mentioned|mentions|messaged|texted|told\s+(?:me|us|you|them|him|her)|asked\s+(?:that|whether|if|for))`;

/**
 * Reported speech: a speech verb whose subject is not the owner ("the worker
 * said …", "Bob says that …", "she wrote: …"). "I said" and "we said" are the
 * owner's own. A quote right after a colon is left to the caller, which drops
 * just the quote.
 */
const REPORTED_SPEECH = new RegExp(
  String.raw`(?<!\b(?:i|we)(?:'\w+)?(?:\s+\w+)?\s+)\b${SPEECH_VERB}\b(?![ \t]*:[ \t]*["“„«'‘])`,
  "gi"
);

/**
 * Reported speech in other languages ("Bob dijo:", "Bob a écrit :", "Bob
 * schrieb:", "鲍勃说：", "बॉब ने कहा"), matched on letter boundaries rather than
 * ASCII word boundaries.
 */
const OTHER_LANGUAGE_SPEECH =
  /(?<![\p{L}\p{M}])(?:dijo|escribi[oó]|a\s+[ée]crit|a\s+dit|schrieb|sagte|schreibt|disse|scrisse|ha\s+scritto|zei|schreef|skrev|napisał|написал|сказал)(?![\p{L}\p{M}])(?=[ \t]*[:：,]|[ \t]*$)|说[:：]|說[:：]|写道|寫道|表示[:：]|ने\s+(?:कहा|लिखा)/gimu;

/** Words that mark the text after them as copied from elsewhere. */
const PASTE_MARKER =
  /\b(?:pasted|pasting|copied|copying|forwarded|forwarding|quoting|quoted|cross-?posted|transcript|excerpt)\b/gi;

/**
 * Lines that head a forwarded or copied message: mail headers (`From:`,
 * `Sent:`, `To:`, `Cc:`, `Date:`), "-----Original Message-----" and
 * forwarded-message banners, "On … wrote:", and a chat client's
 * name-and-time line ("Bob Smith  10:31 AM").
 */
const MESSAGE_HEADER = new RegExp(
  [
    String.raw`^[ \t]*(?:from|sent|to|cc|bcc|date)[ \t]*:[ \t]*\S`,
    String.raw`-{2,}[ \t]*(?:original[ \t]+message|forwarded[ \t]+message)[ \t]*-*`,
    String.raw`^[ \t]*begin[ \t]+forwarded[ \t]+message\b`,
    String.raw`^[ \t]*on\b[^\n]{1,200}\bwrote[ \t]*:`,
    String.raw`^[ \t]*@?[A-Z][\w.'-]*(?:[ \t]+[A-Z][\w.'-]*){0,3}[ \t]+\[?\d{1,2}:\d{2}(?::\d{2})?(?:[ \t]*[AaPp]\.?[Mm]\.?)?\]?[ \t]*$`,
  ].join("|"),
  "gim"
);

/** Labels an owner leads their own line with ("Remember: …", "PS: …", "Me: …"); any other is a speaker. */
const OWN_LABELS = new Set([
  "remember", "note", "notes", "reminder", "ps", "pps", "also", "update", "fyi", "important", "rule", "preference",
  "nb", "btw", "edit", "tldr", "context", "ok", "okay", "yes", "no", "so", "and", "then", "please", "actually",
  "memory", "todo", "question", "answer", "re", "subject", "summary", "persona", "hey", "hi", "plus", "next",
  "first", "second", "third", "finally", "lastly", "step", "goal", "task", "ask", "request", "i", "me",
]);

/**
 * A line led by a speaker label: `Bob: …`, `@bob: …`, `[10:31] Bob: …`,
 * `<bob> …`. Captures the label so an owner's own lead-in can be told apart.
 */
const SPEAKER_LINE =
  /^[ \t]*(?:\[[^\]\n]{1,40}\][ \t]*)?(?:(@?[A-Za-z][\w.'-]{0,30}(?:[ \t]+[A-Z][\w.'-]{0,30})?)[ \t]*:(?!\/\/)|<[^>\n]{1,30}>)/gm;

/** A line on which the owner takes the word back after someone else's: "Me: …", "My take: …". */
const OWN_VOICE_LINE = /^[ \t]*(?:me|me\s+again|my\s+(?:take|reply|answer|response|view|thoughts?|two\s+cents)|mine)[ \t]*:/gim;

/** Where the first of `re`'s matches at or after `from` starts that `accept` takes, or -1. */
function firstMatch(re: RegExp, text: string, from: number, accept: (m: RegExpExecArray) => boolean = () => true): number {
  re.lastIndex = from;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (accept(m)) return m.index;
    if (m[0].length === 0) re.lastIndex++;
  }
  return -1;
}

/** Where the first words at or after `from` that are someone else's start, or -1. */
function otherVoiceAt(text: string, from: number): number {
  const starts = [
    firstMatch(SPEAKER_LINE, text, from, (m) => m[1] === undefined || !OWN_LABELS.has(m[1].toLowerCase().replace(/[^a-z]/g, ""))),
    firstMatch(REPORTED_SPEECH, text, from),
    firstMatch(OTHER_LANGUAGE_SPEECH, text, from),
    firstMatch(PASTE_MARKER, text, from),
    firstMatch(MESSAGE_HEADER, text, from),
  ].filter((i) => i >= 0);
  return starts.length > 0 ? Math.min(...starts) : -1;
}

/**
 * `text` (folded) without the words that are someone else's. Once a message
 * turns to another voice — a line led by a speaker label, reported speech,
 * a paste marker, a forwarded or copied message's header — where that voice
 * stops can't be told, so everything after it is left out, unless a later
 * line hands the word back to the owner ("Me: …", "My take: …"). What is
 * left out is replaced by a line break.
 */
export function withoutOtherVoices(text: string): string {
  let kept = "";
  let at = 0;
  while (at < text.length) {
    const other = otherVoiceAt(text, at);
    if (other < 0) return kept + text.slice(at);
    kept += `${text.slice(at, other)}\n`;
    const back = firstMatch(OWN_VOICE_LINE, text, other + 1);
    if (back < 0) return kept;
    at = back;
  }
  return kept;
}

/** What may come before a memory phrase and leave it the owner's own words. */
const LEAD_FILLER =
  /^(?:[\s,;:.!—–\-()"'*⟨⟩]+|(?:and|also|ok(?:ay)?|so|oh|hey|hi|persona|please|pls|actually|just|now|btw|alright|right|yes|yeah|yep|sure|great|thanks|cool|important|ps|note|reminder|fyi|update|rule|preference|nb|edit|tldr|me|me\s+again|my\s+take|one\s+more\s+thing|by\s+the\s+way|and\s+also)\b)/i;
/**
 * The owner asking in the first or second person ("I want you to …", "I'd
 * like you to …", "you should …"), or stating what they decided ("We
 * decided: …", "I said: …").
 */
const OWNER_FRAME =
  /^(?:i(?:'d\s+(?:really\s+)?(?:like|prefer)|\s+(?:really\s+)?(?:want|need|would\s+like|would\s+prefer|prefer))\s+(?:(?:that\s+)?you\s+|it\s+if\s+you\s+|for\s+you\s+)?(?:to\s+)?|i'?m\s+asking\s+you\s+to\s+|you\s+(?:should|must|need\s+to|have\s+to)\s+(?:(?:always|never)\s+)?|make\s+sure\s+(?:that\s+)?(?:you\s+)?(?:to\s+)?|(?:i|we)(?:'ve|\s+have)?\s+(?:decided|agreed|said)(?:\s+that)?\s+)\s*$/i;

/**
 * An instruction in the owner's voice that a trailing memory phrase closes
 * ("Please always ask me before you push, from now on.", "Ask before you
 * push going forward."): it opens with an imperative.
 */
const IMPERATIVE_LEAD =
  /^(?:always|never|don't|dont|do\s+not|ask|use|keep|make|stop|start|run|check|write|send|wait|put|add|include|try|avoid|prefer|reply|answer|tell|call|create|open|cut|attach|default|pick|leave|skip)\b/i;

/**
 * Whether the clause asks in the owner's own voice: nothing but filler comes
 * before its memory phrase (at `phraseAt`), or a first- or second-person
 * frame does ("I want you to remember …", "you should, from now on, …"), or
 * the phrase closes the clause after an imperative ("ask before you push
 * going forward"; `phraseEnd` is where the phrase ends). A clause that opens
 * with someone else ("Bob: from now on …", "the worker said that from now on
 * …", "pasted from #team -- from now on …") does not.
 */
export function isDirectRequest(clause: string, phraseAt: number, phraseEnd?: number): boolean {
  let lead = clause.slice(0, phraseAt);
  for (let m = LEAD_FILLER.exec(lead); m && m[0].length > 0; m = LEAD_FILLER.exec(lead)) {
    lead = lead.slice(m[0].length);
  }
  const rest = lead.trim().replace(/[\s,;:—–-]+$/, "");
  if (rest === "" || OWNER_FRAME.test(`${rest} `)) return true;
  const trailing = phraseEnd !== undefined && /^[\s.!,;:)\]]*$/.test(clause.slice(phraseEnd));
  return trailing && IMPERATIVE_LEAD.test(rest);
}
