import type { ExecResult } from "../core/exec.ts";
import { exec } from "../core/exec.ts";
import { getTask } from "../core/store.ts";
import type { Task } from "../core/task.ts";
import { chainOf, taskTitle } from "../core/task.ts";
import type { Tool, ToolContext, ToolRun } from "./types.ts";

const HERDR_BIN = process.env.WORKWORK_HERDR_BIN ?? "herdr";
const AGENT_KIND = process.env.WORKWORK_HERDR_AGENT_KIND ?? "claude";
/** How long a hand-off will hold the working pool waiting on the agent's turn. */
const WAIT_MS = Number(
  process.env.WORKWORK_HERDR_AGENT_WAIT_MS ?? 30 * 60 * 1000,
);
/** How much of the agent's pane is read back into the task when its turn ends. */
const READ_LINES = Number(process.env.WORKWORK_HERDR_READ_LINES ?? 200);
/**
 * The input box at the foot of the pane, in lines: the rule, the line you type
 * on, the closing rule, the agent's status line, and whatever hint it hangs
 * under that. It is the window `tidySnapshot` scans for the box's top rule.
 */
const BOX_LINES = 8;
/** How long a hand-off waits for a brand-new tab's shell to reach its prompt. */
const SHELL_READY_MS = Number(
  process.env.WORKWORK_HERDR_SHELL_READY_MS ?? 15_000,
);

/**
 * Hand a task off to a human: ask herdr for a new tab, labelled with whatever
 * the user typed (or the task title, if they typed nothing).
 */
export const herdrTool: Tool = {
  id: "herdr",
  name: "herdr tab",
  description: "Create a herdr tab for the task, to work by hand",
  input: {
    prompt: "Tab name",
  },

  pre({ tasks, input }) {
    const task = tasks[0];
    return {
      tasks: tasks.slice(0, 1),
      input: input.trim() || (task ? taskTitle(task) : ""),
    };
  },

  async run({ input }, ctx) {
    ctx.log(`$ ${HERDR_BIN} tab create --label ${input}\n`);

    const result = await exec(HERDR_BIN, ["tab", "create", "--label", input], {
      signal: ctx.signal,
      timeoutMs: 30_000,
      onOutput: ctx.log,
    });

    return {
      ok: result.ok,
      output: result.output.trim() || "(no output)",
      exitCode: result.exitCode,
      // The tab id is read back off the creation, so completing the task later
      // has something concrete to close.
      meta: { label: input, tab: tabIdOf(result.stdout) },
    };
  },

  post({ tasks, input }, run) {
    const task = tasks[0];
    if (!task) return [];

    return [
      {
        parent: task.id,
        data: run.ok
          ? [`Handed off to herdr tab "${input}".`, "", task.data].join("\n")
          : run.output,
        source: "tool:herdr",
        state: "incoming",
        meta: {
          title: run.ok ? `herdr tab → ${input}` : "herdr tab failed",
          error: !run.ok,
          exit_code: run.exitCode,
          label: input,
          // Carries the tab forward, for `cleanup` to close.
          tab: typeof run.meta?.tab === "string" ? run.meta.tab : undefined,
        },
      },
    ];
  },

  /**
   * The tab was opened for this task; completing the task is the point it stops
   * being wanted. Closing it takes the pane and whatever was running in it with
   * it — a tab that has already been closed by hand is the same outcome, so it
   * passes quietly.
   */
  cleanup(task, ctx) {
    return closeTab(task.meta.tab, ctx);
  },
};

/**
 * The same hand-off, but to an agent rather than a person.
 *
 * `herdr agent start` never makes layout of its own — it wants a pane already
 * sitting at a shell prompt — so a first hand-off is three calls: a tab for the
 * task, the agent started in that tab's root pane, then the task itself
 * submitted with `herdr agent prompt`, so the agent wakes up already working on
 * the item rather than sitting idle at an empty prompt. The tab keeps the label
 * you typed; the agent gets a slug of it, because herdr names have to match
 * `[a-z][a-z0-9_-]{0,31}` and be unique among the agents currently alive.
 *
 * Run it again on a task that has already been handed off and it is one call:
 * the prompt, into the agent that is already on the task. Re-running is a
 * follow-up, not a fork — a second pane doing the same work is never what was
 * wanted. Only if that agent is gone from herdr does a fresh one get started.
 *
 * Either way the run then waits, so the task sits in the working pool for as
 * long as the agent is actually working on it and comes back to the feed at the
 * point there is something to see: the turn finished, or the agent stopped to
 * ask. See `submitPrompt`.
 *
 * At that point the pane is read back with `herdr agent read`, and what the
 * agent said is what the task carries into the feed — so a finished turn, or
 * the question a blocked agent stopped on, can be read off the board instead of
 * being something you have to go to the pane for. See `readBack`.
 */
