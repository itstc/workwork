import { toolById } from '../tools/index.ts';
import type { Tool } from '../tools/types.ts';
import { getTask, stampMeta } from './store.ts';
import type { Task } from './task.ts';
import { chainOf, taskTitle } from './task.ts';

/** How long any one tool gets to release what it left behind. */
const TIMEOUT_MS = Number(process.env.WORKWORK_CLEANUP_TIMEOUT_MS ?? 30_000);

export interface CleanupFailure {
  taskId: string;
  title: string;
  toolId: string;
  toolName: string;
  error: string;
}

export interface CleanupReport {
  /** Tasks whose tool released something without complaining. */
  cleaned: number;
  failures: CleanupFailure[];
  /** Everything the cleanups logged, for the notice and for debugging. */
  log: string;
}

/**
 * Completing a task finishes the whole piece of work, not just the step under
 * the cursor — so every task behind it in the chain is done with too, and
 * whatever each of those steps left standing (a herdr tab, an agent holding a
 * pane) can go.
 *
 * Walks the chain of each task handed in, newest step first, and asks the tool
 * that produced each step — `meta.via`, the same stamp `runTool` writes — to
 * clean up after itself. Tools without a `cleanup` are skipped, as are steps
 * already cleaned, so completing, reopening and completing again doesn't shell
 * out twice. A tool that throws is recorded and the walk carries on: one tab
 * that wouldn't close must not strand the rest of the chain.
 *
 * Chains are de-duplicated across `tasks`, so completing a multi-selection that
 * shares history cleans each step once.
 */
export async function cleanupChains(tasks: Task[]): Promise<CleanupReport> {
  const report: CleanupReport = { cleaned: 0, failures: [], log: '' };
  const seen = new Set<string>();

  for (const task of tasks) {
    // Re-read: a chain walked a moment ago may have stamped this one already.
    const current = getTask(task.id) ?? task;
    for (const node of [...chainOf(current, getTask)].reverse()) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      await cleanupTask(node, report);
    }
  }

  return report;
}

/** The same walk for a single task — what completing one item on the board does. */
export function cleanupChain(task: Task): Promise<CleanupReport> {
  return cleanupChains([task]);
}

async function cleanupTask(task: Task, report: CleanupReport): Promise<void> {
  if (typeof task.meta.cleaned_at === 'string') return;

  const tool = toolFor(task);
  if (!tool?.cleanup) return;

  const log = (chunk: string) => {
    report.log += chunk;
  };
  const signal = AbortSignal.timeout(TIMEOUT_MS);

  try {
    // A cleanup has no row in the working pool to annotate — the task it is
    // releasing has already left it — so `status` goes nowhere.
    await tool.cleanup(task, { signal, log, status: () => {} });
    report.cleaned += 1;
    // Stamped only on success, so a failure is retried next time round.
    stampMeta(task.id, { cleaned_at: new Date().toISOString() });
  } catch (error) {
    report.failures.push({
      taskId: task.id,
      title: taskTitle(task),
      toolId: tool.id,
      toolName: tool.name,
      error: error instanceof Error ? error.message : String(error),
    });
    report.log += `\n[${tool.name}: cleanup failed — ${String(error)}]\n`;
  }
}

/** The tool that produced this task, off the `via` stamp `runTool` writes. */
function toolFor(task: Task): Tool | undefined {
  const via = task.meta.via;
  return typeof via === 'string' ? toolById(via) : undefined;
}
