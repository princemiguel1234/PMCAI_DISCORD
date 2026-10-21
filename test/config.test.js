import test from 'node:test';
import assert from 'node:assert/strict';
import { getConfig } from '../src/config.js';

const ENV_NAMES = [
  'DISCORD_TOKEN',
  'GROQ_API_KEY',
  'TAVILY_API_KEY',
  'GROQ_MODEL',
  'DISCORD_GUILD_ID',
  'PORT',
  'GROQ_TIMEOUT_MS',
  'TAVILY_TIMEOUT_MS',
  'MEMORY_TTL_MINUTES',
  'MAX_CONVERSATIONS',
];

async function withEnvironment(values, task) {
  const original = new Map(ENV_NAMES.map((name) => [name, process.env[name]]));
  for (const name of ENV_NAMES) delete process.env[name];
  Object.assign(process.env, values);
  try {
    await task();
  } finally {
    for (const name of ENV_NAMES) {
      const value = original.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('loads required runtime settings while allowing Tavily to be omitted', async () => {
  await withEnvironment({
    DISCORD_TOKEN: 'discord-test-token',
    GROQ_API_KEY: 'groq-test-key',
  }, async () => {
    const config = getConfig();
    assert.equal(config.discordToken, 'discord-test-token');
    assert.equal(config.groqApiKey, 'groq-test-key');
    assert.equal(config.tavilyApiKey, '');
    assert.equal(config.port, 10000);
  });
});

test('rejects malformed integer environment values rather than partially parsing them', async () => {
  await withEnvironment({
    DISCORD_TOKEN: 'discord-test-token',
    GROQ_API_KEY: 'groq-test-key',
    PORT: '8080invalid',
  }, async () => {
    assert.throws(() => getConfig(), /PORT must be an integer/);
  });
});
