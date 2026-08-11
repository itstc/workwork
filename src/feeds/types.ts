import type { TaskDraft } from '../core/task.ts';

export interface FeedContext {
  /**
   * Hand a raw payload to the feed runtime. It is passed straight to this
   * feed's own `postprocess` — a feed can never put anything but a task on the
   * board.
   */
  emit: (raw: unknown) => void;
  /** Surface connection state to the user. */
  report: (level: 'info' | 'error', message: string) => void;
  signal: AbortSignal;
}

export interface FeedHandle {
  /** Human-readable connection state for the status bar. */
  status: () => string;
  stop: () => void | Promise<void>;
}

export interface Feed {
  id: string;
  name: string;
  description: string;
  key: string;
  /** Start this feed automatically when the app boots. */
  autostart?: boolean;
  /**
   * `interactive` feeds have no background connection — they produce a payload
   * when the user asks for one (the manual feed prompts for text).
   */
  interactive?: boolean;
  /** Prompt shown when an interactive feed is triggered. */
  prompt?: string;

  /**
   * Required by the design: raw source data is never a task until the feed
   * converts it. Returning null drops the payload.
   */
  postprocess(raw: unknown): TaskDraft | TaskDraft[] | null;

  /** Background feeds open their connection here. */
  start?(ctx: FeedContext): FeedHandle | Promise<FeedHandle>;
}
