const TAVILY_ENDPOINT = 'https://api.tavily.com/search';
const MAX_RESULTS = 4;
const MAX_SNIPPET_CHARS = 800;

/**
 * Conservative rules keep Tavily usage for requests where freshness or evidence matters.
 * This is intentionally heuristic; it does not make another AI call to decide whether to search.
 */
export function shouldSearch(text) {
  const value = String(text ?? '').trim();
  if (!value) return false;

  const explicitSearch = /\b(search|look\s+up|research|find\s+(?:sources|evidence|references)|cite\s+(?:sources|your\s+sources)|fact[- ]?check|verify\s+(?:this|that|whether|if)|check\s+(?:the\s+)?(?:latest|current|official)|sources?\s+please)\b/i;
  const freshness = /\b(latest|current|currently|today|tonight|this\s+week|this\s+month|recent(?:ly)?|newest|up[- ]to[- ]date|what\s+happened|breaking\s+news|release\s+notes|changelog|pricing|price\s+now|available\s+now)\b/i;
  const technicalFreshness = /\b(?:API|SDK|documentation|docs|npm|Node\.js|discord\.js|library|framework|software)\b.{0,45}\b(?:version|release|change|updated|latest|current|official|example|endpoint)\b/i;

  return explicitSearch.test(value) || freshness.test(value) || technicalFreshness.test(value);
}

export async function searchWeb(query, { apiKey, timeoutMs = 15000 } = {}) {
  if (!apiKey) return { ok: false, results: [], reason: 'missing_key' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  try {
    const response = await fetch(TAVILY_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: String(query).trim().slice(0, 1200),
        topic: 'general',
        search_depth: 'basic',
        max_results: MAX_RESULTS,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
        include_favicon: false,
        safe_search: true,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return { ok: false, results: [], reason: `http_${response.status}` };
    }

    const data = await response.json();
    if (!data || !Array.isArray(data.results)) {
      return { ok: false, results: [], reason: 'malformed_response' };
    }

    const results = data.results.slice(0, MAX_RESULTS).flatMap((item) => {
      if (!item || typeof item.title !== 'string' || typeof item.url !== 'string') return [];
      const url = validHttpUrl(item.url);
      if (!url) return [];
      return [{
        title: item.title.slice(0, 200),
        url,
        content: String(item.content ?? '').slice(0, MAX_SNIPPET_CHARS),
        publishedDate: typeof item.published_date === 'string' ? item.published_date.slice(0, 80) : '',
      }];
    });

    return { ok: true, results, reason: results.length ? null : 'no_results' };
  } catch (error) {
    return {
      ok: false,
      results: [],
      reason: error?.name === 'AbortError' ? 'timeout' : 'network_error',
    };
  } finally {
    clearTimeout(timer);
  }
}

function validHttpUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.href;
  } catch {
    return null;
  }
}
