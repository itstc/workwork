import { cleanupChains } from '../core/cleanup.ts';
import { copyToClipboard } from '../core/clipboard.ts';
import { clearNotices, notify } from '../core/notify.ts';
import { cancelRun, runForTask, runTool } from '../core/runner.ts';
import { discardChain, done, getTask, setState, splitChain } from '../core/store.ts';
import { chainOf, taskTitle } from '../core/task.ts';
import type { Task } from '../core/task.ts';
import { feedStates, feeds, submit, toggleFeed } from '../feeds/index.ts';
import { manualFeed } from '../feeds/manual.ts';
import { tools } from '../tools/index.ts';
import type { Tool } from '../tools/types.ts';
import { fit } from './ansi.ts';
import {
  footerLine,
  headerLine,
  noticeLine,
  renderBoard,
  statusLine,
} from './board.ts';
import type { Key } from './keys.ts';
import { isPrintable } from './keys.ts';
import { panelHeight, renderHelp, renderPanel, renderViewer } from './overlays.ts';
import { size, tick } from './screen.ts';
import type { MenuItem, MenuOverlay, ViewerOverlay } from './state.ts';
import {
  cursorTask,
  cyclePane,
  doneOpen,
  focusPane,
  focusedList,
  focusedPane,
  menuItems,
  moveCursor,
  overlay,
  setCursor,
  targetTasks,
  toggleDone,
} from './state.ts';
import { t } from './theme.ts';

let quit: () => void = () => {};

export function setQuitHandler(handler: () => void): void {
  quit = handler;
}

// --- rendering -------------------------------------------------------------

export function render(): string[] {
  const { rows, cols } = size.value;
  // Read the ticker so spinners and relative timestamps keep refreshing.
  const tickValue = tick.value;
  const current = overlay.value;

  if (current?.kind === 'help') {
    return frame(cols, rows, renderHelp(cols, rows - 3), [['esc / ?', 'close']]);
  }

  if (current?.kind === 'viewer') {
    const bodyHeight = Math.max(1, rows - 3);
    const { lines, total } = renderViewer(current, cols, bodyHeight);
    const position =
      total > bodyHeight
        ? `${current.scroll + 1}–${Math.min(total, current.scroll + bodyHeight)} of ${total}`
        : 'all';
    return frame(cols, rows, lines, [
      ['↑↓', 'step'],
      ['⏎', 'copy step'],
      ['v', 'split here'],
      ['esc', 'close'],
      ['', t.dim(position)],
    ]);
  }

  const panel = current ? renderPanel(current, cols) : [];
  // The panel is the thing being interacted with, so a short window shrinks the
  // board away under it instead of pushing the panel off the bottom.
  const boardHeight = Math.max(0, rows - 4 - panel.length);

  const lines = [
    headerLine(cols),
    statusLine(cols),
    ...renderBoard(cols, boardHeight, tickValue),
    ...panel,
    noticeLine(cols),
    footerLine(cols, boardHints()),
  ];

  return lines.map((line) => fit(line, cols));
}

function frame(cols: number, rows: number, body: string[], hints: [string, string][]): string[] {
  const lines = [headerLine(cols), ...body.slice(0, rows - 2)];
  while (lines.length < rows - 1) lines.push('');
  lines.push(footerLine(cols, hints));
  return lines.slice(0, rows).map((line) => fit(line, cols));
}

function boardHints(): [string, string][] {
  const pane = focusedPane.value;
  const hints: [string, string][] = [
    ['↑↓', 'move'],
    ['←→', 'pane'],
    ['⏎', 'view'],
    ['n', 'new'],
    ['r', 'run tool'],
  ];
  if (pane === 'working') hints.push(['x', 'cancel']);
  else if (pane === 'done') hints.push(['u', 'reopen'], ['3 / esc', 'close']);
  else hints.push(['d', 'complete']);
  if (pane !== 'done') hints.push(['3', 'done']);
  hints.push(['f', 'feeds'], ['?', 'help'], ['^c', 'quit']);
  return hints;
}

// --- actions ---------------------------------------------------------------

function prompt(
  title: string,
  options: { hint?: string; value?: string; onSubmit: (value: string) => void },
): void {
  const value = options.value ?? '';
  overlay.value = {
    kind: 'prompt',
    title,
    hint: options.hint,
    value,
    caret: value.length,
    onSubmit: options.onSubmit,
  };
}