export const herdrAgentTool: Tool = {
  id: "herdr-agent",
  name: "herdr agent",
  description: `Start a ${AGENT_KIND} agent in a new herdr tab, or message the task's agent`,

  // What is being asked for depends on whether the task already has an agent.
  input(tasks) {
    const existing = agentOf(tasks[0]);
    return existing
      ? { prompt: `Message for ${existing} — blank resends the task` }
      : { prompt: "Agent name" };
  },

  pre({ tasks, input }) {
    const task = tasks[0];
    // For an agent that already exists the input is a message to send it, so an
    // empty one stays empty (`run` resends the task); only a name gets defaulted.
    const existing = agentOf(task);
    return {
      tasks: tasks.slice(0, 1),
      input: existing
        ? input.trim()
        : input.trim() || (task ? taskTitle(task) : ""),
    };
  },

  async run({ tasks, input }, ctx) {
    const task = tasks[0];
    const message = input.trim();
    // What the agent is here to work on. Read once, up front: a hand-off that
    // falls over carries it too, so the failed task is still the item and
    // re-running hands the next agent the work rather than the error.
    const text = bodyOf(task);

    const existing = agentOf(task);
    if (existing) {
      const live = await livingAgent(existing, ctx);
      if (live) return promptExisting(existing, live, message || text, ctx);
      // The pane was closed, or herdr restarted. Nothing to talk to, so fall
      // through and put the task in front of a new agent.
      ctx.log(`\n[agent "${existing}" is gone — starting a new one]\n`);
    }

    const label = message || (task ? taskTitle(task) : "");

    // The user is watching their own pane, so the new tab opens behind them.
    const created = await herdr(
      ["tab", "create", "--label", label, "--no-focus"],
      ctx,
      30_000,
    );
    if (!created.ok) {
      return {
        ok: false,
        output: created.output.trim() || "(no output)",
        exitCode: created.exitCode,
        meta: { label, prompt: text || undefined },
      };
    }

    const pane = paneIdOf(created.stdout);
    const tab = tabIdOf(created.stdout);
    // What the pane id *means*: pane ids are short and get reused, so cleanup
    // checks this before closing anything it only knows about second-hand.
    const terminal = terminalIdOf(created.stdout);
    if (!pane) {
      return {
        ok: false,
        output: [
          `could not find a pane id in the tab herdr created:`,
          created.output.trim(),
        ].join("\n"),
        exitCode: created.exitCode,
        meta: { label, tab, prompt: text || undefined },
      };
    }

    const name = await uniqueAgentName(slug(label), ctx);
    // A failed start leaves the tab where it is rather than closing it — the
    // reason the agent didn't come up is on screen in that pane.
    const started = await startAgent(name, pane, ctx);

    const transcript = [created.output.trim(), started.output.trim()];
    if (!started.ok) {
      return {
        ok: false,
        output: transcript.filter(Boolean).join("\n") || "(no output)",
        exitCode: started.exitCode,
        meta: {
          label,
          agent: name,
          kind: AGENT_KIND,
          pane,
          tab,
          terminal,
          prompt: text || undefined,
        },
      };
    }

    // The agent is up and idle: hand it the task, then read back what it did
    // with it once the wait says the turn is over.
    const prompted = text ? await submitPrompt(name, text, ctx) : undefined;
    if (prompted) transcript.push(prompted.output.trim());
    const said = prompted?.ok ? await readBack(name, ctx) : "";

    return {
      ok: prompted ? prompted.ok : true,
      output: transcript.filter(Boolean).join("\n") || "(no output)",
      exitCode: prompted ? prompted.exitCode : started.exitCode,
      meta: {
        label,
        agent: name,
        kind: AGENT_KIND,
        pane,
        tab,
        terminal,
        prompt: text || undefined,
        prompted: Boolean(prompted?.ok),
        status: prompted ? statusOf(prompted.stdout) : undefined,
        said: said || undefined,
      },
    };
  },

  post({ tasks, input }, run) {
    const task = tasks[0];
    if (!task) return [];

    const name =
      typeof run.meta?.agent === "string" ? run.meta.agent : slug(input);
    const pane = typeof run.meta?.pane === "string" ? run.meta.pane : "";
    const label = typeof run.meta?.label === "string" ? run.meta.label : input;
    const sent = typeof run.meta?.prompt === "string" ? run.meta.prompt : "";
    const reused = run.meta?.reused === true;
    const prompted = run.meta?.prompted === true;
    const status = typeof run.meta?.status === "string" ? run.meta.status : "";
    const said = typeof run.meta?.said === "string" ? run.meta.said : "";

    const where =
      `herdr agent "${name}" (${AGENT_KIND})` +
      (pane ? ` in pane ${pane}` : "");
    // How the agent's turn ended is the reason this is back in the feed at all.
    const settled =
      status === "blocked"
        ? " It stopped to ask something."
        : status
          ? " Its turn is done."
          : "";
    const header =
      (reused
        ? sent === bodyOf(task)
          ? `Resent the task to ${where}.`
          : `Sent "${firstLine(sent)}" to ${where}.`
        : `Handed off to ${where}${prompted ? ", with the task as its prompt." : "."}`) +
      settled;

    return [
      {
        parent: task.id,
        // What the agent said, read off its pane — the point of the wait is
        // that by now there is something to show. A read that came back with
        // nothing falls back to what was handed over, so the task still says
        // what the work is rather than being a header on its own.
        data: run.ok
          ? [header, "", said || sent || bodyOf(task)].join("\n")
          : run.output,
        source: "tool:herdr-agent",
        state: "incoming",
        meta: {
          title: run.ok
            ? status === "blocked"
              ? `herdr agent ${name} is blocked`
              : `herdr agent → ${name}`
            : run.meta?.prompted === false
              ? `herdr agent ${name} took no prompt`
              : "herdr agent failed",
          error: !run.ok,
          exit_code: run.exitCode,
          label,
          // Carries the agent forward, so the next run on this chain finds it.
          // Kept on failures too: an agent that came up but wouldn't take the
          // prompt is still the agent for this task, and `run` checks with
          // herdr that a name is real before it talks to it.
          agent:
            typeof run.meta?.agent === "string" ? run.meta.agent : undefined,
          kind: AGENT_KIND,
          pane: pane || undefined,
          // Where the hand-off put the agent. A follow-up into an agent that was
          // already there opens no tab of its own, so the id stays on the
          // hand-off that did, further back in the chain.
          tab: typeof run.meta?.tab === "string" ? run.meta.tab : undefined,
          // The identity of that pane, for `cleanup` to check before closing it.
          terminal:
            typeof run.meta?.terminal === "string"
              ? run.meta.terminal
              : undefined,
          reused: reused || undefined,
          // What was asked. The body is the answer now, so this is what a
          // blank re-run resends rather than handing the agent its own screen.
          prompt: sent || undefined,
          prompted: run.meta?.prompted,
          status: status || undefined,
        },
      },
    ];
  },

  /**
   * What the hand-off left running is the agent, and what the agent is running
   * in is a pane — herdr has no "stop the agent", so closing that pane out from
   * under it is how it ends. Closing the last pane of a tab takes the tab with
   * it, so a hand-off still sitting in the tab it opened needs nothing more;
   * one whose tab has since been split keeps the panes the user added.
   *
   * herdr is asked where the agent is *now* rather than trusting what the
   * hand-off wrote down, since an agent can be moved between panes and the
   * recorded id would then close the wrong one. Only when the agent is gone
   * from herdr entirely does the recorded pane get closed instead — the agent
   * exited but left its pane sitting there — and then only if that pane is
   * still the same terminal, because pane ids get reused and closing a recycled
   * one would take out somebody else's work.
   */
  async cleanup(task, ctx) {
    const agent = typeof task.meta.agent === "string" ? task.meta.agent : "";
    const live = agent ? await livingAgent(agent, ctx) : undefined;
    if (live?.pane) {
      await closePane(live.pane, ctx);
      return;
    }

    const pane = typeof task.meta.pane === "string" ? task.meta.pane : "";
    if (!pane) return;
    if (await isOurPane(pane, task.meta.terminal, ctx))
      await closePane(pane, ctx);
    else
      ctx.log(
        `[pane ${pane} is not the one the hand-off opened — left alone]\n`,
      );
  },
};

