import chalk from 'chalk';
import { runForTask } from '../core/runner.ts';
import { getTask } from '../core/store.ts';
import type { Task } from '../core/task.ts';
import { chainOf, taskTitle } from '../core/task.ts';
import { fit, truncate, width, wrap } from './ansi.ts';
import type { Overlay } from './state.ts';
import { ago, box, duration, stateColor, t } from './theme.ts';

/** Bottom-anchored panels replace whole rows, so nothing needs compositing. */
export function panelHeight(overlay: Overlay, cols: number): number {
  if (overlay.kind === 'menu') return overlay.items.length + 4;
  if (overlay.kind === 'prompt') return overlay.hint ? 6 : 5;
  void cols;
  return 0;
}

export function renderPanel(overlay: Overlay, cols: number): string[] {
  if (overlay.kind === 'menu') return renderMenu(overlay, cols);
  if (overlay.kind === 'prompt') return renderPrompt(overlay, cols);
  return [];
}

function panelBox(title: string, body: string[], cols: number): string[] {
  const inner = Math.max(4, cols - 4);
  const heading = ` ${t.accent(title)} `;
  const fill = Math.max(0, cols - 2 - width(heading));

  const lines = [t.accent(box.tl + box.h) + heading + t.accent(box.h.repeat(fill - 1) + box.tr)];
  for (const row of body) {
    lines.push(t.accent(box.v) + ' ' + fit(row, inner) + ' ' + t.accent(box.v));
  }
  lines.push(t.accent(box.bl + box.h.repeat(cols - 2) + box.br));
  return lines;
}

function renderMenu(
  overlay: Extract<Overlay, { kind: 'menu' }>,
  cols: number,
): string[] {
  const inner = Math.max(4, cols - 4);
  const body = overlay.items.map((item, index) => {
    const active = index === overlay.index;
    const marker = active ? t.accent('▸') : ' ';
    const key = t.key(`[${item.key}]`);
    const label = active ? t.text(item.label) : t.muted(item.label);
    const head = `${marker} ${key} ${label}`;
    const room = inner - width(head) - 2;
    const description = room > 8 ? `  ${t.dim(truncate(item.description, room))}` : '';
    const line = `${head}${description}`;
    return active ? t.cursor(fit(line, inner)) : line;
  });

  if (overlay.subtitle) body.unshift(t.dim(overlay.subtitle));
  body.push(t.dim('↑↓ choose · ⏎ run · esc cancel'));
  return panelBox(overlay.title, body, cols);
}

function renderPrompt(
  overlay: Extract<Overlay, { kind: 'prompt' }>,
  cols: number,
): string[] {
  const inner = Math.max(4, cols - 4);
  const body: string[] = [];
  if (overlay.hint) body.push(t.dim(overlay.hint));

  const value = overlay.value;
  const caret = Math.min(overlay.caret, value.length);
  // Keep the caret in view on a long line.
  const room = inner - 2;
  const start = Math.max(0, caret - room + 1);
  const slice = value.slice(start, start + room);
  const local = caret - start;

  const before = slice.slice(0, local);
  const at = slice[local] ?? ' ';
  const after = slice.slice(local + 1);
  const shown = value.length === 0 && !overlay.value
    ? chalk.inverse(' ')
    : `${t.text(before)}${chalk.inverse(at)}${t.text(after)}`;

  body.push(`${t.accent('❯')} ${shown}`);
  body.push(t.dim('⏎ submit · esc cancel · ^u clear'));
  return panelBox(overlay.title, body, cols);
}

/**
 * The task viewer: the whole chain, root to tail, so you can see a slack
 * message become a claude run become a terminal hand-off become a test run.
 */
