import chalk from 'chalk';
import { runForTask } from '../core/runner.ts';
import { getTask } from '../core/store.ts';
import type { Task } from '../core/task.ts';
import { chainOf, taskTitle } from '../core/task.ts';
import { fit, truncate, width, wrap } from './ansi.ts';
import type { Overlay, ViewerOverlay } from './state.ts';
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

/** Where a chain step starts and ends in the rendered content, for scrolling. */
export interface StepAnchor {
  id: string;
  start: number;
  /** Exclusive. */
  end: number;
}

export interface ViewerRender {
  lines: string[];
  total: number;
  steps: StepAnchor[];
}

/**
 * The task viewer: the whole chain, root to tail, so you can see a slack
 * message become a claude run become a terminal hand-off become a test run.
 * Steps carry a cursor and tick marks — see `copyViewerSteps` in app.ts.
 */
export function renderViewer(overlay: ViewerOverlay, cols: number, rows: number): ViewerRender {
  const task = getTask(overlay.taskId);
  if (!task) return { lines: [t.error(' task no longer exists')], total: 1, steps: [] };

  const chain = chainOf(task, getTask);
  const inner = Math.max(20, cols - 4);
  const picked = new Set(overlay.picked);
  const pick = Math.min(Math.max(0, overlay.pick), Math.max(0, chain.length - 1));
  const content: string[] = [];
  const steps: StepAnchor[] = [];

  const heading = [
    `${chain.length} step${chain.length === 1 ? '' : 's'}`,
    `chain ${short(chain[0]?.id ?? '')} → ${short(task.id)}`,
    picked.size ? `${picked.size} selected` : '',
  ].filter(Boolean);

  content.push('');
  content.push(` ${t.title(truncate(taskTitle(chain[chain.length - 1] ?? task), inner))}`);
  content.push(` ${t.dim(heading.join(' · '))}`);
  content.push('');

  chain.forEach((node, index) => {
    const isCursor = index === pick;
    const isPicked = picked.has(node.id);
    const isCurrent = node.id === task.id;
    const isTail = index === chain.length - 1;
    const color = stateColor[node.state];
    // Arrow column is the cursor, bullet column doubles as the tick box.
    const bullet = isPicked ? color('✓') : isCurrent ? color('●') : t.dim('○');
    const stem = isTail ? ' ' : t.dim(box.v);
    // Two extra columns of gutter hold the cursor/tick marker.
    const lead = `  ${stem}`;
    const start = content.length;

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

    const marker = isCursor ? t.accent('▸') : ' ';
    const head = ` ${marker} ${bullet} ${meta}`;
    content.push(isCursor ? t.cursor(fit(head, Math.max(1, cols - 1))) : head);
    content.push(`${lead} ${t.dim(`id ${short(node.id)}${node.prev ? ` ← ${short(node.prev)}` : ''}`)}`);

    const paint = isCursor || isPicked || isCurrent ? t.text : t.muted;
    for (const line of wrap(node.data, inner - 4)) {
      content.push(`${lead}   ${paint(line)}`);
    }

    const extras = extraMeta(node);
    if (extras.length) {
      content.push(lead);
      for (const line of extras) content.push(`${lead}   ${t.dim(line)}`);
    }

    const run = runForTask(node.id);
    if (run) {
      content.push(lead);
      content.push(`${lead}   ${t.warn(`▸ ${run.toolName} running — live output`)}`);
      for (const line of wrap(run.log.slice(-4000), inner - 4).slice(-40)) {
        content.push(`${lead}   ${t.dim(line)}`);
      }
    }

    steps.push({ id: node.id, start, end: content.length });
    if (!isTail) content.push(`  ${t.dim(box.v)}`);
  });

  content.push('');

  const viewport = Math.max(1, rows);
  const maxScroll = Math.max(0, content.length - viewport);
  const scroll = Math.min(Math.max(0, overlay.scroll), maxScroll);
  return { lines: content.slice(scroll, scroll + viewport), total: content.length, steps };
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
        ['← → / h l / tab', 'switch pane — incoming ⇄ working'],
        ['1 2', 'jump to incoming / working'],
        ['3', 'open the completed flyout (esc closes it)'],
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
      'viewer',
      [
        ['↑ ↓ / j k', 'move between steps of the chain'],
        ['space', 'tick a step'],
        ['⏎', 'copy ticked steps (or the one under the cursor) to the clipboard'],
        ['pgup pgdn', 'scroll a long step'],
        ['a', 'tick every step'],
        ['esc', 'clear ticks / close'],
      ],
    ],
    [
      'work',
      [
        ['r', 'run a tool on the task(s)'],
        ['c', 'claude — type a message; the reply comes back to the feed'],
        ['g (in tools)', 'herdr — create a tab to work by hand'],
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