/**
 * A follow-up into the agent already on the task. One call, no layout: the pane
 * is already there and, as far as the agent is concerned, this is the next
 * thing said in a conversation it is halfway through.
 */
async function promptExisting(
  name: string,
  live: LiveAgent,
  text: string,
  ctx: ToolContext,
): Promise<ToolRun> {
  const meta = {
    label: name,
    agent: name,
    kind: AGENT_KIND,
    pane: live.pane,
    terminal: live.terminal,
    reused: true,
  };
  if (!text) {
    return {
      ok: false,
      output: `nothing to send to herdr agent "${name}" — the task is empty`,
      exitCode: null,
      meta: { ...meta, prompted: false },
    };
  }

  const sent = await submitPrompt(name, text, ctx);
  const said = sent.ok ? await readBack(name, ctx) : "";
  return {
    ok: sent.ok,
    output: sent.output.trim() || "(no output)",
    exitCode: sent.exitCode,
    meta: {
      ...meta,
      prompt: text,
      prompted: sent.ok,
      status: statusOf(sent.stdout),
      said: said || undefined,
    },
  };
}

/**
 * `herdr agent start`, retried while the tab's shell is still coming up.
 *
 * herdr wants the target pane sitting at an interactive shell prompt, and a
 * tab that was created a moment ago is not there yet — a login shell with a
 * real profile behind it (oh-my-zsh, nvm) spends a beat sourcing it. herdr
 * answers a pane in that state with `agent_pane_busy` and answers it
 * *immediately*: `agent start --timeout` covers waiting for the agent to come
 * up, not for the shell to arrive. So the hand-off lost the race about one run
 * in three, and lost it in 38ms — the tab open, no agent in it, and the task
 * back in the feed as a failure.
 *
 * Waiting is therefore ours to do. `agent_pane_busy` is the one error worth
 * another go, since it is the only one that a moment's patience changes; every
 * other failure is the answer and comes straight back. The budget is
 * `WORKWORK_HERDR_SHELL_READY_MS` (default 15s), which is a slow profile's
 * startup and not a hang.
 */
