import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { shellQuote } from '../core/args.ts';
import { exec, spawnDetached } from '../core/exec.ts';
import { stateDir } from '../core/persist.ts';
import type { Tool, ToolRun } from './types.ts';

const SHELL = process.env.SHELL ?? '/bin/zsh';
const GHOSTTY_BIN =
  process.env.WORKWORK_GHOSTTY_BIN ?? '/Applications/Ghostty.app/Contents/MacOS/ghostty';

/**
 * Hand a task off to a human: open a Ghostty tab that is already `cd`'d into the
 * right place with the task text printed at the top, then drop into an
 * interactive shell. The spawn is fire-and-forget — the task goes straight back
 * to the feed with a note about where it was sent.
 */
export const ghosttyTool: Tool = {
  id: 'ghostty',
  name: 'ghostty tab',
  description: 'Open a new Ghostty tab with the task loaded, to work by hand',
  key: 'g',
  accepts: 'one',
  input: {
    prompt: 'Working directory',
    placeholder: process.cwd(),
  },

  pre({ tasks, input }) {
    return { tasks: tasks.slice(0, 1), input: input.trim() || process.cwd() };
  },

  async run({ tasks, input }, ctx): Promise<ToolRun> {
    const task = tasks[0];
    if (!task) return { ok: false, output: 'no task', exitCode: null };

    const scriptPath = writeLauncher(task.id, task.data, input);
    ctx.log(`launcher: ${scriptPath}\n`);

    const strategies = buildStrategies(scriptPath, input);
    const transcript: string[] = [];

    for (const strategy of strategies) {
      ctx.log(`trying: ${strategy.label}\n`);
      const result = await strategy.attempt();
      transcript.push(`${strategy.label}: ${result.detail}`);
      if (result.ok) {
        return {
          ok: true,
          output: [`opened via ${strategy.label}`, `cwd: ${input}`, `script: ${scriptPath}`].join(
            '\n',
          ),
          exitCode: 0,
          meta: { strategy: strategy.label, cwd: input, script: scriptPath },
        };
      }
    }

    return {
      ok: false,
      output: ['could not open a Ghostty tab', ...transcript].join('\n'),
      exitCode: null,
      meta: { cwd: input, script: scriptPath },
    };
  },

  post({ tasks, input }, run) {
    const task = tasks[0];
    if (!task) return [];

    return [
      {
        parent: task.id,
        data: run.ok
          ? [`Handed off to a Ghostty tab in ${input}.`, '', run.output, '', task.data].join('\n')
          : run.output,
        source: 'tool:ghostty',
        state: 'incoming',
        meta: {
          title: run.ok ? `ghostty tab → ${input}` : 'ghostty tab failed',
          error: !run.ok,
          cwd: input,
        },
      },
    ];
  },
};

interface Strategy {
  label: string;
  attempt: () => Promise<{ ok: boolean; detail: string }>;
}

function buildStrategies(scriptPath: string, cwd: string): Strategy[] {
  const strategies: Strategy[] = [];

  // Escape hatch for anyone not on Ghostty: WORKWORK_TERMINAL_CMD is run with
  // the launcher script as its only argument.
  const override = process.env.WORKWORK_TERMINAL_CMD;
  if (override) {
    strategies.push({
      label: `WORKWORK_TERMINAL_CMD (${override})`,
      attempt: async () => {
        const { pid, error } = spawnDetached(SHELL, ['-lc', `${override} ${shellQuote(scriptPath)}`], { cwd });
        return { ok: pid !== undefined, detail: error ?? `pid ${pid}` };
      },
    });
  }

  if (process.platform === 'darwin') {
    // A real new *tab* in the running Ghostty window. Needs Accessibility
    // permission for whatever terminal workwork is running in.
    strategies.push({
      label: 'AppleScript new tab',
      attempt: async () => {
        const result = await exec('osascript', ['-e', appleScript(scriptPath)], {
          timeoutMs: 15_000,
        });
        return { ok: result.ok, detail: result.output.trim() || `exit ${result.exitCode}` };
      },
    });

    // No Accessibility permission? A new window still gets the work done.
    strategies.push({
      label: 'open -na Ghostty (new window)',
      attempt: async () => {
        const result = await exec(
          'open',
          ['-na', 'Ghostty', '--args', `--working-directory=${cwd}`, '-e', SHELL, '-lc', interactive(scriptPath)],
          { timeoutMs: 15_000 },
        );
        return { ok: result.ok, detail: result.output.trim() || `exit ${result.exitCode}` };
      },
    });
  }

  strategies.push({
    label: 'ghostty -e',
    attempt: async () => {
      const bin = process.platform === 'darwin' ? GHOSTTY_BIN : 'ghostty';
      const { pid, error } = spawnDetached(
        bin,
        [`--working-directory=${cwd}`, '-e', SHELL, '-lc', interactive(scriptPath)],
        { cwd },
      );
      return { ok: pid !== undefined, detail: error ?? `pid ${pid}` };
    },
  });

  return strategies;
}

/** Run the launcher, then hand the tab over to the user's interactive shell. */
function interactive(scriptPath: string): string {
  return `${shellQuote(scriptPath)}; exec ${shellQuote(SHELL)} -i`;
}

function appleScript(scriptPath: string): string {
  // `source` keeps the tab's own interactive shell alive afterwards, so the
  // user lands in a normal prompt in the right directory.
  const typed = `source ${shellQuote(scriptPath)}`.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return [
    'tell application "Ghostty" to activate',
    'delay 0.25',
    'tell application "System Events" to tell process "Ghostty"',
    '  keystroke "t" using command down',
    '  delay 0.4',
    `  keystroke "${typed}"`,
    '  key code 36',
    'end tell',
  ].join('\n');
}

function writeLauncher(taskId: string, data: string, cwd: string): string {
  const dir = join(stateDir, 'tabs');
  mkdirSync(dir, { recursive: true });

  const taskFile = join(dir, `${taskId}.txt`);
  writeFileSync(taskFile, `${data}\n`, 'utf8');

  const scriptPath = join(dir, `${taskId}.sh`);
  const script = [
    '#!/bin/sh',
    `cd ${shellQuote(cwd)} 2>/dev/null || true`,
    `export WORKWORK_TASK_ID=${shellQuote(taskId)}`,
    `export WORKWORK_TASK_FILE=${shellQuote(taskFile)}`,
    `printf '\\033[1;35m── workwork task ─────────────────────────────\\033[0m\\n'`,
    `cat ${shellQuote(taskFile)}`,
    `printf '\\033[1;35m──────────────────────────────────────────────\\033[0m\\n'`,
    `printf 'task text is also in $WORKWORK_TASK_FILE\\n\\n'`,
    '',
  ].join('\n');
  writeFileSync(scriptPath, script, { mode: 0o755 });

  return scriptPath;
}
