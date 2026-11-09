/**
 * Terminal escape sequences as they reach Porter in sandbox output (pip and Python colour their
 * output). Order matters: string and CSI sequences are tried before the two-character escapes.
 */
const ESCAPES = new RegExp(
  [
    // OSC, DCS, SOS, PM, APC: a payload ended by BEL or ST (ESC \); a cut-off one ends at the line
    "\\u001b[\\]PX^_][^\\u0007\\u001b\\n]*(?:\\u0007|\\u001b\\\\)?",
    // CSI (7-bit or 8-bit): parameters, intermediates, final byte, which a cut may have lost
    "(?:\\u001b\\[|\\u009b)[0-?]*[ -/]*[@-~]?",
    // charset selection and other escapes with intermediates: ESC ( B
    "\\u001b[ -/]+[0-~]",
    // two-character escapes: ESC 7, ESC M, ESC c
    "\\u001b[0-~]",
    // whatever ESC is left over
    "\\u001b",
  ].join("|"),
  "g",
);

/** The text a terminal would show, for display only: the stored output keeps its escape codes. */
export function stripAnsi(text: string): string {
  return text.includes("\u001b") || text.includes("\u009b") ? text.replace(ESCAPES, "") : text;
}
