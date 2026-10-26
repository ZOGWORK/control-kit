import { useEffect, useRef, useState } from 'react';
import { buildControlPointPayload, type AssemblyContext } from '@control-kit/shared';
import { api, postJson, workerUrl, type ControlKit } from './useControlKit';
import { workspaceAccent, type Accent } from './model';

/** One Control Point workspace the linked account belongs to (`docs/control-point-link.md` §2). */
export type Workspace = { id: number; name: string; ftcNumber: string | null; accentColor: string | null; canEditCad: boolean; cadUrl?: string };
/** `GET /api/control-point/link`. `available: false` means the Worker has no client secret, so linking is off. */
export type LinkState =
  | { linked: false; available?: boolean }
  | { linked: true; account: { email: string; name: string }; workspace: Workspace | null; workspaces: Workspace[]; linkedAt: string };
/** The last import of this assembly into Control Point. */
export type SentRecord = { importId: number; workspaceId: number; sentAt: string; idempotencyKey: string; url: string; created?: number; updated?: number; duplicate?: boolean };

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
  const popup = useRef<Window | null>(null);
  const connected = Boolean(kit.session?.connected);
  const result = kit.result;

  async function refresh() {
    try {
      const response = await api('/api/control-point/link');
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
      if (data.type === 'control-point-link-failed') setError(data.reason === 'access_denied' ? 'Linking was cancelled in Control Point.' : 'Control Point could not be linked. Try again.');
      void refresh();
    };
    window.addEventListener('message', onMessage);
    const timer = setInterval(() => { if (popup.current?.closed) { popup.current = null; setBusy(current => current === 'link' ? null : current); void refresh(); } }, 1000);
    return () => { window.removeEventListener('message', onMessage); clearInterval(timer); };
  }, []);

  // A linked workspace's colour becomes the brand accent; unlinked, or with a colour that fails contrast, it stays volt.
  const workspace = link?.linked ? link.workspace : null;
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

  /** Sends this reviewed scan, as it is, with the workbook and (when exported this session) the STEP ZIP. */
  async function send() {
    if (!result?.scanId || !workspace) return;
    setBusy('send'); setError('');
    try {
      const context = Object.fromEntries(['documentId', 'workspaceOrVersion', 'workspaceOrVersionId', 'elementId'].map(key => [key, kit.context.get(key) ?? ''])) as AssemblyContext;
      const files: Array<{ name: string; mediaType: string; bytes: Uint8Array }> = [];
      const filesNotIncluded: Array<{ name: string; reason: string }> = [];
      try { const book = await kit.buildWorkbook(); files.push({ name: book.filename, mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: book.bytes }); }
      catch { filesNotIncluded.push({ name: 'Excel BOM', reason: 'The workbook could not be built in the browser.' }); }
      const zip = kit.lastStepZip.current;
      if (zip && zip.scanId === result.scanId) files.push({ name: zip.name, mediaType: 'application/zip', bytes: zip.bytes });
      else filesNotIncluded.push({ name: 'STEP files', reason: 'Not exported in this session. Download STEP files from Make, then send again to attach them.' });
      const payload = await buildControlPointPayload(result, { context, workspaceId: workspace.id, files, filesNotIncluded });
      const response = await api(`/api/control-point/send?${new URLSearchParams({ scanId: result.scanId })}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      if (response.status === 401) { await refresh(); throw new Error('Control Point ended the link. Link it again to send.'); }
      if (response.status === 413) throw new Error('This BOM with its files is over 12 MB. Send it without the STEP files, or ask for a larger limit.');
      if (!response.ok) throw new Error(await message(response, 'The send failed. Your scan, Excel, and STEP files are untouched; try again.'));
      const body = await response.json() as { importId: number; url: string; sentAt: string; created: number; updated: number; duplicate: boolean };
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

  return { refresh, link, workspace, accent, sent, busy, error, clearError: () => setError(''), startLink, chooseWorkspace, send, unlink };
}
export type ControlPoint = ReturnType<typeof useControlPoint>;
