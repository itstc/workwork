import { copyToClipboard } from '../core/clipboard.ts';
import { clearNotices, notify } from '../core/notify.ts';
import { cancelRun, runForTask, runTool } from '../core/runner.ts';
import { discardChain, done, getTask, setState } from '../core/store.ts';
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
import type { MenuItem, ViewerOverlay } from './state.ts';
import {
  clearSelection,
  cursorTask,
  cyclePane,
  doneOpen,
  focusPane,
  focusedList,
  focusedPane,
  moveCursor,
  overlay,
  selection,
  setCursor,
  targetTasks,
  toggleDone,
  toggleSelected,
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
    const ticked = current.picked.length;
    return frame(cols, rows, lines, [
      ['↑↓', 'step'],
      ['space', ticked ? `ticked ${ticked}` : 'tick'],
      ['⏎', ticked ? `copy ${ticked}` : 'copy step'],
      ['esc', 'close'],
      ['', t.dim(position)],
    ]);
  }

  const panel = current ? renderPanel(current, cols) : [];
  const boardHeight = Math.max(3, rows - 4 - panel.length);

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
  const count = selection.value.length;
  const hints: [string, string][] = [
    ['↑↓', 'move'],
    ['←→', 'pane'],
    ['⏎', 'view'],
    ['n', 'new'],
    ['r', count > 0 ? `run on ${count}` : 'run tool'],
  ];
  if (pane === 'working') hints.push(['x', 'cancel']);
  else if (pane === 'done') hints.push(['u', 'reopen'], ['3 / esc', 'close']);
  else hints.push(['d', 'complete']);
  if (pane !== 'done') hints.push(['3', 'done']);
  hints.push(['f', 'feeds'], ['?', 'help'], ['q', 'quit']);
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

function menu(title: string, items: MenuItem[], subtitle?: string): void {
  overlay.value = { kind: 'menu', title, subtitle, items, index: 0 };
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
    notify('info', targets.length ? 'those tasks are gone' : 'no task selected');
    return;
  }

  const chosen = tool.accepts === 'one' ? live.slice(0, 1) : live;
  const label =
    chosen.length === 1 ? taskTitle(chosen[0]!) : `${chosen.length} tasks`;

  const launch = (input: string) => {
    clearSelection();
    overlay.value = null;
    focusPane('working');
    void runTool(tool, chosen, input);
  };

  if (tool.input) {
    const ask = () => {
      prompt(`${tool.name} — ${label}`, {
        hint: `${tool.input?.prompt}${tool.input?.placeholder ? `  (default: ${tool.input.placeholder})` : ''}`,
        onSubmit: (value) => {
          if (tool.input?.required && !value.trim()) {
            notify('error', `${tool.name} needs ${tool.input.prompt.toLowerCase()}`);
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
  if (targets.length === 0) {
    notify('info', 'nothing to work on');
    return;
  }

  const subtitle =
    targets.length === 1
      ? `on: ${taskTitle(targets[0]!)}`
      : `on ${targets.length} selected tasks`;

  menu(
    'Run tool',
    tools.map((tool) => ({
      key: tool.key,
      label: tool.name,
      description:
        tool.accepts === 'one' && targets.length > 1
          ? `${tool.description} (first task only)`
          : tool.description,
      run: () => startTool(tool, targets),
    })),
    subtitle,
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
  clearSelection();
  notify('success', `completed ${targets.length} task${targets.length === 1 ? '' : 's'}`);
}

function reopenTask(): void {
  const targets = targetTasks();
  if (!targets.length) return;
  for (const task of targets) setState(task.id, 'incoming');
  clearSelection();
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
  const opened: ViewerOverlay = { kind: 'viewer', taskId: task.id, scroll: 0, pick, picked: [] };
  overlay.value = { ...opened, scroll: scrollForStep(opened, pick) };
}

/** The steps a viewer action applies to: the ticked ones, else the cursor's. */
function viewerSteps(current: ViewerOverlay): Task[] {
  const task = getTask(current.taskId);
  if (!task) return [];
  const chain = chainOf(task, getTask);
  const ticked = chain.filter((node) => current.picked.includes(node.id));
  if (ticked.length) return ticked;
  const cursor = chain[Math.min(Math.max(0, current.pick), chain.length - 1)];
  return cursor ? [cursor] : [];
}

function copyViewerSteps(current: ViewerOverlay): void {
  const steps = viewerSteps(current);
  if (!steps.length) {
    notify('error', 'nothing to copy — that task is gone');
    return;
  }

  const text = steps.map((step) => step.data.replace(/\s+$/, '')).join('\n\n');
  void copyToClipboard(text).then((result) => {
    if (!result.ok) {
      notify('error', `copy failed: ${result.error}`);
      return;
    }
    const what = steps.length === 1 ? taskTitle(steps[0]!) : `${steps.length} steps`;
    notify('success', `copied ${what} (${text.length} chars)`);
  });
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
    case 'q':
      quit();
      return;
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
    case 'space': {
      const task = cursorTask.value;
      if (task) {
        toggleSelected(task.id);
        moveCursor(1);
      }
      return;
    }
    case 'escape':
      // The flyout is the outermost thing esc should shut, ahead of ticks.
      if (doneOpen.value) toggleDone();
      else {
        clearSelection();
        clearNotices();
      }
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

function handleMenu(key: Key, current: Extract<NonNullable<typeof overlay.value>, { kind: 'menu' }>): void {
  switch (key.name) {
    case 'escape':
    case 'q':
      overlay.value = null;
      return;
    case 'up':
    case 'k':
      overlay.value = { ...current, index: Math.max(0, current.index - 1) };
      return;
    case 'down':
    case 'j':
      overlay.value = { ...current, index: Math.min(current.items.length - 1, current.index + 1) };
      return;
    case 'return': {
      const item = current.items[current.index];
      overlay.value = null;
      void item?.run();
      return;
    }
    default: {
      const byKey = current.items.find((item) => item.key === key.name);
      if (byKey) {
        overlay.value = null;
        void byKey.run();
      }
    }
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
      // First esc drops the ticks, second closes — same as the board.
      if (current.picked.length) overlay.value = { ...current, picked: [] };
      else overlay.value = null;
      return;
    case 'q':
      overlay.value = null;
      return;
    case 'return':
      copyViewerSteps({ ...current, pick });
      return;
    case 'space': {
      const step = steps[pick];
      if (!step) return;
      const picked = current.picked.includes(step.id)
        ? current.picked.filter((id) => id !== step.id)
        : [...current.picked, step.id];
      const next = Math.min(pick + 1, Math.max(0, steps.length - 1));
      overlay.value = { ...current, picked, pick: next, scroll: scrollForStep(current, next) };
      return;
    }
    case 'a': {
      const all = steps.length > 0 && current.picked.length === steps.length;
      overlay.value = { ...current, pick, picked: all ? [] : steps.map((step) => step.id) };
      return;
    }
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
