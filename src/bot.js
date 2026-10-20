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
    .setDescription('Switch PMC_AI between human-like and robot speaking styles.')
    .addStringOption((option) => option
      .setName('style')
      .setDescription('Choose a speaking style for this conversation.')
      .setRequired(true)
      .addChoices(
        { name: 'Human-like', value: 'human' },
        { name: 'Robot', value: 'robot' },
      )),
];

export function createDiscordClient() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
  });
  return client;
}

export async function startDiscordBot(config, memory = new ConversationMemory({
  ttlMs: config.memoryTtlMs,
  maxConversations: config.maxConversations,
})) {
  const client = createDiscordClient();
  client.on(Events.Error, (error) => {
    console.error('[discord] Client error:', safeErrorCode(error));
  });
  client.on(Events.ShardError, (error) => {
    console.error('[discord] Gateway connection error:', safeErrorCode(error));
  });

  client.on(Events.MessageCreate, (message) => {
    void handleMessageCreate(message, { client, config, memory });
  });
  client.on(Events.MessageUpdate, (oldMessage, newMessage) => {
    void handleMessageUpdate(oldMessage, newMessage, { client, memory });
  });
  client.on(Events.MessageDelete, (message) => {
    void handleMessageDelete(message, { memory });
  });
  client.on(Events.InteractionCreate, (interaction) => {
    void handleInteraction(interaction, { client, config, memory });
  });

  const readyPromise = new Promise((resolve) => client.once(Events.ClientReady, resolve));
  try {
    await client.login(config.discordToken);
    const readyClient = await readyPromise;
    await registerSlashCommands(readyClient, config);
    console.log(`[discord] Logged in as ${readyClient.user.username}.`);
    return client;
  } catch (error) {
    client.destroy();
    throw error;
  }
}

async function registerSlashCommands(client, config) {
  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  const body = slashCommands.map((command) => command.toJSON());
  const applicationId = client.application?.id ?? client.user.id;
  const route = config.discordGuildId
    ? Routes.applicationGuildCommands(applicationId, config.discordGuildId)
    : Routes.applicationCommands(applicationId);

  await rest.put(route, { body });
  console.log(`[discord] Registered ${body.length} slash commands (${config.discordGuildId ? 'guild' : 'global'} scope).`);
}