function menu(
  title: string,
  items: MenuItem[],
  subtitle?: string,
  options: { search?: boolean } = {},
): void {
  overlay.value = {
    kind: 'menu',
    title,
    subtitle,
    items,
    index: 0,
    // A searching menu starts on an empty filter, which shows everything.
    filter: options.search ? '' : undefined,
  };
}

function newTask(): void {
  prompt('New task', {
    hint: manualFeed.description + ' — \\n makes a new line',
    onSubmit: (value) => {
      const created = submit(manualFeed, value);
      if (created.length) {
        focusPane('incoming');
        setCursor('incoming', 0);
        notify('info', `added ${created.length} task${created.length === 1 ? '' : 's'}`);
      }
    },
  });
}

/**
 * `targets` is captured by the caller at the moment the user chose, not read
 * here: a feed can push a task into the pane while the picker or the input
 * prompt is open, which reorders `incoming` under the cursor.
 */
function startTool(tool: Tool, targets: Task[] = targetTasks()): void {
  const live = targets.filter((task) => getTask(task.id));
  if (live.length === 0) {
    notify('info', targets.length ? 'that task is gone' : 'no task under the cursor');
    return;
  }

  const label = taskTitle(live[0]!);

  const launch = (input: string) => {
    overlay.value = null;
    focusPane('working');
    void runTool(tool, live, input);
  };

  const spec = typeof tool.input === 'function' ? tool.input(live) : tool.input;

  if (spec) {
    const ask = () => {
      prompt(`${tool.name} — ${label}`, {
        hint: `${spec.prompt}${spec.placeholder ? `  (default: ${spec.placeholder})` : ''}`,
        onSubmit: (value) => {
          if (spec.required && !value.trim()) {
            notify('error', `${tool.name} needs ${spec.prompt.toLowerCase()}`);
            // Required means required — keep asking rather than dropping them
            // back on the board with nothing started.
            ask();
            return;
          }
          launch(value);
        },
      });
    };
    ask();
    return;
  }

  launch('');
}

function openTools(targets: Task[] = targetTasks()): void {
  const task = targets[0];
  if (!task) {
    notify('info', 'nothing to work on');
    return;
  }

  // Every tool is listed and typing narrows the list, so a tool needs nothing
  // but a name to be reachable — no shortcut to find a free letter for.
  menu(
    'Run tool',
    tools.map((tool) => ({
      label: tool.name,
      description: tool.description,
      run: () => startTool(tool, targets),
    })),
    `on: ${taskTitle(task)}`,
    { search: true },
  );
}

function openFeeds(): void {
  menu(
    'Data sources',
    feeds.map((feed) => {
      const state = feedStates.value[feed.id];
      const status = feed.interactive
        ? 'on demand'
        : state?.running
          ? `running · ${state.status}`
          : 'stopped';
      return {
        key: feed.key,
        label: `${feed.name}  ${status}`,
        description: `${feed.description}${state?.received ? ` · ${state.received} received` : ''}`,
        run: () => {
          overlay.value = null;
          if (feed.interactive) {
            prompt(feed.prompt ?? feed.name, {
              hint: feed.description,
              onSubmit: (value) => {
                const created = submit(feed, value);
                notify(
                  created.length ? 'info' : 'error',
                  created.length ? `${feed.name}: added ${created.length}` : `${feed.name}: nothing to add`,
                );
              },
            });
          } else {
            void toggleFeed(feed);
          }
        },
      };
    }),
    'enter starts or stops a connection; interactive feeds prompt for input',
  );
}

function completeTask(): void {
  const targets = targetTasks();
  if (!targets.length) return;
  for (const task of targets) setState(task.id, 'done');
  notify('success', `completed ${targets.length} task${targets.length === 1 ? '' : 's'}`);
  void tidyUp(targets);
}

/**
 * Completing an item finishes the whole chain behind it, so the things its
 * steps left standing — a herdr tab, an agent holding a pane — are let go too.
 *
 * It runs behind the notice rather than in front of it: closing tabs takes a
 * moment and the board has already moved on. Only the outcome is reported, and
 * only when there is something to say, since most chains have nothing to
 * release. A step that wouldn't clean up says so and stays uncleaned, so
 * completing the task again retries it.
 */