async function startAgent(
  name: string,
  pane: string,
  ctx: ToolContext,
): Promise<ExecResult> {
  const args = ["agent", "start", name, "--kind", AGENT_KIND, "--pane", pane];
  const deadline = Date.now() + SHELL_READY_MS;

  for (let attempt = 1; ; attempt++) {
    const started = await herdr(args, ctx, 2 * 60 * 1000);
    const waited = attempt > 1;

    if (started.ok) {
      if (waited) ctx.log(`[shell was ready on attempt ${attempt}]\n`);
      return started;
    }

    const retryable = PANE_BUSY.test(started.output) && !ctx.signal.aborted;
    if (!retryable || Date.now() >= deadline) {
      // Say that the waiting happened, so a hand-off that gave up on a shell
      // that never arrived doesn't read like one that never waited at all.
      return waited
        ? {
            ...started,
            output: [
              started.output,
              `[gave up after ${attempt} attempts over ${SHELL_READY_MS}ms` +
                ` waiting for pane ${pane} to reach a shell prompt]`,
            ].join("\n"),
          }
        : started;
    }

    ctx.log(`[pane ${pane} is not at a shell prompt yet — retrying]\n`);
    await pause(Math.min(250 * 2 ** (attempt - 1), 1000), ctx.signal);
  }
}

/** herdr's word for "that pane is not sitting at a shell prompt". */
const PANE_BUSY = /agent_pane_busy/;

