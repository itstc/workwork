import { notices } from '../core/notify.ts';
import { runForTask, runs } from '../core/runner.ts';
import { done, getTask, incoming, working } from '../core/store.ts';
import type { Task, TaskState } from '../core/task.ts';
import { chainOf, taskTitle } from '../core/task.ts';
import { feedStates, feeds } from '../feeds/index.ts';
import { fit, padStart, truncate, width, wrap } from './ansi.ts';
import {
  BOARD_PANES,
  cursorFor,
  cursorTask,
  doneOpen,
  focusedPane,
  selectedSet,
  selectedTasks,
} from './state.ts';
import { ago, box, duration, spinner, stateColor, stateLabel, stateShort, t } from './theme.ts';

const MIN_LIST = 18;
const MIN_DETAIL = 28;
const ROW_HEIGHT = 2;
const DETAIL_LABEL = 'TASK DETAIL';

/** Which key jumps to a pane — also the number printed in its header. */
const PANE_KEY: Record<TaskState, string> = { incoming: '1', working: '2', done: '3' };

type Column =
  | { kind: 'list'; pane: TaskState; width: number }
  | { kind: 'detail'; width: number };

/**
 * The board is a 1 : 3 : 1 grid — incoming feed, the detail of whatever is
 * under the cursor, working pool. Narrow terminals drop the far column, then
 * the detail, rather than squeezing all three into unreadable strips.
 */
export function boardColumns(cols: number): Column[] {
  const focus = focusedPane.value;
  // The flyout is not a column; while it is up the board keeps its last shape.
  const single: TaskState = focus === 'done' ? 'incoming' : focus;

  const three = cols - 2;
  const lists = Math.max(Math.floor(three / 5), MIN_LIST);
  if (three - lists * 2 >= MIN_DETAIL) {
    return [
      { kind: 'list', pane: 'incoming', width: lists },
      { kind: 'detail', width: three - lists * 2 },
      { kind: 'list', pane: 'working', width: lists },
    ];
  }

  const two = cols - 1;
  const list = Math.max(Math.floor(two / 4), MIN_LIST);
  if (two - list >= MIN_DETAIL) {
    return [
      { kind: 'list', pane: single, width: list },
      { kind: 'detail', width: two - list },
    ];
  }

  return [{ kind: 'list', pane: single, width: cols }];
}

export function renderBoard(cols: number, height: number, tickValue: number): string[] {
  if (height < 3) return [];
  const columns = boardColumns(cols);

  const rendered = columns.map((column) =>
    column.kind === 'list'
      ? renderList(column.pane, column.width, height, tickValue)
      : renderDetail(column.width, height, tickValue),
  );

  // The completed flyout drops out of the header button over the left column.
  const first = columns[0];
  if (doneOpen.value && first) {
    const flyout = renderFlyout(first.width, height, tickValue);
    const blank = ' '.repeat(first.width);
    // Cover the column outright — a half-hidden box under the flyout reads as a
    // rendering bug, and the feed's count is still in the header.
    rendered[0] = Array.from({ length: height }, (_, index) => flyout[index] ?? blank);
  }

  const lines: string[] = [];
  for (let row = 0; row < height; row++) {
    lines.push(rendered.map((column) => column[row] ?? '').join(' '));
  }
  return lines;
}

function listFor(pane: TaskState): Task[] {
  if (pane === 'incoming') return incoming.value;
  if (pane === 'working') return working.value;
  return done.value;
}

function renderList(pane: TaskState, w: number, h: number, tickValue: number): string[] {
  const focused = focusedPane.value === pane;
  const color = stateColor[pane];
  const border = focused ? color : t.border;
  const inner = Math.max(1, w - 4);

  const list = listFor(pane);
  const bodyHeight = Math.max(0, h - 2);
  const { visible, offset, perPage } = windowOf(pane, list, bodyHeight);

  const body: string[] = [];
  if (list.length === 0) {
    body.push(t.dim(emptyHint(pane)));
  } else {
    visible.forEach((task, index) => {
      const isCursor = focused && offset + index === cursorFor(pane);
      body.push(...renderRow(task, inner, isCursor, selectedSet.value.has(task.id), color, tickValue));
    });
  }

  const lines = [paneHeader(pane, w, list.length, focused)];
  for (let i = 0; i < bodyHeight; i++) {
    lines.push(border(box.v) + ' ' + fit(body[i] ?? '', inner) + ' ' + border(box.v));
  }
  lines.push(paneFooter(w, border, offset, perPage, list.length));
  return lines;
}

