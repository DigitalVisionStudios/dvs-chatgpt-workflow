export const DVS_QUEUE_STORE_VERSION = 1 as const;

export type DvsQueueItemStatus =
  | 'queued'
  | 'dispatching'
  | 'sending'
  | 'recovering'
  | 'completed'
  | 'stopped'
  | 'error';

export interface DvsQueueBaseline {
  userTurns: number;
  assistantTurns: number;
}

export interface DvsQueueItem {
  id: string;
  text: string;
  status: DvsQueueItemStatus;
  createdAt: number;
  updatedAt: number;
  dispatchId: string | null;
  attempt: number;
  baseline: DvsQueueBaseline | null;
  submittedUserTurnId: string | null;
  lastError: string | null;
}

export interface DvsThreadQueue {
  queueId: string;
  conversationId: string;
  createdAt: number;
  updatedAt: number;
  paused: boolean;
  pauseAfterCurrent: boolean;
  activeItemId: string | null;
  items: DvsQueueItem[];
}

export interface DvsQueueStore {
  version: typeof DVS_QUEUE_STORE_VERSION;
  threads: Record<string, DvsThreadQueue>;
}

export interface PreparedDvsDispatch {
  conversationId: string;
  queueId: string;
  itemId: string;
  dispatchId: string;
  text: string;
  attempt: number;
  baseline: DvsQueueBaseline | null;
}
