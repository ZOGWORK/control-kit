import { useEffect, useRef, useState } from 'react';
import { buildControlPointPayload, controlPointIdempotencyKey, INLINE_FILE_LIMIT_BYTES, type AssemblyContext } from '@control-kit/shared';
import { api, postJson, workerUrl, type ControlKit } from './useControlKit';
import { makeListKey, workspaceAccent, type Accent } from './model';

/** One Control Point workspace the linked account belongs to (`docs/control-point-link.md` §2). */
export type Workspace = { id: number; name: string; ftcNumber: string | null; accentColor: string | null; canEditCad: boolean; cadUrl?: string };
/** `GET /api/control-point/link`. `available: false` means the Worker has no client secret, so linking is off. */
export type LinkState =
  | { linked: false; available?: boolean }
  | { linked: true; account: { email: string; name: string }; workspace: Workspace | null; workspaces: Workspace[]; linkedAt: string; refreshAfter?: string };
/** The last import of this assembly into Control Point. */
export type SentRecord = { importId: number; workspaceId: number; sentAt: string; idempotencyKey: string; url: string; created?: number; updated?: number; duplicate?: boolean };

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** The assembly picture (already drawn for the Overview) goes with a send, so Control Point can show the robot whole. */
const PICTURE_TYPE = 'image/png';
/** Choices made in Control Point that this scan picked up (`POST /api/control-point/decisions`, contract §5). */
export type Pulled = { scanId: string; types: number; products: number };
const workerOrigin = () => new URL(workerUrl || location.origin, location.href).origin;
/** The Worker's own wording for a failure when it gave one. */
const message = async (response: Response, fallback: string) => (await response.json().catch(() => null) as { error?: string } | null)?.error ?? fallback;

/**
 * The Control Point link: whether this person linked an account, which workspace sends go to, and the last send of
 * this assembly. The browser never sees a Control Point token; every call goes through the Worker, which holds it.
 * Nothing is sent without a click, and a failure here never touches the scan, Excel, or STEP.
 */
