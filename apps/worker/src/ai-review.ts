import Anthropic from '@anthropic-ai/sdk';
import { aiReviewHash, aiReviewInstructions, aiReviewSchema, parseAiReview, AI_REVIEW_MAX_LINES, AI_REVIEW_VERSION, type AiProvider, type AiReviewItem, type AiReviewRequest } from '@control-kit/shared';
import type { Kv } from './index';

/**
 * The AI review's one server call per scan. Gemini (free tier) first; Anthropic once, only when Gemini answers with a
 * rate limit or a server error, never on an auth or configuration error. Neither is retried. Keys are Worker secrets.
 * With no key the review is off and everything else is unchanged.
 */
export type AiEnv = { APP_STATE: Kv; GEMINI_API_KEY?: string; ANTHROPIC_API_KEY?: string; GEMINI_MODEL?: string; ANTHROPIC_MODEL?: string };
export const aiReviewEnabled = (env: AiEnv) => Boolean(env.GEMINI_API_KEY?.trim() || env.ANTHROPIC_API_KEY?.trim());
const geminiModel = (env: AiEnv) => env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const anthropicModel = (env: AiEnv) => env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
/** Answers are cached per request and per configured models, so changing a model never serves another model's answer. */
const cacheKeyFor = async (env: AiEnv, request: AiReviewRequest) => `ai-review:${await aiReviewHash(request)}:${geminiModel(env)}:${anthropicModel(env)}`;
/** Reviews across all people per day: a hard ceiling on what one server key can spend. */
export const AI_GLOBAL_DAILY_LIMIT = 300;
const TIMEOUT_MS = 90_000;
const CACHE_SECONDS = 30 * 24 * 3600;
export type AiOutcome =
  | { ok: true; items: AiReviewItem[]; provider: AiProvider; cached: boolean; usage: { inputTokens: number | null; outputTokens: number | null } }
  | { ok: false; status: number; error: string };

/** Errors that may fall back to the other provider: a rate limit or the provider's own failure. */
class ProviderError extends Error {
  constructor(readonly provider: AiProvider, readonly status: number, readonly retryable: boolean, message: string) { super(message); }
}
const providerLabel: Record<AiProvider, string> = { gemini: 'Gemini', anthropic: 'Anthropic' };

/** Gemini's response schema is an OpenAPI subset: nullable instead of a type list, and no additionalProperties. */
const geminiSchema = {
  type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: {
    id: { type: 'string' }, disposition: { type: 'string', enum: [...aiReviewSchema.properties.items.items.properties.disposition.enum] },
    candidateId: { type: 'string', nullable: true }, confidence: { type: 'number' }, reason: { type: 'string' },
  }, required: ['id', 'disposition', 'candidateId', 'confidence', 'reason'] } } }, required: ['items'],
};

async function askGemini(env: AiEnv, request: AiReviewRequest, fetcher: typeof fetch) {
  // The same default as Control Point's Bruno (ai.ts), so one key behaves the same in both apps.
  const model = geminiModel(env);
  let response: Response;
  try {
    response = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY! },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: aiReviewInstructions }] }, contents: [{ role: 'user', parts: [{ text: JSON.stringify(request) }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: geminiSchema } }),
    });
  } catch (error) {
    throw new ProviderError('gemini', 504, false, error instanceof Error && error.name === 'TimeoutError' ? 'Gemini did not answer within 90 seconds.' : 'Could not reach Gemini.');
  }
  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    throw new ProviderError('gemini', response.status, retryable, response.status === 429 ? 'Gemini rate limit reached.' : retryable ? `Gemini failed (HTTP ${response.status}).` : `Gemini rejected the request (HTTP ${response.status}); check the key and model.`);
  }
  const body = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
  const text = body.candidates?.[0]?.content?.parts?.map(part => part.text ?? '').join('') ?? '';
  return { raw: text, usage: { inputTokens: body.usageMetadata?.promptTokenCount ?? null, outputTokens: body.usageMetadata?.candidatesTokenCount ?? null } };
}

