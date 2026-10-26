import { useEffect, useState } from 'react';
import { EmptyState } from '../components/arc/empty-state/empty-state';
import SegmentedControl from '../components/arc/segmented-control/segmented-control';
import type { ControlKit } from './useControlKit';
import { aiCandidateRecord, needsAiReview, type BomLine } from '@control-kit/shared';
import { reviewQueue, shortLabel, vendorLabel, type QueueKind } from './model';
import { CheckCircle2, ListChecks } from 'lucide-react';
import { Button, PartMeta, SectionHead, Thumbnail } from './bits';

type Filter = 'all' | QueueKind | 'ai';
const page = 25;

/** "AI suggests 3D print (78%): reason", with the product it points at when there is one. */
function aiText(line: BomLine) {
  const suggestion = line.aiSuggestion!;
  const record = aiCandidateRecord(line, suggestion.candidateId);
  const what = suggestion.disposition === 'review' ? 'no clear answer' : shortLabel[suggestion.disposition];
  return `AI suggests ${what}${record ? `, ${vendorLabel[record.vendorId]} ${record.sku}` : ''} (${Math.round(suggestion.confidence * 100)}%): ${suggestion.reason}`;
}

/**
 * Only the parts that need a person: possible vendor matches, suggestions to confirm, and open questions.
 * Each item says why it is here and offers the likely answers as one click; anything else opens the part.
 */
