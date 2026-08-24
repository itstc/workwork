import { batch, computed, signal } from '@preact/signals-core';
import type { Task, TaskDraft, TaskMeta, TaskState } from './task.ts';
import { createTask, deriveTask, seqOf } from './task.ts';

/**
 * Every task ever seen, keyed by id. History nodes stay here so a chain can be
 * replayed in the viewer; only tails (`next === null`) show up in the panes.
 */
export const tasks = signal<Record<string, Task>>({});

export function getTask(id: string | null | undefined): Task | undefined {
  return id ? tasks.value[id] : undefined;
}

function put(...updated: Task[]): void {
  const nextTasks = { ...tasks.value };
  for (const task of updated) nextTasks[task.id] = task;
  tasks.value = nextTasks;
}

const live = computed(() => Object.values(tasks.value).filter((t) => t.next === null));

function byCreatedAt(dir: 'asc' | 'desc') {
  return (a: Task, b: Task) => {
    // `seq` breaks ties when a burst of tasks lands in the same millisecond.
    const cmp = a.created_at.localeCompare(b.created_at) || seqOf(a) - seqOf(b);
    return dir === 'asc' ? cmp : -cmp;
  };
}

/** Newest first — a feed reads top-down. */
export const incoming = computed(() =>
  live.value.filter((t) => t.state === 'incoming').sort(byCreatedAt('desc')),
);
/** Oldest first — the thing that has been in flight longest is at the top. */
export const working = computed(() =>
  live.value.filter((t) => t.state === 'working').sort(byCreatedAt('asc')),
);
/** Most recently finished first. */
export const done = computed(() =>
  live.value.filter((t) => t.state === 'done').sort(byCreatedAt('desc')),
);

export const listFor = (state: TaskState) =>
  state === 'incoming' ? incoming : state === 'working' ? working : done;

// --- mutations -------------------------------------------------------------

/** Push a brand new task into the incoming feed. */
export function ingest(draft: TaskDraft): Task {
  const task = createTask(draft);
  put(task);
  return task;
}

/** Move a live task between panes without breaking the chain. */
export function setState(id: string, state: TaskState): Task | undefined {
  const task = getTask(id);
  if (!task || task.state === state) return task;
  const updated = { ...task, state };
  put(updated);
  return updated;
}

/**
 * Write bookkeeping onto a live task's meta without touching the chain — a
 * cleanup stamp, say. Everything that is *work* appends a task instead; this is
 * for notes about a task that are not themselves a step.
 */
export function stampMeta(id: string, patch: TaskMeta): Task | undefined {
  const task = getTask(id);
  if (!task) return undefined;
  const updated = { ...task, meta: { ...task.meta, ...patch } };
  put(updated);
  return updated;
}

/**
 * Close out `parent` by appending the result of processing it. The parent stops
 * being live (it now has a `next`) and the child lands wherever the caller asks
 * — normally back in the incoming feed, per the round-trip in the design.
 */
export function appendResult(parent: Task, draft: TaskDraft): Task {
  const child = deriveTask(parent, draft);
  batch(() => {
    put({ ...parent, next: child.id }, child);
  });
  return child;
}

/**
 * Cut a chain in two at `id`. Everything in front of `id` keeps its history and
 * its new tail goes live again in `headState`; `id` and everything after it are
 * detached into a chain of their own, still live wherever they already were.
 *
 * Splitting at a root does nothing — there is nothing in front of it to keep.
 */
export function splitChain(
  id: string,
  headState: TaskState = 'incoming',
): { head: Task; tail: Task } | undefined {
  const at = getTask(id);
  const before = getTask(at?.prev);
  if (!at || !before) return undefined;

  const head: Task = { ...before, next: null, state: headState };
  const tail: Task = { ...at, prev: null, meta: { ...at.meta, split_from: before.id } };
  batch(() => {
    put(head, tail);
  });
  return { head, tail };
}

/** Drop a whole chain — the task plus everything behind it. */
export function discardChain(id: string): void {
  const start = getTask(id);
  if (!start) return;
  const remaining = { ...tasks.value };
  let cursor: Task | undefined = start;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    delete remaining[cursor.id];
    cursor = cursor.prev ? tasks.value[cursor.prev] : undefined;
  }
  tasks.value = remaining;
}

/** Replace the whole store (used by the persistence layer at startup). */
export function hydrate(all: Task[]): void {
  const map: Record<string, Task> = {};
  for (const task of all) map[task.id] = task;
  tasks.value = map;
}