/** Keep the cursor inside the visible window without jumping around. */
function windowOf(
  pane: TaskState,
  list: Task[],
  bodyHeight: number,
): { visible: Task[]; offset: number; perPage: number } {
  const perPage = Math.max(1, Math.floor(bodyHeight / ROW_HEIGHT));
  const cursor = cursorFor(pane);
  const maxOffset = Math.max(0, list.length - perPage);
  const offset = Math.min(maxOffset, Math.max(0, cursor - Math.floor((perPage - 1) / 2)));
  return { visible: list.slice(offset, offset + perPage), offset, perPage };
}

/**
 * Completed tasks are a flyout, not a column: it hangs off the header button,
 * only as deep as it needs, over whatever the left column is showing.
 */
function renderFlyout(w: number, boardHeight: number, tickValue: number): string[] {
  const color = stateColor.done;
  const inner = Math.max(1, w - 4);
  const list = done.value;

  const wanted = 2 + Math.max(1, list.length * ROW_HEIGHT);
  const h = Math.min(boardHeight, Math.max(7, wanted));
  const bodyHeight = Math.max(1, h - 2);
  const { visible, offset, perPage } = windowOf('done', list, bodyHeight);

  const body: string[] = [];
  if (list.length === 0) {
    body.push(t.dim(emptyHint('done')));
  } else {
    visible.forEach((task, index) => {
      const isCursor = offset + index === cursorFor('done');
      body.push(...renderRow(task, inner, isCursor, selectedSet.value.has(task.id), color, tickValue));
    });
  }

  const name = w - 5 >= width(`▾ ${stateLabel.done} ${list.length}`) ? stateLabel.done : stateShort.done;
  const lines = [boxHeader(w, color, `${color(`▾ ${name}`)} ${t.dim(String(list.length))}`)];
  for (let i = 0; i < bodyHeight; i++) {
    lines.push(color(box.v) + ' ' + fit(body[i] ?? '', inner) + ' ' + color(box.v));
  }
  lines.push(paneFooter(w, color, offset, perPage, list.length));
  return lines;
}

/**
 * The middle column: everything about the task under the cursor, so the board
 * is readable without opening the viewer. `⏎` still opens the whole chain.
 */
