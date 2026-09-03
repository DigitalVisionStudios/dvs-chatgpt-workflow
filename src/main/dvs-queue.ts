import { randomUUID } from 'node:crypto';

import { readDurable, writeDurableNow } from './durable.js';
import {
  DVS_QUEUE_STORE_VERSION,
  type DvsQueueBaseline,
  type DvsQueueItem,
  type DvsQueueItemStatus,
  type DvsQueueStore,
  type DvsThreadQueue,
  type PreparedDvsDispatch
} from '../shared/dvs-queue.js';

const STATE_NAME = 'dvs-queues';
const ACTIVE_STATUSES = new Set<DvsQueueItemStatus>(['dispatching', 'sending', 'recovering']);

let state: DvsQueueStore = emptyStore();
let restored = false;
const listeners = new Set<(snapshot: DvsQueueStore) => void>();

function emptyStore(): DvsQueueStore {
  return { version: DVS_QUEUE_STORE_VERSION, threads: {} };
}

function now(): number {
  return Date.now();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeStatus(value: unknown): DvsQueueItemStatus {
  switch (value) {
    case 'queued':
    case 'dispatching':
    case 'sending':
    case 'recovering':
    case 'completed':
    case 'stopped':
    case 'error':
      return value;
    default:
      return 'queued';
  }
}

function normalizeItem(raw: unknown, fallbackTime: number): DvsQueueItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Partial<DvsQueueItem>;
  const text = cleanText(source.text);
  if (!text) return null;
  const createdAt = Number.isFinite(source.createdAt) ? Number(source.createdAt) : fallbackTime;
  const updatedAt = Number.isFinite(source.updatedAt) ? Number(source.updatedAt) : createdAt;
  const baseline =
    source.baseline &&
    Number.isFinite(source.baseline.userTurns) &&
    Number.isFinite(source.baseline.assistantTurns)
      ? {
          userTurns: Math.max(0, Math.floor(Number(source.baseline.userTurns))),
          assistantTurns: Math.max(0, Math.floor(Number(source.baseline.assistantTurns)))
        }
      : null;
  return {
    id: typeof source.id === 'string' && source.id ? source.id : randomUUID(),
    text,
    status: normalizeStatus(source.status),
    createdAt,
    updatedAt,
    dispatchId: typeof source.dispatchId === 'string' && source.dispatchId ? source.dispatchId : null,
    attempt: Number.isFinite(source.attempt) ? Math.max(0, Math.floor(Number(source.attempt))) : 0,
    baseline,
    submittedUserTurnId:
      typeof source.submittedUserTurnId === 'string' && source.submittedUserTurnId
        ? source.submittedUserTurnId
        : null,
    lastError: typeof source.lastError === 'string' && source.lastError ? source.lastError : null
  };
}

function normalizeThread(conversationId: string, raw: unknown): DvsThreadQueue {
  const stamp = now();
  const source = raw && typeof raw === 'object' ? (raw as Partial<DvsThreadQueue>) : {};
  const items = Array.isArray(source.items)
    ? source.items.map((item) => normalizeItem(item, stamp)).filter((item): item is DvsQueueItem => item !== null)
    : [];
  const active = items.find((item) => ACTIVE_STATUSES.has(item.status)) ?? null;
  return {
    queueId: typeof source.queueId === 'string' && source.queueId ? source.queueId : randomUUID(),
    conversationId,
    createdAt: Number.isFinite(source.createdAt) ? Number(source.createdAt) : stamp,
    updatedAt: Number.isFinite(source.updatedAt) ? Number(source.updatedAt) : stamp,
    paused: source.paused === true,
    pauseAfterCurrent: source.pauseAfterCurrent === true,
    activeItemId: active?.id ?? null,
    items
  };
}

function normalizeStore(raw: unknown): DvsQueueStore {
  if (!raw || typeof raw !== 'object') return emptyStore();
  const source = raw as Partial<DvsQueueStore>;
  const threads: Record<string, DvsThreadQueue> = {};
  if (source.threads && typeof source.threads === 'object') {
    for (const [conversationId, value] of Object.entries(source.threads)) {
      if (!conversationId) continue;
      threads[conversationId] = normalizeThread(conversationId, value);
    }
  }
  return { version: DVS_QUEUE_STORE_VERSION, threads };
}

