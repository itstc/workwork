import { randomUUID } from "node:crypto";
import { splitArgs } from "../core/args.ts";
import type { ExecResult } from "../core/exec.ts";
import { exec } from "../core/exec.ts";
import { appendResult, getTask } from "../core/store.ts";
import type { Task } from "../core/task.ts";
import { chainOf } from "../core/task.ts";
import type { Tool, ToolContext, ToolRun } from "./types.ts";

const BIN = process.env.WORKWORK_CLAUDE_BIN ?? "claude";
const EXTRA_ARGS = splitArgs(process.env.WORKWORK_CLAUDE_ARGS ?? "");
const TIMEOUT_MS = Number(
  process.env.WORKWORK_CLAUDE_TIMEOUT_MS ?? 10 * 60 * 1000,
);
/** Long enough to list what is running, short enough to leave cleanup budget. */
const LIST_TIMEOUT_MS = 10_000;
/** What a session mid-turn gets to stop politely before it is killed. */
const KILL_GRACE_MS = 3_000;

const OPENING_INSTRUCTION =
  "Work this item from a queue. Answer the message at the end, concisely.";

/**
 * claude as a conversation rather than a one-shot.
 *
 * Every turn is a link in the chain: the message you type becomes a task of its
 * own that goes into the working pool, and claude's reply becomes that task's
 * child back in the incoming feed. Replies carry the claude session id, so
 * selecting one and typing again resumes the same session — claude keeps the
 * context of everything it has already said instead of starting cold.
 *
 *   slack ──▸ [you: look at this] ──▸ [claude: which cluster?] ──▸ [you: staging] ──▸ …
 *              working pool            incoming feed              working pool
 */
export const claudeTool: Tool = {
  id: "claude",
  name: "claude",
  description: "Send a message to claude — resumes the session if there is one",
  input: {
    prompt: "Message for claude",
    required: true,
  },

  pre({ tasks, input }) {
    const task = tasks[0];
    const message = input.trim();
    // Only one conversation goes out per run, so the highlighted task wins.
    if (!task || !message) return { tasks: [], input: message };

    // What you typed becomes the next link in the chain, and it is that link —
    // not the task you selected — that sits in the working pool being answered.
    const turn = appendResult(task, {
      data: message,
      source: "you",
      state: "working",
      meta: { title: `you: ${firstLine(message)}` },
    });

    return { tasks: [turn], input: message };
  },

  async run({ tasks, input }, ctx) {
    const turn = tasks[0];
    if (!turn) return { ok: false, output: "no task", exitCode: null };

    const session = sessionOf(turn);
    if (session) {
      const args = [
        "--dangerously-skip-permissions",
        "-p",
        "--resume",
        session,
        ...EXTRA_ARGS,
      ];
      ctx.log(`$ ${BIN} ${args.join(" ")}\n`);
      const resumed = await invoke(args, input, ctx);
      if (resumed.ok || resumed.aborted) return shape(resumed, session, input);

      // A session can go missing — history pruned, or claude started from a
      // different directory. Rather than stranding the conversation there, open
      // a fresh one and hand it the chain so nothing is lost.
      ctx.log("\n[resume failed — opening a fresh session with the chain]\n");
    }

    const fresh = randomUUID();
    const args = [
      "--dangerously-skip-permissions",
      "-p",
      "--session-id",
      fresh,
      ...EXTRA_ARGS,
    ];
    const prompt = openingPrompt(turn, input);
    ctx.log(`$ ${BIN} ${args.join(" ")}\n`);

    const result = await invoke(args, prompt, ctx);
    return shape(result, fresh, prompt, session);
  },

  post({ tasks }, run) {
    const turn = tasks[0];
    if (!turn) return [];

    const body = run.ok
      ? run.output
      : `claude exited with ${run.exitCode ?? "an error"}:\n\n${run.output}`;

    return [
      {
        parent: turn.id,
        data: body,
        source: "tool:claude",
        state: "incoming",
        meta: {
          title: run.ok ? `claude: ${firstLine(run.output)}` : "claude failed",
          error: !run.ok,
          exit_code: run.exitCode,
          // The next turn reads this back to resume instead of starting cold.
          claude_session: run.meta?.claude_session,
          resumed_from: run.meta?.resumed_from,
        },
      },
    ];
  },

  /**
   * A turn is a process, but a conversation is a session: `run` hands claude a
   * `--session-id` and every turn after it resumes that same id, so the session
   * outlives each process that spoke into it. Completing the chain is the point
   * the conversation is over, so whatever is still attached to the session is
   * shut down — a `-p` turn that outlived the wait that was watching it, or an
   * interactive session someone resumed the id in to carry on by hand.
   *
   * claude is asked which sessions are alive rather than trusting a pid written
   * down at run time, because pids get reused and a stale one would terminate
   * somebody else's work. Nothing holding the session is the usual outcome — a
   * `-p` turn exits on its own once it has answered — and that is what cleanup
   * is asking for, so it passes quietly. The transcript on disk is left where
   * it is: the conversation is what ends, not the record of it.
   */
  async cleanup(task, ctx) {
    const session =
      typeof task.meta.claude_session === "string"
        ? task.meta.claude_session
        : "";
    if (!session) return;

    const held = await sessionProcesses(session, ctx);
    if (!held.length) {
      ctx.log(`[claude session ${session} is not running]\n`);
      return;
    }

    const stubborn: number[] = [];
    for (const pid of held) {
      ctx.log(`[terminating claude session ${session} (pid ${pid})]\n`);
      if (!(await terminate(pid, ctx))) stubborn.push(pid);
    }

    if (stubborn.length) {
      throw new Error(
        `claude session ${session} is still running (pid ${stubborn.join(", ")})`,
      );
    }
  },
};

