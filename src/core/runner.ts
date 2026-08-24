import { randomUUID } from 'node:crypto';
import { batch, signal } from '@preact/signals-core';
import { notify } from './notify.ts';
import { appendResult, getTask, setState } from './store.ts';
import type { Task } from './task.ts';
import type { Tool, ToolInvocation, ToolResult, ToolRun } from '../tools/types.ts';

export interface ActiveRun {
  id: string;
  toolId: string;
  toolName: string;
  taskIds: string[];
  startedAt: number;
  /** Tail of the live process output, for the working pane and the viewer. */
  log: string;
  /**
   * What the run is waiting on, when that is worth saying on the board —
   * `blocked` for a herdr hand-off whose agent stopped to ask. Unset means the
   * run is simply running, which the spinner already says.
   */
  status?: string;
}

/** Runs currently in flight, keyed by run id. */
export const runs = signal<Record<string, ActiveRun>>({});

const controllers = new Map<string, AbortController>();

export function runForTask(taskId: string): ActiveRun | undefined {
  return Object.values(runs.value).find((run) => run.taskIds.includes(taskId));
}

const LOG_LIMIT = 64_000;

function patchRun(id: string, patch: Partial<ActiveRun>): void {
  const current = runs.value[id];
  if (!current) return;
  runs.value = { ...runs.value, [id]: { ...current, ...patch } };
}

function dropRun(id: string): void {
  const { [id]: _removed, ...rest } = runs.value;
  runs.value = rest;
  controllers.delete(id);
}

/**
 * The full lifecycle from the design doc:
 *
 *   pre-process -> tasks enter the working pool -> run -> post-process ->
 *   result task goes back to the incoming feed
 *
 * A task that produced a result is closed out (it gets a `next`) and leaves the
 * panes; the child carries the chain forward. Tasks the tool declined to
 * produce a result for are put back in the incoming feed untouched.
 */
export async function runTool(tool: Tool, selected: Task[], rawInput = ''): Promise<void> {
  if (selected.length === 0) return;

  let invocation: ToolInvocation;
  try {
    invocation = await tool.pre({ tasks: selected, input: rawInput });
  } catch (error) {
    notify('error', `${tool.name}: pre-process failed — ${errorText(error)}`);
    return;
  }

  if (invocation.tasks.length === 0) {
    notify('info', `${tool.name}: nothing to do`);
    return;
  }

  const runId = randomUUID();
  const taskIds = invocation.tasks.map((t) => t.id).filter((id) => getTask(id));
  const controller = new AbortController();
  controllers.set(runId, controller);

  batch(() => {
    runs.value = {
      ...runs.value,
      [runId]: {
        id: runId,
        toolId: tool.id,
        toolName: tool.name,
        taskIds,
        startedAt: Date.now(),
        log: '',
      },
    };
    for (const id of taskIds) setState(id, 'working');
  });

  const context = {
    signal: controller.signal,
    log: (chunk: string) => {
      const current = runs.value[runId];
      if (!current) return;
      const next = (current.log + chunk).slice(-LOG_LIMIT);
      patchRun(runId, { log: next });
    },
    status: (text: string) => {
      patchRun(runId, { status: text.trim() || undefined });
    },
  };

  let result: ToolRun;
  try {
    result = await tool.run(invocation, context);
  } catch (error) {
    result = { ok: false, output: errorText(error), exitCode: null, meta: { error: true } };
  }

  const duration = Date.now() - (runs.value[runId]?.startedAt ?? Date.now());

  let results: ToolResult[];
  try {
    results = await tool.post(invocation, result);
  } catch (error) {
    results = invocation.tasks.map((task) => ({
      parent: task.id,
      data: `${tool.name} post-process failed:\n${errorText(error)}`,
      source: `tool:${tool.id}`,
      meta: { error: true, via: tool.id },
    }));
  }

  batch(() => {
    const handled = new Set<string>();
    for (const draft of results) {
      const parent = getTask(draft.parent);
      if (!parent) continue;
      handled.add(parent.id);
      appendResult(parent, {
        data: draft.data,
        source: draft.source,
        state: draft.state ?? 'incoming',
        meta: { via: tool.id, duration_ms: duration, ...draft.meta },
      });
    }
    // Anything the tool ignored goes back to the feed rather than being stranded
    // in the working pool.
    for (const id of taskIds) {
      if (!handled.has(id)) setState(id, 'incoming');
    }
    dropRun(runId);
  });

  const label = summarize(invocation.tasks);
  if (controller.signal.aborted) {
    notify('info', `${tool.name} cancelled — ${label}`);
  } else if (result.ok) {
    notify('success', `${tool.name} finished — ${label}`, { bell: true });
  } else {
    notify('error', `${tool.name} failed (${result.exitCode ?? 'error'}) — ${label}`, {
      bell: true,
    });
  }
}

export function cancelRun(runId: string): boolean {
  const controller = controllers.get(runId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export function cancelAll(): void {
  for (const controller of controllers.values()) controller.abort();
}

function summarize(tasks: Task[]): string {
  const first = tasks[0];
  if (!first) return 'no tasks';
  const head = first.data.split('\n')[0]?.slice(0, 48) ?? '';
  return tasks.length > 1 ? `${head} (+${tasks.length - 1} more)` : head;
}

function errorText(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}
