import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareAttachments, selectAttachmentRoute } from '../src/attachments.js';
import { buildSpeakerContext, generateReply } from '../src/ai.js';

const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function imageAttachment(overrides = {}) {
  return {
    name: 'picture.png',
    contentType: 'image/png',
    size: pngBytes.length,
    url: 'https://cdn.discordapp.com/attachments/123/picture.png',
    ...overrides,
  };
}

test('routes text, supported images, videos, unsupported files, and mixed attachments', () => {
  assert.equal(selectAttachmentRoute([]).model, 'openai/gpt-oss-120b');
  assert.equal(selectAttachmentRoute([imageAttachment()]).model, 'qwen/qwen3.8-27b');
  assert.equal(selectAttachmentRoute([
    imageAttachment(),
    { name: 'clip.mp4', contentType: 'video/mp4', size: 100 },
  ]).model, 'openai/gpt-oss-120b');
  assert.equal(selectAttachmentRoute([
    imageAttachment(),
    { name: 'document.pdf', contentType: 'application/pdf', size: 100 },
  ]).model, 'openai/gpt-oss-120b');
  assert.equal(selectAttachmentRoute([
    imageAttachment({ name: 'clip.mov', contentType: 'image/png' }),
  ]).model, 'openai/gpt-oss-120b');
  assert.equal(selectAttachmentRoute(
    Array.from({ length: 6 }, () => imageAttachment()),
  ).model, 'openai/gpt-oss-120b');
  assert.equal(selectAttachmentRoute([
    imageAttachment({ size: 15 * 1024 * 1024 }),
  ]).model, 'openai/gpt-oss-120b');
});

test('downloads supported image bytes and prepares a multimodal data URL', async () => {
  let requestedUrl;
  const prepared = await prepareAttachments([imageAttachment()], async (url) => {
    requestedUrl = url;
    return new Response(pngBytes, { headers: { 'content-type': 'image/png' } });
  });

  assert.equal(requestedUrl, imageAttachment().url);
  assert.equal(prepared.model, 'qwen/qwen3.8-27b');
  assert.equal(prepared.images.length, 1);
  assert.equal(prepared.images[0].mimeType, 'image/png');
  assert.equal(prepared.images[0].dataUrl, `data:image/png;base64,${pngBytes.toString('base64')}`);
});

test('invalid or inaccessible images fall back to text-only routing', async () => {
  const invalid = await prepareAttachments([imageAttachment({ url: 'https://example.com/image.png' })]);
  assert.equal(invalid.model, 'openai/gpt-oss-120b');
  assert.deepEqual(invalid.images, []);

  const unavailable = await prepareAttachments([imageAttachment()], async () => {
    throw new TypeError('network failed');
  });
  assert.equal(unavailable.model, 'openai/gpt-oss-120b');
  assert.equal(unavailable.ignored, true);
  assert.deepEqual(unavailable.images, []);

  const invalidContents = await prepareAttachments([imageAttachment()], async () => (
    new Response(Buffer.from('not an image'), {
      headers: { 'content-type': 'image/png' },
    })
  ));
  assert.equal(invalidContents.model, 'openai/gpt-oss-120b');
  assert.equal(invalidContents.reason, 'invalid_or_unavailable_image');
  assert.deepEqual(invalidContents.images, []);
});

test('does not download an image when an unsupported attachment is also present', async () => {
  let requested = false;
  const prepared = await prepareAttachments([
    imageAttachment(),
    { name: 'clip.mp4', contentType: 'video/mp4', size: 100 },
  ], async () => {
    requested = true;
    throw new Error('must not request the image');
  });

  assert.equal(requested, false);
  assert.equal(prepared.model, 'openai/gpt-oss-120b');
  assert.deepEqual(prepared.images, []);
});

test('generates text-only and image requests using their selected models and speaker context', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return Response.json({ choices: [{ message: { content: 'Answer' } }] });
  };

  try {
    const config = { groqTimeoutMs: 5000, groqApiKey: 'test-key' };
    const common = {
      userText: 'What is this?',
      speakerContext: 'Discord speaker: Alice; user ID: 42.',
      history: [{ role: 'user', content: 'Earlier question' }],
      config,
    };

    await generateReply({ ...common, model: 'openai/gpt-oss-120b' });
    await generateReply({
      ...common,
      model: 'qwen/qwen3.8-27b',
      images: [{ dataUrl: `data:image/png;base64,${pngBytes.toString('base64')}` }],
    });

    const textBody = requests[0];
    assert.equal(textBody.model, 'openai/gpt-oss-120b');
    assert.equal(typeof textBody.messages.at(-1).content, 'string');
    assert.match(textBody.messages.at(-1).content, /Alice; user ID: 42/);
    assert.ok(textBody.messages.some((message) => message.content === 'Earlier question'));

    const imageBody = requests[1];
    assert.equal(imageBody.model, 'qwen/qwen3.8-27b');
    assert.deepEqual(imageBody.messages.at(-1).content[1], {
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${pngBytes.toString('base64')}` },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('builds identity and server/channel context from the triggering Discord author', () => {
  const context = buildSpeakerContext({
    author: { username: 'alice', globalName: 'Alice A.', id: 'user-42' },
    member: { displayName: 'Alice in Server' },
    guild: { name: 'PMC Server' },
    guildId: 'guild-7',
    channel: { name: 'general' },
    channelId: 'channel-9',
  });

  assert.match(context, /"username":"alice"/);
  assert.match(context, /"displayName":"Alice in Server"/);
  assert.match(context, /"userId":"user-42"/);
  assert.match(context, /"server":"PMC Server"/);
  assert.match(context, /"channel":"general"/);
  assert.match(context, /human Discord user, not PMC_AI/);
});
