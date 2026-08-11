import { spawn } from 'node:child_process';
import { signal } from '@preact/signals-core';

export type NoticeLevel = 'info' | 'success' | 'error';

export interface Notice {
  id: number;
  level: NoticeLevel;
  text: string;
  at: number;
}

export const notices = signal<Notice[]>([]);

const MAX_VISIBLE = 3;
const TTL_MS = 8000;
let nextId = 1;

/** Whether to also raise a desktop notification (macOS only, opt-in). */
const desktop = process.env.WORKWORK_DESKTOP_NOTIFY === '1' && process.platform === 'darwin';

export function notify(level: NoticeLevel, text: string, options: { bell?: boolean } = {}): void {
  const notice: Notice = { id: nextId++, level, text, at: Date.now() };
  notices.value = [...notices.value, notice].slice(-MAX_VISIBLE);

  const timer = setTimeout(() => {
    notices.value = notices.value.filter((n) => n.id !== notice.id);
  }, TTL_MS);
  timer.unref?.();

  if (options.bell) process.stdout.write('\x07');
  if (desktop) raiseDesktopNotice(text, level);
}

function raiseDesktopNotice(text: string, level: NoticeLevel): void {
  const title = level === 'error' ? 'workwork — failed' : 'workwork';
  const escaped = text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').slice(0, 200);
  const child = spawn(
    'osascript',
    ['-e', `display notification "${escaped}" with title "${title}"`],
    { stdio: 'ignore', detached: true },
  );
  child.on('error', () => {});
  child.unref();
}

export function clearNotices(): void {
  notices.value = [];
}
