import { describe, expect, it } from 'vitest';
import { parseAiReview, type AiReviewRequest } from '@control-kit/shared';
import { reviewWithAi, type AiEnv } from './ai-review';
import type { Kv } from './index';

class MemoryKv implements Kv {
  values = new Map<string, string>();
  async get(k: string) { return this.values.get(k) ?? null; }
  async put(k: string, v: string) { this.values.set(k, v); }
  async delete(k: string) { this.values.delete(k); }
}
/** HORS lines the deterministic layer could not settle (launch report, 2026-10-24). */
const request: AiReviewRequest = { version: 1, assembly: 'HORS', leftOut: 0, lines: [
  { id: 'L1', name: '24mm × 6mm Round Standoff', description: null, material: null, partNumber: null, configuration: [], usedIn: ['HORS > Left Pod'], quantity: 4, source: 'linked document',
    current: { disposition: 'review', suggestion: 'buy', match: 'unmatched', reason: 'Looks like standard hardware', packUnknown: false },
    candidates: [{ id: 'gobilda:150100060240', vendor: 'gobilda', sku: '1501-0006-0240', name: '1501 Series Round Standoff (6mm, 24mm Length)' }] },
  { id: 'L2', name: 'Control Hub REV-31-1152', description: null, material: null, partNumber: null, configuration: [], usedIn: ['HORS > Electronics'], quantity: 1, source: 'linked document',
    current: { disposition: 'review', suggestion: 'buy', match: 'unmatched', reason: null, packUnknown: false },
    candidates: [{ id: 'rev:311595', vendor: 'rev', sku: 'REV-31-1595', name: 'Control Hub' }] },
] };
const answer = { items: [
  { id: 'L1', disposition: 'buy', candidateId: 'gobilda:150100060240', confidence: 0.84, reason: 'Same diameter and length as the 1501 round standoff.' },
  { id: 'L2', disposition: 'buy', candidateId: 'rev:311595', confidence: 0.7, reason: 'REV-31-1152 is discontinued; REV-31-1595 is the current Control Hub.' },
] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const gemini = (body: unknown) => json({ candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }], usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 200 } });
const claude = (body: unknown) => json({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: JSON.stringify(body) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 250 } });
/** Answers each call from the list in order and records which host was asked. Nothing leaves the test. */
function mockFetch(...responses: Array<() => Response>) {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    calls.push(new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).host);
    const next = responses.shift();
    if (!next) throw new Error('unexpected call');
    return next();
  }) as typeof fetch;
  return { fetcher, calls };
}
const env = (keys: Partial<AiEnv> = {}): AiEnv => ({ APP_STATE: new MemoryKv(), ...keys });

describe('AI review providers (mocked)', () => {
  it('is off without a key and makes no call', async () => {
    const { fetcher, calls } = mockFetch();
    expect(await reviewWithAi(env(), request, fetcher)).toMatchObject({ ok: false, status: 501 });
    expect(calls).toEqual([]);
  });
  it('asks Gemini once, logs the call, and serves an unchanged rescan from the cache', async () => {
    const settings = env({ GEMINI_API_KEY: 'test-gemini' });
    const { fetcher, calls } = mockFetch(() => gemini(answer));
    const first = await reviewWithAi(settings, request, fetcher);
    expect(first).toMatchObject({ ok: true, provider: 'gemini', cached: false, usage: { inputTokens: 900, outputTokens: 200 } });
    const again = await reviewWithAi(settings, structuredClone(request), fetcher);
    expect(again).toMatchObject({ ok: true, cached: true });
    expect(calls).toEqual(['generativelanguage.googleapis.com']);
    const ledger = JSON.parse([...(settings.APP_STATE as MemoryKv).values.entries()].find(([key]) => key.startsWith('ai-ledger:'))![1]);
    // A cached answer writes nothing, not even to the ledger.
    expect(ledger).toMatchObject({ calls: 1, cached: 0, lines: 2, inputTokens: 900, outputTokens: 200, byProvider: { gemini: 1 } });
  });
  it('falls back to Anthropic once on a Gemini rate limit, and never on a Gemini key error', async () => {
    const limited = mockFetch(() => json({ error: { code: 429 } }, 429), () => claude(answer));
    expect(await reviewWithAi(env({ GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' }), request, limited.fetcher)).toMatchObject({ ok: true, provider: 'anthropic' });
    expect(limited.calls).toEqual(['generativelanguage.googleapis.com', 'api.anthropic.com']);
    const badKey = mockFetch(() => json({ error: { code: 403 } }, 403));
    expect(await reviewWithAi(env({ GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' }), request, badKey.fetcher)).toMatchObject({ ok: false, status: 502 });
    expect(badKey.calls).toEqual(['generativelanguage.googleapis.com']);
  });
  it('surfaces a rate limit or server error without retrying', async () => {
    const overloaded = mockFetch(() => json({ error: { code: 503 } }, 503), () => json({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 529));
    expect(await reviewWithAi(env({ GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' }), request, overloaded.fetcher)).toMatchObject({ ok: false, status: 503 });
    expect(overloaded.calls).toHaveLength(2);
    const onlyGemini = mockFetch(() => json({}, 429));
    expect(await reviewWithAi(env({ GEMINI_API_KEY: 'g' }), request, onlyGemini.fetcher)).toMatchObject({ ok: false, status: 429 });
    expect(onlyGemini.calls).toHaveLength(1);
  });
  it('drops invented products from the answer', async () => {
    const { fetcher } = mockFetch(() => gemini({ items: [{ id: 'L2', disposition: 'buy', candidateId: 'rev:311152', confidence: 0.9, reason: 'Named in the part.' }] }));
    expect(await reviewWithAi(env({ GEMINI_API_KEY: 'g' }), request, fetcher)).toMatchObject({ ok: true, items: [] });
  });
  it('validates a full 150-line answer in well under a millisecond of Worker CPU per line', () => {
    const lines = Array.from({ length: 150 }, (_, n) => ({ ...request.lines[0], id: `L${n + 1}` }));
    const big: AiReviewRequest = { ...request, lines };
    const raw = JSON.stringify({ items: lines.map(line => ({ ...answer.items[0], id: line.id })) });
    const started = performance.now();
    for (let round = 0; round < 20; round++) parseAiReview(JSON.parse(raw), big);
    const perAnswer = (performance.now() - started) / 20;
    // Measured locally: about 0.1–0.3 ms per 150-line answer; the Worker's free-plan limit is 10 ms per request.
    expect(perAnswer).toBeLessThan(5);
  });
});

describe('AI review allowance', () => {
  it('reserves a review before the call, refuses a second while one runs, and stops at the daily limit', async () => {
    const { reserveAiReview, releaseAiReview } = await import('./ai-review');
    const settings = env({ GEMINI_API_KEY: 'g' });
    expect(await reserveAiReview(settings, 'u1', 2)).toBeNull();
    expect(await reserveAiReview(settings, 'u1', 2)).toMatch(/already running/);
    await releaseAiReview(settings, 'u1');
    expect(await reserveAiReview(settings, 'u1', 2)).toBeNull();
    await releaseAiReview(settings, 'u1');
    expect(await reserveAiReview(settings, 'u1', 2)).toMatch(/limit reached/);
  });
});
