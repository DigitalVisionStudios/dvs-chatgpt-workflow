import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { flushDurable, initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import {
  completeDvsDispatch,
  dvsThreadQueue,
  enqueueDvsQueue,
  markDvsDispatchRecovering,
  markDvsDispatchSending,
  pauseDvsQueue,
  prepareNextDvsDispatch,
  resetDvsQueuesForTests,
  restoreDvsQueues,
  resumeDvsQueue,
  stopDvsDispatch
} from '../src/main/dvs-queue.js';

const cleanup: string[] = [];

afterEach(async () => {
  resetDvsQueuesForTests();
  resetDurableForTests();
  for (const dir of cleanup.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function tempStore(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dvs-queue-'));
  cleanup.push(dir);
  initDurableStore(dir);
  await restoreDvsQueues();
}

describe('DVS durable queue', () => {
  it('persists queued messages in order', async () => {
    await tempStore();
    await enqueueDvsQueue('chat-a', ["What's next?", 'Go ahead']);
    await flushDurable();

    const queue = dvsThreadQueue('chat-a');
    expect(queue?.items.map((item) => [item.text, item.status])).toEqual([
      ["What's next?", 'queued'],
      ['Go ahead', 'queued']
    ]);
  });

  it('commits dispatch intent before returning work to the browser layer', async () => {
    await tempStore();
    await enqueueDvsQueue('chat-a', ['Go ahead']);

    const dispatch = await prepareNextDvsDispatch('chat-a', { userTurns: 4, assistantTurns: 3 });
    expect(dispatch).toMatchObject({
      conversationId: 'chat-a',
      text: 'Go ahead',
      attempt: 1,
      baseline: { userTurns: 4, assistantTurns: 3 }
    });
    expect(dispatch?.dispatchId).toBeTruthy();

    resetDvsQueuesForTests();
    await restoreDvsQueues();
    const item = dvsThreadQueue('chat-a')?.items[0];
    expect(item?.dispatchId).toBe(dispatch?.dispatchId);
    expect(item?.status).toBe('recovering');
    expect(item?.lastError).toMatch(/restarted/i);
  });

  it('never offers a second queued message while a dispatch is uncertain', async () => {
    await tempStore();
    await enqueueDvsQueue('chat-a', ['one', 'two']);
    const first = await prepareNextDvsDispatch('chat-a');
    expect(first).not.toBeNull();

    await markDvsDispatchRecovering('chat-a', first!.itemId, first!.dispatchId, 'acceptance was not proven');
    await expect(prepareNextDvsDispatch('chat-a')).resolves.toBeNull();

    expect(dvsThreadQueue('chat-a')?.items.map((item) => item.status)).toEqual(['recovering', 'queued']);
  });

  it('advances only after the active dispatch is completed', async () => {
    await tempStore();
    await enqueueDvsQueue('chat-a', ['one', 'two']);
    const first = await prepareNextDvsDispatch('chat-a');
    await markDvsDispatchSending('chat-a', first!.itemId, first!.dispatchId, 'user-turn-1');
    await completeDvsDispatch('chat-a', first!.itemId, first!.dispatchId);

    const second = await prepareNextDvsDispatch('chat-a');
    expect(second?.text).toBe('two');
    expect(dvsThreadQueue('chat-a')?.items.map((item) => item.status)).toEqual(['completed', 'dispatching']);
  });

  it('turns Pause during active work into Pause After Current', async () => {
    await tempStore();
    await enqueueDvsQueue('chat-a', ['one', 'two']);
    const first = await prepareNextDvsDispatch('chat-a');
    await markDvsDispatchSending('chat-a', first!.itemId, first!.dispatchId);

    await pauseDvsQueue('chat-a');
    expect(dvsThreadQueue('chat-a')).toMatchObject({ paused: false, pauseAfterCurrent: true });

    await completeDvsDispatch('chat-a', first!.itemId, first!.dispatchId);
    expect(dvsThreadQueue('chat-a')).toMatchObject({ paused: true, pauseAfterCurrent: false });
    await expect(prepareNextDvsDispatch('chat-a')).resolves.toBeNull();

    await resumeDvsQueue('chat-a');
    await expect(prepareNextDvsDispatch('chat-a')).resolves.toMatchObject({ text: 'two' });
  });

  it('stops only the active dispatch and preserves remaining queued work', async () => {
    await tempStore();
    await enqueueDvsQueue('chat-a', ['one', 'two', 'three']);
    const first = await prepareNextDvsDispatch('chat-a');
    await markDvsDispatchSending('chat-a', first!.itemId, first!.dispatchId);

    await stopDvsDispatch('chat-a', first!.itemId, first!.dispatchId);
    const queue = dvsThreadQueue('chat-a');
    expect(queue).toMatchObject({ paused: true, activeItemId: null });
    expect(queue?.items.map((item) => item.status)).toEqual(['stopped', 'queued', 'queued']);
  });

  it('rejects stale dispatch identities instead of completing the wrong item', async () => {
    await tempStore();
    await enqueueDvsQueue('chat-a', ['one']);
    const first = await prepareNextDvsDispatch('chat-a');
    await expect(markDvsDispatchSending('chat-a', first!.itemId, 'stale-token')).rejects.toThrow(/identity/i);
    expect(dvsThreadQueue('chat-a')?.items[0]?.status).toBe('dispatching');
  });
});
