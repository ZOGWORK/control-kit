import { useEffect, useState } from 'react';
import { Check, ExternalLink, Send } from 'lucide-react';
import { buildControlPointPayload, CONTROL_POINT_CAD_URL, type ControlPointCadPart } from '@control-kit/shared';
import { Alert } from '../components/arc/alert/alert';
import { Button } from './bits';
import type { ControlKit } from './useControlKit';
import type { ControlPoint, Workspace } from './useControlPoint';
import { ago, feedDates, money } from './model';

const CONTROL_POINT = 'https://tryctrlpoint.org';
export const createWorkspaceUrl = `${CONTROL_POINT}/teams?tab=workspaces&new=1`;
export const joinWorkspaceUrl = `${CONTROL_POINT}/teams?tab=workspaces&join=1`;
const external = { target: '_blank', rel: 'noopener noreferrer' } as const;

/** The workspace's initial in its colour, as Control Point's workspace switcher shows it. */
export function WorkspaceMark({ workspace, size = 22 }: { workspace: Workspace; size?: number }) {
  return <span className="workspace-mark" style={{ width: size, height: size, fontSize: size * 0.5 }} aria-hidden>{workspace.name.trim().charAt(0).toUpperCase() || '?'}</span>;
}
const workspaceName = (workspace: Workspace) => `${workspace.name}${workspace.ftcNumber ? ` · FTC ${workspace.ftcNumber}` : ''}`;

/**
 * Control Point on the Overview. Unlinked, it shows this scan as Control Point would hold it and what linking adds;
 * linked, it names the workspace next to every send. Nothing is sent without a click.
 */
export function ControlPointCard({ kit, cp, now }: { kit: ControlKit; cp: ControlPoint; now: number | null }) {
  const link = cp.link;
  if (!link) return null;
  return <section className="panel control-point" aria-labelledby="control-point">
    <div className="panel-head"><div className="cp-title">
      <img src="/control-point-icon.png" alt="" className="cp-logo" />
      <div><h2 id="control-point">Control Point</h2><p>{link.linked && cp.workspace ? 'Your team\'s workspace for parts, orders, and builds.' : 'Send this BOM to your team\'s workspace in one tap.'}</p></div>
    </div>
      <a className="link small" href={cp.workspace?.cadUrl ?? CONTROL_POINT_CAD_URL} {...external}>View CAD <ExternalLink aria-hidden size={11} /></a></div>
    <div className="panel-body stack">
      {cp.error && <Alert tone="danger" title={cp.error} onDismiss={cp.clearError} />}
      {!link.linked ? <Unlinked kit={kit} cp={cp} available={link.available !== false} />
        : !cp.workspace ? <Picker cp={cp} />
        : <Linked kit={kit} cp={cp} now={now} />}
    </div>
  </section>;
}

function Unlinked({ kit, cp, available }: { kit: ControlKit; cp: ControlPoint; available: boolean }) {
  return <>
    <Preview kit={kit} />
    <ul className="cp-payoff small">
      <li><Check aria-hidden size={13} />No retyping: the full BOM, Excel, and STEP go across together, and sending the same scan again never duplicates parts.</li>
      <li><Check aria-hidden size={13} />The whole team works from one list, with order status and who has each part.</li>
      <li><Check aria-hidden size={13} />CAD reviews, snapshots, and docs live next to the parts. Control Point is free.</li>
    </ul>
    <div className="inline-actions">
      {available ? <Button variant="secondary" loading={cp.busy === 'link'} onClick={cp.startLink}>Link Control Point</Button>
        : <span className="muted small">Linking opens once Control Point is ready for it.</span>}
      <a className="button-link" href={createWorkspaceUrl} {...external}>Create a free workspace <ExternalLink aria-hidden size={12} /></a>
    </div>
  </>;
}

