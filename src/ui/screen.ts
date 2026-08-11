import { effect, signal } from '@preact/signals-core';
import { ansi, fit } from './ansi.ts';
import type { Key } from './keys.ts';
import { parseKeys } from './keys.ts';

export const size = signal({ rows: process.stdout.rows || 24, cols: process.stdout.columns || 80 });

/** Bumped on a timer so spinners and relative timestamps stay alive. */
export const tick = signal(0);

const out = process.stdout;
const input = process.stdin;

let previous: string[] = [];
let active = false;
let disposeRender: (() => void) | null = null;
let ticker: NodeJS.Timeout | null = null;
let onKey: ((key: Key) => void) | null = null;

function readSize(): void {
  size.value = { rows: out.rows || 24, cols: out.columns || 80 };
}

/**
 * Repaint only the rows that actually changed. Full-screen rewrites in a
 * terminal flicker; line diffing keeps the board steady even while a tool is
 * streaming output into it.
 */
function paint(lines: string[]): void {
  const { rows, cols } = size.value;
  const frame = lines.slice(0, rows);
  let buffer = '';

  for (let row = 0; row < frame.length; row++) {
    const line = fit(frame[row] ?? '', cols);
    if (previous[row] === line) continue;
    buffer += ansi.moveTo(row + 1, 1) + line;
  }

  // Clear rows the frame no longer uses (terminal got shorter, list shrank).
  for (let row = frame.length; row < previous.length; row++) {
    buffer += ansi.moveTo(row + 1, 1) + ansi.eraseLine;
  }

  if (buffer) out.write(buffer + ansi.reset);
  previous = frame;
}

export interface ScreenOptions {
  render: () => string[];
  onKey: (key: Key) => void;
}

export function start(options: ScreenOptions): void {
  if (active) return;
  active = true;
  onKey = options.onKey;

  readSize();
  out.write(ansi.enterAlt + ansi.hideCursor + ansi.clear);
  previous = [];

  if (input.isTTY) input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');
  input.on('data', handleData);
  out.on('resize', handleResize);

  // Re-render whenever any signal the render function touched changes.
  let scheduled = false;
  let latest: string[] = [];
  disposeRender = effect(() => {
    latest = options.render();
    if (scheduled) return;
    scheduled = true;
    // Coalesce bursts (a tool streaming output) into one paint per frame, and
    // always paint the newest frame rather than the one that started the burst.
    setTimeout(() => {
      scheduled = false;
      if (active) paint(latest);
    }, 16);
  });

  ticker = setInterval(() => {
    tick.value = tick.value + 1;
  }, 120);
  ticker.unref?.();
}

function handleData(chunk: string): void {
  if (!onKey) return;
  for (const key of parseKeys(chunk)) onKey(key);
}

function handleResize(): void {
  readSize();
  // Everything moved; force a full repaint.
  previous = [];
  out.write(ansi.clear);
}

export function stop(): void {
  if (!active) return;
  active = false;

  disposeRender?.();
  disposeRender = null;
  if (ticker) clearInterval(ticker);
  ticker = null;

  input.off('data', handleData);
  out.off('resize', handleResize);
  if (input.isTTY) input.setRawMode(false);
  input.pause();

  out.write(ansi.showCursor + ansi.leaveAlt + ansi.reset);
  previous = [];
}
