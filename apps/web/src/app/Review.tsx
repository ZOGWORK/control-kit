import { useEffect, useState } from 'react';
import { EmptyState } from '../components/arc/empty-state/empty-state';
import SegmentedControl from '../components/arc/segmented-control/segmented-control';
import type { ControlKit } from './useControlKit';
import { reviewQueue, shortLabel, vendorLabel, type QueueKind } from './model';
import { Button, PartMeta, Thumbnail } from './bits';

type Filter = 'all' | QueueKind;
const page = 25;

/**
 * Only the parts that need a person: possible vendor matches, suggestions to confirm, and open questions.
 * Each item says why it is here and offers the likely answers as one click; anything else opens the part.
 */
export function Review({ kit, open }: { kit: ControlKit; open: (key: string) => void }) {
  const queue = reviewQueue(kit.result!);
  const [filter, setFilter] = useState<Filter>('all');
  const [shown, setShown] = useState(page);
  const count = (kind: QueueKind) => queue.filter(item => item.kind === kind).length;
  const items = queue.filter(item => filter === 'all' || item.kind === filter);
  const suggested = queue.filter(item => item.kind === 'suggested');
  const visible = items.slice(0, shown);
  // The highlighted row stays at its position: a decided part leaves the list and the next one slides under it.
  const [active, setActive] = useState(0);
  const current = visible[Math.min(active, visible.length - 1)];
  useEffect(() => { if (active > visible.length - 1) setActive(Math.max(0, visible.length - 1)); }, [visible.length, active]);
  useEffect(() => { document.getElementById(`review-${current?.line.bomLineKey}`)?.scrollIntoView({ block: 'nearest' }); }, [current?.line.bomLineKey]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Keys act only on the list itself: not while typing, not with a drawer or dialog open, not with modifiers.
      const target = event.target as HTMLElement | null;
      if (event.ctrlKey || event.metaKey || event.altKey || target?.closest('input, textarea, select, [contenteditable], [role="dialog"]') || document.querySelector('[role="dialog"]')) return;
      if (!current) return;
      const { line, kind } = current;
      const ready = !kit.pending && Boolean(kit.result!.scanId) && !kit.saving.has(line.bomLineKey);
      const key = event.key.toLowerCase();
      if (key === 'arrowdown' || key === 'j') setActive(index => Math.min(index + 1, visible.length - 1));
      else if (key === 'arrowup' || key === 'k') setActive(index => Math.max(index - 1, 0));
      else if (key === 'enter') open(line.bomLineKey);
      else if (!ready) return;
      else if (key === 'a') { if (kind === 'match') void kit.decide(line, 'confirmed'); else if (kind === 'suggested') void kit.setDisposition(line, line.suggestedDisposition!); else return; }
      else if (key === 'b') void kit.setDisposition(line, 'buy');
      else if (key === 'p') void kit.setDisposition(line, 'print');
      else if (key === 'n') void kit.setDisposition(line, 'ignore');
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const suggestedBy = suggested.reduce<Record<string, number>>((counts, item) => ({ ...counts, [item.line.suggestedDisposition!]: (counts[item.line.suggestedDisposition!] ?? 0) + 1 }), {});

  if (!queue.length) return <section className="panel"><EmptyState title="Nothing to review" description="Every part has a decision. New or changed parts show up here after a rescan." /></section>;
  return <>
    <div className="section-head">
      <div><h2>{queue.length} parts need a decision</h2><p>Your choices apply to everyone who scans this document and are kept across rescans. Choose a part to see the evidence behind it.</p></div>
    </div>
    <SegmentedControl label="Show" value={filter} onValueChange={value => { setFilter(value as Filter); setShown(page); }} options={[
      { value: 'all', label: `All ${queue.length}` },
      { value: 'match', label: `Vendor matches ${count('match')}` },
      { value: 'suggested', label: `Suggested ${count('suggested')}` },
      { value: 'undecided', label: `Undecided ${count('undecided')}` },
    ]} />
    <section className="panel">
      {suggested.length > 1 && (filter === 'all' || filter === 'suggested') && <div className="panel-head">
        <div><h3>{kit.bulk ? `Saving ${kit.bulk.done + 1} of ${kit.bulk.total}…` : `${suggested.length} parts have a suggestion`}</h3>
          <p>{Object.entries(suggestedBy).map(([choice, n]) => `${n} ${shortLabel[choice as keyof typeof shortLabel]}`).join(', ')}. Accepting saves each one as if you chose it; you can change any of them later.</p></div>
        <Button size="sm" variant="secondary" loading={Boolean(kit.bulk)} disabled={Boolean(kit.pending) && !kit.bulk} onClick={() => void kit.acceptSuggestions(suggested.map(item => item.line))}>Accept all {suggested.length}</Button>
      </div>}
      <p className="muted small keys-hint" aria-hidden>Keys: <kbd>A</kbd> accept suggestion · <kbd>B</kbd> buy · <kbd>P</kbd> 3D print · <kbd>N</kbd> not needed · <kbd>↑</kbd><kbd>↓</kbd> move · <kbd>Enter</kbd> details</p>
      <div className="rows" role="listbox" aria-label="Parts to decide" aria-activedescendant={visible[active] ? `review-${visible[active].line.bomLineKey}` : undefined}>{visible.map(({ line, kind }, index) => {
        const busy = kit.saving.has(line.bomLineKey);
        // Only a whole-list operation (Accept all, loading shared choices) blocks every row; one save blocks only its own.
        const locked = Boolean(kit.pending) || !kit.result!.scanId || busy;
        return <div key={line.bomLineKey} id={`review-${line.bomLineKey}`} role="option" aria-selected={index === active} className={`row ${index === active ? 'focused' : ''}`} onMouseEnter={() => setActive(index)}>
          <div className="row-main">
            <button type="button" className="row-title link-button" onClick={() => open(line.bomLineKey)}><Thumbnail line={line} /><span>{line.name}</span></button>
            <PartMeta line={line} />
            <span className="muted small">{kind === 'match' ? `Possible match: ${vendorLabel[line.vendor!.vendorId]} ${line.vendor!.sku}, ${line.vendor!.name}` : line.reviewReason}</span>
          </div>
          <div className="row-aside">
            {kind === 'match' && <>
              <Button size="sm" disabled={locked} onClick={() => void kit.decide(line, 'confirmed')}>Confirm match</Button>
              <Button size="sm" variant="ghost" disabled={locked} onClick={() => void kit.decide(line, 'rejected')}>Not this</Button>
            </>}
            {kind === 'suggested' && <Button size="sm" disabled={locked} onClick={() => void kit.setDisposition(line, line.suggestedDisposition!)}>Mark {shortLabel[line.suggestedDisposition!]}</Button>}
            {kind !== 'match' && <>
              {line.suggestedDisposition !== 'buy' && <Button size="sm" variant="secondary" disabled={locked} onClick={() => void kit.setDisposition(line, 'buy')}>Buy</Button>}
              {line.suggestedDisposition !== 'print' && <Button size="sm" variant="secondary" disabled={locked} onClick={() => void kit.setDisposition(line, 'print')}>3D print</Button>}
            </>}
            <Button size="sm" variant="ghost" disabled={locked} title="Not a real part to buy or make, such as a body that is part of an imported product" onClick={() => void kit.setDisposition(line, 'ignore')}>Not needed</Button>
            <Button size="sm" variant="ghost" disabled={locked} onClick={() => open(line.bomLineKey)}>Other</Button>
          </div>
        </div>;
      })}</div>
      {items.length > shown && <div className="subtotal"><span className="muted">Showing {shown} of {items.length}</span><Button size="sm" variant="ghost" onClick={() => setShown(shown + page)}>Show {Math.min(page, items.length - shown)} more</Button></div>}
      {!items.length && <EmptyState title="None in this group" description="Pick another group above." />}
    </section>
  </>;
}
