import { exec } from '../core/exec.ts';
import { taskTitle } from '../core/task.ts';
import type { Tool } from './types.ts';

const HERDR_BIN = process.env.WORKWORK_HERDR_BIN ?? 'herdr';

/**
 * Hand a task off to a human: ask herdr for a new tab, labelled with whatever
 * the user typed (or the task title, if they typed nothing).
 */
export const herdrTool: Tool = {
  id: 'herdr',
  name: 'herdr tab',
  description: 'Create a herdr tab for the task, to work by hand',
  key: 'g',
  accepts: 'one',
  input: {
    prompt: 'Tab name',
  },

  pre({ tasks, input }) {
    const task = tasks[0];
    return {
      tasks: tasks.slice(0, 1),
      input: input.trim() || (task ? taskTitle(task) : ''),
    };
  },

  async run({ input }, ctx) {
    ctx.log(`$ ${HERDR_BIN} tab create --label ${input}\n`);

    const result = await exec(HERDR_BIN, ['tab', 'create', '--label', input], {
      signal: ctx.signal,
      timeoutMs: 30_000,
      onOutput: ctx.log,
    });

    return {
      ok: result.ok,
      output: result.output.trim() || '(no output)',
      exitCode: result.exitCode,
      meta: { label: input },
    };
  },

  post({ tasks, input }, run) {
    const task = tasks[0];
    if (!task) return [];

    return [
      {
        parent: task.id,
        data: run.ok
          ? [`Handed off to herdr tab "${input}".`, '', task.data].join('\n')
          : run.output,
        source: 'tool:herdr',
        state: 'incoming',
        meta: {
          title: run.ok ? `herdr tab → ${input}` : 'herdr tab failed',
          error: !run.ok,
          exit_code: run.exitCode,
          label: input,
        },
      },
    ];
  },
};
