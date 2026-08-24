import { randomUUID } from 'node:crypto';

/**
 * A task is an immutable node in a linked chain.
 *
 * Nothing is ever edited in place. Every time a task is processed by a tool the
 * output becomes a *new* task whose `prev` points at the task it came from, and
 * the old task's `next` is stamped with the new id. Walking `prev`/`next` gives
 * you the full history of a piece of work:
 *
 *   slack -> claude -> herdr tab -> bash test run -> done
 *
 * Only the tail of a chain (`next === null`) is "live" and shown in a pane.
 * Everything behind it is history.
 */
export interface Task {
  id: string;
  prev: string | null;
  next: string | null;
  data: string;
  created_at: string;
  source: string;
  /** Which pane this task lives in. Only meaningful for the tail of a chain. */
  state: TaskState;
  meta: TaskMeta;
}

export type TaskState = 'incoming' | 'working' | 'done';

export interface TaskMeta {
  /** Short human label. Derived from `data` when a producer doesn't set one. */
  title?: string;
  /** Tool/feed that produced this task, when it wasn't a plain hand-off. */
  via?: string;
  /** Non-zero exit / thrown error while producing this task. */
  error?: boolean;
  /** Exit code of the process that produced this task. */
  exit_code?: number | null;
  /** ms spent in the working pool. */
  duration_ms?: number;
  /** Set when a task was recovered from disk after the process died mid-work. */
  recovered_at?: string;
  /** Set once the producing tool's `cleanup` has released what it left behind. */
  cleaned_at?: string;
  [key: string]: unknown;
}

export interface TaskDraft {
  data: string;
  source: string;
  state?: TaskState;
  meta?: TaskMeta;
}

let lastSeq = 0;

/**
 * Strictly increasing creation stamp with sub-millisecond resolution. A feed
 * can deliver a burst of messages inside one millisecond, and `created_at` on
 * its own would leave their order up to the sort's tie-breaking.
 */
function nextSeq(): number {
  const micros = Math.round((performance.timeOrigin + performance.now()) * 1000);
  lastSeq = micros > lastSeq ? micros : lastSeq + 1;
  return lastSeq;
}

export function createTask(draft: TaskDraft, prev: string | null = null): Task {
  return {
    id: randomUUID(),
    prev,
    next: null,
    data: draft.data,
    created_at: new Date().toISOString(),
    source: draft.source,
    state: draft.state ?? 'incoming',
    meta: { seq: nextSeq(), ...draft.meta },
  };
}

/** Creation order, falling back to 0 for tasks written before `seq` existed. */
export function seqOf(task: Task): number {
  return typeof task.meta.seq === 'number' ? task.meta.seq : 0;
}

/** A child task carrying the output of processing `parent`. */
export function deriveTask(parent: Task, draft: TaskDraft): Task {
  return createTask(draft, parent.id);
}

/** First line of the task data, trimmed to something a pane row can hold. */
export function taskTitle(task: Task): string {
  if (typeof task.meta.title === 'string' && task.meta.title.trim()) {
    return task.meta.title.trim();
  }
  const line = task.data
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ?? '(empty)';
}

export function isLive(task: Task): boolean {
  return task.next === null;
}

/** Ordered root -> tail chain that `task` belongs to. */
export function chainOf(task: Task, byId: (id: string) => Task | undefined): Task[] {
  const back: Task[] = [];
  const seen = new Set<string>([task.id]);
  let cursor = task.prev ? byId(task.prev) : undefined;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    back.unshift(cursor);
    cursor = cursor.prev ? byId(cursor.prev) : undefined;
  }

  const forward: Task[] = [];
  cursor = task.next ? byId(task.next) : undefined;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    forward.push(cursor);
    cursor = cursor.next ? byId(cursor.next) : undefined;
  }

  return [...back, task, ...forward];
}

/**
 * The head of the chain `task` belongs to — the task the work came in as,
 * before any tool appended to it. A completed chain is read by where it
 * started, not by the step that happened to close it.
 */
export function rootOf(task: Task, byId: (id: string) => Task | undefined): Task {
  const seen = new Set<string>([task.id]);
  let root = task;
  let cursor = task.prev ? byId(task.prev) : undefined;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    root = cursor;
    cursor = cursor.prev ? byId(cursor.prev) : undefined;
  }
  return root;
}
