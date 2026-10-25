import Anthropic from '@anthropic-ai/sdk';
import { aiReviewHash, aiReviewInstructions, aiReviewSchema, configurationValues, dispositions, normalizeSku, parseAiReview, AI_REVIEW_MAX_LINES, AI_REVIEW_VERSION, type AiProvider, type AiReviewItem, type AiReviewLine, type AiReviewRequest, type ScanResult } from '@control-kit/shared';
import type { AllowanceReply, AllowanceRequest } from './ai-allowance';
import type { Kv } from './index';

/**
 * The AI review's one server call per scan. Gemini (free tier) first; Anthropic once, only when Gemini answers with a
 * rate limit or a server error, never on an auth or configuration error. Neither is retried. Keys are Worker secrets.
 * With no key the review is off and everything else is unchanged.
 */
/** `AI_ALLOWANCE` is the Durable Object namespace holding the daily allowance (`ai-allowance.ts`). */
export type AiEnv = { APP_STATE: Kv; GEMINI_API_KEY?: string; ANTHROPIC_API_KEY?: string; GEMINI_MODEL?: string; ANTHROPIC_MODEL?: string;
  AI_ALLOWANCE?: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } } };
/** A key counts only when it holds something: a blank secret is no key. */
const hasGemini = (env: AiEnv) => Boolean(env.GEMINI_API_KEY?.trim());
const hasAnthropic = (env: AiEnv) => Boolean(env.ANTHROPIC_API_KEY?.trim());
export const aiReviewEnabled = (env: AiEnv) => (hasGemini(env) || hasAnthropic(env)) && Boolean(env.AI_ALLOWANCE);
const geminiModel = (env: AiEnv) => env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const anthropicModel = (env: AiEnv) => env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
/** Answers are cached per request and per configured models, so changing a model never serves another model's answer. */
const cacheKeyFor = async (env: AiEnv, request: AiReviewRequest) => `ai-review:${await aiReviewHash(request)}:${geminiModel(env)}:${anthropicModel(env)}`;
/** Reviews across all people per day: a hard ceiling on what one server key can spend (held atomically by `AI_ALLOWANCE`). */
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
      headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY!.trim() },
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
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY!.trim(), maxRetries: 0, timeout: TIMEOUT_MS, fetch: fetcher });
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
async function allowance(env: AiEnv, body: AllowanceRequest): Promise<AllowanceReply> {
  const stub = env.AI_ALLOWANCE!.get(env.AI_ALLOWANCE!.idFromName('global'));
  return await (await stub.fetch(new Request('https://allowance/', { method: 'POST', body: JSON.stringify(body) }))).json() as AllowanceReply;
}
const refusals: Record<Exclude<AllowanceReply, { ok: true }>['reason'], (limit: number) => string> = {
  busy: () => 'An AI review is already running for you. Try again when it finishes.',
  'user-limit': limit => `AI review limit reached for today (${limit} reviews). It resets at midnight UTC.`,
  'global-limit': () => 'AI review has reached its limit for today. It resets at midnight UTC.',
};
/** Reserves one of the person's daily reviews and one of everyone's, atomically, before any provider is asked. */
export async function reserveAiReview(env: AiEnv, userId: string, limit = 20): Promise<string | null> {
  // The lock outlasts the slowest review (Gemini, then Anthropic, 90 seconds each).
  const reply = await allowance(env, { action: 'reserve', userId, perUser: limit, global: AI_GLOBAL_DAILY_LIMIT, lockMs: 200_000 });
  return reply.ok ? null : refusals[reply.reason](limit);
}
export const releaseAiReview = async (env: AiEnv, userId: string) => { await allowance(env, { action: 'release', userId }); };

/** Text without control characters (code points below 32, and 127), cut to `max`. */
const plain = (value: unknown, max: number) => typeof value === 'string' ? [...value].map(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? ' ' : char).join('').slice(0, max) : '';
/**
 * The request as it is sent: every line rebuilt from the caller's own stored scan (name, description, material, part
 * number, configuration, places used, quantity, source, review reason; matched by the line key the browser sends for
 * each id), with only the browser's catalog candidates
 * and conclusion kept, both shape-checked. Unknown fields are dropped. Null when a line is not in that scan.
 */
export function trustedAiRequest(request: AiReviewRequest, keys: unknown, scan: ScanResult): AiReviewRequest | null {
  if (request.assembly !== scan.assemblyName || !keys || typeof keys !== 'object') return null;
  // Lines join the scan by line key, not name: two configurations or revisions of one part share a name.
  const byKey = new Map([...scan.lines, ...scan.suppressed].map(line => [line.bomLineKey, line]));
  const lineKeys = keys as Record<string, unknown>;
  const statuses = ['unmatched', 'possible', 'confirmed', 'exact', 'rejected'];
  const lines: AiReviewLine[] = [];
  for (const asked of request.lines) {
    const key = lineKeys[asked.id];
    const line = typeof key === 'string' ? byKey.get(key) : undefined;
    if (!line || line.name !== asked.name || !/^L\d{1,3}$/.test(asked.id)) return null;
    const current = asked.current ?? {} as AiReviewLine['current'];
    lines.push({
      id: asked.id, name: line.name, description: line.description, material: line.material, partNumber: line.partNumber,
      configuration: configurationValues(line.configuration), usedIn: line.instancePaths.slice(0, 3), quantity: line.qty,
      source: line.isStandardContent ? 'standard content' : line.documentId === scan.documentId ? 'this document' : 'linked document',
      current: {
        disposition: dispositions.includes(current.disposition) ? current.disposition : 'review',
        suggestion: dispositions.includes(current.suggestion as never) ? current.suggestion : null,
        match: statuses.includes(current.match) ? current.match : 'unmatched', reason: line.reviewReason, packUnknown: current.packUnknown === true,
      },
      // Candidates come from the browser's catalog match: each must be a well-formed catalog id for its own SKU.
      candidates: asked.candidates.filter(candidate => ['gobilda', 'servocity', 'andymark', 'rev', 'pitsco'].includes(candidate.vendor)
        && /^[A-Za-z0-9._-]{1,40}$/.test(candidate.sku) && candidate.id === `${candidate.vendor}:${normalizeSku(candidate.sku, candidate.vendor)}`)
        .map(candidate => ({ id: candidate.id, vendor: candidate.vendor, sku: candidate.sku, name: plain(candidate.name, 160) })),
    });
  }
  return { version: AI_REVIEW_VERSION, assembly: scan.assemblyName, leftOut: Math.max(0, Math.min(Number(request.leftOut) || 0, 10_000)), lines };
}

export async function reviewWithAi(env: AiEnv, request: AiReviewRequest, fetcher: typeof fetch = fetch): Promise<AiOutcome> {
  if (!aiReviewEnabled(env)) return { ok: false, status: 501, error: 'AI review is not set up on this server. Everything else works as before.' };
  const saved = await cachedAiReview(env, request);
  if (saved) return saved;
  const cacheKey = await cacheKeyFor(env, request);
  const order: AiProvider[] = hasGemini(env) ? ['gemini', ...(hasAnthropic(env) ? ['anthropic' as const] : [])] : ['anthropic'];
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
