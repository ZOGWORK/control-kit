import { strToU8, zipSync } from 'fflate';
import type { BomLine, ScanResult } from '@control-kit/shared';

type FetchOnshape = (path: string, init: RequestInit) => Promise<Response>;
type ZipOptions = { pollMs?: number; timeoutMs?: number; now?: Date };
const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});
const encode = encodeURIComponent;
function source(line: BomLine) {
  if (!line.sourceType || !line.sourceId) return null;
  return `d/${encode(line.documentId)}/${line.sourceType}/${encode(line.sourceId)}/e/${encode(line.elementId)}`;
}
function category(name: string) {
  if (/wheel|drive|swerve/i.test(name)) return 'drivetrain';
  if (/intake|roller/i.test(name)) return 'intake';
  if (/lift|slide|elevator/i.test(name)) return 'lift';
  if (/shooter|launch/i.test(name)) return 'shooter';
  if (/turret/i.test(name)) return 'turret';
  if (/frame|channel|rail/i.test(name)) return 'chassis';
  if (/electronic|sensor|circuit|wire/i.test(name)) return 'electronics';
  return 'misc';
}
function filename(line: BomLine) {
  const clean = line.name.toLowerCase().replace(/[^a-z0-9-_ ]/g, '').trim().replace(/ +/g, '_').slice(0, 80).replace(/[_-]+$/, '') || 'part';
  return `${clean}__${(line.partId ?? 'unknown').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'unknown'}.stl`;
}
function reason(error: unknown) { return error instanceof Error ? error.message.slice(0, 180) : 'Unknown STL export error'; }

/** Uses Onshape's single-part STL first, then the documented async translation path. */
export async function buildStlZip(result: ScanResult, apiVersion: string, fetchOnshape: FetchOnshape, requestSignal: AbortSignal, options: ZipOptions = {}) {
  const printed = result.lines.filter(line => line.classification === 'printed');
  const root = `${result.assemblyName.replace(/[^a-zA-Z0-9-_ ]/g, '').trim().replace(/ +/g, '_').slice(0, 80) || 'Assembly'}_prints`;
  const files: Record<string, Uint8Array> = {};
  const successes: { path: string; url: string }[] = [];
  const failures: { name: string; reason: string; url: string }[] = [];
  let index = 0;
  const pollMs = options.pollMs ?? 2000;
  const timeoutMs = options.timeoutMs ?? 60000;
  async function exportLine(line: BomLine) {
    const partSource = source(line);
    if (!partSource || !line.partId) throw Error('Part ID or source revision unavailable');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(Error('STL export timed out')), timeoutMs);
    const signal = AbortSignal.any([requestSignal, controller.signal]);
    try {
      const partId = encode(line.partId);
      // Onshape Parts/getPartSTL: https://onshape-public.github.io/docs/api-adv/parts/
      const configuration = line.configuration ? `&configuration=${encode(line.configuration)}` : '';
      const direct = await fetchOnshape(`/api/${apiVersion}/parts/${partSource}/partid/${partId}/stl?mode=binary&grouping=true&scale=1&units=mm${configuration}`, { signal });
      if (direct.ok) {
        const bytes = new Uint8Array(await direct.arrayBuffer());
        if (bytes.length) return bytes;
      }
      // Onshape PartStudios/createPartStudioTranslation: https://onshape-public.github.io/docs/api-adv/partstudios/
      const start = await fetchOnshape(`/api/${apiVersion}/partstudios/${partSource}/translations`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ formatName: 'STL', storeInDocument: false, partIds: line.partId, translate: true, ...(line.configuration ? { configuration: line.configuration } : {}) }), signal });
      if (!start.ok) throw Error(`STL translation request failed (HTTP ${start.status})`);
      const started = await start.json() as { id?: string; translationId?: string };
      const translationId = started.id ?? started.translationId;
      if (!translationId) throw Error('STL translation ID missing');
      while (true) {
        if (signal.aborted) throw signal.reason;
        // Onshape Translations/getTranslation: https://onshape-public.github.io/docs/api-adv/translation/
        const status = await fetchOnshape(`/api/${apiVersion}/translations/${encode(translationId)}`, { signal });
        if (!status.ok) throw Error(`STL translation status failed (HTTP ${status.status})`);
        const value = await status.json() as { requestState?: string; resultExternalDataIds?: string[]; failureReason?: string };
        if (value.requestState === 'FAILED') throw Error(value.failureReason ?? 'Onshape translation failed');
        if (value.requestState === 'DONE') {
          const externalDataId = value.resultExternalDataIds?.[0];
          if (!externalDataId) throw Error('STL translation output missing');
          // Onshape Documents/downloadExternalData: https://onshape-public.github.io/docs/api-adv/documents/
          const output = await fetchOnshape(`/api/${apiVersion}/documents/d/${encode(line.documentId)}/externaldata/${encode(externalDataId)}`, { signal });
          if (!output.ok) throw Error(`STL download failed (HTTP ${output.status})`);
          const bytes = new Uint8Array(await output.arrayBuffer());
          if (!bytes.length) throw Error('STL download was empty');
          return bytes;
        }
        await pause(pollMs, signal);
      }
    } finally { clearTimeout(timeout); }
  }
  async function worker() {
    while (index < printed.length) {
      const line = printed[index++];
      try {
        const bytes = await exportLine(line);
        const folder = category(line.name);
        let path = `${root}/${folder}/${filename(line)}`;
        for (let suffix = 2; files[path]; suffix++) path = `${root}/${folder}/${filename(line).replace(/\.stl$/, `_${suffix}.stl`)}`;
        files[path] = bytes;
        successes.push({ path, url: line.partStudioUrl });
      } catch (error) { failures.push({ name: line.name, reason: reason(error), url: line.partStudioUrl }); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, printed.length) }, () => worker()));
  successes.sort((a, b) => a.path.localeCompare(b.path));
  failures.sort((a, b) => a.name.localeCompare(b.name));
  const readme = [`Assembly: ${result.assemblyName}`, `Scan date: ${result.scannedAt}`, `Zip date: ${(options.now ?? new Date()).toISOString()}`, '',
    'STL files and source links:', ...successes.map(item => `${item.path}\n  ${item.url}`), '', 'FAILED parts:',
    ...(failures.length ? failures.map(item => `${item.name}: ${item.reason}\n  ${item.url}`) : ['None'])].join('\n');
  files[`${root}/README.txt`] = strToU8(readme);
  return { bytes: zipSync(files, { level: 0 }), filename: `${root}.zip`, failures };
}
