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

Three panes — **incoming feed**, **working pool**, **completed**.

```
 workwork · 5 incoming  ·  1 working  ·  0 done
 feeds ● websocket (connected)  ○ manual                                   1 running
╭─ 1 INCOMING FEED 5 ──────────────╮ ╭─ 2 WORKING POOL 1 ───────────────╮ ╭─ 3 COMPLETED 0 ──╮
│ ▸ dana: prod deploy is stuck on… │ │   Fix the flaky checkout test    │ │ nothing yet      │
│   websocket · 2m                 │ │   ⠙ claude 12.4s  reading src/…  │ │                  │
```

Running tools stream their output into the working pane as they go, and raise a
notification (plus a bell) when they finish.

| key | |
| --- | --- |
| `↑ ↓` / `j k` | move within a pane |
| `← →` / `h l` / `tab` | switch pane (`1` `2` `3` to jump) |
| `g` / `G` | top / bottom |
| `n` | new task via the manual feed |
| `⏎` | open the viewer — the task's whole history |
| `space` | add to a multi-selection |
| `r` | run a tool on the task(s); `c` is a shortcut for claude |
| `d` / `u` | mark complete / send back to the feed |
| `x` | cancel a running tool, or delete a task and its history |
| `f` | data sources — start/stop connections |
| `?` | help |
| `q` | quit (state is saved) |

The viewer is where a task's life is legible: a slack message that got piped to
claude, handed to a Ghostty tab, then had `git` run against it shows up as four
linked steps with every process transcript intact.

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
| **claude** | pipes the task into `claude -p` and brings the response back as the next task |
| **ghostty tab** | opens a Ghostty tab `cd`'d into the right directory with the task text printed, to work by hand |
| **git** | runs a git command and staples the output onto the task(s); works on a multi-selection |

The Ghostty hand-off tries a real new tab via AppleScript first (needs
Accessibility permission for your terminal), falls back to a new window via
`open -na Ghostty`, then to `ghostty -e`. `WORKWORK_TERMINAL_CMD` overrides the
lot — it's invoked with the generated launcher script as its argument.

## Configuration

| variable | |
| --- | --- |
| `WORKWORK_HOME` | state directory (default `~/.workwork`) |
| `WORKWORK_WS_URL` | websocket feed source; setting it enables the feed |
| `WORKWORK_CLAUDE_BIN` / `WORKWORK_CLAUDE_ARGS` | claude executable and extra `-p` args |
| `WORKWORK_CLAUDE_TIMEOUT_MS` | default 10 minutes |
| `WORKWORK_GIT_CWD` | repo the git tool runs in (default: cwd) |
| `WORKWORK_GHOSTTY_BIN` / `WORKWORK_TERMINAL_CMD` | terminal hand-off |
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
- layout geometry at 110/84/70/44 columns — every row exact width, borders
  aligned, panes collapsing 3 → 2 → 1
- `claude` against a stub binary; `git` against a real repo; `add`/`ls`/`--help`

`tsc --noEmit` is clean.

Two things to know:

- **The websocket feed goes beyond the "manual only" TODO.** It is off unless
  `WORKWORK_WS_URL` is set. It is here because it is step 1 of the Slack example
  and because it exercises the feed interface against a real connection — with
  reconnect and backoff — in a way the manual feed cannot. Delete
  `src/feeds/websocket.ts` and its entry in `src/feeds/index.ts` to drop it.
- **The Ghostty new-*tab* path is the one thing not executed during testing**, as
  it would have opened terminal windows. Its `pre`/`post` contract is verified;
  the spawn itself is not. It uses AppleScript keystrokes (there is no cleaner
  API for "tab in the existing window"), so it needs Accessibility permission for
  whichever terminal runs workwork, and falls back to a new window via
  `open -na Ghostty`, then `ghostty -e`. `WORKWORK_TERMINAL_CMD` overrides all
  of it. Worth one manual try before relying on it.
