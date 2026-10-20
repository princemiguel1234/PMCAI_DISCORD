import 'dotenv/config';

function positiveInteger(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function requiredString(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function getConfig() {
  return Object.freeze({
    discordToken: requiredString('DISCORD_TOKEN'),
    groqApiKey: requiredString('GROQ_API_KEY'),
    tavilyApiKey: requiredString('TAVILY_API_KEY'),
    groqModel: process.env.GROQ_MODEL?.trim() || 'openai/gpt-oss-120b',
    discordGuildId: process.env.DISCORD_GUILD_ID?.trim() || '',
    port: positiveInteger('PORT', 10000, { min: 1, max: 65535 }),
    groqTimeoutMs: positiveInteger('GROQ_TIMEOUT_MS', 45000, { min: 5000, max: 120000 }),
    tavilyTimeoutMs: positiveInteger('TAVILY_TIMEOUT_MS', 15000, { min: 3000, max: 60000 }),
    memoryTtlMs: positiveInteger('MEMORY_TTL_MINUTES', 360, { min: 5, max: 10080 }) * 60_000,
    maxConversations: positiveInteger('MAX_CONVERSATIONS', 1000, { min: 10, max: 10000 }),
  });
}
