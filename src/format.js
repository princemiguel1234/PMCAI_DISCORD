const DISCORD_MESSAGE_LIMIT = 1900;

/** Split Discord replies below the API's 2,000 UTF-16-code-unit content limit. */
export function splitDiscordMessage(value, maxLength = DISCORD_MESSAGE_LIMIT) {
  let remaining = String(value ?? '').trim();
  if (!remaining) return ['I could not generate a text response.'];
  if (!Number.isInteger(maxLength) || maxLength < 4) throw new RangeError('maxLength must be an integer of at least 4.');

  const chunks = [];
  while (remaining.length > maxLength) {
    let end = maxLength;
    // JavaScript counts UTF-16 code units; avoid splitting a surrogate pair (for example, emoji).
    if (isHighSurrogate(remaining.charCodeAt(end - 1)) && isLowSurrogate(remaining.charCodeAt(end))) {
      end -= 1;
    }

    const preferredFloor = Math.floor(end * 0.55);
    const newlineAt = remaining.lastIndexOf('\n', end - 1);
    const spaceAt = remaining.lastIndexOf(' ', end - 1);
    if (newlineAt >= preferredFloor) end = newlineAt;
    else if (spaceAt >= preferredFloor) end = spaceAt;

    if (end < 1) end = maxLength;
    let chunk = remaining.slice(0, end).trimEnd();
    if (!chunk) {
      end = maxLength;
      if (isHighSurrogate(remaining.charCodeAt(end - 1)) && isLowSurrogate(remaining.charCodeAt(end))) end -= 1;
      chunk = remaining.slice(0, end);
    }
    chunks.push(chunk);
    remaining = remaining.slice(end).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks.length ? chunks : ['I could not generate a text response.'];
}

function isHighSurrogate(codeUnit) {
  return codeUnit >= 0xD800 && codeUnit <= 0xDBFF;
}

function isLowSurrogate(codeUnit) {
  return codeUnit >= 0xDC00 && codeUnit <= 0xDFFF;
}
