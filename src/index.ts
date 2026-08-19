import { notify } from './core/notify.ts';
import { autosave, flush, load, statePath } from './core/persist.ts';
import { cancelAll } from './core/runner.ts';
import { done, incoming, working } from './core/store.ts';
import { pollFeedStatus, startAutoFeeds, stopAllFeeds, submit } from './feeds/index.ts';
import { manualFeed } from './feeds/manual.ts';
import { handleKey, render, setQuitHandler } from './ui/app.ts';
import { start, stop } from './ui/screen.ts';
import { t } from './ui/theme.ts';

const HELP = `
workwork — a CLI work queue

  workwork              open the board
  workwork add <text>   add a task to the incoming feed, then exit
  workwork ls           print the current board as text
  workwork --help       this message

State lives in ${statePath}

Environment
  WORKWORK_HOME            state directory (default ~/.workwork)
  WORKWORK_WS_URL          websocket feed source; enables that feed
  WORKWORK_CLAUDE_BIN      claude executable (default: claude)
  WORKWORK_CLAUDE_ARGS     extra args for claude -p
  WORKWORK_GIT_CWD         repo the git tool runs in (default: cwd)
  WORKWORK_HERDR_BIN       herdr executable (default: herdr)
  WORKWORK_DESKTOP_NOTIFY  1 to also raise macOS notifications
`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(HELP);
    return;
  }

  const { recovered } = await load();

  if (command === 'add') {
    const created = submit(manualFeed, rest.join(' '));
    await flush();
    process.stdout.write(
      created.length ? `added ${created.length} task(s)\n` : 'nothing to add\n',
    );
    return;
  }

  if (command === 'ls') {
    printBoard();
    return;
  }

  if (command) {
    process.stderr.write(`unknown command: ${command}\n${HELP}`);
    process.exitCode = 1;
    return;
  }

  if (!process.stdin.isTTY) {
    process.stderr.write('workwork needs an interactive terminal (try `workwork ls`)\n');
    process.exitCode = 1;
    return;
  }

  await runInteractive(recovered);
}

async function runInteractive(recovered: number): Promise<void> {
  const stopAutosave = autosave();
  await startAutoFeeds();

  // Feeds report connection state lazily; keep the status bar honest.
  const statusPoll = setInterval(pollFeedStatus, 1000);
  statusPoll.unref?.();

  let exiting = false;
  const shutdown = () => {
    if (exiting) return;
    exiting = true;
    clearInterval(statusPoll);
    stop();
    stopAutosave();
    cancelAll();
    void (async () => {
      await stopAllFeeds();
      await flush();
      process.stdout.write(
        `${t.dim('board saved to')} ${statePath}\n` +
          `${t.dim('incoming')} ${incoming.value.length}  ${t.dim('working')} ${working.value.length}  ${t.dim('done')} ${done.value.length}\n`,
      );
      process.exit(0);
    })();
  };

  setQuitHandler(shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  start({ render, onKey: handleKey });

  if (recovered > 0) {
    notify('info', `recovered ${recovered} in-flight task${recovered === 1 ? '' : 's'} from last run`);
  }
}

function printBoard(): void {
  const sections: [string, typeof incoming.value][] = [
    ['INCOMING', incoming.value],
    ['WORKING', working.value],
    ['DONE', done.value],
  ];

  for (const [label, list] of sections) {
    process.stdout.write(`${label} (${list.length})\n`);
    for (const task of list) {
      const title = task.data.split('\n')[0]?.slice(0, 80) ?? '';
      process.stdout.write(`  ${task.id.slice(0, 8)}  ${task.source.padEnd(14)}  ${title}\n`);
    }
    process.stdout.write('\n');
  }
}

main().catch((error: unknown) => {
  stop();
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