/** A delay that gives up the moment the run is cancelled. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Submit the task, then hold until herdr says the agent has settled.
 *
 * The wait is what keeps the item in the working pool: `runTool` leaves a task
 * `working` for exactly as long as `run` is pending, so returning at submission
 * time put the task back in the feed while the agent was still typing. herdr
 * settles on `idle`/`done` — the turn is over — or `blocked`, where it has
 * stopped to ask something, and both are the moment the task is worth a look
 * again. Cancelling the run (`x`) only stops the waiting: the agent is a
 * process in its own pane and keeps going, and the pane is still there.
 *
 * `prompt --wait` rather than a separate `agent wait`: it anchors the wait at
 * the submission. A standalone wait races the detector — the agent is idle at
 * the instant the prompt lands, so a wait that subscribes before herdr has
 * classified the turn as `working` matches that idle and returns immediately.
 * `--wait` only matches states observed after the submission, and gives up with
 * `agent_prompt_stalled` if the prompt produced no state change at all.
 *
 * The prompt is logged by its first line — the whole thing is already in the
 * task it came from.
 */
function submitPrompt(name: string, text: string, ctx: ToolContext) {
  const shown = firstLine(text) + (text.includes("\n") ? " …" : "");
  ctx.log(
    `$ ${HERDR_BIN} agent prompt ${name} ${JSON.stringify(shown)} --wait\n`,
  );
  return exec(
    HERDR_BIN,
    ["agent", "prompt", name, text, "--wait", "--timeout", String(WAIT_MS)],
    {
      signal: ctx.signal,
      // Past herdr's own deadline, so a slow turn comes back as herdr's `timeout`
      // rather than a killed CLI with nothing to say about the agent.
      timeoutMs: WAIT_MS + 30_000,
      onOutput: ctx.log,
    },
  );
}

/**
 * What the agent said, taken off its own pane.
 *
 * herdr has no transcript to ask for — the pane *is* the record — so the result
 * of the turn is a snapshot of it, bounded by `WORKWORK_HERDR_READ_LINES`.
 *
 * That bound is taken off the *end* of what came back: what the agent said last
 * is the answer, and what a longer region reaches back to is the turn before
 * it. It is applied here rather than by asking herdr for fewer lines, because
 * `--lines` is a window on the *viewport* and not on the output — it counts
 * back from the bottom row of the pane, and the rows under a young agent's
 * last word are blank. A pane 19 rows into a 58-row viewport answers
 * `--lines 40` with nothing at all, and answers 45 with the last five lines of
 * the box. So the read asks for the region and `tidySnapshot` keeps the last
 * `READ_LINES` of it, which is the bound `WORKWORK_HERDR_READ_LINES` promises.
 *
 * A read that fails is not a failed run: the turn happened either way, the pane
 * is still there to be looked at, and `post` falls back to the task's own text.
 * The snapshot is not streamed into the log — it is the pane the user can
 * already see, and it would bury the run's own transcript.
 */
async function readBack(name: string, ctx: ToolContext): Promise<string> {
  // `recent-unwrapped`: not clipped to the pane's height, and in the answer's
  // own lines rather than hard-wrapped at the pane's width.
  const args = ["agent", "read", name, "--source", "recent-unwrapped"];
  ctx.log(`$ ${HERDR_BIN} ${args.join(" ")}\n`);

  const read = await exec(HERDR_BIN, args, {
    signal: ctx.signal,
    timeoutMs: 30_000,
  });
  if (!read.ok) {
    ctx.log(
      `[could not read ${name}'s pane: ${read.output.trim() || `exit ${read.exitCode}`}]\n`,
    );
    return "";
  }

  const said = tidySnapshot(read.stdout, READ_LINES);
  ctx.log(
    `[read ${said ? `${said.split("\n").length} lines from` : "nothing from"} ${name}]\n`,
  );
  return said;
}

/** A pane-wide rule: the border an agent draws around the line you type on. */
const RULE = /^[─━═_-]{20,}$/;

/**
 * A terminal snapshot, as something worth reading in the feed: trailing blanks
 * off every line, and the input box at the foot of the pane — a rule, the empty
 * line you would type on, another rule, then the agent's own status line — cut
 * away, since none of it is anything the agent said. The cut starts at the
 * topmost rule in the last few lines, so it takes the whole box rather than
 * leaving its lid behind.
 *
 * What is left is then taken from the bottom: `keep` lines counted back from
 * where the box was, so the snapshot ends on the agent's last word rather than
 * starting on whatever the read window happened to reach back to.
 */
