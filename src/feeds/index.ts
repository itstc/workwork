import { signal } from '@preact/signals-core';
import { notify } from '../core/notify.ts';
import { ingest } from '../core/store.ts';
import type { Task } from '../core/task.ts';
import { manualFeed } from './manual.ts';
import type { Feed, FeedHandle } from './types.ts';
import { websocketFeed } from './websocket.ts';

export const feeds: Feed[] = [manualFeed, websocketFeed];

export function feedById(id: string): Feed | undefined {
  return feeds.find((feed) => feed.id === id);
}

export interface FeedState {
  running: boolean;
  status: string;
  received: number;
}

export const feedStates = signal<Record<string, FeedState>>(
  Object.fromEntries(feeds.map((feed) => [feed.id, { running: false, status: 'idle', received: 0 }])),
);

const handles = new Map<string, { handle: FeedHandle; controller: AbortController }>();

function patch(id: string, changes: Partial<FeedState>): void {
  const current = feedStates.value[id] ?? { running: false, status: 'idle', received: 0 };
  feedStates.value = { ...feedStates.value, [id]: { ...current, ...changes } };
}

/**
 * The one and only path from a raw payload to the board: the feed's own
 * `postprocess` converts it, and whatever comes back is created as a task.
 */
export function submit(feed: Feed, raw: unknown): Task[] {
  let drafts;
  try {
    drafts = feed.postprocess(raw);
  } catch (error) {
    notify('error', `${feed.name} feed: postprocess failed — ${String(error)}`);
    return [];
  }
  if (!drafts) return [];

  const created = (Array.isArray(drafts) ? drafts : [drafts]).map((draft) =>
    ingest({ ...draft, source: draft.source || feed.id, state: 'incoming' }),
  );

  const state = feedStates.value[feed.id];
  patch(feed.id, { received: (state?.received ?? 0) + created.length });
  return created;
}

export async function startFeed(feed: Feed): Promise<void> {
  if (!feed.start || handles.has(feed.id)) return;

  const controller = new AbortController();
  try {
    const handle = await feed.start({
      emit: (raw) => {
        submit(feed, raw);
        patch(feed.id, { status: handles.get(feed.id)?.handle.status() ?? 'connected' });
      },
      report: (level, message) => {
        patch(feed.id, { status: handles.get(feed.id)?.handle.status() ?? level });
        notify(level, message);
      },
      signal: controller.signal,
    });
    handles.set(feed.id, { handle, controller });
    patch(feed.id, { running: true, status: handle.status() });
  } catch (error) {
    patch(feed.id, { running: false, status: 'failed' });
    notify('error', `${feed.name} feed failed to start — ${String(error)}`);
  }
}

export async function stopFeed(feed: Feed): Promise<void> {
  const entry = handles.get(feed.id);
  if (!entry) return;
  handles.delete(feed.id);
  entry.controller.abort();
  await entry.handle.stop();
  patch(feed.id, { running: false, status: 'stopped' });
}

export async function toggleFeed(feed: Feed): Promise<void> {
  if (feedStates.value[feed.id]?.running) await stopFeed(feed);
  else await startFeed(feed);
}

/** Refresh connection status text for feeds that report it lazily. */
export function pollFeedStatus(): void {
  for (const [id, entry] of handles) {
    const status = entry.handle.status();
    if (feedStates.value[id]?.status !== status) patch(id, { status });
  }
}

export async function startAutoFeeds(): Promise<void> {
  await Promise.all(feeds.filter((feed) => feed.autostart).map(startFeed));
}

export async function stopAllFeeds(): Promise<void> {
  await Promise.all([...handles.keys()].map((id) => {
    const feed = feedById(id);
    return feed ? stopFeed(feed) : Promise.resolve();
  }));
}