async function handleMessageCreate(message, context) {
  try {
    if (!message || message.author?.bot) return;
    if (!message.channel || typeof message.channel.sendTyping !== 'function') return;

    const clientUser = context.client.user;
    const isDirectMessage = !message.guildId;
    const isMentioned = Boolean(clientUser && message.mentions?.users?.has(clientUser.id));
    if (!isDirectMessage && !isMentioned) return;

    const key = conversationKey(message.channelId, message.author.id);
    const userText = extractUserText(message, clientUser?.id, isDirectMessage);

    await context.memory.withLock(key, async () => {
      const stopTyping = startTyping(message.channel);
      try {
        const modeChange = detectModeChange(userText);
        if (modeChange) {
          context.memory.setMode(key, modeChange);
          const reply = modeChange === 'robot'
            ? 'Robot mode activated. I will use a more mechanical speaking style in this conversation until you switch back.'
            : 'Human-like mode restored. I will use my normal conversational style in this conversation.';
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
        const history = context.memory.getHistory(key).slice(-24);
        const requestSearch = shouldSearch(userText);
        let searchResult = null;

        if (requestSearch) {
          searchResult = await searchWeb(userText, {
            apiKey: context.config.tavilyApiKey,
            timeoutMs: context.config.tavilyTimeoutMs,
          });
          if (!searchResult.ok) {
            console.warn('[tavily] Search unavailable:', searchResult.reason);
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
        console.error('[bot] Message processing failed:', safeErrorCode(error));
        try {
          await message.reply({
            content: 'I hit a temporary AI service issue. Please try again in a moment.',
            allowedMentions: { parse: [] },
          });
        } catch (sendError) {
          console.warn('[discord] Could not send error reply:', safeErrorCode(sendError));
        }
      } finally {
        stopTyping();
      }
    });
  } catch (error) {
    console.error('[bot] Message handler failed:', safeErrorCode(error));
  }
}

async function handleInteraction(interaction, { client, config, memory }) {
  if (!interaction.isChatInputCommand()) return;
  const key = conversationKey(interaction.channelId, interaction.user.id);

  try {
    if (interaction.commandName === 'ping') {
      await interaction.reply({
        content: `Pong! Gateway ping: ${Math.max(0, Math.round(client.ws.ping))} ms.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.commandName === 'help') {
      await interaction.reply({ content: helpText(), flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.commandName === 'clear') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await memory.withLock(key, async () => {
        memory.clear(key);
        await interaction.editReply('Cleared PMC_AI short-term memory for this conversation. This only clears the current channel/DM history.');
      });
      return;
    }

    if (interaction.commandName === 'mode') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const mode = interaction.options.getString('style', true);
      await memory.withLock(key, async () => {
        memory.setMode(key, mode);
        await interaction.editReply(mode === 'robot'
          ? 'Robot mode activated for this conversation.'
          : 'Human-like mode restored for this conversation.');
      });
    }
  } catch (error) {
    console.error('[discord] Interaction failed:', safeErrorCode(error));
    const response = { content: 'That command failed temporarily. Please try again.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(response).catch(() => {});
    } else {
      await interaction.reply(response).catch(() => {});
    }
  }
}

async function handleMessageUpdate(_oldMessage, newMessage, { client, memory }) {
  try {
    if (newMessage.partial) await newMessage.fetch().catch(() => null);
    if (!newMessage.author || newMessage.author.bot || !newMessage.id || !newMessage.channelId) return;
    const key = conversationKey(newMessage.channelId, newMessage.author.id);
    const updatedText = extractUserText(newMessage, client.user?.id, !newMessage.guildId);
    await memory.withLock(key, async () => {
      memory.updateUserMessage(key, newMessage.id, updatedText);
    });
  } catch (error) {
    console.warn('[memory] Could not process message edit:', safeErrorCode(error));
  }
}

async function handleMessageDelete(message, { memory }) {
  try {
    if (!message?.id || !message.channelId) return;
    const key = conversationKey(message.channelId, message.author?.id ?? 'unknown');
    await memory.withLock(key, async () => {
      memory.removeMessage(key, message.id);
    });
  } catch (error) {
    console.warn('[memory] Could not process message deletion:', safeErrorCode(error));
  }
}

function conversationKey(channelId, userId) {
  // The channel is the conversation boundary; userId is a fallback for channel-less interactions.
  return channelId ? `channel:${channelId}` : `user:${userId}`;
}

function extractUserText(message, botUserId, isDirectMessage) {
  let content = String(message.content ?? '');
  if (botUserId) {
    const mentionPattern = new RegExp(`<@!?${escapeRegExp(botUserId)}>`, 'g');
    content = content.replace(mentionPattern, ' ');
  }
  content = content.replace(/[ \t]+\n/g, '\n').trim();

  const attachments = [...(message.attachments?.values?.() ?? [])].slice(0, 5).map((attachment) => {
    const name = String(attachment.name ?? 'attachment').slice(0, 120);
    const url = String(attachment.url ?? '').slice(0, 500);
    return `[Attachment: ${name}${url ? ` — ${url}` : ''}]`;
  });
  if (attachments.length) content = `${content}${content ? '\n' : ''}${attachments.join('\n')}`;

  if (!content) {
    return isDirectMessage
      ? 'The user sent an empty message. Briefly ask what they need help with.'
      : 'The user mentioned PMC_AI without a text question. Briefly ask how you can help.';
  }
  return content.slice(0, 4000);
}

function detectModeChange(text) {
  const robot = /\b(?:robot\s+mode|act\s+like\s+a\s+robot|talk\s+like\s+a\s+robot|respond\s+like\s+a\s+robot|speak\s+like\s+a\s+robot|activate\s+robot\s+mode)\b/i;
  const human = /\b(?:human\s+mode|normal\s+mode|act\s+like\s+a\s+human|back\s+to\s+normal|switch\s+back\s+to\s+human)\b/i;
  if (robot.test(text)) return 'robot';
  if (human.test(text)) return 'human';
  return null;
}

function startTyping(channel) {
  void channel.sendTyping().catch(() => {});
  const timer = setInterval(() => void channel.sendTyping().catch(() => {}), 8000);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function sendResponse(message, text) {
  const chunks = splitDiscordMessage(text);
  const ids = [];
  const first = await message.reply({
    content: chunks[0],
    allowedMentions: { parse: [] },
  });
  ids.push(first.id);

  for (const chunk of chunks.slice(1)) {
    const sent = await message.channel.send({ content: chunk, allowedMentions: { parse: [] } });
    ids.push(sent.id);
  }
  return ids;
}


function helpText() {
  return [
    '**PMC_AI — Prince Miguel Cayetano’s AI**',
    '• Mention `@PMC_AI` in a server channel to chat. In DMs, send a message directly.',
    '• `/ping` — check responsiveness.',
    '• `/clear` — clear short-term history for the current channel or DM.',
    '• `/mode style:Robot` or `/mode style:Human-like` — change speaking style.',
    '• Or mention me and say `act like a robot` / `human mode`.',
    '• I use Groq GPT-OSS 120B and Tavily search for current information when useful.',
    'Memory is temporary, channel-specific, and resets when the service restarts.',
  ].join('\n');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeErrorCode(error) {
  const status = error?.status ?? error?.cause?.status;
  if (Number.isInteger(status)) return `http_${status}`;
  return String(error?.code ?? error?.name ?? 'unknown_error').slice(0, 80);
}
