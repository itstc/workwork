import chalk from 'chalk';
import type { TaskState } from '../core/task.ts';

/** Chalk degrades these to the nearest supported colour on its own. */
export const palette = {
  incoming: '#7dd3fc',
  working: '#fbbf24',
  done: '#86efac',
  error: '#f87171',
  muted: '#6b7280',
  dim: '#4b5563',
  border: '#374151',
  text: '#e5e7eb',
  accent: '#c4b5fd',
};

export const t = {
  title: chalk.hex(palette.accent).bold,
  muted: chalk.hex(palette.muted),
  dim: chalk.hex(palette.dim),
  text: chalk.hex(palette.text),
  error: chalk.hex(palette.error),
  success: chalk.hex(palette.done),
  warn: chalk.hex(palette.working),
  accent: chalk.hex(palette.accent),
  border: chalk.hex(palette.border),
  key: chalk.hex(palette.accent).bold,
  source: chalk.hex(palette.muted).italic,
  selected: chalk.bgHex('#1f2937'),
  cursor: chalk.bgHex('#312e57'),
};

export const stateColor: Record<TaskState, (text: string) => string> = {
  incoming: chalk.hex(palette.incoming),
  working: chalk.hex(palette.working),
  done: chalk.hex(palette.done),
};

export const stateLabel: Record<TaskState, string> = {
  incoming: 'INCOMING FEED',
  working: 'WORKING POOL',
  done: 'COMPLETED',
};

export const box = {
  tl: '╭',
  tr: '╮',
  bl: '╰',
  br: '╯',
  h: '─',
  v: '│',
};

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function spinner(tick: number): string {
  return SPINNER[tick % SPINNER.length] ?? '⠋';
}

/** Compact relative time — feeds read better with "3m" than a timestamp. */
export function ago(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '?';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

export function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 100) / 10;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${Math.round(seconds % 60)}s`;
}
