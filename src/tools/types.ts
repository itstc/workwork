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
  /**
   * A word for what the run is doing *now*, shown on the working pool row in
   * place of the spinner's usual "running" reading — `blocked`, for a hand-off
   * sitting on an agent that stopped to ask. An empty string clears it, which
   * is what a run says when it starts moving again.
   *
   * It is a live annotation on the run, not a result: nothing is written to the
   * task, and it goes when the run does.
   */
  status: (text: string) => void;
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
  /**
   * Ask the user for extra input before running. A function is resolved against
   * the task(s) under the cursor, for tools where what is being asked for
   * depends on them — herdr agent wants a name for a new agent, but a message
   * for one the task already has.
   */
  input?: ToolInputSpec | ((tasks: Task[]) => ToolInputSpec);

  /**
   * Adjust the task(s) and input before the process starts — templating a
   * prompt, filtering tasks the tool can't handle, defaulting the input.
   *
   * Tasks come back by id, so anything returned must exist in the store: either
   * the tasks handed in, or a new link a tool opened on top of one (claude
   * turns the message you typed into a task and works on that). Whatever is
   * returned is what enters the working pool and what `post` chains onto.
   */
  pre(invocation: ToolInvocation): Promise<ToolInvocation> | ToolInvocation;

  run(invocation: ToolInvocation, context: ToolContext): Promise<ToolRun>;

  /**
   * Turn the process output into task(s). Returning a result for a task closes
   * that task out and puts the child back in the incoming feed.
   */
  post(invocation: ToolInvocation, run: ToolRun): Promise<ToolResult[]> | ToolResult[];

  /**
   * Let go of whatever `run` left standing — a herdr tab still open on the
   * work, a pane still held by an agent. Called once per task when the chain
   * that task belongs to is completed, on the tool named by that task's
   * `meta.via`, so a chain that passed through several tools has each of them
   * tidy up its own leftovers.
   *
   * The task handed in is the one *that tool produced*, so whatever `post`
   * stamped on its meta (a tab id, an agent name) is what identifies the thing
   * to release. Nothing is chained off it — cleanup produces no task.
   *
   * Make it idempotent and forgiving: the resource is usually already gone by
   * hand, and completing a chain must not turn into an error report. Throw only
   * when something was genuinely left behind. Tools with nothing to release
   * (bash) leave it off entirely.
   */
  cleanup?(task: Task, context: ToolContext): Promise<void> | void;
}