async function tidyUp(targets: Task[]): Promise<void> {
  const report = await cleanupChains(targets);

  const failed = report.failures[0];
  if (failed) {
    const rest = report.failures.length - 1;
    notify(
      'error',
      `${failed.toolName}: ${failed.error}${rest > 0 ? ` (+${rest} more)` : ''}`,
    );
    return;
  }

  if (report.cleaned) {
    notify('info', `cleaned up ${report.cleaned} step${report.cleaned === 1 ? '' : 's'}`);
  }
}

function reopenTask(): void {
  const targets = targetTasks();
  if (!targets.length) return;
  for (const task of targets) setState(task.id, 'incoming');
  // Emptying the flyout by reopening everything should not leave it hanging.
  if (doneOpen.value && done.value.length === 0) toggleDone();
  notify('info', `back in the feed: ${targets.length}`);
}

function cancelOrDelete(): void {
  const task = cursorTask.value;
  if (!task) return;

  const run = runForTask(task.id);
  if (run) {
    cancelRun(run.id);
    notify('info', `cancelling ${run.toolName}…`);
    return;
  }

  prompt(`Delete "${taskTitle(task).slice(0, 40)}"?`, {
    hint: 'type y to delete this task and its history — anything else cancels',
    onSubmit: (value) => {
      if (value.trim().toLowerCase() !== 'y') return;
      discardChain(task.id);
      notify('info', 'task chain deleted');
    },
  });
}

function openViewer(): void {
  const task = cursorTask.value;
  if (!task) return;
  // Start on the step the board cursor was pointing at, not the root.
  const chain = chainOf(task, getTask);
  const pick = Math.max(0, chain.findIndex((node) => node.id === task.id));
  const opened: ViewerOverlay = { kind: 'viewer', taskId: task.id, scroll: 0, pick };
  overlay.value = { ...opened, scroll: scrollForStep(opened, pick) };
}

/** The step a viewer action applies to: whichever one the cursor is on. */
function viewerStep(current: ViewerOverlay): Task | undefined {
  const task = getTask(current.taskId);
  if (!task) return undefined;
  const chain = chainOf(task, getTask);
  return chain[Math.min(Math.max(0, current.pick), chain.length - 1)];
}

function copyViewerStep(current: ViewerOverlay): void {
  const step = viewerStep(current);
  if (!step) {
    notify('error', 'nothing to copy — that task is gone');
    return;
  }

  const text = step.data.replace(/\s+$/, '');
  void copyToClipboard(text).then((result) => {
    if (!result.ok) {
      notify('error', `copy failed: ${result.error}`);
      return;
    }
    notify('success', `copied ${taskTitle(step)} (${text.length} chars)`);
  });
}

/**
 * Cut the chain at the viewer cursor. Everything before the cursor stays with
 * the task you were reading up to that point; the cursor step onward becomes a
 * task of its own, so a chain that turned into two pieces of work can be split
 * without losing either half's history.
 */
function splitViewerChain(current: ViewerOverlay): void {
  const task = getTask(current.taskId);
  if (!task) {
    notify('error', 'nothing to split — that task is gone');
    return;
  }

  const chain = chainOf(task, getTask);
  const at = chain[Math.min(Math.max(0, current.pick), chain.length - 1)];
  if (!at) return;
  if (!at.prev) {
    notify('info', 'already the start of the chain — nothing in front to split off');
    return;
  }

  const split = splitChain(at.id);
  if (!split) {
    notify('error', 'could not split there');
    return;
  }

  // Keep reading whichever half the viewed task landed in, cursor parked on the
  // cut: the new root if we followed it, otherwise the head half's fresh tail.
  const stillThere = getTask(current.taskId) ?? split.tail;
  const nextChain = chainOf(stillThere, getTask);
  const cut = nextChain.findIndex((node) => node.id === at.id);
  const pick = cut >= 0 ? cut : Math.max(0, nextChain.length - 1);
  const moved: ViewerOverlay = { ...current, taskId: stillThere.id, pick };
  overlay.value = { ...moved, scroll: scrollForStep(moved, pick) };

  notify('success', `split off "${taskTitle(split.tail)}" — ${taskTitle(split.head)} is back in the feed`);
}

