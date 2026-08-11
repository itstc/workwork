import { ESC } from './ansi.ts';

export interface Key {
  /** Normalised name: 'up', 'return', 'escape', 'a', … */
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  /** Raw bytes, useful for inserting printable text. */
  sequence: string;
}

const SIMPLE: Record<string, string> = {
  '\r': 'return',
  '\n': 'return',
  '\t': 'tab',
  '\x7f': 'backspace',
  '\b': 'backspace',
  ' ': 'space',
};

const CSI_NAMES: Record<string, string> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  Z: 'tab',
};

const TILDE_NAMES: Record<string, string> = {
  '1': 'home',
  '2': 'insert',
  '3': 'delete',
  '4': 'end',
  '5': 'pageup',
  '6': 'pagedown',
  '7': 'home',
  '8': 'end',
};

function key(name: string, sequence: string, extra: Partial<Key> = {}): Key {
  return { name, ctrl: false, meta: false, shift: false, sequence, ...extra };
}

/**
 * Turn a raw stdin chunk into key events. Handles the escape sequences a
 * terminal actually sends for arrows, page keys and shift-tab; anything else
 * printable comes through as-is so text input works, including pastes.
 */
export function parseKeys(chunk: string): Key[] {
  const keys: Key[] = [];
  let i = 0;

  while (i < chunk.length) {
    const char = chunk[i] as string;

    if (char === ESC) {
      const rest = chunk.slice(i);

      // CSI: ESC [ params final
      const csi = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(rest);
      if (csi) {
        const [full, params = '', final = ''] = csi;
        const modifier = Number(params.split(';')[1] ?? '1') - 1;
        const shift = Boolean(modifier & 1) || final === 'Z';
        const meta = Boolean(modifier & 2);
        const ctrl = Boolean(modifier & 4);

        const name =
          final === '~'
            ? (TILDE_NAMES[params.split(';')[0] ?? ''] ?? 'unknown')
            : (CSI_NAMES[final] ?? 'unknown');

        keys.push(key(name, full, { shift, meta, ctrl }));
        i += full.length;
        continue;
      }

      // SS3: ESC O final (some terminals in application cursor mode)
      const ss3 = /^\x1bO([A-Za-z])/.exec(rest);
      if (ss3) {
        const [full, final = ''] = ss3;
        keys.push(key(CSI_NAMES[final] ?? 'unknown', full));
        i += full.length;
        continue;
      }

      // ESC + character = alt/meta chord.
      const next = chunk[i + 1];
      if (next && next !== ESC) {
        keys.push(key(SIMPLE[next] ?? next.toLowerCase(), ESC + next, { meta: true }));
        i += 2;
        continue;
      }

      keys.push(key('escape', ESC));
      i += 1;
      continue;
    }

    if (SIMPLE[char]) {
      keys.push(key(SIMPLE[char], char));
      i += 1;
      continue;
    }

    const code = char.charCodeAt(0);
    if (code < 32) {
      // Ctrl chords land in the control range: ^A is 1, ^Z is 26.
      keys.push(
        key(String.fromCharCode(code + 96), char, { ctrl: true }),
      );
      i += 1;
      continue;
    }

    // Printable — take the whole code point so emoji survive.
    const point = chunk.codePointAt(i) ?? code;
    const printable = String.fromCodePoint(point);
    keys.push(
      key(printable.toLowerCase(), printable, {
        shift: printable !== printable.toLowerCase(),
      }),
    );
    i += printable.length;
  }

  return keys;
}

/** True when the key represents literal text the user typed. */
export function isPrintable(k: Key): boolean {
  if (k.ctrl || k.meta) return false;
  if (k.name === 'space') return true;
  return k.sequence.length > 0 && k.sequence.codePointAt(0)! >= 32 && k.sequence !== '\x7f';
}
