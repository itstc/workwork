import { notices } from '../core/notify.ts';
import { runForTask, runs } from '../core/runner.ts';
import { done, incoming, working } from '../core/store.ts';
import type { Task, TaskState } from '../core/task.ts';
import { taskTitle } from '../core/task.ts';
import { feedStates, feeds } from '../feeds/index.ts';
import { fit, padStart, truncate, width } from './ansi.ts';
import { size } from './screen.ts';
import { PANES, cursorFor, focusIndex, selectedSet } from './state.ts';
import { ago, box, duration, spinner, stateColor, stateLabel, t } from './theme.ts';

const MIN_PANE = 26;
const ROW_HEIGHT = 2;

export function visiblePanes(cols: number): { panes: TaskState[]; widths: number[] } {
  let count = 3;
  if (cols < MIN_PANE * 3 + 2) count = 2;
  if (cols < MIN_PANE * 2 + 1) count = 1;

  // Slide the window so the focused pane is always on screen.
  const start = Math.min(Math.max(0, focusIndex.value - count + 1), PANES.length - count);
  const panes = PANES.slice(start, start + count);

  const gaps = count - 1;
  const usable = Math.max(count * 8, cols - gaps);
  const base = Math.floor(usable / count);
  const widths = panes.map((_, index) => base + (index < usable % count ? 1 : 0));

  return { panes, widths };
}

export function renderBoard(cols: number, height: number, tickValue: number): string[] {
  if (height < 3) return [];
  const { panes, widths } = visiblePanes(cols);

  const columns = panes.map((pane, index) =>
    renderPane(pane, widths[index] ?? MIN_PANE, height, tickValue),
  );

  const lines: string[] = [];
  for (let row = 0; row < height; row++) {
    lines.push(columns.map((column) => column[row] ?? '').join(' '));
  }
  return lines;
}

function listFor(pane: TaskState): Task[] {
  if (pane === 'incoming') return incoming.value;
  if (pane === 'working') return working.value;
  return done.value;
}

function renderPane(pane: TaskState, w: number, h: number, tickValue: number): string[] {
  const focused = PANES[focusIndex.value] === pane;
  const color = stateColor[pane];
  const border = focused ? color : t.border;
  const inner = Math.max(1, w - 4);

  const list = listFor(pane);
  const cursor = cursorFor(pane);
  const bodyHeight = Math.max(0, h - 2);
  const perPage = Math.max(1, Math.floor(bodyHeight / ROW_HEIGHT));

  // Keep the cursor inside the visible window without jumping around.
  const maxOffset = Math.max(0, list.length - perPage);
  const offset = Math.min(maxOffset, Math.max(0, cursor - Math.floor((perPage - 1) / 2)));
  const visible = list.slice(offset, offset + perPage);

  const lines: string[] = [];
  lines.push(paneHeader(pane, w, list.length, focused));

  const body: string[] = [];
  if (list.length === 0) {
    body.push(t.dim(emptyHint(pane)));
  } else {
    visible.forEach((task, index) => {
      const isCursor = focused && offset + index === cursor;
      const isSelected = selectedSet.value.has(task.id);
      body.push(...renderRow(task, inner, isCursor, isSelected, color, tickValue));
    });
  }

  for (let i = 0; i < bodyHeight; i++) {
    const content = body[i] ?? '';
    lines.push(border(box.v) + ' ' + fit(content, inner) + ' ' + border(box.v));
  }

  lines.push(paneFooter(w, border, offset, perPage, list.length));
  return lines;
}

function paneHeader(pane: TaskState, w: number, count: number, focused: boolean): string {
  const color = stateColor[pane];
  const border = focused ? color : t.border;
  const index = PANES.indexOf(pane) + 1;
  const name = stateLabel[pane];
  const label = ` ${t.dim(String(index))} ${focused ? color(name) : t.muted(name)} ${t.dim(String(count))} `;
  const fill = Math.max(0, w - 2 - width(label) - 1);
  return border(box.tl + box.h) + label + border(box.h.repeat(fill) + box.tr);
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
  return 'nothing completed yet';
}

export function headerLine(cols: number): string {
  const counts = [
    `${stateColor.incoming(String(incoming.value.length))} ${t.dim('incoming')}`,
    `${stateColor.working(String(working.value.length))} ${t.dim('working')}`,
    `${stateColor.done(String(done.value.length))} ${t.dim('done')}`,
  ].join(t.dim('  ·  '));

  const brand = `${t.title('workwork')} ${t.dim('·')} `;
  return fit(` ${brand}${counts}`, cols);
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