export function renderViewer(
  overlay: Extract<Overlay, { kind: 'viewer' }>,
  cols: number,
  rows: number,
): { lines: string[]; total: number } {
  const task = getTask(overlay.taskId);
  if (!task) return { lines: [t.error(' task no longer exists')], total: 1 };

  const chain = chainOf(task, getTask);
  const inner = Math.max(20, cols - 4);
  const content: string[] = [];

  content.push('');
  content.push(` ${t.title(truncate(taskTitle(chain[chain.length - 1] ?? task), inner))}`);
  content.push(
    ` ${t.dim(`${chain.length} step${chain.length === 1 ? '' : 's'} · chain ${short(chain[0]?.id ?? '')} → ${short(task.id)}`)}`,
  );
  content.push('');

  chain.forEach((node, index) => {
    const isCurrent = node.id === task.id;
    const isTail = index === chain.length - 1;
    const color = stateColor[node.state];
    const bullet = isCurrent ? color('●') : t.dim('○');
    const stem = isTail ? ' ' : t.dim(box.v);

    const meta = [
      t.accent(node.source),
      t.dim(new Date(node.created_at).toLocaleString()),
      t.dim(`${ago(node.created_at)} ago`),
      typeof node.meta.duration_ms === 'number' ? t.dim(duration(node.meta.duration_ms)) : '',
      node.meta.error ? t.error('failed') : '',
      isTail ? color(`[${node.state}]`) : '',
    ]
      .filter(Boolean)
      .join(t.dim(' · '));

    content.push(` ${bullet} ${meta}`);
    content.push(` ${stem} ${t.dim(`id ${short(node.id)}${node.prev ? ` ← ${short(node.prev)}` : ''}`)}`);

    for (const line of wrap(node.data, inner - 4)) {
      content.push(` ${stem}   ${isCurrent ? t.text(line) : t.muted(line)}`);
    }

    const extras = extraMeta(node);
    if (extras.length) {
      content.push(` ${stem}`);
      for (const line of extras) content.push(` ${stem}   ${t.dim(line)}`);
    }

    const run = runForTask(node.id);
    if (run) {
      content.push(` ${stem}`);
      content.push(` ${stem}   ${t.warn(`▸ ${run.toolName} running — live output`)}`);
      for (const line of wrap(run.log.slice(-4000), inner - 4).slice(-40)) {
        content.push(` ${stem}   ${t.dim(line)}`);
      }
    }

    if (!isTail) content.push(` ${t.dim(box.v)}`);
  });

  content.push('');

  const viewport = Math.max(1, rows);
  const maxScroll = Math.max(0, content.length - viewport);
  const scroll = Math.min(overlay.scroll, maxScroll);
  return { lines: content.slice(scroll, scroll + viewport), total: content.length };
}

function extraMeta(task: Task): string[] {
  const skip = new Set(['title', 'via', 'error', 'duration_ms', 'prompt', 'seq']);
  return Object.entries(task.meta)
    .filter(([key, value]) => !skip.has(key) && value !== undefined && value !== null)
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

function short(id: string): string {
  return id.slice(0, 8);
}

export function renderHelp(cols: number, rows: number): string[] {
  const sections: [string, [string, string][]][] = [
    [
      'move',
      [
        ['↑ ↓ / j k', 'move within a pane'],
        ['← → / h l / tab', 'switch pane'],
        ['1 2 3', 'jump to incoming / working / done'],
        ['g G', 'top / bottom'],
      ],
    ],
    [
      'tasks',
      [
        ['n', 'new task (manual feed)'],
        ['⏎', 'open the task viewer — full chain history'],
        ['space', 'add to multi-selection'],
        ['esc', 'clear selection / close overlay'],
        ['d', 'mark complete'],
        ['u', 'send back to the incoming feed'],
        ['x', 'cancel a running tool, or delete the chain'],
      ],
    ],
    [
      'work',
      [
        ['r', 'run a tool on the task(s)'],
        ['c', 'claude — pipe the task into claude -p'],
        ['g (in tools)', 'ghostty — open a tab to work by hand'],
        ['i (in tools)', 'git — run a git command against the task'],
        ['f', 'feeds — start/stop data sources'],
      ],
    ],
    [
      'other',
      [
        ['?', 'this help'],
        ['q / ^c', 'quit (state is saved)'],
      ],
    ],
  ];

  const lines: string[] = ['', ` ${t.title('workwork')} ${t.dim('— keys')}`, ''];
  for (const [heading, entries] of sections) {
    lines.push(` ${t.accent(heading)}`);
    for (const [keyName, label] of entries) {
      lines.push(`   ${t.key(keyName.padEnd(16))} ${t.muted(label)}`);
    }
    lines.push('');
  }
  lines.push(` ${t.dim('tasks live in ~/.workwork/state.json — nothing is lost if this process dies')}`);

  return lines.slice(0, rows).map((line) => fit(line, cols));
}
