export const productName = 'Control Kit';

export type AssemblyContext = { documentId: string; workspaceOrVersion: 'w' | 'v' | 'm'; workspaceOrVersionId: string; elementId: string };
export type AssemblyInstance = { id: string; name: string; type: string; documentId: string; elementId: string; partId?: string; configuration?: string; fullConfiguration?: string; documentMicroversion?: string; versionId?: string; workspaceId?: string; suppressed?: boolean; isSuppressed?: boolean };
export type AssemblyDefinition = { rootAssembly: { name?: string; instances?: AssemblyInstance[] }; subAssemblies?: Array<{ documentId: string; elementId: string; configuration?: string; documentMicroversion?: string; instances?: AssemblyInstance[] }>; parts?: Array<{ documentId: string; elementId: string; partId: string; name?: string }> };
export type BomLine = { bomLineKey: string; name: string; description: string | null; documentId: string; elementId: string; partId: string | null; configuration: string | null; sourceType: 'w' | 'v' | 'm' | null; sourceId: string | null; qty: number; suppressed: boolean; instancePaths: string[]; massKg: number | null; material: string | null; missingMetadataReason: string | null; vendor: null; matchConfidence: number; classification: 'unknown'; classificationScore: number; classificationReasons: string[]; partStudioUrl: string; unresolvedSubassembly?: boolean };
export type ScanResult = { assemblyName: string; documentId: string; elementId: string; scannedAt: string; lines: BomLine[]; suppressed: BomLine[]; missingMetadata: BomLine[]; stats: { uniqueLines: number; totalInstances: number; totalCostUsd: number | null; outOfStockLines: number; printedLines: number; staleVendorData: boolean } };

function subassemblyKey(value: Pick<AssemblyInstance, 'documentId' | 'elementId' | 'configuration' | 'documentMicroversion'>) { return `${value.documentId}:${value.elementId}:${value.configuration ?? ''}:${value.documentMicroversion ?? ''}`; }

/** Reused subassemblies contribute once per insertion; suppression propagates to descendants. */
export function aggregateAssembly(definition: AssemblyDefinition, context: AssemblyContext, assemblyName: string): ScanResult {
  const definitions = new Map((definition.subAssemblies ?? []).map(part => [subassemblyKey(part), part]));
  const active = new Map<string, BomLine>();
  const suppressed = new Map<string, BomLine>();
  const partNames = new Map((definition.parts ?? []).map(part => [`${part.documentId}:${part.elementId}:${part.partId}`, part.name]));
  const rootName = assemblyName || definition.rootAssembly.name || 'Assembly';
  function add(instance: AssemblyInstance, path: string[], isSuppressed: boolean, unresolvedSubassembly = false) {
    const configuration = instance.fullConfiguration ?? instance.configuration ?? null;
    const partId = instance.partId ?? null;
    const sourceType = instance.documentMicroversion ? 'm' : instance.versionId ? 'v' : instance.workspaceId ? 'w' : instance.documentId === context.documentId ? context.workspaceOrVersion : null;
    const sourceId = instance.documentMicroversion ?? instance.versionId ?? instance.workspaceId ?? (instance.documentId === context.documentId ? context.workspaceOrVersionId : null);
    const key = `${instance.documentId}:${instance.elementId}:${partId ?? ''}:${configuration ?? ''}:${sourceType ?? ''}:${sourceId ?? ''}`;
    const bucket = isSuppressed ? suppressed : active;
    const found = bucket.get(key);
    if (found) { found.qty++; found.instancePaths.push(path.join(' > ')); return; }
    const source = sourceType && sourceId ? `${sourceType}/${encodeURIComponent(sourceId)}` : '';
    const name = partNames.get(`${instance.documentId}:${instance.elementId}:${partId}`) ?? instance.name.replace(/\s*<\d+>$/, '');
    bucket.set(key, { bomLineKey: key, name, description: null, documentId: instance.documentId, elementId: instance.elementId, partId, configuration, sourceType, sourceId, qty: 1, suppressed: isSuppressed,
      instancePaths: [path.join(' > ')], massKg: null, material: null, missingMetadataReason: null, vendor: null, matchConfidence: 0, classification: 'unknown', classificationScore: 0,
      classificationReasons: [], unresolvedSubassembly, partStudioUrl: source ? `https://cad.onshape.com/documents/${encodeURIComponent(instance.documentId)}/${source}/e/${encodeURIComponent(instance.elementId)}` : `https://cad.onshape.com/documents/${encodeURIComponent(instance.documentId)}` });
  }
  function walk(instances: AssemblyInstance[], path: string[], inheritedSuppression: boolean, ancestry: Set<string>) {
    for (const instance of instances) {
      const childPath = [...path, instance.name];
      const isSuppressed = inheritedSuppression || Boolean(instance.suppressed || instance.isSuppressed);
      if (instance.type.toLowerCase() !== 'assembly') { add(instance, childPath, isSuppressed); continue; }
      const key = subassemblyKey(instance);
      const child = definitions.get(key);
      if (!child || !Array.isArray(child.instances) || ancestry.has(key)) { add(instance, childPath, isSuppressed, true); continue; }
      walk(child.instances, childPath, isSuppressed, new Set([...ancestry, key]));
    }
  }
  walk(definition.rootAssembly.instances ?? [], [rootName], false, new Set());
  const lines = [...active.values()];
  const suppressedLines = [...suppressed.values()];
  return { assemblyName: rootName, documentId: context.documentId, elementId: context.elementId, scannedAt: new Date().toISOString(), lines, suppressed: suppressedLines, missingMetadata: [],
    stats: { uniqueLines: lines.length, totalInstances: lines.reduce((total, line) => total + line.qty, 0), totalCostUsd: null, outOfStockLines: 0, printedLines: 0, staleVendorData: false } };
}
