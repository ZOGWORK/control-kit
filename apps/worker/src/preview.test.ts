import { describe, expect, it, vi } from 'vitest';
import { aggregateAssembly, type BomLine } from '@control-kit/shared';
import type { Kv } from './index';
import { linePreview, previewCacheKey, previewPath, PreviewUnavailableError } from './preview';

class MemoryKv implements Kv {
  values = new Map<string, string>();
  async get(key: string) { return this.values.get(key) ?? null; }
  async put(key: string, value: string) { this.values.set(key, value); }
  async delete(key: string) { this.values.delete(key); }
}
const result = aggregateAssembly({ rootAssembly: { instances: [
  { id: 'p', name: 'Intake Guide', type: 'Part', documentId: 'doc1', elementId: 'ps1', partId: 'JHD', configuration: 'len=10' },
  { id: 'm', name: '5203-2402-0014 assembly simple', type: 'Assembly', documentId: 'gobilda', elementId: 'motor', documentVersion: 'v9' },
] } }, { documentId: 'doc1', workspaceOrVersion: 'w', workspaceOrVersionId: 'w1', elementId: 'asm' }, 'Robot');
result.scanId = '00000000-0000-4000-8000-000000000001';
result.diagnostics = { onshapeRequests: null, metadataIssues: [], revision: { type: 'm', id: 'micro1' } };
const part = result.lines.find(line => line.partId === 'JHD')!;
const motor = result.lines.find(line => line.purchasedAssembly)!;
const png = btoa('PNG-BYTES');

describe('part pictures', () => {
  it('asks Onshape for the part, or for a product listed as one unit its whole assembly, at the scanned revision', () => {
    expect(previewPath(part, 'v9')).toBe('/api/v9/parts/d/doc1/w/w1/e/ps1/partid/JHD/shadedviews?viewMatrix=isometric&pixelSize=0&outputWidth=480&outputHeight=320&configuration=len%3D10');
    expect(previewPath(motor, 'v9')).toBe('/api/v9/assemblies/d/gobilda/v/v9/e/motor/shadedviews?viewMatrix=isometric&pixelSize=0&outputWidth=480&outputHeight=320');
    expect(previewPath({ ...part, sourceType: null } as BomLine, 'v9')).toBeNull();
  });
  it('caches a workspace part per scanned revision and a versioned one by its version', () => {
    expect(previewCacheKey('u1', result, part, 'h')).toBe('u1:preview:doc1:w:micro1:h');
    expect(previewCacheKey('u1', result, motor, 'h')).toBe('u1:preview:gobilda:v:v9:h');
  });
  it('spends one Onshape request the first time and none after', async () => {
    const kv = new MemoryKv();
    const fetchOnshape = vi.fn(async () => new Response(JSON.stringify({ images: [png] })));
    const first = await linePreview(part, 'key', kv, fetchOnshape, 'v9');
    const second = await linePreview(part, 'key', kv, fetchOnshape, 'v9');
    expect(new TextDecoder().decode(first)).toBe('PNG-BYTES');
    expect(new TextDecoder().decode(second)).toBe('PNG-BYTES');
    expect(fetchOnshape).toHaveBeenCalledTimes(1);
  });
  it('explains a part Onshape will not draw instead of failing the drawer', async () => {
    await expect(linePreview(part, 'key', new MemoryKv(), async () => new Response('{}', { status: 403 }), 'v9')).rejects.toThrow(PreviewUnavailableError);
    await expect(linePreview(part, 'key', new MemoryKv(), async () => new Response('{"images":[]}'), 'v9')).rejects.toThrow('no picture');
  });
});
