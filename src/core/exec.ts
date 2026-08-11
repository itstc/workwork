import { spawn } from 'node:child_process';

export interface ExecOptions {
  cwd?: string;
  /** Written to the child's stdin, then stdin is closed. */
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Called with every chunk of stdout/stderr as it arrives. */
  onOutput?: (chunk: string) => void;
}

export interface ExecResult {
  ok: boolean;
  output: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  aborted: boolean;
}

/**
 * Run a command, merging stdout and stderr into one transcript the way a
 * terminal would show it. Never rejects — a failure to even spawn comes back as
 * `ok: false` so tools can turn it into a task like any other output.
 */
export function exec(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  const started = Date.now();

  return new Promise<ExecResult>((resolve) => {
    let settled = false;
    let output = '';
    let aborted = false;

    const finish = (result: Omit<ExecResult, 'durationMs' | 'output' | 'aborted'>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ...result, output, aborted, durationMs: Date.now() - started });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        ok: false,
        output: `failed to spawn ${command}: ${String(error)}`,
        exitCode: null,
        signal: null,
        aborted: false,
        durationMs: Date.now() - started,
      });
      return;
    }

    const collect = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      output += text;
      options.onOutput?.(text);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    const kill = (reason: 'abort' | 'timeout') => {
      aborted = true;
      output += `\n[${reason === 'abort' ? 'cancelled' : 'timed out'}]\n`;
      child.kill('SIGTERM');
      // Escalate if the child ignores the polite request.
      const hard = setTimeout(() => child.kill('SIGKILL'), 2000);
      hard.unref?.();
    };

    const onAbort = () => kill('abort');
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const timer = options.timeoutMs
      ? setTimeout(() => kill('timeout'), options.timeoutMs)
      : null;
    timer?.unref?.();

    function cleanup() {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }

    child.on('error', (error) => {
      output += `\n${String(error)}\n`;
      finish({ ok: false, exitCode: null, signal: null });
    });

    child.on('close', (code, signal) => {
      finish({ ok: code === 0 && !aborted, exitCode: code, signal });
    });

    if (options.stdin !== undefined) {
      child.stdin?.end(options.stdin);
    } else {
      child.stdin?.end();
    }
  });
}

/** Fire-and-forget: detach a process and stop tracking it entirely. */
export function spawnDetached(
  command: string,
  args: string[],
  options: { cwd?: string } = {},
): { pid: number | undefined; error?: string } {
  try {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: 'ignore',
      detached: true,
    });
    child.on('error', () => {});
    child.unref();
    return { pid: child.pid };
  } catch (error) {
    return { pid: undefined, error: String(error) };
  }
}
