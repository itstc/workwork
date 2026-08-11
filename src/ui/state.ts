import { computed, signal } from '@preact/signals-core';
import { done, incoming, working } from '../core/store.ts';
import type { Task, TaskState } from '../core/task.ts';

export const PANES: TaskState[] = ['incoming', 'working', 'done'];

export const focusIndex = signal(0);
export const cursors = signal<Record<TaskState, number>>({ incoming: 0, working: 0, done: 0 });
/** Multi-selection, for tools that accept more than one task. */
export const selection = signal<string[]>([]);

export interface MenuItem {
  key: string;
  label: string;
  description: string;
  hint?: string;
  run: () => void | Promise<void>;
}

export type Overlay =
  | { kind: 'help' }
  | { kind: 'viewer'; taskId: string; scroll: number }
  | { kind: 'menu'; title: string; subtitle?: string; items: MenuItem[]; index: number }
  | {
      kind: 'prompt';
      title: string;
      hint?: string;
      value: string;
      caret: number;
      onSubmit: (value: string) => void;
    };

export const overlay = signal<Overlay | null>(null);

export const focusedPane = computed<TaskState>(
  () => PANES[focusIndex.value] ?? 'incoming',
);

export function listOf(pane: TaskState): Task[] {
  if (pane === 'incoming') return incoming.value;
  if (pane === 'working') return working.value;
  return done.value;
}

export const focusedList = computed(() => listOf(focusedPane.value));

/** Cursor position clamped to whatever the list currently holds. */
export function cursorFor(pane: TaskState): number {
  const list = listOf(pane);
  if (list.length === 0) return 0;
  return Math.min(Math.max(0, cursors.value[pane] ?? 0), list.length - 1);
}

export const cursorTask = computed<Task | undefined>(
  () => focusedList.value[cursorFor(focusedPane.value)],
);

export function setCursor(pane: TaskState, index: number): void {
  cursors.value = { ...cursors.value, [pane]: Math.max(0, index) };
}

export function moveCursor(delta: number): void {
  const pane = focusedPane.value;
  const list = listOf(pane);
  if (list.length === 0) return;
  const next = Math.min(list.length - 1, Math.max(0, cursorFor(pane) + delta));
  setCursor(pane, next);
}

export function focusPane(index: number): void {
  focusIndex.value = Math.min(PANES.length - 1, Math.max(0, index));
}

export function cyclePane(delta: number): void {
  focusIndex.value = (focusIndex.value + delta + PANES.length) % PANES.length;
}

export const selectedSet = computed(() => new Set(selection.value));

export function toggleSelected(id: string): void {
  selection.value = selection.value.includes(id)
    ? selection.value.filter((existing) => existing !== id)
    : [...selection.value, id];
}

export function clearSelection(): void {
  if (selection.value.length) selection.value = [];
}

/**
 * What a tool should act on: the multi-selection if there is one, otherwise the
 * task under the cursor. Selected ids that no longer exist are dropped.
 */
export function targetTasks(): Task[] {
  const all = [...incoming.value, ...working.value, ...done.value];
  const chosen = all.filter((task) => selection.value.includes(task.id));
  if (chosen.length) return chosen;
  const current = cursorTask.value;
  return current ? [current] : [];
}