function tidySnapshot(snapshot: string, keep: number): string {
  const lines = snapshot
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd());

  let end = lines.length;
  while (end > 0 && !lines[end - 1]) end--;
  for (let i = Math.max(0, end - BOX_LINES); i < end; i++) {
    if (RULE.test(lines[i]?.trim() ?? "")) {
      end = i;
      break;
    }
  }

  return lines
    .slice(Math.max(0, end - keep), end)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The agent already working this chain, if any: the most recent one named on
 * the way here. Hand-offs stamp `agent` on the task they produce, so this is
 * the same trick the claude tool uses to find a session to resume.
 */
function agentOf(task: Task | undefined): string | undefined {
  if (!task) return undefined;

  const chain = chainOf(task, getTask);
  const from = chain.findIndex((node) => node.id === task.id);
  for (let i = (from < 0 ? chain.length : from + 1) - 1; i >= 0; i--) {
    const agent = chain[i]?.meta.agent;
    if (typeof agent === "string" && agent) return agent;
  }
  return undefined;
}

/**
 * herdr is the authority on whether that agent is still there — a pane gets
 * closed, or herdr restarted, long after the hand-off was written down. An
 * unknown name comes back as `agent_not_found` and a non-zero exit.
 */
async function livingAgent(
  name: string,
  ctx: ToolContext,
): Promise<LiveAgent | undefined> {
  const got = await herdr(["agent", "get", name], ctx, 10_000);
  return got.ok
    ? { pane: paneIdOf(got.stdout) ?? "", terminal: terminalIdOf(got.stdout) }
    : undefined;
}

/** Where an agent herdr still knows about is sitting, right now. */
interface LiveAgent {
  pane: string;
  terminal?: string;
}

/**
 * Whether `pane` is still the pane the hand-off opened. One that is gone is
 * nothing to close; one now running a different terminal than the id written
 * down is somebody else's, since herdr hands pane ids back out after a close.
 * A task from before terminals were recorded has only existence to go on.
 */
async function isOurPane(
  pane: string,
  terminal: unknown,
  ctx: ToolContext,
): Promise<boolean> {
  const got = await herdr(["pane", "get", pane], ctx, 10_000);
  if (!got.ok) return false;
  if (typeof terminal !== "string" || !terminal) return true;
  return terminalIdOf(got.stdout) === terminal;
}

/** The hand-off note `post` writes, so re-running strips it back off again. */
const HANDOFF_NOTE =
  /^(?:Handed off to|Sent .* to|Resent the task to) herdr [^\n]*\n\n/;

/**
 * What the agent gets asked to do: the task as it stands, minus the note a
 * previous hand-off left on the front of it. Nothing is templated on top — the
 * agent is being handed the item, not answering a question about it, and the
 * pane is a real conversation it can be steered in afterwards.
 *
 * A task that has already been through an agent carries what was sent to it on
 * `meta.prompt`, and its body is the reply that came back — so that is what a
 * re-run hands over, rather than reading the agent its own transcript. The item
 * therefore stays the same thing on every re-run, exactly as the stripped note
 * kept it before the reply became the body.
 */
function bodyOf(task: Task | undefined): string {
  const asked = task?.meta.prompt;
  if (typeof asked === "string" && asked.trim()) return asked.trim();
  return (task?.data ?? "").replace(HANDOFF_NOTE, "").trim();
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((line) => line.trim())
      ?.trim()
      .slice(0, 72) ?? ""
  );
}

function herdr(args: string[], ctx: ToolContext, timeoutMs: number) {
  ctx.log(`$ ${HERDR_BIN} ${args.join(" ")}\n`);
  return exec(HERDR_BIN, args, {
    signal: ctx.signal,
    timeoutMs,
    onOutput: ctx.log,
  });
}

/**
 * Close what a hand-off opened. Both closes are `cleanup` paths, so "it isn't
 * there any more" is the outcome being asked for, not a failure: herdr answers
 * an id it doesn't know with `tab_not_found` / `pane_not_found`, and that is a
 * tab someone already closed by hand. Anything else — no herdr running, a
 * refused close — throws, and the board says the chain was left standing.
 */