function renderDetail(w: number, h: number, tickValue: number): string[] {
  const inner = Math.max(1, w - 4);
  const bodyHeight = Math.max(0, h - 2);
  const task = cursorTask.value;
  const picked = selectedTasks.value;
  const body: string[] = [];
  /** Live tool output — kept out of `body` so trimming cannot swallow it. */
  const tail: string[] = [];

  if (task) {
    const color = stateColor[task.state];
    const chain = chainOf(task, getTask);

    for (const line of wrap(taskTitle(task), inner).slice(0, 2)) body.push(t.title(line));
    body.push(
      [
        color(`[${task.state}]`),
        t.source(task.source),
        t.dim(`${ago(task.created_at)} ago`),
        t.dim(`${chain.length} step${chain.length === 1 ? '' : 's'}`),
        task.meta.error ? t.error('failed') : '',
      ]
        .filter(Boolean)
        .join(t.dim(' · ')),
    );

    if (picked.length > 1) {
      body.push('');
      body.push(t.accent(`✓ ${picked.length} selected — r runs a tool on all of them`));
      for (const other of picked.slice(0, 3)) {
        body.push(`  ${t.muted(truncate(taskTitle(other), inner - 2))}`);
      }
      if (picked.length > 3) body.push(t.dim(`  +${picked.length - 3} more`));
    }

    body.push('');
    for (const line of wrap(task.data.replace(/\s+$/, ''), inner)) body.push(t.text(line));

    const extras = detailMeta(task);
    if (extras.length) {
      body.push('');
      for (const line of extras) body.push(t.dim(truncate(line, inner)));
    }

    const run = runForTask(task.id);
    if (run) {
      // A live tool keeps its slice of the panel: the newest output is the whole
      // point, so it is budgeted before the static text is trimmed to fit.
      const spent = Math.min(body.length, Math.max(0, bodyHeight - 4));
      const budget = Math.max(1, bodyHeight - spent - 2);
      tail.push(
        '',
        `${color(spinner(tickValue))} ${t.warn(run.toolName)} ${t.dim(duration(Date.now() - run.startedAt))} ${t.dim('live')}`,
      );
      for (const line of wrap(run.log.slice(-4000), inner).slice(-budget)) tail.push(t.dim(line));
    }
  } else {
    body.push(t.dim(focusedPane.value === 'done' ? 'nothing completed yet' : 'nothing selected'));
  }

  const room = Math.max(1, bodyHeight - tail.length);
  const hidden = Math.max(0, body.length - room);
  const shown =
    hidden > 0
      ? [
          ...body.slice(0, Math.max(0, room - 1)),
          t.dim(truncate(`↓ ${hidden + 1} more lines — ⏎ for the full chain`, inner)),
          ...tail,
        ]
      : [...body, ...tail];

  const lines = [boxHeader(w, t.border, t.muted(w - 5 >= DETAIL_LABEL.length ? DETAIL_LABEL : 'DETAIL'))];
  for (let i = 0; i < bodyHeight; i++) {
    lines.push(t.border(box.v) + ' ' + fit(shown[i] ?? '', inner) + ' ' + t.border(box.v));
  }
  lines.push(t.border(box.bl + box.h.repeat(Math.max(0, w - 2)) + box.br));
  return lines;
}

