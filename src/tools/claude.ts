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
  key: "c",
  accepts: "one",
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
    const args = ["-p", "--session-id", fresh, ...EXTRA_ARGS];
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