async function closeTab(tab: unknown, ctx: ToolContext): Promise<void> {
  if (typeof tab !== "string" || !tab) return;
  await release(["tab", "close", tab], ctx, `herdr tab ${tab}`);
}

async function closePane(pane: unknown, ctx: ToolContext): Promise<void> {
  if (typeof pane !== "string" || !pane) return;
  await release(["pane", "close", pane], ctx, `herdr pane ${pane}`);
}

async function release(
  args: string[],
  ctx: ToolContext,
  what: string,
): Promise<void> {
  const result = await herdr(args, ctx, 30_000);
  if (result.ok || /_not_found/.test(result.output)) return;
  throw new Error(
    `could not close ${what}: ${result.output.trim() || `exit ${result.exitCode}`}`,
  );
}

/**
 * `tab create` answers with the tab and its root pane. Read the id back rather
 * than predicting it — but fall back to the first pane id anywhere in the
 * payload, so a shape change costs a worse guess instead of a failed run.
 */
function paneIdOf(stdout: string): string | undefined {
  try {
    const result = JSON.parse(stdout)?.result;
    // `tab create` answers with the tab, `agent get` with the agent.
    const pane = result?.root_pane?.pane_id ?? result?.agent?.pane_id;
    if (typeof pane === "string" && pane) return pane;
  } catch {
    // Not JSON — fall through to the regex.
  }
  return /"pane_id"\s*:\s*"([^"]+)"/.exec(stdout)?.[1];
}

/** The tab out of the same payload — `tab create` and `tab get` both name it. */
function tabIdOf(stdout: string): string | undefined {
  try {
    const result = JSON.parse(stdout)?.result;
    const tab =
      result?.tab?.tab_id ?? result?.tab_id ?? result?.root_pane?.tab_id;
    if (typeof tab === "string" && tab) return tab;
  } catch {
    // Not JSON — fall through to the regex.
  }
  return /"tab_id"\s*:\s*"([^"]+)"/.exec(stdout)?.[1];
}

/**
 * The terminal running in a pane, out of whichever payload named it — a tab
 * creation (its root pane), a `pane get`, an `agent get`. It outlives nothing:
 * a new terminal in the same pane id is a different one, which is the whole
 * point of checking it.
 */
function terminalIdOf(stdout: string): string | undefined {
  try {
    const result = JSON.parse(stdout)?.result;
    const terminal =
      result?.root_pane?.terminal_id ??
      result?.pane?.terminal_id ??
      result?.agent?.terminal_id;
    if (typeof terminal === "string" && terminal) return terminal;
  } catch {
    // Not JSON — fall through to the regex.
  }
  return /"terminal_id"\s*:\s*"([^"]+)"/.exec(stdout)?.[1];
}

/**
 * The lifecycle state herdr settled on, off the agent it answers a finished
 * wait with: `idle` or `done` for a turn that ended, `blocked` for one that
 * stopped to ask. Same fall-back as `paneIdOf` — a shape change costs the
 * wording of a header, not the run.
 */
function statusOf(stdout: string): string | undefined {
  try {
    const status = JSON.parse(stdout)?.result?.agent?.agent_status;
    if (typeof status === "string" && status) return status;
  } catch {
    // Not JSON — fall through to the regex.
  }
  return /"agent_status"\s*:\s*"([^"]+)"/.exec(stdout)?.[1];
}

/** herdr agent names: lowercase, `[a-z][a-z0-9_-]{0,31}`. */
function slug(label: string): string {
  const cleaned = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 32);
  return cleaned || "task";
}

/**
 * Names only have to be unique among *live* agents, so ask herdr whether this
 * one is taken — the same `agent get` probe the reuse path runs, rather than
 * reading names out of `agent list`, whose entries don't always carry one.
 */
async function uniqueAgentName(
  base: string,
  ctx: ToolContext,
): Promise<string> {
  if (!(await livingAgent(base, ctx))) return base;

  for (let n = 2; n < 100; n++) {
    const candidate = `${base.slice(0, 29)}-${n}`;
    if (!(await livingAgent(candidate, ctx))) return candidate;
  }
  return base;
}
