import type { Feed, FeedContext, FeedHandle } from './types.ts';

/**
 * A generic websocket data source — the shape the Slack example in the design
 * takes. Point WORKWORK_WS_URL at any socket that streams JSON (or plain text)
 * messages and each one becomes a task.
 *
 * Off unless the URL is configured, so nothing dials out by default.
 */
const URL_ENV = process.env.WORKWORK_WS_URL ?? '';

export const websocketFeed: Feed = {
  id: 'websocket',
  name: 'websocket',
  description: URL_ENV
    ? `Stream tasks from ${URL_ENV}`
    : 'Stream tasks from a websocket (set WORKWORK_WS_URL)',
  key: 'w',
  autostart: Boolean(URL_ENV),

  postprocess(raw) {
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (!text.trim()) return null;

    // Best effort at reading a common notification shape without assuming one.
    let title: string | undefined;
    let body = text;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        const record = parsed as Record<string, unknown>;
        const message = pickString(record, ['text', 'message', 'body', 'title', 'summary']);
        const from = pickString(record, ['user', 'username', 'author', 'from', 'channel']);
        if (message) {
          title = from ? `${from}: ${message}` : message;
          body = message;
        }
        body = `${body}\n\n---\n${JSON.stringify(parsed, null, 2)}`;
      }
    } catch {
      // Not JSON — the raw text is the task.
    }

    return {
      data: body.trim(),
      source: 'websocket',
      meta: { title: title?.slice(0, 96) },
    };
  },

  start(ctx: FeedContext): FeedHandle {
    const url = URL_ENV;
    if (!url) {
      ctx.report('error', 'websocket feed: WORKWORK_WS_URL is not set');
      return { status: () => 'unconfigured', stop: () => {} };
    }

    let socket: WebSocket | null = null;
    let state = 'connecting';
    let attempt = 0;
    let retry: NodeJS.Timeout | null = null;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      state = attempt === 0 ? 'connecting' : `reconnecting (#${attempt})`;

      try {
        socket = new WebSocket(url);
      } catch (error) {
        ctx.report('error', `websocket feed: ${String(error)}`);
        scheduleRetry();
        return;
      }

      socket.addEventListener('open', () => {
        attempt = 0;
        state = 'connected';
        ctx.report('info', `websocket feed connected to ${url}`);
      });

      socket.addEventListener('message', (event: MessageEvent) => {
        ctx.emit(typeof event.data === 'string' ? event.data : String(event.data));
      });

      socket.addEventListener('error', () => {
        state = 'error';
      });

      socket.addEventListener('close', () => {
        socket = null;
        if (stopped) return;
        state = 'disconnected';
        scheduleRetry();
      });
    };

    const scheduleRetry = () => {
      if (stopped || retry) return;
      // Exponential backoff, capped at 30s.
      const delay = Math.min(30_000, 1000 * 2 ** attempt);
      attempt += 1;
      retry = setTimeout(() => {
        retry = null;
        connect();
      }, delay);
      retry.unref?.();
    };

    ctx.signal.addEventListener('abort', () => handle.stop(), { once: true });

    const handle: FeedHandle = {
      status: () => state,
      stop: () => {
        stopped = true;
        if (retry) clearTimeout(retry);
        retry = null;
        socket?.close();
        socket = null;
        state = 'stopped';
      },
    };

    connect();
    return handle;
  },
};

function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}
