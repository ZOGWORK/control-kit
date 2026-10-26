import { Download, ExternalLink, Wrench } from 'lucide-react';
import { Alert } from '../components/arc/alert/alert';
import { Button, SectionHead } from './bits';
import { EmptyState } from '../components/arc/empty-state/empty-state';
import { Progress } from '../components/arc/progress/progress';
import type { ControlKit } from './useControlKit';
import { makeGroups, type View } from './model';

/** Parts the team makes, by process, with the STEP export and its per-part results. */
export function Make({ kit, open, go }: { kit: ControlKit; open: (key: string) => void; go: (view: View) => void }) {
  const groups = makeGroups(kit.result!);
  const total = groups.reduce((sum, group) => sum + group.lines.length, 0);
  const step = kit.step;

  if (!total) return <section className="panel"><EmptyState title="Nothing to make yet" description="Parts appear here when they are marked 3D print, CNC, 2D cut, or other fabrication. Name tags like (3D PRINT) or a print material set this automatically."
    action={<Button size="sm" onClick={() => go('review')}>Review parts</Button>} /></section>;
  return <>
    <SectionHead icon={<Wrench />} tone="make" title="Make">{total} parts the team prints or fabricates. STEP files come straight from Onshape, one per part, with a manifest of sources and quantities.</SectionHead>
    {/* "Download build pack" lands here while the workbook builds, so its failure has to show here too. */}
    {kit.excel === 'failed' && <Alert tone="warning" title="The Excel file could not be built">The STEP files below are unaffected. <Button size="sm" variant="ghost" onClick={() => void kit.downloadExcel()}>Try again</Button><Button size="sm" variant="ghost" onClick={() => void kit.downloadCsv()}>Download CSV</Button></Alert>}

    <section className="panel" aria-labelledby="step-export">
      <div className="panel-head">
        <div><h2 id="step-export">STEP files</h2><p>For slicers and CAM. A 2D-cut part still needs a cut file (DXF) made from its flat face.</p></div>
        <Button loading={step?.running} onClick={() => void kit.downloadStep()}><Download aria-hidden size={15} /> Download STEP files</Button>
      </div>
      {step?.running && <div className="panel-body stack" aria-live="polite">
        <Progress value={step.ready + step.failed} max={Math.max(step.total, 1)} label="STEP export progress" showValue />
        <p className="muted small">{step.total ? `${step.ready} of ${step.total} exported${step.failed ? `, ${step.failed} failed` : ''}. Onshape translates each part; large parts take longer.` : 'Starting the export…'}</p>
      </div>}
      {step && !step.running && step.zipMade !== null && <div className="panel-body stack">
        {step.zipMade ? <Alert tone={step.failures.length ? 'warning' : 'success'} title={`${step.ready} of ${step.total} STEP files downloaded`}>{step.failures.length ? 'The parts below failed. They are also listed in MANIFEST.txt in the ZIP.' : 'Every part exported and passed its file check.'}</Alert>
          : <Alert tone="danger" title="No STEP file could be exported">No ZIP was made. Each part and its reason is listed below.</Alert>}
        {step.failures.length > 0 && <div className="rows">{step.failures.map(failure => <div key={`${failure.name}:${failure.reason}`} className="row">
          <div className="row-main"><span className="row-title"><span>{failure.name}</span></span><span className="muted small">{failure.reason}</span></div>
          <div className="row-aside"><a className="link small" href={failure.url} target="_blank" rel="noopener noreferrer">Open in Onshape <ExternalLink aria-hidden size={11} /></a></div>
        </div>)}</div>}
      </div>}
    </section>

    {groups.map(group => <section key={group.disposition} className="panel tone-make" aria-label={group.label}>
      <div className="panel-head"><div><h2><span className="dot make" aria-hidden /> {group.label}</h2><p>{group.lines.length} part{group.lines.length === 1 ? '' : 's'}, {group.lines.reduce((sum, line) => sum + line.qty, 0)} pieces</p></div></div>
      <div className="rows">{group.lines.map(line => <div key={line.bomLineKey} className="row">
        <div className="row-main">
          <button type="button" className="row-title link-button" onClick={() => open(line.bomLineKey)}><span>{line.name}</span></button>
          <span className="row-meta"><span><span className="num">{line.qty}</span> needed</span>{line.material && <span>{line.material}</span>}
            <span>{line.dispositionSource === 'manual' ? 'chosen by your team' : line.dispositionEvidence[line.dispositionEvidence.length - 1] ?? ''}</span></span>
        </div>
        <div className="row-aside"><a className="link small" href={line.partStudioUrl} target="_blank" rel="noopener noreferrer">Open in Onshape <ExternalLink aria-hidden size={11} /></a></div>
      </div>)}</div>
    </section>)}
  </>;
}
