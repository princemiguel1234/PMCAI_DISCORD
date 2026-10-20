
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';

import { generateReply } from './ai.js';
import { shouldSearch, searchWeb } from './search.js';
import { ConversationMemory } from './memory.js';
import { splitDiscordMessage } from './format.js';

const READY_TIMEOUT_MS = 45_000;
const MAX_USER_MESSAGE_LENGTH = 4000;
const MAX_HISTORY_MESSAGES = 24;

const slashCommands = [
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check whether PMC_AI is responsive.'),

  new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Clear PMC_AI short-term memory for this conversation.'),

  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show PMC_AI features and commands.'),

  new SlashCommandBuilder()
    .setName('mode')
    .setDescription('Switch PMC_AI speaking styles.')
    .addStringOption((option) =>
      option
        .setName('style')
        .setDescription('Choose a speaking style.')
        .setRequired(true)
        .addChoices(
          { name: 'Human-like', value: 'human' },
          { name: 'Robot', value: 'robot' },
        ),
    ),
];

export function createDiscordClient() {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [
      Partials.Channel,
      Partials.Message,
    ],
  });
}

export async function startDiscordBot(
  config,
  memory = new ConversationMemory({
    ttlMs: config.memoryTtlMs,
    maxConversations: config.maxConversations,
  }),
) {
  if (!config?.discordToken?.trim()) {
    throw new Error(
      'DISCORD_TOKEN is missing or empty. Check your Render environment variables.',
    );
  }

  const client = createDiscordClient();

  // Keep the actual error details so Render logs can identify the cause.
  client.on(Events.Error, (error) => {
    logError('[discord] Client error', error);
  });

  client.on(Events.ShardError, (error, shardId) => {
    console.error(
      `[discord] Gateway error on shard ${shardId}:`,
    );
    logError('[discord] Gateway details', error);
  });

  client.on(Events.ShardDisconnect, (event, shardId) => {
    console.warn(
      `[discord] Shard ${shardId} disconnected. Close code: ${
        event?.code ?? 'unknown'
      }; reason: ${event?.reason || 'none'}`,
    );
  });

  client.on(Events.ShardReconnecting, (shardId) => {
    console.warn(`[discord] Shard ${shardId} reconnecting.`);
  });

  client.on(Events.ShardResume, (shardId) => {
    console.log(`[discord] Shard ${shardId} resumed.`);
  });

  client.on(Events.MessageCreate, (message) => {
    void handleMessageCreate(message, { client, config, memory });
  });

  client.on(Events.MessageUpdate, (oldMessage, newMessage) => {
    void handleMessageUpdate(oldMessage, newMessage, {
      client,
      memory,
    });
  });

  client.on(Events.MessageDelete, (message) => {
    void handleMessageDelete(message, { memory });
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void handleInteraction(interaction, { client, config, memory });
  });

  // Install the ready listener BEFORE logging in to avoid missing
  // the event if the client becomes ready quickly.
  const readyWait = waitForClientReady(client, READY_TIMEOUT_MS);

  try {
    console.log('[discord] Connecting to Discord Gateway...');

    await client.login(config.discordToken.trim());

    const readyClient = await readyWait.promise;

    console.log(
      `[discord] Connected as ${readyClient.user.tag}.`,
    );

    await registerSlashCommands(readyClient, config);

    console.log('[discord] PMC_AI startup completed.');

    return client;
  } catch (error) {
    readyWait.cancel();

    console.error('[startup] PMC_AI failed to start.');
    logError('[startup] Failure details', error);

    client.destroy();

    throw error;
  }
}

function waitForClientReady(client, timeoutMs) {
  let timer;

  let onReady;

  const promise = new Promise((resolve, reject) => {
    onReady = (readyClient) => {
      clearTimeout(timer);
      resolve(readyClient);
    };

    timer = setTimeout(() => {
      client.off(Events.ClientReady, onReady);

      reject(
        new Error(
          `Discord client did not become ready within ${timeoutMs} ms.`,
        ),
      );
    }, timeoutMs);

    timer.unref?.();

    client.once(Events.ClientReady, onReady);
  });

  return {
    promise,

    cancel() {
      clearTimeout(timer);
      client.off(Events.ClientReady, onReady);
    },
  };
}

async function registerSlashCommands(client, config) {
  const rest = new REST({ version: '10' }).setToken(
    config.discordToken.trim(),
  );

  const body = slashCommands.map((command) => command.toJSON());

  const applicationId = client.application?.id ?? client.user?.id;

  if (!applicationId) {
    throw new Error(
      'Cannot register slash commands: Discord application ID is missing.',
    );
  }

  const route = config.discordGuildId
    ? Routes.applicationGuildCommands(
        applicationId,
        config.discordGuildId,
      )
    : Routes.applicationCommands(applicationId);

  await rest.put(route, { body });

  console.log(
    `[discord] Registered ${body.length} slash commands (${
      config.discordGuildId ? 'guild' : 'global'
    } scope).`,
  );
}

