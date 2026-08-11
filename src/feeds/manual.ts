import type { Feed } from './types.ts';

/**
 * The simplest possible data source: whatever the user types. Still goes
 * through `postprocess` like every other feed, so there is exactly one path
 * from raw payload to task.
 */
export const manualFeed: Feed = {
  id: 'manual',
  name: 'manual',
  description: 'Type a task in by hand',
  key: 'm',
  interactive: true,
  prompt: 'New task',

  postprocess(raw) {
    const text = String(raw ?? '')
      // Let a single-line prompt still produce multi-line task data.
      .replaceAll('\\n', '\n')
      .trim();
    if (!text) return null;

    return {
      data: text,
      source: 'manual',
      meta: { title: text.split('\n')[0]?.slice(0, 96) },
    };
  },
};