export function Review({ kit, open }: { kit: ControlKit; open: (key: string) => void }) {
  // AI answers on parts that are otherwise settled (a Buy line whose pack size is unknown) get their own group.
  const queued = reviewQueue(kit.result!);
  const queue: Array<{ line: BomLine; kind: QueueKind | 'ai' }> = [...queued, ...kit.result!.lines
    // A suggestion stays until it is accepted (both saves), dismissed, or replaced by the person's own decision.
    .filter(line => line.aiSuggestion && !queued.some(item => item.line.bomLineKey === line.bomLineKey)).map(line => ({ line, kind: 'ai' as const }))];
  const [filter, setFilter] = useState<Filter>('all');
  const [shown, setShown] = useState(page);
  const count = (kind: QueueKind | 'ai') => queue.filter(item => item.kind === kind).length;
  const items = queue.filter(item => filter === 'all' || item.kind === filter);
  const suggested = queue.filter(item => item.kind === 'suggested');
  const visible = items.slice(0, shown);
  // Once its last AI answer is accepted or dismissed, the AI group's button goes away, so the view returns to all.
  const aiLeft = count('ai');
  useEffect(() => { if (filter === 'ai' && !aiLeft) setFilter('all'); }, [filter, aiLeft]);
  // The highlighted row stays at its position: a decided part leaves the list and the next one slides under it.
  const [active, setActive] = useState(0);
  const current = visible[Math.min(active, visible.length - 1)];
  useEffect(() => { if (active > visible.length - 1) setActive(Math.max(0, visible.length - 1)); }, [visible.length, active]);
  useEffect(() => { document.getElementById(`review-${current?.line.bomLineKey}`)?.scrollIntoView({ block: 'nearest' }); }, [current?.line.bomLineKey]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Keys act on the list: not while typing, not with a drawer or dialog open, not with modifiers, and not once
      // another control handled the key.
      const target = event.target as HTMLElement | null;
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || target?.closest('input, textarea, select, [contenteditable], [role="dialog"]') || document.querySelector('[role="dialog"]')) return;
      if (!current) return;
      const { line, kind } = current;
      const ready = !kit.pending && Boolean(kit.result!.scanId) && !kit.saving.has(line.bomLineKey);
      const key = event.key.toLowerCase();
      // After a click on a filter or a row button, the letter keys still work; Enter, Space, and the arrows keep that
      // control's own meaning (pressing it, or moving between filter options).
      if (target?.closest('button, a, [role="button"], [role="radio"], [role="tab"]') && (key === 'enter' || key === ' ' || key.startsWith('arrow'))) return;
      // A held key repeats: moving may repeat, deciding may not (each repeat would decide the next part as it slides up).
      if (event.repeat && !['arrowdown', 'arrowup', 'j', 'k'].includes(key)) return;
      if (key === 'arrowdown' || key === 'j') setActive(index => Math.min(index + 1, visible.length - 1));
      else if (key === 'arrowup' || key === 'k') setActive(index => Math.max(index - 1, 0));
      else if (key === 'enter') open(line.bomLineKey);
      else if (!ready) return;
      else if (key === 'a') { if (kind === 'match') void kit.decide(line, 'confirmed'); else if (kind === 'suggested') void kit.setDisposition(line, line.suggestedDisposition!); else return; }
      else if (key === 'i' && line.aiSuggestion) void kit.acceptAi(line);
      else if (key === 'x' && line.aiSuggestion) kit.dismissAi(line);
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

  const uncertain = kit.result!.lines.filter(needsAiReview).length;
  const aiButton = kit.ai.enabled && uncertain > 0 && <Button size="sm" variant="secondary" loading={kit.ai.running} disabled={!kit.result!.scanId || kit.result!.vendorMatching === 'pending'} onClick={() => void kit.runAiReview()}>Recheck {uncertain} with AI</Button>;
  if (!queue.length) return <>
    <SectionHead icon={<CheckCircle2 />} tone="done" title="Review complete" actions={aiButton}>Every part has a decision. New or changed parts show up here after a rescan.</SectionHead>
    {kit.ai.note && <p className="muted small" role="status">{kit.ai.note}</p>}
  </>;
  return <>
    <SectionHead icon={<ListChecks />} tone="attention" title={`${queue.length} ${queue.length === 1 ? 'part needs' : 'parts need'} a decision`} actions={aiButton}>Your choices apply to everyone who scans this document and are kept across rescans. Choose a part to see the evidence behind it.</SectionHead>
    {kit.ai.note && <p className="muted small" role="status">{kit.ai.note}</p>}
    <SegmentedControl label="Show" value={filter} onValueChange={value => { setFilter(value as Filter); setShown(page); }} options={[
      { value: 'all', label: `All ${queue.length}` },
      { value: 'match', label: `Vendor matches ${count('match')}` },
      { value: 'suggested', label: `Suggested ${count('suggested')}` },
      { value: 'undecided', label: `Undecided ${count('undecided')}` },
      ...(count('ai') ? [{ value: 'ai', label: `AI on other parts ${count('ai')}` }] : []),
    ]} />
    <section className="panel">
      {suggested.length > 1 && (filter === 'all' || filter === 'suggested') && <div className="panel-head">
        <div><h3>{kit.bulk ? `Saving ${kit.bulk.done + 1} of ${kit.bulk.total}…` : `${suggested.length} parts have a suggestion`}</h3>
          <p>{Object.entries(suggestedBy).map(([choice, n]) => `${n} ${shortLabel[choice as keyof typeof shortLabel]}`).join(', ')}. Accepting saves each one as if you chose it; you can change any of them later.</p></div>
        <Button size="sm" variant="secondary" loading={Boolean(kit.bulk)} disabled={Boolean(kit.pending) && !kit.bulk} onClick={() => void kit.acceptSuggestions(suggested.map(item => item.line))}>Accept all {suggested.length}</Button>
      </div>}
      <p className="muted small keys-hint">Keys: <kbd>A</kbd> accept suggestion · <kbd>B</kbd> buy · <kbd>P</kbd> 3D print · <kbd>N</kbd> not needed · {kit.ai.enabled && <><kbd>I</kbd> accept AI · <kbd>X</kbd> dismiss AI · </>}<kbd>↑</kbd><kbd>↓</kbd> move · <kbd>Enter</kbd> details</p>
      <div className="rows" role="list" aria-label="Parts to decide">{visible.map(({ line, kind }, index) => {
        const busy = kit.saving.has(line.bomLineKey);
        // Only a whole-list operation (Accept all, loading shared choices) blocks every row; one save blocks only its own.
        const locked = Boolean(kit.pending) || !kit.result!.scanId || busy;
        // Only the highlighted row's likely answer is primary, so the list never shows a column of volt buttons.
        const lead = index === active ? 'primary' : 'secondary';
        return <div key={line.bomLineKey} id={`review-${line.bomLineKey}`} role="listitem" aria-current={index === active ? 'true' : undefined} className={`row review-row ${index === active ? 'focused' : ''}`} onMouseEnter={() => setActive(index)}>
          <div className="row-main">
            <button type="button" className="row-title link-button" onClick={() => open(line.bomLineKey)}><Thumbnail line={line} /><span>{line.name}</span></button>
            <PartMeta line={line} />
            <span className="muted small">{kind === 'match' ? `Possible match: ${vendorLabel[line.vendor!.vendorId]} ${line.vendor!.sku}, ${line.vendor!.name}` : line.reviewReason ?? (line.vendor && !line.vendor.packSizeVerified ? 'Pack size unknown, so no total yet' : '')}</span>
            {line.aiSuggestion && <span className="small">{aiText(line)}</span>}
          </div>
          <div className="row-aside">
            {line.aiSuggestion && <>
              <Button size="sm" variant={lead} disabled={locked} onClick={() => void kit.acceptAi(line)}>Use AI suggestion</Button>
              <Button size="sm" variant="ghost" disabled={locked} onClick={() => kit.dismissAi(line)}>Dismiss</Button>
            </>}
            {kind === 'match' && <>
              <Button size="sm" variant={line.aiSuggestion ? 'secondary' : lead} disabled={locked} onClick={() => void kit.decide(line, 'confirmed')}>Confirm match</Button>
              <Button size="sm" variant="ghost" disabled={locked} onClick={() => void kit.decide(line, 'rejected')}>Not this</Button>
            </>}
            {kind === 'suggested' && <Button size="sm" variant={line.aiSuggestion ? 'secondary' : lead} disabled={locked} onClick={() => void kit.setDisposition(line, line.suggestedDisposition!)}>Mark {shortLabel[line.suggestedDisposition!]}</Button>}
            {(kind === 'match' || line.suggestedDisposition !== 'buy') && <Button size="sm" variant="secondary" disabled={locked} onClick={() => void kit.setDisposition(line, 'buy')}>Buy</Button>}
            {line.suggestedDisposition !== 'print' && <Button size="sm" variant="secondary" disabled={locked} onClick={() => void kit.setDisposition(line, 'print')}>3D print</Button>}
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
