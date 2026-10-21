import test from 'node:test';
import assert from 'node:assert/strict';
import { searchWeb } from '../src/search.js';

async function withMockFetch(handler, task) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    await task();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('returns sanitized Tavily search results', async () => {
  let request;
  await withMockFetch(async (_url, options) => {
    request = JSON.parse(options.body);
    return Response.json({
      results: [{
        title: 'Official result',
        url: 'https://example.com/source',
        content: 'Useful snippet',
        published_date: '2026-10-21',
      }],
    });
  }, async () => {
    const result = await searchWeb('latest info', { apiKey: 'test-key' });
    assert.equal(result.ok, true);
    assert.equal(result.results[0].title, 'Official result');
    assert.equal(result.results[0].content, 'Useful snippet');
    assert.equal(request.query, 'latest info');
    assert.equal(request.max_results, 4);
  });
});

test('handles empty, malformed, and failed Tavily responses without throwing', async () => {
  await withMockFetch(async () => Response.json({ results: [] }), async () => {
    assert.deepEqual(
      await searchWeb('latest info', { apiKey: 'test-key' }),
      { ok: true, results: [], reason: 'no_results' },
    );
  });

  await withMockFetch(async () => Response.json({ unexpected: true }), async () => {
    const result = await searchWeb('latest info', { apiKey: 'test-key' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'malformed_response');
  });

  await withMockFetch(async () => new Response('unavailable', { status: 503 }), async () => {
    const result = await searchWeb('latest info', { apiKey: 'test-key' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'http_503');
  });

  await withMockFetch(async () => {
    throw new TypeError('network failed');
  }, async () => {
    const result = await searchWeb('latest info', { apiKey: 'test-key' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'network_error');
  });

  await withMockFetch(async () => {
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  }, async () => {
    const result = await searchWeb('latest info', { apiKey: 'test-key' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'timeout');
  });
});

test('skips Tavily requests when its optional API key is missing', async () => {
  let calls = 0;
  await withMockFetch(async () => {
    calls += 1;
    return Response.json({ results: [] });
  }, async () => {
    const result = await searchWeb('latest info');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing_key');
    assert.equal(calls, 0);
  });
});
