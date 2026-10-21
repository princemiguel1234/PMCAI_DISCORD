import test from 'node:test';
import assert from 'node:assert/strict';
import { generateReply } from '../src/ai.js';

const config = { groqApiKey: 'test-key', groqTimeoutMs: 5000 };

async function withMockFetch(handler, task) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    await task();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function completionResponse(content = 'Test answer') {
  return Response.json({ choices: [{ message: { content } }] });
}

test('selects human and robot styles and defaults missing or invalid modes to human', async () => {
  await withMockFetch(async (_url, options) => {
    return completionResponse(JSON.parse(options.body).messages[0].content);
  }, async () => {
    const human = await generateReply({ userText: 'Hi', config });
    const robot = await generateReply({ userText: 'Hi', mode: 'robot', config });
    const missing = await generateReply({ userText: 'Hi', mode: undefined, config });
    const invalid = await generateReply({ userText: 'Hi', mode: 'unexpected', config });

    assert.match(human, /HUMAN-LIKE/);
    assert.match(robot, /ROBOT/);
    assert.match(missing, /HUMAN-LIKE/);
    assert.match(invalid, /HUMAN-LIKE/);
  });
});

test('sends a successful Groq text request and returns its response', async () => {
  let requestBody;
  await withMockFetch(async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return completionResponse(' Groq reply ');
  }, async () => {
    const reply = await generateReply({
      userText: 'Hello',
      model: 'openai/gpt-oss-120b',
      config,
    });
    assert.equal(reply, 'Groq reply');
    assert.equal(requestBody.model, 'openai/gpt-oss-120b');
    assert.equal(requestBody.messages.at(-1).content, 'Hello');
  });
});

test('rejects empty and malformed Groq completion responses', async () => {
  await withMockFetch(async () => completionResponse('  '), async () => {
    await assert.rejects(
      generateReply({ userText: 'Hello', config }),
      /Groq returned an empty response/,
    );
  });

  await withMockFetch(async () => Response.json({ choices: {} }), async () => {
    await assert.rejects(
      generateReply({ userText: 'Hello', config }),
      /Groq returned an empty response/,
    );
  });

  let calls = 0;
  await withMockFetch(async () => {
    calls += 1;
    return new Response('{', { status: 200 });
  }, async () => {
    await assert.rejects(
      generateReply({ userText: 'Hello', config }),
      /Groq request failed/,
    );
    assert.equal(calls, 1);
  });
});

test('does not retry non-transient Groq HTTP errors', async () => {
  let calls = 0;
  await withMockFetch(async () => {
    calls += 1;
    return new Response('unauthorized', { status: 401 });
  }, async () => {
    await assert.rejects(
      generateReply({ userText: 'Hello', config }),
      (error) => error.code === 'GROQ_REQUEST_FAILED' && error.status === 401,
    );
    assert.equal(calls, 1);
  });
});

test('retries a transient Groq error once and then returns a successful response', async () => {
  let calls = 0;
  await withMockFetch(async () => {
    calls += 1;
    return calls === 1
      ? new Response('temporarily unavailable', {
          status: 503,
          headers: { 'retry-after': '0' },
        })
      : completionResponse('recovered');
  }, async () => {
    assert.equal(await generateReply({ userText: 'Hello', config }), 'recovered');
    assert.equal(calls, 2);
  });
});

test('retries an aborted request once and caps retries after a second timeout', async () => {
  let calls = 0;
  await withMockFetch(async () => {
    calls += 1;
    if (calls === 1) {
      throw Object.assign(new Error('timed out'), { name: 'AbortError' });
    }
    return completionResponse('recovered');
  }, async () => {
    assert.equal(await generateReply({ userText: 'Hello', config }), 'recovered');
    assert.equal(calls, 2);
  });

  calls = 0;
  await withMockFetch(async () => {
    calls += 1;
    throw Object.assign(new Error('timed out'), { name: 'AbortError' });
  }, async () => {
    await assert.rejects(
      generateReply({ userText: 'Hello', config }),
      /Groq request failed/,
    );
    assert.equal(calls, 2);
  });
});