/** Scroll that brings step `index` into view, moving as little as it can. */
function scrollForStep(current: ViewerOverlay, index: number): number {
  const { rows, cols } = size.value;
  const viewport = Math.max(1, rows - 3);
  const { total, steps } = renderViewer({ ...current, scroll: 0 }, cols, viewport);
  const maxScroll = Math.max(0, total - viewport);
  const scroll = Math.min(maxScroll, Math.max(0, current.scroll));

  const step = steps[index];
  if (!step) return scroll;
  if (step.start < scroll) return step.start;
  // A step taller than the viewport pins to its head rather than its tail.
  if (step.end > scroll + viewport) return Math.min(step.start, Math.max(0, step.end - viewport));
  return scroll;
}

// --- input -----------------------------------------------------------------

export function handleKey(key: Key): void {
  const current = overlay.value;

  if (key.ctrl && key.name === 'c') {
    quit();
    return;
  }

  if (current?.kind === 'prompt') return handlePrompt(key, current);
  if (current?.kind === 'menu') return handleMenu(key, current);
  if (current?.kind === 'viewer') return handleViewer(key, current);
  if (current?.kind === 'help') {
    if (key.name === 'escape' || key.name === '?' || key.name === 'q') overlay.value = null;
    return;
  }

  handleBoard(key);
}

function handleBoard(key: Key): void {
  switch (key.name) {
    case '?':
      overlay.value = { kind: 'help' };
      return;
    case 'up':
    case 'k':
      moveCursor(-1);
      return;
    case 'down':
    case 'j':
      moveCursor(1);
      return;
    case 'pageup':
      moveCursor(-5);
      return;
    case 'pagedown':
      moveCursor(5);
      return;
    case 'g':
      // G (shift) jumps to the bottom, g to the top.
      setCursor(focusedPane.value, key.shift ? Math.max(0, focusedList.value.length - 1) : 0);
      return;
    case 'left':
    case 'h':
      cyclePane(-1);
      return;
    case 'right':
    case 'l':
    case 'tab':
      cyclePane(key.shift ? -1 : 1);
      return;
    case '1':
      focusPane('incoming');
      return;
    case '2':
      focusPane('working');
      return;
    case '3':
      toggleDone();
      return;
    case 'escape':
      if (doneOpen.value) toggleDone();
      else clearNotices();
      return;
    case 'return':
      openViewer();
      return;
    case 'n':
      newTask();
      return;
    case 'r':
      openTools();
      return;
    case 'c': {
      const claude = tools.find((tool) => tool.id === 'claude');
      if (claude) startTool(claude);
      return;
    }
    case 'f':
      openFeeds();
      return;
    case 'd':
      completeTask();
      return;
    case 'u':
      reopenTask();
      return;
    case 'x':
      cancelOrDelete();
      return;
    default:
      return;
  }
}

function handlePrompt(key: Key, current: Extract<NonNullable<typeof overlay.value>, { kind: 'prompt' }>): void {
  const update = (patch: Partial<typeof current>) => {
    overlay.value = { ...current, ...patch };
  };

  switch (key.name) {
    case 'escape':
      overlay.value = null;
      return;
    case 'return': {
      const value = current.value;
      overlay.value = null;
      current.onSubmit(value);
      return;
    }
    case 'backspace':
      if (current.caret > 0) {
        update({
          value: current.value.slice(0, current.caret - 1) + current.value.slice(current.caret),
          caret: current.caret - 1,
        });
      }
      return;
    case 'delete':
      update({ value: current.value.slice(0, current.caret) + current.value.slice(current.caret + 1) });
      return;
    case 'left':
      update({ caret: Math.max(0, current.caret - 1) });
      return;
    case 'right':
      update({ caret: Math.min(current.value.length, current.caret + 1) });
      return;
    case 'home':
      update({ caret: 0 });
      return;
    case 'end':
      update({ caret: current.value.length });
      return;
    case 'u':
      if (key.ctrl) update({ value: '', caret: 0 });
      else if (isPrintable(key)) insert(key, current, update);
      return;
    case 'w':
      if (key.ctrl) {
        const trimmed = current.value.slice(0, current.caret).replace(/\S*\s*$/, '');
        update({ value: trimmed + current.value.slice(current.caret), caret: trimmed.length });
      } else if (isPrintable(key)) insert(key, current, update);
      return;
    default:
      if (isPrintable(key)) insert(key, current, update);
  }
}

