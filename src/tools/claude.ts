import { splitArgs } from '../core/args.ts';
import { exec } from '../core/exec.ts';
import type { Tool } from './types.ts';

const BIN = process.env.WORKWORK_CLAUDE_BIN ?? 'claude';
const EXTRA_ARGS = splitArgs(process.env.WORKWORK_CLAUDE_ARGS ?? '');
const TIMEOUT_MS = Number(process.env.WORKWORK_CLAUDE_TIMEOUT_MS ?? 10 * 60 * 1000);

const DEFAULT_INSTRUCTION =
  'Work this item. Explain what you did and what still needs a human, concisely.';

/**
 * Pipe a task into `claude -p` and bring the answer back as the next link in
 * the chain. Non-interactive on purpose so it can sit in the working pool while
 * the rest of the board stays usable.
 */
export const claudeTool: Tool = {
  id: 'claude',
  name: 'claude',
  description: 'Pipe the task into `claude -p` and capture the response',
  key: 'c',
  accepts: 'one',
  input: {
    prompt: 'Instruction for claude',
    placeholder: DEFAULT_INSTRUCTION,
  },

  pre({ tasks, input }) {
    // Only one prompt goes out per run, so the highlighted task wins.
    return { tasks: tasks.slice(0, 1), input: input.trim() || DEFAULT_INSTRUCTION };
  },

  async run({ tasks, input }, ctx) {
    const task = tasks[0];
    if (!task) return { ok: false, output: 'no task', exitCode: null };

    const prompt = [
      input,
      '',
      `<task source="${task.source}" created_at="${task.created_at}">`,
      task.data,
      '</task>',
    ].join('\n');

    ctx.log(`$ ${BIN} -p${EXTRA_ARGS.length ? ` ${EXTRA_ARGS.join(' ')}` : ''}\n`);

    const result = await exec(BIN, ['-p', ...EXTRA_ARGS], {
      stdin: prompt,
      signal: ctx.signal,
      timeoutMs: TIMEOUT_MS,
      onOutput: ctx.log,
    });

    return {
      ok: result.ok,
      output: result.output.trim() || '(claude produced no output)',
      exitCode: result.exitCode,
      meta: { prompt, duration_ms: result.durationMs, aborted: result.aborted },
    };
  },

  post({ tasks }, run) {
    const task = tasks[0];
    if (!task) return [];

    const body = run.ok
      ? run.output
      : `claude exited with ${run.exitCode ?? 'an error'}:\n\n${run.output}`;

    return [
      {
        parent: task.id,
        data: body,
        source: 'tool:claude',
        state: 'incoming',
        meta: {
          title: run.ok ? `claude: ${firstLine(run.output)}` : 'claude failed',
          error: !run.ok,
          exit_code: run.exitCode,
        },
      },
    ];
  },
};

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim())?.trim().slice(0, 72) ?? 'no output';
}
