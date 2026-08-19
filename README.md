# workwork

A CLI work queue. Connections turn into tasks, tasks get piped through tools, and
whatever the tool produces comes back to the feed as the next link in the chain.

```
  slack websocket ──▶ INCOMING FEED ──▶ WORKING POOL ──▶ result back to INCOMING
                            ▲                                      │
                            └──────── continue, or mark complete ◀─┘
```

Built on [chalk](https://github.com/chalk/chalk) for the interface and
[`@preact/signals-core`](https://preactjs.com/guide/v10/signals/) for state — the
whole board is a pure function of signals, so anything that mutates the store
repaints the screen.

## Running it

Needs Node 22.18+ (the TypeScript sources run directly via type stripping — no
build step).

```sh
npm install
npm start          # or: node bin/workwork.js
```

Other entry points:

```sh
workwork add "triage the on-call pager noise"   # push a task in from a script
workwork ls                                     # print the board as text
workwork --help
```

## The board

A **1 : 3 : 1** grid — the **incoming feed** on the left, the **detail** of
whatever the cursor is on in the middle, the **working pool** on the right.
Completed tasks are not a column: they live in a flyout that drops out of the
`done` button in the top-left corner.

```
 workwork  ▸ done 2 [3]  ·  5 incoming  ·  1 working
 feeds ● websocket (connected)  ○ manual                                                  1 running
╭─ 1 INCOMING FEED 5 ╮ ╭─ TASK DETAIL ─────────────────────────────────────╮ ╭─ 2 WORKING POOL 1 ╮
│ ▸ dana: prod depl… │ │ dana: prod deploy is stuck on the migration step  │ │ ▸ Fix the flaky … │
│   websocket · 2m   │ │ [incoming] · websocket · 2m ago · 3 steps         │ │   ⠙ claude 12.4s  │
│   review the pric… │ │                                                   │ │                   │
│   manual · 14m     │ │ the rollout has been pending for 20 minutes and   │ │                   │
│                    │ │ the pod is CrashLooping.                          │ │                   │
```

Pressing `3` (or `esc` to close) hangs the completed list over the feed column:

```
╭─ ▾ COMPLETED 2 ────╮ ╭─ TASK DETAIL ─────────────────────────────────────╮
│ ▸ shipped the hot… │ │ shipped the hotfix                                │
│   manual · 4m      │ │ [done] · manual · 4m ago · 5 steps                │
╰────────────────────╯ │                                                   │
```

The middle column is the board's reading surface: title, state, source, chain
depth, the task's whole text, its `meta`, and — while a tool is running — the
live tail of its output, which keeps its slice of the panel even when the text
above has to be trimmed. `⏎` still opens the full chain in the viewer.

Running tools stream their output into the working pane as they go, and raise a
notification (plus a bell) when they finish.

| key | |
| --- | --- |
| `↑ ↓` / `j k` | move within a pane |
| `← →` / `h l` / `tab` | switch pane — incoming ⇄ working (`1` `2` to jump) |
| `3` | open the completed flyout (`esc` closes it) |
| `g` / `G` | top / bottom |
| `n` | new task via the manual feed |
| `⏎` | open the viewer — the task's whole history |
| `space` | add to a multi-selection |
| `r` | run a tool on the task(s); `c` is a shortcut for claude |
| `⏎` (in the viewer) | copy the ticked steps — or the one under the cursor — to the clipboard |
| `v` (in the viewer) | split the chain at the cursor — that step onward becomes a new task |
| `d` / `u` | mark complete / send back to the feed |
| `x` | cancel a running tool, or delete a task and its history |
| `f` | data sources — start/stop connections |
| `?` | help |
| `q` | quit (state is saved) |

The viewer is where a task's life is legible: a slack message that got piped to
claude, handed to a herdr tab, then had `git` run against it shows up as four
linked steps with every process transcript intact. Inside it, `↑ ↓` moves
between steps, `space` ticks the ones you want (`a` ticks all), and `⏎` pipes
their text through `pbcopy` — with nothing ticked it copies the step under the
cursor. `v` splits the chain at the cursor: the steps in front of it stay
together as a task that goes back to the incoming feed, and the cursor step
onward is detached into a task of its own — both halves keep their history.

## The task model

A task is an immutable node in a linked chain. Nothing is edited in place —
processing a task appends a **new** task whose `prev` points back at it, and
stamps the old one's `next`. Only the tail of a chain (`next === null`) is live
and shown in a pane; everything behind it is history.

```json
{
  "id": "e2b1…",
  "prev": "5cbd…",
  "next": null,
  "data": "the task text, or a tool's output",
  "created_at": "2026-08-11T02:39:47.206Z",
  "source": "tool:claude",
  "state": "incoming",
  "meta": { "title": "…", "via": "claude", "exit_code": 0 }
}
```

`state` is which pane it sits in, and `meta` is producer-specific detail. The
whole store is JSON at `~/.workwork/state.json`, written atomically (tmp file +
rename) on every change. **If the process dies, nothing is lost** — anything that
was mid-flight in the working pool comes back to the incoming feed on the next
start, tagged with `meta.recovered_at`, because no tool is running for it any
more.

## Adding a data source

A feed converts raw payloads into tasks. It never puts anything on the board
directly: the runtime hands every payload to the feed's own `postprocess`, which
is the only path from raw data to a task.

```ts
// src/feeds/linear.ts
export const linearFeed: Feed = {
  id: 'linear',
  name: 'linear',
  description: 'Issues assigned to me',
  key: 'l',
  autostart: true,

  // required: raw payload -> task draft(s), or null to drop it
  postprocess(raw) {
    const issue = raw as { identifier: string; title: string; url: string };
    return {
      data: `${issue.identifier} ${issue.title}\n${issue.url}`,
      source: 'linear',
      meta: { title: issue.title },
    };
  },

  // optional: open a connection and emit raw payloads
  start(ctx) {
    const poll = setInterval(async () => ctx.emit(await fetchNextIssue()), 30_000);
    return { status: () => 'polling', stop: () => clearInterval(poll) };
  },
};
```

Register it in `src/feeds/index.ts`. Feeds with no `start` are `interactive: true`
— they prompt for input when triggered, which is all the manual feed is.

Shipped: **manual** (type it in) and **websocket** (set `WORKWORK_WS_URL`; the
shape the Slack example takes — it reconnects with backoff and reads common
`text`/`user`/`channel` notification fields).

## Adding a tool

A tool takes task(s) and optional input, and is built from three functions:

- **`pre`** — adjust the tasks and input before anything runs (template a prompt,
  drop tasks it can't handle, default the input). Task ids must survive so
  results can be chained back.
- **`run`** — do the work. Gets an `AbortSignal` (so `x` can cancel it) and a
  `log()` callback that streams output into the working pane and the viewer live.
- **`post`** — turn the process output into task(s), each linked to the `parent`
  it came from. Returning a result closes that parent out and puts the child back
  in the incoming feed.

```ts
export const testTool: Tool = {
  id: 'test', name: 'tests', description: 'Run the suite', key: 't',
  accepts: 'many',
  input: { prompt: 'test filter', placeholder: '' },

  pre: ({ tasks, input }) => ({ tasks, input: input.trim() }),

  run: async ({ input }, ctx) =>
    exec('npm', ['test', '--', input], { signal: ctx.signal, onOutput: ctx.log })
      .then((r) => ({ ok: r.ok, output: r.output, exitCode: r.exitCode })),

  post: ({ tasks }, run) => tasks.map((task) => ({
    parent: task.id,
    data: run.output,
    source: 'tool:test',
    meta: { title: run.ok ? 'tests passed' : 'tests failed', error: !run.ok },
  })),
};
```

Register it in `src/tools/index.ts`. Shipped tools:

| tool | what it does |
| --- | --- |
| **claude** | a conversation: the message you type becomes a task in the working pool, claude's reply comes back to the feed, and replying again resumes the same claude session |
| **herdr tab** | runs `herdr tab create --label <name>` to open a tab for the task, to work by hand |
| **git** | runs a git command and staples the output onto the task(s); works on a multi-selection |

### Talking to claude

claude runs one process per turn, so a long conversation never holds the board
hostage. Selecting a task and pressing `c` asks for a message — it's required,
because the message *is* the stdin claude works from:

    slack ──▸ [you: take a look] ──▸ [claude: which cluster?] ──▸ [you: staging] ──▸ …
               working pool             incoming feed              working pool

Each reply carries the claude session id in its meta, and the next turn resumes
that session with `--resume`, so claude keeps everything it has already said.
The first turn opens a session with `--session-id` and hands it the chain so far
as context. If a session has gone missing — pruned history, a different working
directory — the run falls back to a fresh session carrying the whole chain
rather than stranding the conversation, and notes `resumed_from` on the result.

The herdr hand-off is a single `herdr tab create --label <name>`. The name is
whatever you type at the prompt; leave it blank and the task's title is used.

## Configuration

| variable | |
| --- | --- |
| `WORKWORK_HOME` | state directory (default `~/.workwork`) |
| `WORKWORK_WS_URL` | websocket feed source; setting it enables the feed |
| `WORKWORK_CLAUDE_BIN` / `WORKWORK_CLAUDE_ARGS` | claude executable and extra `-p` args |
| `WORKWORK_CLAUDE_TIMEOUT_MS` | default 10 minutes |
| `WORKWORK_COPY_BIN` / `WORKWORK_COPY_ARGS` | clipboard command for the viewer (default `pbcopy`) |
| `WORKWORK_GIT_CWD` | repo the git tool runs in (default: cwd) |
| `WORKWORK_HERDR_BIN` | herdr executable (default `herdr`) |
| `WORKWORK_DESKTOP_NOTIFY` | `1` to also raise macOS notifications on completion |

## Layout

```
src/
  core/     task model, signal store, persistence, process runner, exec helpers
  feeds/    data sources: raw payload -> postprocess -> task
  tools/    pre -> run -> post, one file per tool
  ui/       ansi measuring, theme, key parsing, diffing renderer, panes, overlays
```

`npm run typecheck` runs `tsc --noEmit`.

## How the design boundaries are enforced

Not by convention — by the shape of the code:

- **Everything on the board is a task.** Feeds cannot reach `ingest`. The runtime
  hands every raw payload to that feed's own `postprocess`, which is the only
  path from source data to a task.
- **Tasks are an immutable chain, not mutable records.** Processing appends a
  *new* task with `prev` pointing back; the parent is stamped with `next` and
  stops being live. "Result goes back to the incoming feed" and "keep the whole
  history" are therefore the same mechanism — the viewer just walks the chain.
- **Tools are `pre` → `run` → `post`.** `post` returns results tagged with the
  `parent` they came from; anything a tool declines to produce a result for is
  returned to the incoming feed rather than stranded in the working pool.
- **The store is JSON on disk at all times**, so a dead process costs nothing.

## Status

Verified end to end, both headlessly and by driving the real binary under a pty:

- the full loop — feed → task → tool → working pool → result back in the feed
- chain integrity: parent stamped with `next`, child linked by `prev`, only the
  tail live, multi-step chains render in the viewer
- cancellation (`x`) tears down the child process and still records a task
- crash recovery (in-flight tasks return to the feed) and corrupt-state handling
- layout geometry at 140/110/84/70/64/50/44 columns, board and flyout alike —
  every row exact width, borders aligned, the grid collapsing feed + detail +
  pool → focused list + detail → one list as the terminal narrows
- `claude` against a stub binary; `git` against a real repo; `add`/`ls`/`--help`

`tsc --noEmit` is clean.

Two things to know:

- **The websocket feed goes beyond the "manual only" TODO.** It is off unless
  `WORKWORK_WS_URL` is set. It is here because it is step 1 of the Slack example
  and because it exercises the feed interface against a real connection — with
  reconnect and backoff — in a way the manual feed cannot. Delete
  `src/feeds/websocket.ts` and its entry in `src/feeds/index.ts` to drop it.
- **The herdr tab path is the one thing not executed during testing**, as it
  would have opened terminal tabs. Its `pre`/`post` contract is verified; the
  `herdr tab create` call itself is not. Worth one manual try before relying
  on it.
