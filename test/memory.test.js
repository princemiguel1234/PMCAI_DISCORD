import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationMemory } from '../src/memory.js';

function makeMemory(options = {}) {
  return new ConversationMemory({ ttlMs: 60_000, maxConversations: 50, ...options });
}

test('keeps at most 25 conversation messages, counting user and assistant', () => {
  const memory = makeMemory();
  try {
    for (let i = 0; i < 15; i += 1) {
      memory.addExchange('channel:1', {
        userContent: `user ${i}`,
        assistantContent: `assistant ${i}`,
        userMessageId: `u${i}`,
        assistantMessageIds: [`a${i}`],
      });
    }
    const history = memory.getHistory('channel:1');
    assert.equal(history.length, 25);
    assert.equal(history[0].content, 'assistant 2');
    assert.equal(history.at(-1).content, 'assistant 14');
  } finally {
    memory.stop();
  }
});

test('separates conversations and keeps style mode per channel', () => {
  const memory = makeMemory();
  try {
    memory.setMode('channel:1', 'robot');
    memory.addExchange('channel:1', { userContent: 'hello', assistantContent: 'beep' });
    assert.equal(memory.getMode('channel:1'), 'robot');
    assert.equal(memory.getMode('channel:2'), 'human');
    assert.equal(memory.getHistory('channel:2').length, 0);
  } finally {
    memory.stop();
  }
});

test('serializes queued work in order for the same conversation', async () => {
  const memory = makeMemory();
  const order = [];
  try {
    await Promise.all([
      memory.withLock('channel:1', async () => { order.push('first-start'); await new Promise((r) => setTimeout(r, 20)); order.push('first-end'); }),
      memory.withLock('channel:1', async () => { order.push('second-start'); order.push('second-end'); }),
    ]);
    assert.deepEqual(order, ['first-start', 'first-end', 'second-start', 'second-end']);
  } finally {
    memory.stop();
  }
});

test('releases a conversation lock after a task fails', async () => {
  const memory = makeMemory();
  try {
    await assert.rejects(
      memory.withLock('channel:1', async () => {
        throw new Error('turn failed');
      }),
      /turn failed/,
    );

    const result = await memory.withLock('channel:1', async () => 'next turn');
    assert.equal(result, 'next turn');
    assert.equal(memory.locks.size, 0);
  } finally {
    memory.stop();
  }
});

test('editing a user message removes its outdated assistant response', () => {
  const memory = makeMemory();
  try {
    memory.addExchange('channel:1', {
      userContent: 'old question',
      assistantContent: 'answer to old question',
      userMessageId: 'u1',
      assistantMessageIds: ['a1'],
    });
    assert.equal(memory.updateUserMessage('channel:1', 'u1', 'edited question'), true);
    assert.deepEqual(memory.getHistory('channel:1').map((item) => item.content), ['edited question']);
  } finally {
    memory.stop();
  }
});

test('deleting either message removes the exchange', () => {
  const memory = makeMemory();
  try {
    memory.addExchange('channel:1', {
      userContent: 'question',
      assistantContent: 'answer',
      userMessageId: 'u1',
      assistantMessageIds: ['a1', 'a2'],
    });
    assert.equal(memory.removeMessage('channel:1', 'a2'), true);
    assert.equal(memory.getHistory('channel:1').length, 0);
  } finally {
    memory.stop();
  }
});

test('removes inactive conversations after their TTL', () => {
  const memory = makeMemory({ ttlMs: 10 });
  try {
    memory.addExchange('channel:1', { userContent: 'q', assistantContent: 'a' });
    memory.cleanup(Date.now() + 100);
    assert.equal(memory.getHistory('channel:1').length, 0);
  } finally {
    memory.stop();
  }
});