function insert(
  key: Key,
  current: Extract<NonNullable<typeof overlay.value>, { kind: 'prompt' }>,
  update: (patch: Partial<Extract<NonNullable<typeof overlay.value>, { kind: 'prompt' }>>) => void,
): void {
  const text = key.name === 'space' ? ' ' : key.sequence;
  update({
    value: current.value.slice(0, current.caret) + text + current.value.slice(current.caret),
    caret: current.caret + text.length,
  });
}

function handleMenu(key: Key, current: MenuOverlay): void {
  const searching = current.filter !== undefined;
  const items = menuItems(current);
  const index = Math.min(Math.max(0, current.index), Math.max(0, items.length - 1));

  const move = (delta: number) => {
    overlay.value = { ...current, index: Math.min(Math.max(0, index + delta), Math.max(0, items.length - 1)) };
  };

  const choose = () => {
    const item = items[index];
    if (!item) return;
    overlay.value = null;
    void item.run();
  };

  // On a searching menu the letters belong to the filter, so only the keys that
  // can't be typed — arrows, enter, escape — still steer the list.
  const filterTo = (value: string) => {
    overlay.value = { ...current, filter: value, index: 0 };
  };

  switch (key.name) {
    case 'escape':
      overlay.value = null;
      return;
    case 'up':
      move(-1);
      return;
    case 'down':
      move(1);
      return;
    case 'return':
      choose();
      return;
    case 'backspace':
      if (searching) filterTo((current.filter ?? '').slice(0, -1));
      return;
    default:
      break;
  }

  if (!searching) {
    switch (key.name) {
      case 'q':
        overlay.value = null;
        return;
      case 'k':
        move(-1);
        return;
      case 'j':
        move(1);
        return;
      default: {
        const byKey = items.find((item) => item.key && item.key === key.name);
        if (byKey) {
          overlay.value = null;
          void byKey.run();
        }
        return;
      }
    }
  }

  if (key.ctrl && key.name === 'u') {
    filterTo('');
    return;
  }
  if (isPrintable(key)) {
    filterTo((current.filter ?? '') + (key.name === 'space' ? ' ' : key.sequence));
  }
}

function handleViewer(key: Key, current: ViewerOverlay): void {
  const { rows, cols } = size.value;
  const viewport = Math.max(1, rows - 3);
  // Ask the renderer how tall the chain is so scrolling can never run past it.
  const { total, steps } = renderViewer({ ...current, scroll: 0 }, cols, viewport);
  const maxScroll = Math.max(0, total - viewport);
  const pick = Math.min(Math.max(0, current.pick), Math.max(0, steps.length - 1));

  const to = (value: number) => {
    overlay.value = { ...current, pick, scroll: Math.min(maxScroll, Math.max(0, value)) };
  };

  // Moving the step cursor drags the viewport along with it.
  const toStep = (index: number) => {
    const next = Math.min(Math.max(0, index), Math.max(0, steps.length - 1));
    overlay.value = { ...current, pick: next, scroll: scrollForStep(current, next) };
  };

  switch (key.name) {
    case 'escape':
    case 'q':
      overlay.value = null;
      return;
    case 'return':
      copyViewerStep({ ...current, pick });
      return;
    case 'up':
    case 'k':
      toStep(pick - 1);
      return;
    case 'down':
    case 'j':
      toStep(pick + 1);
      return;
    case 'pageup':
      to(current.scroll - viewport + 2);
      return;
    case 'pagedown':
      to(current.scroll + viewport - 2);
      return;
    case 'g':
      toStep(key.shift ? steps.length - 1 : 0);
      return;
    case 'home':
      to(0);
      return;
    case 'end':
      to(maxScroll);
      return;
    case 'v':
      splitViewerChain({ ...current, pick });
      return;
    case 'r': {
      // Run a tool straight from the viewer, on the task being read — not on
      // whatever the cursor points at now, which may have shifted since.
      const viewed = getTask(current.taskId);
      overlay.value = null;
      openTools(viewed ? [viewed] : []);
      return;
    }
    default:
      return;
  }
}