async function handleMessageCreate(message, context) {
  try {
    if (!message || message.author?.bot) return;

    if (
      !message.channel ||
      typeof message.channel.sendTyping !== 'function'
    ) {
      return;
    }

    const clientUser = context.client.user;
    const isDirectMessage = !message.guildId;

    const isMentioned = Boolean(
      clientUser &&
      message.mentions?.users?.has(clientUser.id),
    );

    if (!isDirectMessage && !isMentioned) return;

    const key = conversationKey(
      message.channelId,
      message.author.id,
    );

    const userText = extractUserText(
      message,
      clientUser?.id,
      isDirectMessage,
    );

    await context.memory.withLock(key, async () => {
      const stopTyping = startTyping(message.channel);

      try {
        const modeChange = detectModeChange(userText);

        if (modeChange) {
          context.memory.setMode(key, modeChange);

          const reply = modeChange === 'robot'
            ? 'Robot mode activated. I will use a more mechanical speaking style until you switch back.'
            : 'Human-like mode restored. I will use my normal conversational style.';

          const replyIds = await sendResponse(message, reply);

          context.memory.addExchange(key, {
            userContent: userText,
            assistantContent: reply,
            userMessageId: message.id,
            assistantMessageIds: replyIds,
          });

          return;
        }

        const mode = context.memory.getMode(key);

        const history = context.memory
          .getHistory(key)
          .slice(-MAX_HISTORY_MESSAGES);

        const requestSearch = shouldSearch(userText);

        let searchResult = null;

        if (requestSearch) {
          try {
            searchResult = await searchWeb(userText, {
              apiKey: context.config.tavilyApiKey,
              timeoutMs: context.config.tavilyTimeoutMs,
            });

            if (!searchResult?.ok) {
              console.warn(
                '[tavily] Search unavailable:',
                searchResult?.reason ?? 'unknown reason',
              );
            }
          } catch (error) {
            console.error('[tavily] Search failed.');
            logError('[tavily] Details', error);
          }
        }

        const reply = await generateReply({
          userText,
          history,
          mode,
          searchResult,
          searchWasRequested: requestSearch,
          config: context.config,
        });

        const replyIds = await sendResponse(message, reply);

        context.memory.addExchange(key, {
          userContent: userText,
          assistantContent: reply,
          userMessageId: message.id,
          assistantMessageIds: replyIds,
        });
      } catch (error) {
        console.error('[bot] Message processing failed.');
        logError('[bot] Details', error);

        try {
          await message.reply({
            content:
              'I hit a temporary AI service issue. Please try again in a moment.',
            allowedMentions: { parse: [] },
          });
        } catch (sendError) {
          logError('[discord] Could not send error reply', sendError);
        }
      } finally {
        stopTyping();
      }
    });
  } catch (error) {
    console.error('[bot] Message handler failed.');
    logError('[bot] Handler details', error);
  }
}

async function handleInteraction(
  interaction,
  { client, memory },
) {
  if (!interaction.isChatInputCommand()) return;

  const key = conversationKey(
    interaction.channelId,
    interaction.user.id,
  );

  try {
    if (interaction.commandName === 'ping') {
      await interaction.reply({
        content: `Pong! Gateway ping: ${
          Math.max(0, Math.round(client.ws.ping))
        } ms.`,
        flags: MessageFlags.Ephemeral,
      });

      return;
    }

    if (interaction.commandName === 'help') {
      await interaction.reply({
        content: helpText(),
        flags: MessageFlags.Ephemeral,
      });

      return;
    }

    if (interaction.commandName === 'clear') {
      await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
      });

      await memory.withLock(key, async () => {
        memory.clear(key);

        await interaction.editReply(
          'Cleared PMC_AI short-term memory for this channel or DM and your account.',
        );
      });

      return;
    }

    if (interaction.commandName === 'mode') {
      const mode = interaction.options.getString('style', true);

      await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
      });

      await memory.withLock(key, async () => {
        memory.setMode(key, mode);

        await interaction.editReply(
          mode === 'robot'
            ? 'Robot mode activated for this conversation.'
            : 'Human-like mode restored for this conversation.',
        );
      });
    }
  } catch (error) {
    console.error('[discord] Interaction failed.');
    logError('[discord] Interaction details', error);

    const response = {
      content: 'That command failed temporarily. Please try again.',
      flags: MessageFlags.Ephemeral,
    };

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(response);
      } else {
        await interaction.reply(response);
      }
    } catch (replyError) {
      logError('[discord] Could not respond to interaction', replyError);
    }
  }
}

