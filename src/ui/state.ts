import { computed, signal } from '@preact/signals-core';
import { done, incoming, working } from '../core/store.ts';
import type { Task, TaskState } from '../core/task.ts';

/** The two list columns on the board — left and right of the detail panel. */
export const BOARD_PANES: TaskState[] = ['incoming', 'working'];

/**
 * Where the cursor lives. `done` is not a board column: focusing it is what
 * opens the completed flyout, so focus and "is the flyout open" are one fact.
 */
export const focusedPane = signal<TaskState>('incoming');
export const cursors = signal<Record<TaskState, number>>({ incoming: 0, working: 0, done: 0 });

export interface MenuItem {
  /** Shortcut that picks the item outright. Omitted on menus that search. */
  key?: string;
  label: string;
  description: string;
  hint?: string;
  run: () => void | Promise<void>;
}

export type Overlay =
  | { kind: 'help' }
  | {
      kind: 'viewer';
      taskId: string;
      scroll: number;
      /** Which step of the chain the cursor sits on. */
      pick: number;
    }
  | {
      kind: 'menu';
      title: string;
      subtitle?: string;
      items: MenuItem[];
      index: number;
      /**
       * Present — even empty — on a menu you search rather than one you pick by
       * key: what you type narrows the list instead of matching a shortcut.
       */
      filter?: string;
    }
  | {
      kind: 'prompt';
      title: string;
      hint?: string;
      value: string;
      caret: number;
      onSubmit: (value: string) => void;
    };

export type ViewerOverlay = Extract<Overlay, { kind: 'viewer' }>;
export type MenuOverlay = Extract<Overlay, { kind: 'menu' }>;

/**
 * The items a menu is currently showing: everything, or what the filter keeps.
 * Labels only — descriptions are prose, and matching them turns a filter into a
 * guessing game ("her" lives inside "there").
 */
export function menuItems(menu: MenuOverlay): MenuItem[] {
  const query = menu.filter?.trim().toLowerCase();
  if (!query) return menu.items;
  return menu.items.filter((item) => item.label.toLowerCase().includes(query));
}

export const overlay = signal<Overlay | null>(null);

/** True while the completed flyout is up. */
export const doneOpen = computed(() => focusedPane.value === 'done');

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

/** The column focus falls back to when the flyout closes. */
let lastBoardPane: TaskState = 'incoming';

export function focusPane(pane: TaskState): void {
  if (pane !== 'done') lastBoardPane = pane;
  focusedPane.value = pane;
}

/** The completed flyout is a focus state, so opening it is just focusing it. */
export function toggleDone(): void {
  focusPane(focusedPane.value === 'done' ? lastBoardPane : 'done');
}

/** Cycles the board columns only — never lands on the flyout. */
export function cyclePane(delta: number): void {
  const index = Math.max(0, BOARD_PANES.indexOf(lastBoardPane));
  const next = (index + delta + BOARD_PANES.length) % BOARD_PANES.length;
  focusPane(BOARD_PANES[next] ?? 'incoming');
}

/**
 * What a tool should act on: the task under the cursor. Handed back as a list
 * because a tool run takes a list of tasks, even when the board only ever
 * points at one of them.
 */
export function targetTasks(): Task[] {
  const current = cursorTask.value;
  return current ? [current] : [];
}
