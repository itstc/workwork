export const ESC = '\u001B';
export const CSI = `${ESC}[`;

export const ansi = {
  enterAlt: `${CSI}?1049h`,
  leaveAlt: `${CSI}?1049l`,
  hideCursor: `${CSI}?25l`,
  showCursor: `${CSI}?25h`,
  clear: `${CSI}2J`,
  home: `${CSI}H`,
  eraseLine: `${CSI}2K`,
  eraseToEnd: `${CSI}0K`,
  reset: `${CSI}0m`,
  moveTo: (row: number, col: number) => `${CSI}${row};${col}H`,
};

/** CSI sequences, OSC strings, and bare two-character escapes. */
const ANSI_SOURCE =
  '\\u001B(?:\\[[0-?]*[ -/]*[@-~]|\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)|[@-Z\\\\-_])';
const ANSI_PATTERN = new RegExp(ANSI_SOURCE, 'g');
const ANSI_AT_START = new RegExp(`^(?:${ANSI_SOURCE})`);

export function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, '');
}

/** Columns a code point occupies in a terminal grid. */
function charWidth(codePoint: number): number {
  if (codePoint === 0x200d) return 0; // zero-width joiner
  if (codePoint >= 0xfe00 && codePoint <= 0xfe0f) return 0; // variation selectors
  if (codePoint >= 0x0300 && codePoint <= 0x036f) return 0; // combining marks
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff)
  ) {
    return 2;
  }
  return 1;
}

export function width(input: string): number {
  let total = 0;
  for (const char of stripAnsi(input)) {
    const point = char.codePointAt(0);
    if (point === undefined || point < 32) continue;
    total += charWidth(point);
  }
  return total;
}

/**
 * Cut a string to `max` columns without slicing an escape sequence in half.
 * Styling still open at the cut point is closed with a reset.
 */
export function truncate(input: string, max: number, ellipsis = '…'): string {
  if (max <= 0) return '';
  if (width(input) <= max) return input;

  const limit = Math.max(0, max - width(ellipsis));
  let out = '';
  let used = 0;
  let styled = false;
  let i = 0;

  while (i < input.length) {
    if (input[i] === ESC) {
      const match = ANSI_AT_START.exec(input.slice(i));
      if (match) {
        out += match[0];
        styled = true;
        i += match[0].length;
        continue;
      }
    }
    const point = input.codePointAt(i) ?? 32;
    const char = String.fromCodePoint(point);
    const w = charWidth(point);
    if (used + w > limit) break;
    out += char;
    used += w;
    i += char.length;
  }

  return out + (styled ? ansi.reset : '') + ellipsis;
}

export function padEnd(input: string, target: number, filler = ' '): string {
  const gap = target - width(input);
  return gap > 0 ? input + filler.repeat(gap) : input;
}

export function padStart(input: string, target: number, filler = ' '): string {
  const gap = target - width(input);
  return gap > 0 ? filler.repeat(gap) + input : input;
}

/** Fit to exactly `target` columns: truncate if long, pad if short. */
export function fit(input: string, target: number): string {
  return padEnd(truncate(input, target), target);
}

/** Hard-wrap plain text to a column width, preserving blank lines. */
export function wrap(text: string, columns: number): string[] {
  if (columns <= 0) return [];
  const out: string[] = [];

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replaceAll('\t', '  ');
    if (width(line) <= columns) {
      out.push(line);
      continue;
    }

    let current = '';
    for (const word of line.split(' ')) {
      if (width(word) > columns) {
        // A single token wider than the pane — chop it.
        if (current) {
          out.push(current);
          current = '';
        }
        let rest = word;
        while (width(rest) > columns) {
          out.push(rest.slice(0, columns));
          rest = rest.slice(columns);
        }
        current = rest;
        continue;
      }
      if (!current) current = word;
      else if (width(current) + 1 + width(word) <= columns) current += ` ${word}`;
      else {
        out.push(current);
        current = word;
      }
    }
    out.push(current);
  }

  return out;
}
