/**
 * A command line for `terminal.sendText`, which a shell then reads (bash, zsh, fish,
 * PowerShell or cmd.exe — whichever the user's terminal runs). A word of only plain
 * characters goes as it is; any other is wrapped in double quotes, which every one of
 * those shells reads literally as long as the word holds none of `"`, `$`, backtick,
 * `\`, `!` or `%` (and no newline) — the launch values are validated to hold none
 * (core isCharacterLaunch). zsh would otherwise glob `sonnet[1m]` and fail the launch.
 */

const PLAIN_WORD_RE = /^[A-Za-z0-9_\-./:=@,+]+$/;
const UNQUOTABLE_RE = /["$`\\!%\r\n]/;

export function shellJoin(words: readonly string[]): string {
  return words
    .map((word) => {
      if (PLAIN_WORD_RE.test(word)) return word;
      if (UNQUOTABLE_RE.test(word)) {
        throw new Error(`[Pixel Agents] Refusing to type an unsafe word into the shell: ${word}`);
      }
      return `"${word}"`;
    })
    .join(' ');
}
