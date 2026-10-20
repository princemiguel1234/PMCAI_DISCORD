const DEFAULT_HISTORY_LIMIT = 25;
const MAX_STORED_MESSAGE_CHARS = 1800;

/**
 * Small, bounded, process-local conversation memory.
 * History is ephemeral and is intentionally not written to disk.
 */
export class ConversationMemory {
  constructor({ ttlMs = 6 * 60 * 60 * 1000, maxConversations = 1000, historyLimit = DEFAULT_HISTORY_LIMIT } = {}) {
    this.ttlMs = ttlMs;
    this.maxConversations = maxConversations;
    this.historyLimit = historyLimit;
    this.conversations = new Map();
    this.locks = new Map();

    const cleanupEveryMs = Math.max(60_000, Math.min(ttlMs, 15 * 60_000));
    this.cleanupTimer = setInterval(() => this.cleanup(), cleanupEveryMs);
    this.cleanupTimer.unref?.();
  }

  async withLock(key, task) {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release;
    const currentTurn = new Promise((resolve) => {
      release = resolve;
    });
    const queueTail = previous.then(() => currentTurn, () => currentTurn);
    this.locks.set(key, queueTail);

    await previous.catch(() => {});
    try {
      return await task();
    } finally {
      release();
      if (this.locks.get(key) === queueTail) this.locks.delete(key);
    }
  }

  getHistory(key) {
    const state = this.#getState(key, false);
    if (!state) return [];
    this.#touch(key, state);
    return state.history.map((item) => ({ ...item, messageIds: [...(item.messageIds ?? [])] }));
  }

  getMode(key) {
    const state = this.#getState(key, true);
    this.#touch(key, state);
    return state.mode;
  }

  setMode(key, mode) {
    if (mode !== 'human' && mode !== 'robot') throw new TypeError('Mode must be "human" or "robot".');
    const state = this.#getState(key, true);
    state.mode = mode;
    this.#touch(key, state);
  }

  addExchange(key, { userContent, assistantContent, userMessageId = null, assistantMessageIds = [] }) {
    const state = this.#getState(key, true);
    const turnId = userMessageId || `turn-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const now = Date.now();

    state.history.push({
      role: 'user',
      content: limitText(userContent, MAX_STORED_MESSAGE_CHARS),
      turnId,
      messageId: userMessageId,
      messageIds: userMessageId ? [userMessageId] : [],
      at: now,
    });
    state.history.push({
      role: 'assistant',
      content: limitText(assistantContent, MAX_STORED_MESSAGE_CHARS),
      turnId,
      messageId: assistantMessageIds[0] ?? null,
      messageIds: [...assistantMessageIds],
      at: now,
    });

    if (state.history.length > this.historyLimit) {
      state.history.splice(0, state.history.length - this.historyLimit);
    }
    this.#touch(key, state);
    this.cleanup();
  }

  updateUserMessage(key, messageId, newContent) {
    const state = this.#getState(key, false);
    if (!state) return false;
    const target = state.history.find((item) => item.role === 'user' && item.messageId === messageId);
    if (!target) return false;

    target.content = limitText(newContent, MAX_STORED_MESSAGE_CHARS);
    // The assistant's prior response may no longer match the edited user message.
    state.history = state.history.filter((item) => !(item.turnId === target.turnId && item.role === 'assistant'));
    this.#touch(key, state);
    return true;
  }

  removeMessage(key, messageId) {
    const state = this.#getState(key, false);
    if (!state) return false;
    const target = state.history.find((item) => item.messageIds?.includes(messageId));
    if (!target) return false;
    const before = state.history.length;
    state.history = state.history.filter((item) => item.turnId !== target.turnId);
    this.#touch(key, state);
    return state.history.length !== before;
  }

  clear(key) {
    const state = this.#getState(key, false);
    if (!state) return;
    state.history = [];
    this.#touch(key, state);
  }

  cleanup(now = Date.now()) {
    for (const [key, state] of this.conversations) {
      if (now - state.updatedAt > this.ttlMs) this.conversations.delete(key);
    }
    while (this.conversations.size > this.maxConversations) {
      const oldestKey = this.conversations.keys().next().value;
      if (oldestKey === undefined) break;
      this.conversations.delete(oldestKey);
    }
  }

  stop() {
    clearInterval(this.cleanupTimer);
    this.locks.clear();
  }

  #getState(key, create) {
    let state = this.conversations.get(key);
    if (state && Date.now() - state.updatedAt > this.ttlMs) {
      this.conversations.delete(key);
      state = undefined;
    }
    if (!state && create) {
      state = { history: [], mode: 'human', updatedAt: Date.now() };
      this.conversations.set(key, state);
      this.cleanup();
    }
    return state;
  }

  #touch(key, state) {
    state.updatedAt = Date.now();
    this.conversations.delete(key);
    this.conversations.set(key, state);
  }
}

function limitText(value, max) {
  return String(value ?? '').slice(0, max);
}
