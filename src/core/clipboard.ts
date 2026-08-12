import { exec } from './exec.ts';

const BIN = process.env.WORKWORK_COPY_BIN ?? 'pbcopy';
const COPY_ARGS = process.env.WORKWORK_COPY_ARGS?.split(' ').filter(Boolean) ?? [];

/**
 * Pipe text into the system clipboard. Never throws — a missing `pbcopy` comes
 * back as `ok: false` so the UI can show it as a notice like any other failure.
 */
export async function copyToClipboard(text: string): Promise<{ ok: boolean; error?: string }> {
  const result = await exec(BIN, COPY_ARGS, { stdin: text, timeoutMs: 5000 });
  if (result.ok) return { ok: true };

  const detail = result.output.trim().split('\n').filter(Boolean).pop();
  return { ok: false, error: detail || `${BIN} exited ${result.exitCode ?? '?'}` };
}
