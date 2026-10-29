import { strToU8, zipSync } from 'fflate';
import { exportManifest, type ExportPart } from '../../shared/src/index';

export type StepZipInput = { assemblyName: string; documentName?: string; revision?: { type: string; id: string } | null; scannedAt: string; parts: ExportPart[];
  /** File text by part index, for parts whose state is `ready`. */
  files: Record<number, string>;
  /** DXF text by part index, for 2D-cut parts whose `dxf.state` is `ready`. */
  dxfFiles?: Record<number, string>; now?: Date };

/** Thrown when no part produced a file: a ZIP holding only a report would look like a successful export. */
export class NoStepFilesError extends Error {}

/**
 * Builds the download in the browser: successful STEP files grouped by process folder, each 2D-cut part's DXF beside
 * its STEP, plus MANIFEST.txt listing every file and every failure with its Onshape link. Failures are never only
 * inside the ZIP; the app shows them too.
 */
export function buildStepZip(input: StepZipInput) {
  const root = `${input.assemblyName.replace(/[^\w\- ]/g, '').trim().replace(/\s+/g, '_').slice(0, 80) || 'Assembly'}_STEP`;
  const folders: Record<ExportPart['disposition'], string> = { print: '3D_print', cnc: 'CNC', 'cut-2d': '2D_cut', fabricate: 'Fabricate', buy: 'Other', hardware: 'Other', ignore: 'Other', review: 'Other' };
  const files: Record<string, Uint8Array> = {};
  const dxfFiles = input.dxfFiles ?? {};
  const parts = input.parts.map((part, index) => {
    const step = part.state === 'ready' && input.files[index] === undefined ? { ...part, state: 'failed' as const, error: 'File was not downloaded' } : part;
    return step.dxf?.state === 'ready' && dxfFiles[index] === undefined ? { ...step, dxf: { ...step.dxf, state: 'failed' as const, error: 'DXF was not downloaded' } } : step;
  });
  parts.forEach((part, index) => {
    if (part.state === 'ready') files[`${root}/${folders[part.disposition]}/${part.fileName}`] = strToU8(input.files[index]);
    if (part.dxf?.state === 'ready') files[`${root}/${folders[part.disposition]}/${part.dxf.fileName}`] = strToU8(dxfFiles[index]);
  });
  if (!Object.keys(files).length) throw new NoStepFilesError(`No STEP file could be exported (${parts.length} part${parts.length === 1 ? '' : 's'} failed).`);
  const exportedAt = (input.now ?? new Date()).toISOString();
  files[`${root}/MANIFEST.txt`] = strToU8(exportManifest({ assemblyName: input.assemblyName, documentName: input.documentName, revision: input.revision, scannedAt: input.scannedAt, exportedAt, parts }));
  return { bytes: zipSync(files, { level: 6, mtime: input.now ?? new Date() }), filename: `${root}.zip`, ready: parts.filter(part => part.state === 'ready').length, failed: parts.filter(part => part.state === 'failed').length, dxf: parts.filter(part => part.dxf?.state === 'ready').length };
}
