import { exec } from '../core/exec.ts';
import type { Tool } from './types.ts';

/** The shell the command is handed to. `-c` is the one flag we rely on. */
const SHELL = process.env.WORKWORK_BASH_SHELL ?? process.env.SHELL ?? '/bin/bash';
const TIMEOUT_MS = Number(process.env.WORKWORK_BASH_TIMEOUT_MS ?? 10 * 60 * 1000);
/** A command can be a paragraph; a task title cannot. */
const TITLE_LIMIT = 60;

function firstLine(command: string): string {
  const line = command.trim().split('\n')[0] ?? '';
  return line.length > TITLE_LIMIT ? `${line.slice(0, TITLE_LIMIT - 1)}…` : line;
}

/**
 * Run a shell command to completion and staple its transcript onto the task(s).
 *
 * The command goes to the shell whole rather than as argv, so pipes,
 * redirects and `&&` work the way they do when you type them. One process, one
 * result per task, so a batch handed in together all pick up the same output.
 */
export const bashTool: Tool = {
  id: 'bash',
  name: 'bash',
  description: 'Run a shell command and attach the output to the task(s)',
  input: {
    prompt: 'Shell command',
    placeholder: 'git status --short --branch',
    required: true,
  },

  pre({ tasks, input }) {
    return { tasks, input: input.trim() };
  },

  async run({ tasks, input }, ctx) {
    // A task can carry its own directory — a feed, or an earlier run in the chain.
    const cwd =
      (typeof tasks[0]?.meta.cwd === 'string' ? (tasks[0].meta.cwd as string) : undefined) ??
      process.env.WORKWORK_BASH_CWD ??
      process.cwd();

    ctx.log(`$ ${input}   (${cwd})\n`);

    const result = await exec(SHELL, ['-c', input], {
      cwd,
      signal: ctx.signal,
      timeoutMs: TIMEOUT_MS,
      onOutput: ctx.log,
    });

    return {
      ok: result.ok,
      output: result.output.trim() || '(no output)',
      exitCode: result.exitCode,
      meta: { cwd, command: input },
    };
  },

  post({ tasks, input }, run) {
    const header = `$ ${input}`;
    return tasks.map((task) => ({
      parent: task.id,
      data: [header, '', run.output].join('\n'),
      source: 'tool:bash',
      state: 'incoming' as const,
      meta: {
        title: `${firstLine(input)}${run.ok ? '' : ` (exit ${run.exitCode ?? '?'})`}`,
        error: !run.ok,
        exit_code: run.exitCode,
        cwd: run.meta?.cwd,
      },
    }));
  },
};