async function askAnthropic(env: AiEnv, request: AiReviewRequest, fetcher: typeof fetch) {
  // No SDK retries: a 429 or 5xx is surfaced, never retried blindly.
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY!, maxRetries: 0, timeout: TIMEOUT_MS, fetch: fetcher });
  try {
    const message = await client.beta.messages.create({
      model: anthropicModel(env), max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      system: aiReviewInstructions,
      messages: [{ role: 'user', content: JSON.stringify(request) }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema: aiReviewSchema as unknown as Record<string, unknown> } },
    } as Parameters<typeof client.beta.messages.create>[0]) as Anthropic.Beta.BetaMessage;
    if (message.stop_reason === 'refusal') throw new ProviderError('anthropic', 502, false, 'Anthropic declined the request.');
    if (message.stop_reason === 'max_tokens') throw new ProviderError('anthropic', 502, false, 'Anthropic\'s answer was cut off.');
    const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
    return { raw: text, usage: { inputTokens: message.usage.input_tokens ?? null, outputTokens: message.usage.output_tokens ?? null } };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (error instanceof Anthropic.RateLimitError) throw new ProviderError('anthropic', 429, false, 'Anthropic rate limit reached.');
    if (error instanceof Anthropic.APIConnectionTimeoutError) throw new ProviderError('anthropic', 504, false, 'Anthropic did not answer within 90 seconds.');
    if (error instanceof Anthropic.APIError && typeof error.status === 'number') throw new ProviderError('anthropic', error.status, false, error.status >= 500 ? `Anthropic failed (HTTP ${error.status}).` : `Anthropic rejected the request (HTTP ${error.status}); check the key and model.`);
    throw new ProviderError('anthropic', 502, false, 'Could not reach Anthropic.');
  }
}

/** One aggregate per day: calls, lines reviewed, tokens, and failures by provider. Read-modify-write, so approximate under concurrency. */
async function logAiCall(env: AiEnv, entry: { provider: AiProvider; lines: number; ok: boolean; cached: boolean; inputTokens: number | null; outputTokens: number | null }) {
  const key = `ai-ledger:${new Date().toISOString().slice(0, 10)}`;
  let ledger: { calls: number; cached: number; failures: number; lines: number; inputTokens: number; outputTokens: number; byProvider: Record<string, number> } = { calls: 0, cached: 0, failures: 0, lines: 0, inputTokens: 0, outputTokens: 0, byProvider: {} };
  try { ledger = { ...ledger, ...JSON.parse(await env.APP_STATE.get(key) ?? '{}') }; } catch { /* Start a fresh day. */ }
  if (entry.cached) ledger.cached++;
  else {
    ledger.calls++;
    ledger.byProvider[entry.provider] = (ledger.byProvider[entry.provider] ?? 0) + 1;
    if (!entry.ok) ledger.failures++;
    ledger.lines += entry.lines;
    ledger.inputTokens += entry.inputTokens ?? 0;
    ledger.outputTokens += entry.outputTokens ?? 0;
  }
  await env.APP_STATE.put(key, JSON.stringify(ledger), { expirationTtl: 400 * 24 * 3600 });
}

/** Shape check before any provider is asked: small, versioned, and nothing beyond the fields the review uses. */
export function validAiRequest(value: unknown): value is AiReviewRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as AiReviewRequest;
  return request.version === AI_REVIEW_VERSION && typeof request.assembly === 'string' && Array.isArray(request.lines) && request.lines.length > 0 && request.lines.length <= AI_REVIEW_MAX_LINES
    && request.lines.every(line => line && typeof line.id === 'string' && typeof line.name === 'string' && Array.isArray(line.candidates) && line.candidates.length <= 8
      && line.candidates.every(candidate => candidate && typeof candidate.id === 'string' && typeof candidate.sku === 'string'));
}

