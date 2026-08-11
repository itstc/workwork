import type { Task, TaskDraft, TaskMeta } from '../core/task.ts';

/** What a tool is handed: task(s) plus optional free-form input from the user. */
export interface ToolInvocation {
  tasks: Task[];
  input: string;
}

/** What running the tool produced. */
export interface ToolRun {
  ok: boolean;
  /** The process transcript, or whatever stands in for it. */
  output: string;
  exitCode: number | null;
  meta?: TaskMeta;
}

export interface ToolContext {
  /** Aborted when the user cancels the working item. */
  signal: AbortSignal;
  /** Stream progress into the working pane / task viewer. */
  log: (chunk: string) => void;
}

/** A post-processed result, linked back to the task it came from. */
export interface ToolResult extends TaskDraft {
  /** id of the task in `invocation.tasks` this result belongs to. */
  parent: string;
}

export interface ToolInputSpec {
  prompt: string;
  placeholder?: string;
  /** When true the tool won't run with an empty input. */
  required?: boolean;
}

export interface Tool {
  id: string;
  name: string;
  description: string;
  /** Keyboard shortcut in the tool picker. */
  key: string;
  /** Whether the tool can take a multi-selection or only the highlighted task. */
  accepts: 'one' | 'many';
  /** Ask the user for extra input before running. */
  input?: ToolInputSpec;

  /**
   * Adjust the task(s) and input before the process starts — templating a
   * prompt, filtering tasks the tool can't handle, defaulting the input.
   * Must preserve task ids so results can be chained back to their parents.
   */
  pre(invocation: ToolInvocation): Promise<ToolInvocation> | ToolInvocation;

  run(invocation: ToolInvocation, context: ToolContext): Promise<ToolRun>;

  /**
   * Turn the process output into task(s). Returning a result for a task closes
   * that task out and puts the child back in the incoming feed.
   */
  post(invocation: ToolInvocation, run: ToolRun): Promise<ToolResult[]> | ToolResult[];
}
