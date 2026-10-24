import type { BomLine, ScanResult } from '@control-kit/shared';
import type { Kv } from './index';

type FetchOnshape = (path: string, init?: RequestInit) => Promise<Response>;
const size = { outputWidth: '480', outputHeight: '320' };

/**
 * Onshape's shaded-view request for one line, at the revision the scan read: the part itself, or for a product
 * listed as one unit, its whole assembly. Null when the line has no readable source revision.
 */
export function previewPath(line: BomLine, apiVersion: string) {
  if (!line.sourceType || !line.sourceId || (!line.purchasedAssembly && !line.partId)) return null;
  const base = `/api/${apiVersion}/${line.purchasedAssembly || !line.partId ? 'assemblies' : 'parts'}/d/${encodeURIComponent(line.documentId)}/${line.sourceType}/${encodeURIComponent(line.sourceId)}/e/${encodeURIComponent(line.elementId)}`;
  const query = new URLSearchParams({ viewMatrix: 'isometric', pixelSize: '0', ...size, ...(line.configuration && line.configuration !== 'default' ? { configuration: line.configuration } : {}) });
  return `${base}${line.purchasedAssembly ? '' : `/partid/${encodeURIComponent(line.partId!)}`}/shadedviews?${query}`;
}

/**
 * A workspace keeps changing, so its previews are cached per scanned revision; versions and microversions never change.
 * Keys are scoped to the user, like the scan's own source cache.
 */
export function previewCacheKey(userId: string, result: ScanResult, line: BomLine, digest: string) {
  const revision = line.sourceType === 'w' ? result.diagnostics?.revision?.id ?? result.scanId ?? 'unknown' : line.sourceId;
  return `${userId}:preview:${line.documentId}:${line.sourceType}:${revision}:${digest}`;
}

export class PreviewUnavailableError extends Error {}

/** PNG bytes for a line's picture, from the cache or one Onshape request. */
export async function linePreview(line: BomLine, cacheKey: string, kv: Kv, fetchOnshape: FetchOnshape, apiVersion: string): Promise<Uint8Array> {
  const cached = await kv.get(cacheKey);
  if (cached) return Uint8Array.from(atob(cached), char => char.charCodeAt(0));
  const path = previewPath(line, apiVersion);
  if (!path) throw new PreviewUnavailableError('This part has no readable source revision, so Onshape cannot draw it.');
  const response = await fetchOnshape(path, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new PreviewUnavailableError(response.status === 403 || response.status === 404 ? 'Onshape would not draw this part; its document may not be shared with you.' : `Onshape could not draw this part (HTTP ${response.status}).`);
  const body = await response.json().catch(() => null) as { images?: unknown } | null;
  const image = Array.isArray(body?.images) && typeof body.images[0] === 'string' ? body.images[0] : null;
  if (!image) throw new PreviewUnavailableError('Onshape returned no picture for this part.');
  await kv.put(cacheKey, image, { expirationTtl: 30 * 86400 });
  return Uint8Array.from(atob(image), char => char.charCodeAt(0));
}