function requireRestored(): void {
  if (!restored) throw new Error('DVS queue store has not been restored yet.');
}

function requireThread(conversationId: string): DvsThreadQueue {
  requireRestored();
  const thread = state.threads[conversationId];
  if (!thread) throw new Error(`No DVS queue exists for conversation ${conversationId}.`);
  return thread;
}

function requireDispatch(
  conversationId: string,
  itemId: string,
  dispatchId: string,
  allowed: DvsQueueItemStatus[]
): { thread: DvsThreadQueue; item: DvsQueueItem } {
  const thread = requireThread(conversationId);
  const item = thread.items.find((entry) => entry.id === itemId);
  if (!item) throw new Error(`DVS queue item ${itemId} does not exist.`);
  if (item.dispatchId !== dispatchId) throw new Error('DVS dispatch identity does not match the durable queue item.');
  if (!allowed.includes(item.status)) {
    throw new Error(`DVS queue item ${itemId} is ${item.status}, not ${allowed.join(' or ')}.`);
  }
  return { thread, item };
}

function emitChange(): void {
  const snapshot = clone(state);
  for (const listener of listeners) listener(snapshot);
}

async function commit(): Promise<void> {
  await writeDurableNow(STATE_NAME, state);
  emitChange();
}

function noteThread(thread: DvsThreadQueue, stamp = now()): void {
  thread.updatedAt = stamp;
}

export async function restoreDvsQueues(): Promise<void> {
  const saved = await readDurable<unknown>(STATE_NAME);
  state = normalizeStore(saved);
  let changed = false;
  const stamp = now();

  // A restart can happen after the durable dispatch intent landed but before browser acceptance
  // was proved. Never turn that item back into queued work: recovery must reconcile visible
  // ChatGPT evidence before deciding whether anything may be sent again.
  for (const thread of Object.values(state.threads)) {
    let active: DvsQueueItem | null = null;
    for (const item of thread.items) {
      if (item.status === 'dispatching' || item.status === 'sending') {
        item.status = 'recovering';
        item.updatedAt = stamp;
        item.lastError = 'Application restarted before dispatch completion was proven.';
        changed = true;
      }
      if (ACTIVE_STATUSES.has(item.status) && !active) active = item;
    }
    const nextActive = active?.id ?? null;
    if (thread.activeItemId !== nextActive) {
      thread.activeItemId = nextActive;
      changed = true;
    }
    if (changed) noteThread(thread, stamp);
  }

  restored = true;
  if (changed) await commit();
}

export function dvsQueueSnapshot(): DvsQueueStore {
  requireRestored();
  return clone(state);
}