/** This scan in Control Point's shape: its sections, counts, and the priced total. A preview, never a live account. */
function Preview({ kit }: { kit: ControlKit }) {
  const result = kit.result!;
  const [parts, setParts] = useState<ControlPointCadPart[] | null>(null);
  useEffect(() => {
    let live = true;
    void buildControlPointPayload(result, { workspaceId: null }).then(payload => { if (live) setParts(payload.cadParts); }).catch(() => undefined);
    return () => { live = false; };
  }, [result]);
  if (!parts) return null;
  const sections = [...parts.reduce((map, part) => map.set(part.section, [...(map.get(part.section) ?? []), part]), new Map<string, ControlPointCadPart[]>())]
    .sort((a, b) => b[1].length - a[1].length);
  const priced = parts.filter(part => part.unit_cost > 0);
  const total = Math.round(priced.reduce((sum, part) => sum + part.unit_cost * part.quantity, 0) * 100) / 100;
  return <figure className="cp-preview">
    <div className="cp-preview-head"><span className="small">Parts list</span><span className="num small">{priced.length ? money(total) : 'None priced'}</span></div>
    <ul>{sections.map(([section, items]) => <li key={section}>
      <span>{section}</span>
      <span className="cp-sources">{(['purchased', 'gobilda', 'printed', 'other'] as const).map(source => {
        const count = items.filter(item => item.source === source).length;
        return count ? <span key={source} className={`cp-source ${source}`} title={source}>{count}</span> : null;
      })}</span>
      <span className="num muted small">{items.length} parts</span>
    </li>)}</ul>
    <figcaption className="muted small">Preview: this is how {result.assemblyName} would appear in Control Point, every part To Order, unpriced parts left blank rather than $0.{feedDates(result.lines).map(note => ` ${note}.`).join('')}</figcaption>
  </figure>;
}

