/**
 * Wraps a string as a single POSIX-shell-quoted word, safe for ANY content.
 * Single quotes suppress every shell expansion — `$(...)` command substitution,
 * backticks, `$VAR`, globbing, word-splitting — so an attacker-influenced value
 * (a ticket title, a branch name) can never turn a composed command line into
 * code execution when a human pastes and runs it. The only character single
 * quotes cannot carry is `'` itself, which is closed, escaped, and reopened
 * (`'\''`). A double-quoted form is NOT safe here: a shell still performs
 * command substitution and variable expansion inside `"..."`.
 */
export function shquote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