function detailMeta(task: Task): string[] {
  const skip = new Set(['title', 'error', 'seq']);
  return Object.entries(task.meta)
    .filter(([key, value]) => !skip.has(key) && value !== undefined && value !== null)
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

/**
 * A titled top border of exactly `w` columns. The title is truncated rather
 * than allowed to push the border past the column and shove the grid sideways.
 */
function boxHeader(w: number, border: (text: string) => string, title: string): string {
  const room = Math.max(0, w - 5);
  if (room === 0) return border(box.tl + box.h.repeat(Math.max(0, w - 2)) + box.tr);
  const label = truncate(title, room);
  const fill = Math.max(0, room - width(label));
  return border(box.tl + box.h) + ` ${label} ` + border(box.h.repeat(fill) + box.tr);
}

function paneHeader(pane: TaskState, w: number, count: number, focused: boolean): string {
  const color = stateColor[pane];
  const border = focused ? color : t.border;
  // Drop to the short label before letting the title get chopped mid-word —
  // measured against the longest label so the two columns stay symmetrical.
  const longest = Math.max(...BOARD_PANES.map((other) => stateLabel[other].length));
  const needed = 3 + longest + String(count).length;
  const name = w - 5 >= needed ? stateLabel[pane] : stateShort[pane];
  const title = `${t.dim(PANE_KEY[pane])} ${focused ? color(name) : t.muted(name)} ${t.dim(String(count))}`;
  return boxHeader(w, border, title);
}

function paneFooter(
  w: number,
  border: (text: string) => string,
  offset: number,
  perPage: number,
  total: number,
): string {
  const hidden = total - Math.min(total, offset + perPage);
  const note =
    offset > 0 || hidden > 0
      ? ` ${t.dim(`${offset > 0 ? `↑${offset}` : ''}${offset > 0 && hidden > 0 ? ' ' : ''}${hidden > 0 ? `↓${hidden}` : ''}`)} `
      : '';
  const fill = Math.max(0, w - 2 - width(note));
  return border(box.bl + box.h.repeat(fill)) + note + border(box.br);
}

function renderRow(
  task: Task,
  inner: number,
  isCursor: boolean,
  isSelected: boolean,
  color: (text: string) => string,
  tickValue: number,
): string[] {
  const marker = isCursor ? color('▸') : isSelected ? t.accent('✓') : ' ';
  const title = taskTitle(task);
  const titleText = isCursor ? t.text(truncate(title, inner - 2)) : t.muted(truncate(title, inner - 2));
  const head = `${marker} ${titleText}`;

  const run = task.state === 'working' ? runForTask(task.id) : undefined;
  let detail: string;

  if (run) {
    const elapsed = duration(Date.now() - run.startedAt);
    const tail = lastLogLine(run.log);
    const left = `${color(spinner(tickValue))} ${t.warn(run.toolName)} ${t.dim(elapsed)}`;
    const room = inner - 2 - width(left) - 1;
    detail = room > 6 && tail ? `${left} ${t.dim(truncate(tail, room))}` : left;
  } else {
    const left = `${t.source(task.source)} ${t.dim('·')} ${t.dim(ago(task.created_at))}`;
    const flag = task.meta.error ? t.error('failed') : task.meta.recovered_at ? t.warn('recovered') : '';
    const room = inner - 2 - width(left);
    detail = flag && room > width(flag) + 1 ? `${left}${padStart(flag, room)}` : left;
  }

  const body = `  ${detail}`;
  return isCursor
    ? [t.cursor(fit(head, inner)), t.cursor(fit(body, inner))]
    : [head, body];
}

function lastLogLine(log: string): string {
  const lines = log.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

function emptyHint(pane: TaskState): string {
  if (pane === 'incoming') return 'nothing incoming — press n to add a task, f for feeds';
  if (pane === 'working') return 'idle — press r on a task to run a tool';
  return 'nothing completed yet — d marks a task done';
}

export function headerLine(cols: number): string {
  const open = doneOpen.value;
  const count = done.value.length;
  // The done button lives top-left and is what opens the completed flyout.
  const button = open
    ? t.cursor(` ${stateColor.done(`▾ done ${count}`)} ${t.dim('[esc]')} `)
    : ` ${t.dim('▸')} ${t.muted('done')} ${stateColor.done(String(count))} ${t.key('[3]')} `;

  const counts = [
    `${stateColor.incoming(String(incoming.value.length))} ${t.dim('incoming')}`,
    `${stateColor.working(String(working.value.length))} ${t.dim('working')}`,
  ].join(t.dim('  ·  '));

  return fit(` ${t.title('workwork')} ${button} ${t.dim('·')}  ${counts}`, cols);
}

export function statusLine(cols: number): string {
  const running = Object.values(runs.value).length;
  const parts = feeds.map((feed) => {
    const state = feedStates.value[feed.id];
    const dot = state?.running ? t.success('●') : feed.interactive ? t.muted('○') : t.dim('○');
    const status = state?.running ? t.dim(`(${state.status})`) : '';
    return `${dot} ${t.muted(feed.name)}${status ? ` ${status}` : ''}`;
  });

  const left = ` ${t.dim('feeds')} ${parts.join(t.dim('  '))}`;
  const right = running > 0 ? `${t.warn(`${running} running`)} ` : '';
  const gap = Math.max(0, cols - width(left) - width(right));
  return left + ' '.repeat(gap) + right;
}

export function noticeLine(cols: number): string {
  const all = notices.value;
  const latest = all[all.length - 1];
  if (!latest) return '';

  const icon = latest.level === 'error' ? t.error('✖') : latest.level === 'success' ? t.success('✔') : t.accent('•');
  const paint = latest.level === 'error' ? t.error : latest.level === 'success' ? t.success : t.text;
  const extra = all.length > 1 ? t.dim(` (+${all.length - 1})`) : '';
  return fit(` ${icon} ${paint(latest.text)}${extra}`, cols);
}

export function footerLine(cols: number, hints: [string, string][]): string {
  const rendered = hints.map(([keyName, label]) => `${t.key(keyName)} ${t.dim(label)}`).join(t.dim('  '));
  return fit(` ${rendered}`, cols);
}

export function ruleLine(cols: number, label = ''): string {
  const text = label ? ` ${label} ` : '';
  const fill = Math.max(0, cols - width(text) - 1);
  return t.border(box.h.repeat(1)) + (label ? t.muted(text) : '') + t.border(box.h.repeat(fill));
}
