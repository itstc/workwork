import { splitArgs } from '../core/args.ts';
import { exec } from '../core/exec.ts';
import type { Tool } from './types.ts';

const DEFAULT_ARGS = 'status --short --branch';

/**
 * Run a git command against a repo and staple the output onto the task(s).
 * Works on a multi-selection: one process, one result per task, so a batch of
 * related items all pick up the same snapshot.
 */
export const gitTool: Tool = {
  id: 'git',
  name: 'git',
  description: 'Run a git command and attach the output to the task(s)',
  key: 'i',
  accepts: 'many',
  input: {
    prompt: 'git arguments',
    placeholder: DEFAULT_ARGS,
  },

  pre({ tasks, input }) {
    const cleaned = input.trim().replace(/^git\s+/, '') || DEFAULT_ARGS;
    return { tasks, input: cleaned };
  },

  async run({ tasks, input }, ctx) {
    // A task can carry its own repo — a feed, or an earlier git run in the chain.
    const cwd =
      (typeof tasks[0]?.meta.cwd === 'string' ? (tasks[0].meta.cwd as string) : undefined) ??
      process.env.WORKWORK_GIT_CWD ??
      process.cwd();

    const args = splitArgs(input);
    ctx.log(`$ git ${args.join(' ')}   (${cwd})\n`);

    const result = await exec('git', args, {
      cwd,
      signal: ctx.signal,
      timeoutMs: 2 * 60 * 1000,
      onOutput: ctx.log,
    });

    return {
      ok: result.ok,
      output: result.output.trim() || '(no output)',
      exitCode: result.exitCode,
      meta: { cwd, args: `git ${input}` },
    };
  },

  post({ tasks, input }, run) {
    const header = `$ git ${input}`;
    return tasks.map((task) => ({
      parent: task.id,
      data: [header, '', run.output].join('\n'),
      source: 'tool:git',
      state: 'incoming' as const,
      meta: {
        title: `git ${input}${run.ok ? '' : ` (exit ${run.exitCode ?? '?'})`}`,
        error: !run.ok,
        exit_code: run.exitCode,
        cwd: run.meta?.cwd,
      },
    }));
  },
};
