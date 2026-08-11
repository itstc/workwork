import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { effect } from '@preact/signals-core';
import type { Task } from './task.ts';
import { hydrate, tasks } from './store.ts';

const SCHEMA_VERSION = 1;

export const stateDir = process.env.WORKWORK_HOME ?? join(homedir(), '.workwork');
export const statePath = join(stateDir, 'state.json');

interface StateFile {
  version: number;
  saved_at: string;
  tasks: Task[];
}

/**
 * Read the store back off disk. Anything that was mid-flight when the process
 * died is put back in the incoming feed, since no tool is running for it now.
 */
export async function load(): Promise<{ recovered: number }> {
  if (!existsSync(statePath)) return { recovered: 0 };

  let parsed: StateFile;
  try {
    parsed = JSON.parse(await readFile(statePath, 'utf8')) as StateFile;
  } catch {
    // A corrupt state file should never stop the app from starting; keep the
    // bad copy around so it can be inspected by hand.
    await rename(statePath, `${statePath}.corrupt-${Date.now()}`).catch(() => {});
    return { recovered: 0 };
  }

  if (parsed.version !== SCHEMA_VERSION || !Array.isArray(parsed.tasks)) {
    return { recovered: 0 };
  }

  let recovered = 0;
  const restored = parsed.tasks.map((task) => {
    if (task.next === null && task.state === 'working') {
      recovered += 1;
      return {
        ...task,
        state: 'incoming' as const,
        meta: { ...task.meta, recovered_at: new Date().toISOString() },
      };
    }
    return task;
  });

  hydrate(restored);
  return { recovered };
}

let pending: NodeJS.Timeout | null = null;
let writing: Promise<void> = Promise.resolve();

async function write(): Promise<void> {
  const payload: StateFile = {
    version: SCHEMA_VERSION,
    saved_at: new Date().toISOString(),
    tasks: Object.values(tasks.value),
  };
  const body = JSON.stringify(payload, null, 2);
  const tmp = `${statePath}.${process.pid}.tmp`;
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(tmp, body, 'utf8');
  // Rename is atomic on the same filesystem, so a crash mid-write can never
  // leave a half-serialized state file behind.
  await rename(tmp, statePath);
}

/** Persist on the next tick, coalescing bursts of mutations into one write. */
export function save(): void {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    writing = writing.then(write).catch(() => {});
  }, 250);
  pending.unref?.();
}

/** Mirror every store mutation to disk for the lifetime of the process. */
export function autosave(): () => void {
  return effect(() => {
    void tasks.value;
    save();
  });
}

/** Flush immediately — call before exiting. */
export async function flush(): Promise<void> {
  if (pending) {
    clearTimeout(pending);
    pending = null;
  }
  writing = writing.then(write).catch(() => {});
  await writing;
}