function invoke(
  args: string[],
  stdin: string,
  ctx: ToolContext,
): Promise<ExecResult> {
  return exec(BIN, args, {
    stdin,
    signal: ctx.signal,
    timeoutMs: TIMEOUT_MS,
    onOutput: ctx.log,
  });
}

function shape(
  result: ExecResult,
  session: string,
  prompt: string,
  failedSession?: string,
): ToolRun {
  // The answer is stdout alone — claude warns on stderr, and that noise would
  // otherwise become the body and the title of the task in the feed. A failed
  // run keeps the whole transcript, since the reason is usually on stderr.
  const answer = result.stdout.trim();
  const transcript = result.output.trim();

  return {
    ok: result.ok,
    output:
      (result.ok ? answer || transcript : transcript) ||
      "(claude produced no output)",
    exitCode: result.exitCode,
    meta: {
      prompt,
      claude_session: session,
      resumed_from: failedSession,
      duration_ms: result.durationMs,
      aborted: result.aborted,
    },
  };
}

/**
 * The live processes holding `session`, straight from claude rather than from
 * anything this tool recorded. `claude agents --json` lists what is running —
 * interactive sessions and background agents both — with the session id each
 * one is on.
 *
 * Our own process is never a candidate: workwork itself can be running inside a
 * claude session, and cleanup must not be able to terminate the board.
 *
 * A listing that fails means we don't know what is still attached, which is not
 * the same as knowing nothing is — so it throws, and completing the task again
 * retries it.
 */
async function sessionProcesses(
  session: string,
  ctx: ToolContext,
): Promise<number[]> {
  const args = ["agents", "--json"];
  const result = await exec(BIN, args, {
    signal: ctx.signal,
    timeoutMs: LIST_TIMEOUT_MS,
  });

  if (!result.ok) {
    throw new Error(
      `could not ask claude what is running: ${result.output.trim() || `exit ${result.exitCode}`}`,
    );
  }

  let listed: unknown;
  try {
    listed = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `could not read the session list from ${BIN}: ${result.stdout.trim().slice(0, 200)}`,
    );
  }
  if (!Array.isArray(listed)) return [];

  const pids: number[] = [];
  for (const entry of listed) {
    if (!entry || typeof entry !== "object") continue;
    const { sessionId, pid } = entry as { sessionId?: unknown; pid?: unknown };
    if (sessionId !== session) continue;
    if (typeof pid !== "number" || !Number.isInteger(pid)) continue;
    if (pid === process.pid || pid === process.ppid) continue;
    if (!pids.includes(pid)) pids.push(pid);
  }
  return pids;
}

/**
 * Ask the process to end, and insist if it won't. A session that is mid-turn
 * gets the grace period to put its transcript down before SIGKILL. Answers
 * whether the process is actually gone — a pid that was already gone counts,
 * since that is the state being asked for.
 */
async function terminate(pid: number, ctx: ToolContext): Promise<boolean> {
  if (!signalTo(pid, "SIGTERM")) return true;

  const deadline = Date.now() + KILL_GRACE_MS;
  while (Date.now() < deadline && !ctx.signal.aborted) {
    await delay(100);
    if (!alive(pid)) return true;
  }

  signalTo(pid, "SIGKILL");
  await delay(100);
  return !alive(pid);
}

/** Send a signal, answering false when there was no process left to send it to. */
function signalTo(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    // Gone between the listing and the signal — the outcome we wanted anyway.
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
}

/** Signal 0 tests for the process without disturbing it. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Running, but not ours to signal — still standing as far as we're concerned.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Not unref'd, unlike the timers guarding a run: cleanup is *waiting on* this
 * one, and a timer the event loop is free to ignore would let the process exit
 * with the session half-terminated.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The session of the most recent claude reply behind this task, if any. */
function sessionOf(task: Task): string | undefined {
  const chain = chainOf(task, getTask);
  const from = chain.findIndex((node) => node.id === task.id);
  for (let i = (from < 0 ? chain.length : from) - 1; i >= 0; i--) {
    const session = chain[i]?.meta.claude_session;
    if (typeof session === "string" && session) return session;
  }
  return undefined;
}

/**
 * The prompt for a conversation that has no session to resume: the chain so far
 * as context, then the message being asked now.
 */
function openingPrompt(turn: Task, message: string): string {
  const history = chainOf(turn, getTask).filter((node) => node.id !== turn.id);
  const parts = [OPENING_INSTRUCTION, ""];

  if (history.length) {
    parts.push("<chain>");
    for (const node of history) {
      parts.push(
        `<item source="${attr(node.source)}" created_at="${attr(node.created_at)}">`,
        node.data.trim(),
        "</item>",
      );
    }
    parts.push("</chain>", "");
  }

  parts.push("<message>", message.trim(), "</message>");
  return parts.join("\n");
}

function attr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((line) => line.trim())
      ?.trim()
      .slice(0, 72) ?? "no output"
  );
}