/** A saved answer for exactly this request, or null. Costs no AI call and no allowance. */
export async function cachedAiReview(env: AiEnv, request: AiReviewRequest): Promise<AiOutcome | null> {
  const cached = await env.APP_STATE.get(await cacheKeyFor(env, request));
  if (!cached) return null;
  try {
    // A cached answer costs nothing and writes nothing, so repeated hits cannot use up KV writes.
    const saved = JSON.parse(cached) as { items: unknown; provider: AiProvider };
    return { ok: true, items: parseAiReview({ items: saved.items }, request), provider: saved.provider, cached: true, usage: { inputTokens: null, outputTokens: null } };
  } catch { return null; }
}

/**
 * Reserves one of a person's daily reviews before any provider is asked. Workers KV has no atomic counter, so a
 * short-lived lock refuses a second review while one is running, and the count is written before the call. Two
 * requests landing within KV's propagation window could still both pass; the providers' own quotas are the hard cap.
 */
export async function reserveAiReview(env: AiEnv, userId: string, limit = 20): Promise<string | null> {
  const day = new Date().toISOString().slice(0, 10);
  const lock = `ai-busy:${userId}`;
  if (await env.APP_STATE.get(lock)) return 'An AI review is already running for you. Try again when it finishes.';
  const countKey = `ai-user:${userId}:${day}`;
  const globalKey = `ai-global:${day}`;
  const used = Number(await env.APP_STATE.get(countKey) ?? 0);
  if (used >= limit) return `AI review limit reached for today (${limit} reviews). It resets at midnight UTC.`;
  const everyone = Number(await env.APP_STATE.get(globalKey) ?? 0);
  if (everyone >= AI_GLOBAL_DAILY_LIMIT) return 'AI review has reached its limit for today. It resets at midnight UTC.';
  // Longer than the slowest review (Gemini, then Anthropic, 90 seconds each).
  await env.APP_STATE.put(lock, '1', { expirationTtl: 200 });
  await env.APP_STATE.put(countKey, String(used + 1), { expirationTtl: 2 * 24 * 3600 });
  await env.APP_STATE.put(globalKey, String(everyone + 1), { expirationTtl: 2 * 24 * 3600 });
  return null;
}
export const releaseAiReview = (env: AiEnv, userId: string) => env.APP_STATE.delete(`ai-busy:${userId}`);

export async function reviewWithAi(env: AiEnv, request: AiReviewRequest, fetcher: typeof fetch = fetch): Promise<AiOutcome> {
  if (!aiReviewEnabled(env)) return { ok: false, status: 501, error: 'AI review is not set up on this server. Everything else works as before.' };
  const saved = await cachedAiReview(env, request);
  if (saved) return saved;
  const cacheKey = await cacheKeyFor(env, request);
  const order: AiProvider[] = env.GEMINI_API_KEY ? ['gemini', ...(env.ANTHROPIC_API_KEY ? ['anthropic' as const] : [])] : ['anthropic'];
  let failure: ProviderError | null = null;
  for (const provider of order) {
    try {
      const answer = provider === 'gemini' ? await askGemini(env, request, fetcher) : await askAnthropic(env, request, fetcher);
      let parsed: unknown = null;
      try { parsed = JSON.parse(answer.raw); } catch { /* Not JSON: no items survive. */ }
      const items = parseAiReview(parsed, request);
      await logAiCall(env, { provider, lines: request.lines.length, ok: true, cached: false, ...answer.usage });
      if (items.length) await env.APP_STATE.put(cacheKey, JSON.stringify({ items, provider }), { expirationTtl: CACHE_SECONDS });
      return { ok: true, items, provider, cached: false, usage: answer.usage };
    } catch (error) {
      failure = error instanceof ProviderError ? error : new ProviderError(provider, 502, false, `${providerLabel[provider]} failed.`);
      await logAiCall(env, { provider, lines: request.lines.length, ok: false, cached: false, inputTokens: null, outputTokens: null });
      // Only Gemini's rate limit or server error moves on to Anthropic, once.
      if (!(provider === 'gemini' && failure.retryable)) break;
    }
  }
  return { ok: false, status: failure!.status === 429 ? 429 : failure!.status >= 500 ? 503 : 502, error: failure!.message };
}
