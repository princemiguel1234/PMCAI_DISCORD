const TEXT_MODEL = 'openai/gpt-oss-120b';
const VISION_MODEL = 'qwen/qwen3.8-27b';
const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 14 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 14 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const IMAGE_EXTENSIONS = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
]);
const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.mpeg', '.mpg']);

export function selectAttachmentRoute(attachments = []) {
  const files = [...attachments];
  if (!files.length) return { model: TEXT_MODEL, kind: 'text' };

  const kinds = files.map(classifyAttachment);
  if (kinds.some((kind) => kind !== 'image')) {
    return { model: TEXT_MODEL, kind: 'text', ignored: true, reason: 'unsupported_attachment' };
  }
  if (files.length > MAX_IMAGES) {
    return { model: TEXT_MODEL, kind: 'text', ignored: true, reason: 'attachment_limit' };
  }
  if (files.some((file) => Number(file.size) > MAX_IMAGE_BYTES)) {
    return { model: TEXT_MODEL, kind: 'text', ignored: true, reason: 'attachment_limit' };
  }
  if (files.reduce((total, file) => total + (Number(file.size) || 0), 0) > MAX_TOTAL_IMAGE_BYTES) {
    return { model: TEXT_MODEL, kind: 'text', ignored: true, reason: 'attachment_limit' };
  }

  return { model: VISION_MODEL, kind: 'images' };
}

export async function prepareAttachments(attachments = [], fetchImpl = fetch) {
  const files = [...attachments];
  const route = selectAttachmentRoute(files);
  if (route.kind === 'text') return { ...route, images: [] };

  const images = [];
  let totalBytes = 0;
  for (const attachment of files) {
    try {
      const image = await downloadImage(attachment, fetchImpl);
      totalBytes += image.bytes.length;
      if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
        return {
          model: TEXT_MODEL,
          kind: 'text',
          ignored: true,
          reason: 'attachment_limit',
          images: [],
        };
      }
      images.push(image);
    } catch {
      return {
        model: TEXT_MODEL,
        kind: 'text',
        ignored: true,
        reason: 'invalid_or_unavailable_image',
        images: [],
      };
    }
  }

  return { ...route, images };
}

function classifyAttachment(attachment) {
  const name = String(attachment?.name ?? '').toLowerCase();
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  const contentType = String(attachment?.contentType ?? '').split(';', 1)[0].trim().toLowerCase();

  if (
    contentType.startsWith('video/') ||
    VIDEO_TYPES.has(contentType) ||
    VIDEO_EXTENSIONS.has(extension)
  ) {
    return 'unsupported';
  }

  const extensionType = IMAGE_EXTENSIONS.get(extension);
  if (
    contentType &&
    (
      !IMAGE_TYPES.has(contentType) ||
      (extension && (!extensionType || extensionType !== contentType))
    )
  ) {
    return 'unsupported';
  }

  return IMAGE_TYPES.has(contentType) || (!contentType && extensionType)
    ? 'image'
    : 'unsupported';
}

async function downloadImage(attachment, fetchImpl) {
  const url = safeDiscordAttachmentUrl(attachment?.url);
  if (!url) throw new Error('Invalid attachment URL.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  timer.unref?.();

  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok || !response.body) throw new Error('Attachment download failed.');

    const responseType = String(response.headers.get('content-type') ?? '')
      .split(';', 1)[0]
      .trim()
      .toLowerCase();
    const declaredType = String(attachment.contentType ?? '')
      .split(';', 1)[0]
      .trim()
      .toLowerCase();
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
      throw new Error('Attachment is too large.');
    }

    const chunks = [];
    let byteLength = 0;
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      byteLength += bytes.length;
      if (byteLength > MAX_IMAGE_BYTES) throw new Error('Attachment is too large.');
      chunks.push(bytes);
    }
    if (!byteLength) throw new Error('Attachment is empty.');

    const bytes = Buffer.concat(chunks, byteLength);
    const actualType = detectImageType(bytes);
    if (!actualType || !IMAGE_TYPES.has(responseType) || responseType !== actualType) {
      throw new Error('Attachment is not a supported image.');
    }
    if (declaredType && declaredType !== actualType) {
      throw new Error('Attachment content type does not match its contents.');
    }

    return {
      mimeType: actualType,
      bytes,
      dataUrl: `data:${actualType};base64,${bytes.toString('base64')}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function safeDiscordAttachmentUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    const host = url.hostname.toLowerCase();
    const allowedHost = host === 'discordapp.com' ||
      host.endsWith('.discordapp.com') ||
      host === 'discord.com' ||
      host.endsWith('.discord.com') ||
      host === 'discordapp.net' ||
      host.endsWith('.discordapp.net');
    return url.protocol === 'https:' && allowedHost ? url.href : null;
  } catch {
    return null;
  }
}

function detectImageType(bytes) {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) return 'image/png';
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) return 'image/jpeg';
  if (
    bytes.length >= 6 &&
    ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))
  ) return 'image/gif';
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) return 'image/webp';
  return null;
}
