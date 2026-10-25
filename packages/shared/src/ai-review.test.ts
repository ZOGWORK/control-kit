import { describe, expect, it } from 'vitest';
import { aiReviewHash, applyAiReview, buildAiReviewRequest, needsAiReview, parseAiReview } from './ai-review';
import { aggregateAssembly, classifyScan, type AssemblyDefinition, type BomLine } from './index';
import { normalizeName, normalizeSku, type VendorRecord } from './matching';

const context = { documentId: 'doc1', workspaceOrVersion: 'w' as const, workspaceOrVersionId: 'work1', elementId: 'elem1' };
const record = (sku: string, name: string, vendorId: VendorRecord['vendorId'] = 'gobilda'): VendorRecord => ({ vendorId, sku, normalizedSku: normalizeSku(sku, vendorId), name, normalizedName: normalizeName(name), url: 'https://www.gobilda.com/x/', priceUsd: 5, packSize: 1, packSizeVerified: true, stock: 'in', stockQty: null, category: 'structure', updatedAt: '2026-10-24T00:00:00.000Z', source: 'sitemap' });
/** Open gaps from the live HORS scan (docs/launch-report-2026-10-24.md) plus a FRCDesign library part. */
function horsGaps() {
  const part = (id: string, name: string, documentId = 'doc1') => ({ id, name, type: 'Part', documentId, elementId: `e-${id}`, partId: id });
  const definition: AssemblyDefinition = { rootAssembly: { instances: [
    part('standoff', '24mm × 6mm Round Standoff'), part('hub', 'Control Hub REV-31-1152', 'revlib'), part('ls1', '[LS] M4 x 12mm Socket Head Screw'),
    part('servohub', 'Servo Hub (GB)', 'frcdesign'), part('plate', 'Intake side plate'),
  ] } };
  const result = classifyScan(aggregateAssembly(definition, context, 'HORS'), { teamNumber: null }, {});
  const byName = (name: string) => result.lines.find(line => line.name === name)!;
  // What the matcher leaves on these lines: close records that were not chosen, and a possible match.
  byName('24mm × 6mm Round Standoff').nearMatches = [record('1501-0006-0240', '1501 Series Round Standoff (6mm, 24mm Length)'), record('1501-0006-0200', '1501 Series Round Standoff (6mm, 20mm Length)')];
  byName('Control Hub REV-31-1152').nearMatches = [record('REV-31-1595', 'Control Hub', 'rev')];
  Object.assign(byName('Servo Hub (GB)'), { matchStatus: 'possible', vendor: record('1908-0025-0032', '1908 Series Servo Hub (25 Tooth Spline, 32mm Diameter)'), choices: [record('1908-0025-0032', '1908 Series Servo Hub (25 Tooth Spline, 32mm Diameter)'), record('1908-0024-0032', '1908 Series Servo Hub (24 Tooth Spline, 32mm Diameter)')] } satisfies Partial<BomLine>);
  return result;
}

describe('AI review contract', () => {
  it('sends only the ambiguous bucket, never decided or settled lines', () => {
    const result = horsGaps();
    const plate = result.lines.find(line => line.name === 'Intake side plate')!;
    plate.manualClassification = 'cut-2d';
    const { request, keys } = buildAiReviewRequest(result);
    const sent = request.lines.map(line => line.name);
    expect(sent).toContain('24mm × 6mm Round Standoff');
    expect(sent).toContain('Servo Hub (GB)');
    expect(sent).not.toContain('Intake side plate');
    expect(Object.keys(keys)).toEqual(request.lines.map(line => line.id));
    expect(request.lines.find(line => line.name === 'Servo Hub (GB)')!.candidates.map(candidate => candidate.id)).toEqual(['gobilda:190800250032', 'gobilda:190800240032']);
    expect(needsAiReview({ ...plate, manualClassification: null, disposition: 'buy', dispositionConfidence: 'certain', matchStatus: 'exact', vendor: record('1', 'x') })).toBe(false);
  });
  it('never accepts a product the request did not offer, such as the discontinued Control Hub REV-31-1152', () => {
    const { request } = buildAiReviewRequest(horsGaps());
    const hub = request.lines.find(line => line.name === 'Control Hub REV-31-1152')!;
    const items = parseAiReview({ items: [
      { id: hub.id, disposition: 'buy', candidateId: 'rev:REV311152', confidence: 0.9, reason: 'Part number names it.' },
      { id: 'L999', disposition: 'print', candidateId: null, confidence: 0.5, reason: 'Unknown line.' },
      { id: request.lines[0].id, disposition: 'paint', candidateId: null, confidence: 0.5, reason: 'Bad type.' },
      { id: request.lines[0].id, disposition: 'buy', candidateId: null, confidence: 1.4, reason: 'Bad confidence.' },
    ] }, request);
    expect(items).toEqual([]);
    expect(parseAiReview('not json', request)).toEqual([]);
    const current = parseAiReview({ items: [{ id: hub.id, disposition: 'buy', candidateId: hub.candidates[0].id, confidence: 0.7, reason: 'REV-31-1152 is discontinued; REV-31-1595 is the current Control Hub.' }] }, request);
    expect(current).toHaveLength(1);
    expect(hub.candidates.map(candidate => candidate.sku)).toEqual(['REV-31-1595']);
  });
  it('puts answers on the lines they were asked about, even after other lines were decided', async () => {
    const result = horsGaps();
    const { request, keys } = buildAiReviewRequest(result);
    const standoff = request.lines.find(line => line.name.startsWith('24mm'))!;
    const items = parseAiReview({ items: [{ id: standoff.id, disposition: 'buy', candidateId: 'gobilda:150100060240', confidence: 0.82, reason: 'A 24mm long, 6mm round standoff matches the 1501 standoff.' }] }, request);
    // Another line is decided while the request runs, which changes the ambiguous bucket.
    const servo = result.lines.find(line => line.name === 'Servo Hub (GB)')!;
    servo.manualClassification = 'buy';
    const applied = applyAiReview(result, keys, items, 'gemini');
    expect(applied.lines.find(line => line.name.startsWith('24mm'))!.aiSuggestion).toMatchObject({ disposition: 'buy', candidateId: 'gobilda:150100060240', provider: 'gemini' });
    expect(applied.lines.filter(line => line.aiSuggestion)).toHaveLength(1);
    expect(await aiReviewHash(request)).toBe(await aiReviewHash(structuredClone(request)));
  });
});