export function onDvsQueueChange(listener: (snapshot: DvsQueueStore) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function dvsThreadQueue(conversationId: string): DvsThreadQueue | null {
  requireRestored();
  const thread = state.threads[conversationId];
  return thread ? clone(thread) : null;
}

export async function enqueueDvsQueue(conversationId: string, texts: string[]): Promise<DvsThreadQueue> {
  requireRestored();
  const cleaned = texts.map(cleanText).filter(Boolean);
  if (cleaned.length === 0) throw new Error('At least one non-empty DVS queue message is required.');

  const stamp = now();
  let thread = state.threads[conversationId];
  if (!thread) {
    thread = {
      queueId: randomUUID(),
      conversationId,
      createdAt: stamp,
      updatedAt: stamp,
      paused: false,
      pauseAfterCurrent: false,
      activeItemId: null,
      items: []
    };
    state.threads[conversationId] = thread;
  }

  for (const text of cleaned) {
    thread.items.push({
      id: randomUUID(),
      text,
      status: 'queued',
      createdAt: stamp,
      updatedAt: stamp,
      dispatchId: null,
      attempt: 0,
      baseline: null,
      submittedUserTurnId: null,
      lastError: null
    });
  }
  noteThread(thread, stamp);
  await commit();
  return clone(thread);
}

export async function prepareNextDvsDispatch(
  conversationId: string,
  baseline: DvsQueueBaseline | null = null
): Promise<PreparedDvsDispatch | null> {
  const thread = requireThread(conversationId);
  if (thread.paused || thread.pauseAfterCurrent) return null;

  const active = thread.items.find((item) => ACTIVE_STATUSES.has(item.status));
  if (active) return null;

  const item = thread.items.find((entry) => entry.status === 'queued');
  if (!item) return null;

  const stamp = now();
  const dispatchId = randomUUID();
  item.status = 'dispatching';
  item.dispatchId = dispatchId;
  item.attempt += 1;
  item.baseline = baseline ? clone(baseline) : null;
  item.submittedUserTurnId = null;
  item.lastError = null;
  item.updatedAt = stamp;
  thread.activeItemId = item.id;
  noteThread(thread, stamp);

  // This is the exact crash boundary inherited from DVS v3: intent is durable before anything
  // is allowed to touch ChatGPT's composer.
  await commit();

  return {
    conversationId,
    queueId: thread.queueId,
    itemId: item.id,
    dispatchId,
    text: item.text,
    attempt: item.attempt,
    baseline: item.baseline ? clone(item.baseline) : null
  };
}

export async function markDvsDispatchSending(
  conversationId: string,
  itemId: string,
  dispatchId: string,
  submittedUserTurnId: string | null = null
): Promise<void> {
  const { thread, item } = requireDispatch(conversationId, itemId, dispatchId, ['dispatching']);
  const stamp = now();
  item.status = 'sending';
  item.submittedUserTurnId = submittedUserTurnId;
  item.updatedAt = stamp;
  noteThread(thread, stamp);
  await commit();
}

export async function markDvsDispatchRecovering(
  conversationId: string,
  itemId: string,
  dispatchId: string,
  reason: string
): Promise<void> {
  const { thread, item } = requireDispatch(conversationId, itemId, dispatchId, ['dispatching', 'sending', 'recovering']);
  const stamp = now();
  item.status = 'recovering';
  item.lastError = cleanText(reason) || 'Dispatch outcome is uncertain.';
  item.updatedAt = stamp;
  noteThread(thread, stamp);
  await commit();
}

export async function completeDvsDispatch(
  conversationId: string,
  itemId: string,
  dispatchId: string
): Promise<void> {
  const { thread, item } = requireDispatch(conversationId, itemId, dispatchId, ['sending', 'recovering']);
  const stamp = now();
  item.status = 'completed';
  item.updatedAt = stamp;
  item.lastError = null;
  thread.activeItemId = null;
  if (thread.pauseAfterCurrent) {
    thread.pauseAfterCurrent = false;
    thread.paused = true;
  }
  noteThread(thread, stamp);
  await commit();
}

export async function failDvsDispatch(
  conversationId: string,
  itemId: string,
  dispatchId: string,
  reason: string
): Promise<void> {
  const { thread, item } = requireDispatch(conversationId, itemId, dispatchId, ['dispatching', 'sending', 'recovering']);
  const stamp = now();
  item.status = 'error';
  item.lastError = cleanText(reason) || 'Dispatch failed.';
  item.updatedAt = stamp;
  thread.activeItemId = null;
  thread.pauseAfterCurrent = false;
  thread.paused = true;
  noteThread(thread, stamp);
  await commit();
}

export async function stopDvsDispatch(
  conversationId: string,
  itemId: string,
  dispatchId: string
): Promise<void> {
  const { thread, item } = requireDispatch(conversationId, itemId, dispatchId, ['dispatching', 'sending', 'recovering']);
  const stamp = now();
  item.status = 'stopped';
  item.updatedAt = stamp;
  thread.activeItemId = null;
  thread.pauseAfterCurrent = false;
  thread.paused = true;
  noteThread(thread, stamp);
  await commit();
}

export async function pauseDvsQueue(conversationId: string): Promise<void> {
  const thread = requireThread(conversationId);
  const hasActive = thread.items.some((item) => ACTIVE_STATUSES.has(item.status));
  if (hasActive) thread.pauseAfterCurrent = true;
  else thread.paused = true;
  noteThread(thread);
  await commit();
}

export async function resumeDvsQueue(conversationId: string): Promise<void> {
  const thread = requireThread(conversationId);
  thread.paused = false;
  thread.pauseAfterCurrent = false;
  noteThread(thread);
  await commit();
}

export function resetDvsQueuesForTests(): void {
  state = emptyStore();
  restored = false;
  listeners.clear();
}