export function useControlPoint(kit: ControlKit) {
  const [link, setLink] = useState<LinkState | null>(null);
  const [sent, setSent] = useState<SentRecord | null>(null);
  const [busy, setBusy] = useState<'link' | 'workspace' | 'send' | 'unlink' | null>(null);
  const [error, setError] = useState('');
  const [pulled, setPulled] = useState<Pulled | null>(null);
  const popup = useRef<Window | null>(null);
  const connected = Boolean(kit.session?.connected);
  const result = kit.result;

  /** `fresh` asks Control Point for the workspace list now (for "Check again"); the Worker allows it every 30 seconds. */
  async function refresh(fresh = false) {
    try {
      const response = await api(fresh ? '/api/control-point/link?refresh=1' : '/api/control-point/link');
      // An older Worker without the link routes reads as "not available", never as an error on every page.
      setLink(response.ok ? await response.json() as LinkState : { linked: false, available: false });
    } catch { setLink({ linked: false, available: false }); }
  }
  useEffect(() => { if (connected) void refresh(); else setLink(null); }, [connected]);

  // The last send of this assembly, for "Sent to … · date".
  useEffect(() => {
    setSent(null);
    if (!connected || !result || link?.linked !== true) return;
    const controller = new AbortController();
    api(`/api/control-point/sent?${new URLSearchParams({ documentId: result.documentId, elementId: result.elementId })}`, { signal: controller.signal })
      .then(response => response.ok ? response.json() as Promise<SentRecord | null> : null).then(record => setSent(record ?? null)).catch(() => undefined);
    return () => controller.abort();
  }, [connected, result?.documentId, result?.elementId, link?.linked]);

  // The sign-in popup tells us when it is done; closing it without finishing also re-checks.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; reason?: string } | null;
      if (event.origin !== workerOrigin() || !data?.type?.startsWith('control-point-link')) return;
      setBusy(null);
      if (data.type === 'control-point-link-failed') setError(data.reason === 'cancelled' ? 'Linking was cancelled in Control Point.' : 'Control Point could not be linked. Try again.');
      void refresh();
    };
    window.addEventListener('message', onMessage);
    const timer = setInterval(() => { if (popup.current?.closed) { popup.current = null; setBusy(current => current === 'link' ? null : current); void refresh(); } }, 1000);
    return () => { window.removeEventListener('message', onMessage); clearInterval(timer); };
  }, []);

  // A linked workspace's colour becomes the brand accent; unlinked, or with a colour that fails contrast, it stays volt.
  const workspace = link?.linked ? link.workspace : null;
  // The key a send would carry now: it changes with the BOM, the workspace, and which files would go inline (the
  // workbook always, the STEP ZIP once exported this session), so "sent" means this exact BOM went to this workspace.
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  // The STEP ZIP goes with a send only when it was exported from this scan's current make list; it goes inline (and so
  // into the key) only up to the payload's inline limit, larger ZIPs travel as references, exactly as the builder decides.
  const zip = kit.lastStepZip.current;
  const zipCurrent = Boolean(kit.step?.zipMade) && Boolean(result) && zip?.scanId === result?.scanId && zip?.makeList === makeListKey(result!);
  const zipReady = zipCurrent && zip!.bytes.length <= INLINE_FILE_LIMIT_BYTES;
  useEffect(() => {
    setCurrentKey(null);
    if (!result || !workspace) return;
    let live = true;
    // The same choice times and files a send carries, so a choice saved since the last send shows as a change, and a
    // send without a picture (Onshape would not draw one) still reads as current.
    void Promise.all([kit.choiceTimes(result), assemblyPictureBytes()]).then(([choiceTimes, picture]) => controlPointIdempotencyKey(result, { workspaceId: workspace.id,
      inlineMediaTypes: [XLSX_TYPE, ...(picture ? [PICTURE_TYPE] : []), ...(zipReady ? ['application/zip'] : [])], choiceTimes: choiceTimes ?? undefined }))
      .then(key => { if (live) setCurrentKey(key); }).catch(() => undefined);
    return () => { live = false; };
  }, [result, workspace?.id, zipReady]);

  // Choices made in Control Point reach a scan here: once per scan, after matching, while a workspace is linked. The
  // Worker saves the newer ones as Control Kit's own, then the scan reloads its choices. A failure is quiet: the next
  // scan tries again, and nothing about the scan itself depends on it.
  const pulledFor = useRef<string | null>(null);
  useEffect(() => {
    const scanId = result?.scanId;
    if (!scanId || result!.vendorMatching === 'pending' || !workspace || pulledFor.current === scanId) return;
    pulledFor.current = scanId;
    const scanned = result!;
    void postJson('/api/control-point/decisions', { documentId: scanned.documentId, scanId })
      .then(async response => {
        if (!response.ok) { if ((await response.json().catch(() => null) as { code?: string } | null)?.code === 'revoked') void refresh(); return; }
        const counts = await response.json() as { types: number; products: number };
        setPulled({ scanId, types: counts.types, products: counts.products });
        if (counts.types || counts.products) await kit.refreshChoices(scanned);
      }).catch(() => undefined);
  }, [result?.scanId, result?.vendorMatching, workspace?.id]);

  const sentCurrent = Boolean(sent && workspace && currentKey && sent.workspaceId === workspace.id && sent.idempotencyKey === currentKey);
  const accent: Accent | null = workspaceAccent(workspace?.accentColor);
  useEffect(() => {
    const root = document.documentElement;
    const names = ['--ck-volt', '--ck-volt-hover', '--ck-volt-soft', '--ck-volt-ink'];
    if (accent) [accent.accent, accent.hover, accent.soft, accent.ink].forEach((value, index) => root.style.setProperty(names[index], value));
    else names.forEach(name => root.style.removeProperty(name));
    return () => names.forEach(name => root.style.removeProperty(name));
  }, [accent?.accent]);

  function startLink() {
    setError('');
    // Onshape's iframe cannot show Control Point's sign-in, so it opens in its own window.
    popup.current = window.open(`${workerUrl}/control-point/start`, 'control-point-link', 'popup,width=520,height=720');
    if (!popup.current) { setError('Allow pop-ups for Control Kit, then try again.'); return; }
    setBusy('link');
  }

  async function chooseWorkspace(id: number) {
    setBusy('workspace'); setError('');
    try {
      const response = await postJson('/api/control-point/workspace', { workspaceId: id });
      if (!response.ok) throw new Error(await message(response, 'That workspace could not be chosen. Try again.'));
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'That workspace could not be chosen.'); }
    finally { setBusy(null); }
  }

  /** The scan's assembly picture as PNG bytes (cached by the Worker per revision, and here per scan), or null. */
  const picture = useRef<{ scanId: string; bytes: Promise<Uint8Array | null> } | null>(null);
  function assemblyPictureBytes() {
    const scanId = result?.scanId;
    if (!scanId) return Promise.resolve(null);
    if (picture.current?.scanId !== scanId) {
      const entry = { scanId, bytes: drawPicture() };
      picture.current = entry;
      // Only a picture is kept: a failure (Onshape busy, a timeout) is asked again by the next send.
      void entry.bytes.then(bytes => { if (!bytes && picture.current === entry) picture.current = null; });
    }
    return picture.current.bytes;
  }
  async function drawPicture() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      // The isometric view shows the whole robot; Control Point shows it uncropped.
      const { url } = await kit.assemblyPicture('isometric', controller.signal);
      const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
      URL.revokeObjectURL(url);
      return bytes.length && bytes.length <= INLINE_FILE_LIMIT_BYTES ? bytes : null;
    } catch { return null; }
    finally { clearTimeout(timer); }
  }

  /** Sends this reviewed scan, as it is, with the workbook, the assembly picture and (when exported this session) the STEP ZIP. */
  async function send() {
    if (!result?.scanId || !workspace) return;
    setBusy('send'); setError('');
    try {
      const context = Object.fromEntries(['documentId', 'workspaceOrVersion', 'workspaceOrVersionId', 'elementId'].map(key => [key, kit.context.get(key) ?? ''])) as AssemblyContext;
      const files: Array<{ name: string; mediaType: string; bytes: Uint8Array }> = [];
      const filesNotIncluded: Array<{ name: string; reason: string }> = [];
      try { const book = await kit.buildWorkbook(); files.push({ name: book.filename, mediaType: XLSX_TYPE, bytes: book.bytes }); }
      catch { filesNotIncluded.push({ name: 'Excel BOM', reason: 'The workbook could not be built in the browser.' }); }
      const exported = kit.lastStepZip.current;
      if (exported && exported.scanId === result.scanId && exported.makeList === makeListKey(result)) files.push({ name: exported.name, mediaType: 'application/zip', bytes: exported.bytes });
      else filesNotIncluded.push({ name: 'STEP files', reason: exported && exported.scanId === result.scanId
        ? 'The make list changed after the STEP files were exported. Download them again from Make, then send again to attach them.'
        : 'Not exported in this session. Download STEP files from Make, then send again to attach them.' });
      const picture = await assemblyPictureBytes();
      if (picture) files.push({ name: `${result.assemblyName || 'Assembly'} assembly.png`, mediaType: PICTURE_TYPE, bytes: picture });
      else filesNotIncluded.push({ name: 'Assembly picture', reason: 'Onshape did not draw the assembly for this scan.' });
      const choiceTimes = await kit.choiceTimes(result);
      const payload = await buildControlPointPayload(result, { context, workspaceId: workspace.id, files, filesNotIncluded, choiceTimes: choiceTimes ?? undefined });
      // The workspace named on the button travels with the send; the Worker refuses it if the saved one changed meanwhile.
      const response = await api(`/api/control-point/send?${new URLSearchParams({ scanId: result.scanId, workspaceId: String(workspace.id) })}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      if (response.status === 409 && (await response.clone().json().catch(() => null) as { code?: string } | null)?.code === 'revoked') { await refresh(); throw new Error('Control Point ended the link. Link it again to send.'); }
      if (response.status === 409 && (await response.clone().json().catch(() => null) as { code?: string } | null)?.code === 'workspace_changed') { await refresh(); throw new Error('The workspace changed while sending. Check where it goes and send again.'); }
      if (response.status === 413) throw new Error('This BOM with its files is over 12 MB. Send it without the STEP files, or ask for a larger limit.');
      if (!response.ok) throw new Error(await message(response, 'The send failed. Your scan, Excel, and STEP files are untouched; try again.'));
      const body = await response.json() as { importId: number; url: string; sentAt: string; created: number; updated: number; duplicate: boolean };
      // What was just sent is current, whichever files it carried (a picture can arrive only at send time).
      setCurrentKey(payload.idempotencyKey);
      setSent({ importId: body.importId, workspaceId: workspace.id, sentAt: body.sentAt, idempotencyKey: payload.idempotencyKey, url: body.url, created: body.created, updated: body.updated, duplicate: body.duplicate });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The send failed. Try again.'); }
    finally { setBusy(null); }
  }

  async function unlink() {
    setBusy('unlink'); setError('');
    try {
      const response = await postJson('/api/control-point/unlink', {});
      if (!response.ok) throw new Error(await message(response, 'Control Point could not be unlinked. Try again.'));
      setSent(null); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Control Point could not be unlinked.'); }
    finally { setBusy(null); }
  }

  return { refresh, link, workspace, accent, sent, sentCurrent, pulled: pulled && pulled.scanId === result?.scanId ? pulled : null, busy, error, clearError: () => setError(''), startLink, chooseWorkspace, send, unlink };
}
export type ControlPoint = ReturnType<typeof useControlPoint>;