/** After linking: pick the workspace. One workspace is shown chosen but still confirmed; none gets create and join links. */
function Picker({ cp }: { cp: ControlPoint }) {
  const link = cp.link as Extract<ControlPoint['link'], { linked: true }>;
  const only = link.workspaces.length === 1 ? link.workspaces[0].id : null;
  const [chosen, setChosen] = useState<number | null>(only);
  // A single workspace that appears after "Check again" is preselected too, still waiting for confirmation.
  useEffect(() => { if (only !== null) setChosen(current => current ?? only); }, [only]);
  if (!link.workspaces.length) return <>
    <p className="small">Linked as {link.account.email}. You don't have a Control Point workspace yet.</p>
    {link.refreshAfter && Date.parse(link.refreshAfter) > Date.now() && <p className="muted small">Control Point was just checked; you can check again at {new Date(link.refreshAfter).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.</p>}
    <div className="inline-actions">
      <a className="button-link" href={createWorkspaceUrl} {...external}>Create a workspace <ExternalLink aria-hidden size={12} /></a>
      <a className="button-link" href={joinWorkspaceUrl} {...external}>Join one with a code <ExternalLink aria-hidden size={12} /></a>
      <Button variant="ghost" size="sm" onClick={() => void cp.refresh(true)}>Check again</Button>
    </div>
  </>;
  return <>
    <p className="small">Linked as {link.account.email}. Which workspace should this BOM go to?</p>
    <div className="workspace-list" role="radiogroup" aria-label="Control Point workspace">
      {link.workspaces.map(workspace => <button key={workspace.id} type="button" role="radio" aria-checked={chosen === workspace.id} className="workspace-option" onClick={() => setChosen(workspace.id)}>
        <WorkspaceMark workspace={workspace} /><span>{workspaceName(workspace)}</span>{!workspace.canEditCad && <span className="muted small">view only</span>}
      </button>)}
    </div>
    <div className="inline-actions"><Button variant="secondary" disabled={chosen === null} loading={cp.busy === 'workspace'} onClick={() => chosen !== null && void cp.chooseWorkspace(chosen)}>Use this workspace</Button></div>
  </>;
}

/** "2 part types and 1 product" */
function pulledText(pulled: { types: number; products: number }) {
  const types = pulled.types ? `${pulled.types} part type${pulled.types === 1 ? '' : 's'}` : '';
  const products = pulled.products ? `${pulled.products} product${pulled.products === 1 ? '' : 's'}` : '';
  return [types, products].filter(Boolean).join(' and ');
}

function Linked({ kit, cp, now }: { kit: ControlKit; cp: ControlPoint; now: number | null }) {
  const workspace = cp.workspace!;
  const sent = cp.sent && cp.sent.workspaceId === workspace.id ? cp.sent : null;
  const current = Boolean(sent) && cp.sentCurrent;
  return <>
    <div className="workspace-line"><WorkspaceMark workspace={workspace} size={28} /><div><strong>{workspace.name}</strong><span className="muted small">{workspace.ftcNumber ? `FTC ${workspace.ftcNumber}` : 'No FTC number'}</span></div></div>
    {!workspace.canEditCad && <Alert tone="warning" title="You can't edit CAD parts in this workspace">Ask a workspace admin for CAD access, or switch workspace in Settings.</Alert>}
    {sent && <p className="small cp-sent"><Check aria-hidden size={13} />{current ? 'This scan was sent' : 'An earlier scan was sent'}{now ? ` ${ago(sent.sentAt, now)}` : ''}{sent.created !== undefined ? `: ${sent.created} new, ${sent.updated ?? 0} updated` : ''}. <a className="link" href={sent.url} {...external}>View in Control Point <ExternalLink aria-hidden size={11} /></a></p>}
    {cp.pulled && cp.pulled.types + cp.pulled.products > 0 && <p className="small cp-sent"><Check aria-hidden size={13} />Picked up {pulledText(cp.pulled)} made in Control Point.</p>}
    <div className="inline-actions">
      <Button variant="secondary" disabled={!workspace.canEditCad || !kit.result!.scanId} loading={cp.busy === 'send'} onClick={() => void cp.send()}><Send aria-hidden size={14} />{current ? `Send again to ${workspace.name}` : `Send full BOM to ${workspace.name}`}</Button>
    </div>
    <p className="muted small">Sends every part with its quantity, vendor, price, and status, plus the Excel BOM, the assembly picture, and this session's STEP files. Sending the same scan again changes nothing; a new scan updates the same parts and keeps your team's statuses. Part types and products chosen in Control Point arrive with your next scan.</p>
  </>;
}

/** Control Point in Settings: which account and workspace, switching, and unlinking. */
export function ControlPointSettings({ cp }: { cp: ControlPoint }) {
  const link = cp.link;
  const [switching, setSwitching] = useState(false);
  if (!link) return null;
  return <div className="stack">
    <h3>Control Point</h3>
    {cp.error && <Alert tone="danger" title={cp.error} onDismiss={cp.clearError} />}
    {!link.linked ? <>
      <p className="muted small">Not linked. Linking lets you send a scanned BOM to your team's Control Point workspace.</p>
      {link.available !== false ? <div><Button size="sm" variant="secondary" loading={cp.busy === 'link'} onClick={cp.startLink}>Link Control Point</Button></div>
        : <p className="muted small">Linking opens once Control Point is ready for it.</p>}
    </> : <>
      <p className="small">Linked as {link.account.email}{cp.workspace ? <>, sending to <strong>{workspaceName(cp.workspace)}</strong></> : ', no workspace chosen yet'}.</p>
      {cp.workspace && !cp.accent && cp.workspace.accentColor && <p className="muted small">Workspace colour kept off buttons for readability; Control Kit stays volt.</p>}
      {cp.workspace && !cp.workspace.accentColor && <p className="muted small">This workspace has no colour set, so Control Kit stays volt.</p>}
      {(switching || !cp.workspace) && link.workspaces.length > 0 && <div className="workspace-list" role="radiogroup" aria-label="Control Point workspace">
        {link.workspaces.map(workspace => <button key={workspace.id} type="button" role="radio" aria-checked={cp.workspace?.id === workspace.id} className="workspace-option"
          disabled={cp.busy === 'workspace'} onClick={() => { void cp.chooseWorkspace(workspace.id); setSwitching(false); }}><WorkspaceMark workspace={workspace} /><span>{workspaceName(workspace)}</span></button>)}
      </div>}
      <p className="muted small">Switching never re-sends a scan. Unlinking stops future sends; it deletes nothing already in Control Point.</p>
      <div className="inline-actions">
        {cp.workspace && link.workspaces.length > 1 && <Button size="sm" variant="secondary" onClick={() => setSwitching(!switching)}>{switching ? 'Keep this workspace' : 'Switch workspace'}</Button>}
        <Button size="sm" variant="ghost" loading={cp.busy === 'unlink'} onClick={() => void cp.unlink()}>Unlink</Button>
      </div>
    </>}
    <p className="muted small">Your team number above is separate: it only helps spot team-designed parts, and is never used to pick a workspace.</p>
  </div>;
}