async function handleMessageUpdate(
  _oldMessage,
  newMessage,
  { client, memory },
) {
  try {
    if (newMessage.partial) {
      const fetched = await newMessage.fetch().catch(() => null);

      if (!fetched) return;

      newMessage = fetched;
    }

    if (
      !newMessage.author ||
      newMessage.author.bot ||
      !newMessage.id ||
      !newMessage.channelId
    ) {
      return;
    }

    const isDirectMessage = !newMessage.guildId;

    // Only track edits that are still relevant to the bot.
    const isMentioned = Boolean(
      client.user &&
      newMessage.mentions?.users?.has(client.user.id),
    );

    if (!isDirectMessage && !isMentioned) return;

    const key = conversationKey(
      newMessage.channelId,
      newMessage.author.id,
    );

    const updatedText = extractUserText(
      newMessage,
      client.user?.id,
      isDirectMessage,
    );

    await memory.withLock(key, async () => {
      memory.updateUserMessage(key, newMessage.id, updatedText);
    });
  } catch (error) {
    logError('[memory] Could not process message edit', error);
  }
}

async function handleMessageDelete(message, { memory }) {
  try {
    if (!message?.id || !message.channelId) return;

    if (!message.author || message.author.bot) return;

    const key = conversationKey(
      message.channelId,
      message.author.id,
    );

    await memory.withLock(key, async () => {
      memory.removeMessage(key, message.id);
    });
  } catch (error) {
    logError('[memory] Could not process message deletion', error);
  }
}

function conversationKey(channelId, userId) {
  // Separate each user's conversation within a shared channel.
  // This prevents one user's history from leaking into another's.
  return channelId
    ? `channel:${channelId}:user:${userId}`
    : `user:${userId}`;
}

function extractUserText(message, botUserId, isDirectMessage) {
  let content = String(message.content ?? '');

  if (botUserId) {
    const mentionPattern = new RegExp(
      `<@!?${escapeRegExp(botUserId)}>`,
      'g',
    );

    content = content.replace(mentionPattern, ' ');
  }

  content = content.replace(/[ \t]+\n/g, '\n').trim();

  const attachments = [
    ...(message.attachments?.values?.() ?? []),
  ]
    .slice(0, 5)
    .map((attachment) => {
      const name = String(
        attachment.name ?? 'attachment',
      ).slice(0, 120);

      const url = String(attachment.url ?? '').slice(0, 500);

      return `[Attachment: ${name}${url ? ` — ${url}` : ''}]`;
    });

  if (attachments.length) {
    content = `${content}${content ? '\n' : ''}${attachments.join('\n')}`;
  }

  if (!content) {
    return isDirectMessage
      ? 'The user sent an empty message. Briefly ask what they need help with.'
      : 'The user mentioned PMC_AI without a text question. Briefly ask how you can help.';
  }

  return content.slice(0, MAX_USER_MESSAGE_LENGTH);
}

function detectModeChange(text) {
  const robot =
    /\b(?:robot\s+mode|act\s+like\s+a\s+robot|talk\s+like\s+a\s+robot|respond\s+like\s+a\s+robot|speak\s+like\s+a\s+robot|activate\s+robot\s+mode)\b/i;

  const human =
    /\b(?:human\s+mode|normal\s+mode|act\s+like\s+a\s+human|back\s+to\s+normal|switch\s+back\s+to\s+human)\b/i;

  if (robot.test(text)) return 'robot';
  if (human.test(text)) return 'human';

  return null;
}

function startTyping(channel) {
  void channel.sendTyping().catch(() => {});

  const timer = setInterval(() => {
    void channel.sendTyping().catch(() => {});
  }, 8000);

  timer.unref?.();

  return () => clearInterval(timer);
}

async function sendResponse(message, text) {
  const chunks = splitDiscordMessage(String(text ?? ''));

  if (!chunks.length) {
    chunks.push('I could not generate a response. Please try again.');
  }

  const ids = [];

  const first = await message.reply({
    content: chunks[0],
    allowedMentions: { parse: [] },
  });

  ids.push(first.id);

  for (const chunk of chunks.slice(1)) {
    const sent = await message.channel.send({
      content: chunk,
      allowedMentions: { parse: [] },
    });

    ids.push(sent.id);
  }

  return ids;
}

function helpText() {
  return [
    '**PMC_AI — Prince Miguel Cayetano’s AI**',
    '• Mention `@PMC_AI` in a server channel to chat. In DMs, send a message directly.',
    '• `/ping` — check responsiveness.',
    '• `/clear` — clear your short-term history for this channel or DM.',
    '• `/mode style:Robot` or `/mode style:Human-like` — change speaking style.',
    '• Or mention me and say `act like a robot` / `human mode`.',
    '• I use Groq for AI replies and Tavily for web searches when configured.',
    '• Memory is temporary and resets when the service restarts.',
  ].join('\n');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function logError(label, error) {
  if (!(error instanceof Error)) {
    console.error(`${label}:`, error);
    return;
  }

  console.error(`${label}: ${error.name}: ${error.message}`);

  if (error.code !== undefined) {
    console.error(`${label} code:`, error.code);
  }

  if (error.status !== undefined) {
    console.error(`${label} HTTP status:`, error.status);
  }

  if (error.cause) {
    console.error(`${label} cause:`, error.cause);
  }

  if (error.stack) {
    console.error(`${label} stack:\n${error.stack}`);
  }
}
