import type { BomLine, ScanResult } from '@control-kit/shared';
import type { Kv } from './index';

type FetchOnshape = (path: string, init?: RequestInit) => Promise<Response>;
const size = { outputWidth: '480', outputHeight: '320' };

/**
 * Onshape's shaded-view request for one line, at the revision the scan read: the part itself, or for a product
 * listed as one unit, its whole assembly. Null when the line has no readable source revision. A workspace part is drawn
 * at the microversion the scan read (`scanned`), so an edit made after the scan cannot change its picture.
 */
export function previewPath(line: BomLine, apiVersion: string, scanned?: { type: 'v' | 'm'; id: string } | null) {
  if (!line.sourceType || !line.sourceId || (!line.purchasedAssembly && !line.partId)) return null;
  const [type, id] = line.sourceType === 'w' && scanned ? [scanned.type, scanned.id] : [line.sourceType, line.sourceId];
  // A product folded from one Part Studio's bodies (it keeps a partId) is drawn as the whole Part Studio.
  const kind = line.purchasedAssembly && line.partId ? 'partstudios' : line.purchasedAssembly || !line.partId ? 'assemblies' : 'parts';
  const base = `/api/${apiVersion}/${kind}/d/${encodeURIComponent(line.documentId)}/${type}/${encodeURIComponent(id)}/e/${encodeURIComponent(line.elementId)}`;
  const query = new URLSearchParams({ viewMatrix: 'isometric', pixelSize: '0', ...size, ...(line.configuration && line.configuration !== 'default' ? { configuration: line.configuration } : {}) });
  return `${base}${kind === 'parts' ? `/partid/${encodeURIComponent(line.partId!)}` : ''}/shadedviews?${query}`;
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

/** The angles a team can pick for the assembly's picture, as Onshape's named views. */
export const assemblyViews = ['isometric', 'front', 'right', 'top'] as const;
export type AssemblyView = typeof assemblyViews[number];
export const assemblyView = (value: string | null): AssemblyView => (assemblyViews as readonly string[]).includes(value ?? '') ? value as AssemblyView : 'isometric';
const assemblyQuery = (view: AssemblyView) => new URLSearchParams({ viewMatrix: view, pixelSize: '0', outputWidth: '960', outputHeight: '600' });

/** The scanned assembly drawn whole, at the revision the scan read (null for a scan without one). */
export function assemblyPreviewPath(result: ScanResult, apiVersion: string, view: AssemblyView = 'isometric') {
  const revision = result.diagnostics?.revision;
  if (!revision) return null;
  return `/api/${apiVersion}/assemblies/d/${encodeURIComponent(result.documentId)}/${revision.type}/${encodeURIComponent(revision.id)}/e/${encodeURIComponent(result.elementId)}/shadedviews?${assemblyQuery(view)}`;
}
/** Per user, scanned revision, and view: a revision never changes, so a rescan of an unchanged assembly reuses its picture. Isometric keeps the original key. */
export const assemblyPreviewCacheKey = (userId: string, result: ScanResult, view: AssemblyView = 'isometric') =>
  `${userId}:preview-assembly:${result.documentId}:${result.elementId}:${result.diagnostics?.revision?.type ?? ''}:${result.diagnostics?.revision?.id ?? result.scanId ?? 'unknown'}${view === 'isometric' ? '' : `:${view}`}`;

/**
 * A picture drawn on request from the assembly as it is now (its workspace, or its version), kept per user, assembly,
 * and view with the time it was drawn. It replaces the scanned picture while it is newer than the scan.
 */
export const assemblyNowKey = (userId: string, result: ScanResult, view: AssemblyView) => `${userId}:preview-assembly-now:${result.documentId}:${result.elementId}:${view}`;
export type AssemblyNow = { at: string; image: string };
/** How long a person waits between redraws of one assembly and view: each costs a billable Onshape request. */
export const redrawPauseMs = 60_000;

/** The current workspace or version, drawn whole. */
export function assemblyNowPath(result: ScanResult, source: { type: 'w' | 'v'; id: string }, apiVersion: string, view: AssemblyView) {
  return `/api/${apiVersion}/assemblies/d/${encodeURIComponent(result.documentId)}/${source.type}/${encodeURIComponent(source.id)}/e/${encodeURIComponent(result.elementId)}/shadedviews?${assemblyQuery(view)}`;
}

/** The redrawn picture when it is newer than the scan, else null. */
export async function readAssemblyNow(kv: Kv, key: string, result: ScanResult): Promise<AssemblyNow | null> {
  const raw = await kv.get(key);
  if (!raw) return null;
  try {
    const now = JSON.parse(raw) as AssemblyNow;
    return typeof now.image === 'string' && Date.parse(now.at) > Date.parse(result.scannedAt) ? now : null;
  } catch { return null; }
}

/** PNG bytes from the cache, or from one Onshape shaded-view request that is then cached for 30 days. */
async function shadedView(path: string | null, cacheKey: string, kv: Kv, fetchOnshape: FetchOnshape, noun: string): Promise<Uint8Array> {
  const cached = await kv.get(cacheKey);
  if (cached) return Uint8Array.from(atob(cached), char => char.charCodeAt(0));
  if (!path) throw new PreviewUnavailableError(`This ${noun} has no readable source revision, so Onshape cannot draw it.`);
  const response = await fetchOnshape(path, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new PreviewUnavailableError(response.status === 403 || response.status === 404 ? `Onshape would not draw this ${noun}; its document may not be shared with you.` : `Onshape could not draw this ${noun} (HTTP ${response.status}).`);
  const body = await response.json().catch(() => null) as { images?: unknown } | null;
  const image = Array.isArray(body?.images) && typeof body.images[0] === 'string' ? body.images[0] : null;
  if (!image) throw new PreviewUnavailableError(`Onshape returned no picture for this ${noun}.`);
  await kv.put(cacheKey, image, { expirationTtl: 30 * 86400 });
  return Uint8Array.from(atob(image), char => char.charCodeAt(0));
}

/** PNG bytes for a line's picture, from the cache or one Onshape request. */
export function linePreview(line: BomLine, cacheKey: string, kv: Kv, fetchOnshape: FetchOnshape, apiVersion: string, scanned?: { type: 'v' | 'm'; id: string } | null): Promise<Uint8Array> {
  return shadedView(previewPath(line, apiVersion, scanned), cacheKey, kv, fetchOnshape, 'part');
}
/** PNG bytes for the whole assembly at its scanned revision, from the cache or one Onshape request. */
export function assemblyPreview(result: ScanResult, cacheKey: string, kv: Kv, fetchOnshape: FetchOnshape, apiVersion: string, view: AssemblyView = 'isometric'): Promise<Uint8Array> {
  return shadedView(assemblyPreviewPath(result, apiVersion, view), cacheKey, kv, fetchOnshape, 'assembly');
}

/** One Onshape request for the assembly as it is now, stored with the time it was drawn. */
export async function redrawAssembly(result: ScanResult, source: { type: 'w' | 'v'; id: string }, key: string, kv: Kv, fetchOnshape: FetchOnshape, apiVersion: string, view: AssemblyView): Promise<{ png: Uint8Array; at: string }> {
  const response = await fetchOnshape(assemblyNowPath(result, source, apiVersion, view), { headers: { accept: 'application/json' } });
  if (!response.ok) throw new PreviewUnavailableError(response.status === 403 || response.status === 404 ? 'Onshape would not draw this assembly; its document may not be shared with you.' : `Onshape could not draw this assembly (HTTP ${response.status}).`);
  const body = await response.json().catch(() => null) as { images?: unknown } | null;
  const image = Array.isArray(body?.images) && typeof body.images[0] === 'string' ? body.images[0] : null;
  if (!image) throw new PreviewUnavailableError('Onshape returned no picture for this assembly.');
  const at = new Date().toISOString();
  await kv.put(key, JSON.stringify({ at, image } satisfies AssemblyNow), { expirationTtl: 30 * 86400 });
  return { png: Uint8Array.from(atob(image), char => char.charCodeAt(0)), at };
}
