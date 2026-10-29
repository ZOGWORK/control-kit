import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { EmptyState } from '../components/arc/empty-state/empty-state';
import { Alert } from '../components/arc/alert/alert';
import SegmentedControl from '../components/arc/segmented-control/segmented-control';
import type { ControlKit } from './useControlKit';
import { aiCandidateRecord, needsAiReview, type BomLine, type ClassificationOverride } from '@control-kit/shared';
import { catalogsComplete, inReview, queueKind, inSubassembly, matchedText, money, productOptions, reviewQueue, shortLabel, subassemblyOf, vendorLabel, vendorLookup, type QueueKind, type Subassembly } from './model';
import { CheckCircle2, ExternalLink, ListChecks } from 'lucide-react';
import { Button, PartMeta, SectionHead, Thumbnail } from './bits';
import type { Open, ReviewFilter } from './App';

const page = 25;
/** The types a selection can be set to at once, in the drawer's order. */
const bulkChoices: ClassificationOverride[] = ['buy', 'print', 'cnc', 'cut-2d', 'fabricate', 'hardware', 'ignore'];

/** "AI suggests 3D print (78%): reason", with the product it points at when there is one. */
function aiText(line: BomLine) {
  const suggestion = line.aiSuggestion!;
  const record = aiCandidateRecord(line, suggestion.candidateId);
  const what = suggestion.disposition === 'review' ? 'no clear answer' : shortLabel[suggestion.disposition];
  return `AI suggests ${what}${record ? `, ${vendorLabel[record.vendorId]} ${record.sku}` : ''} (${Math.round(suggestion.confidence * 100)}%): ${suggestion.reason}`;
}

/** Why a part to buy is here: its possible product, or that nothing matched yet (and whether catalogs are still loading). */
// Each sentence names only the fixes the row actually offers: products to pick, a vendor search, or neither.
function productReason(line: BomLine, complete: boolean, options: number, lookup: boolean) {
  if (line.matchStatus === 'possible' && line.vendor) return `Buy. Possible product: ${vendorLabel[line.vendor.vendorId]} ${line.vendor.sku}, ${line.vendor.name}`;
  const fixes = [options ? 'pick the closest product' : null, lookup ? 'search the vendor' : null, 'add its SKU to the part number in Onshape', 'or change its type'].filter(Boolean).join(', ');
  if (line.matchStatus === 'rejected') return `Buy. You rejected the suggested product: ${fixes}.`;
  return complete ? `Buy, but no vendor product matched: ${fixes}.` : `Buy, but no vendor product matched yet; some catalogs are still loading. Meanwhile: ${fixes}.`;
}

/**
 * Everything that needs a person: possible vendor matches, suggestions to confirm, open questions, and parts to buy
 * that have no vendor product yet. Each item says why it is here and offers the likely answers as one click; several
 * can be selected (shift-click for a range, or a whole subassembly) and given one type. Anything else opens the part.
 */
export function Review({ kit, open, filter, setFilter }: { kit: ControlKit; open: Open; filter: ReviewFilter; setFilter: (filter: ReviewFilter) => void }) {
  const result = kit.result!;
  // AI answers on parts that are otherwise settled (a Buy line whose pack size is unknown) get their own group.
  const queued = reviewQueue(result);
  const queue: Array<{ line: BomLine; kind: QueueKind | 'ai' }> = [...queued, ...result.lines
    // A suggestion stays until it is accepted (both saves), dismissed, or replaced by the person's own decision.
    .filter(line => line.aiSuggestion && !queued.some(item => item.line.bomLineKey === line.bomLineKey)).map(line => ({ line, kind: 'ai' as const }))];
  const [shown, setShown] = useState(page);
  const count = (kind: QueueKind | 'ai') => queue.filter(item => item.kind === kind).length;
  const items = queue.filter(item => filter === 'all' || item.kind === filter);
  const suggested = queue.filter(item => item.kind === 'suggested');
  const visible = items.slice(0, shown);
  const complete = catalogsComplete(result.catalogHealth);
  // The AI and No product groups' buttons go away once empty (the last answer accepted, the last product picked), so
  // the view returns to all.
  useEffect(() => { if ((filter === 'ai' || filter === 'product') && !items.length) setFilter('all'); }, [filter, items.length]);
  // The drawer moves through this same list, in this order, while its parts are still in Review.
  // A part counts as still listed only while it is in the group shown: one marked Buy from Undecided has moved to No
  // product, so working through Undecided never wraps back to it.
  const listed = (line: BomLine) => filter === 'all' ? inReview(line) || Boolean(line.aiSuggestion)
    : filter === 'ai' ? Boolean(line.aiSuggestion) && !inReview(line) : inReview(line) && queueKind(line) === filter;
  const list = { keys: items.map(item => item.line.bomLineKey), listed };
  const openPart = (key: string) => open(key, list);

  // Selected parts, by line key, for one type at once. A part that leaves Review leaves the selection.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // The last row clicked, by line key: rows move as parts leave or the filter changes, so its position is looked up again.
  const anchor = useRef<string | null>(null);
  const [bulkNote, setBulkNote] = useState<{ tone: 'danger' | 'success'; text: string } | null>(null);
  const [bulkRunning, setBulkRunning] = useState(false);
  const queuedKeys = new Set(queue.map(item => item.line.bomLineKey));
  useEffect(() => { if ([...selected].some(key => !queuedKeys.has(key))) setSelected(current => new Set([...current].filter(key => queuedKeys.has(key)))); });
  const chosen = queue.filter(item => selected.has(item.line.bomLineKey)).map(item => item.line);
  /** A click toggles one row; shift-click sets every row between the last clicked one and this one to this row's new state. */
  const toggle = (index: number, event: MouseEvent<HTMLInputElement>) => {
    const key = visible[index].line.bomLineKey;
    const on = !selected.has(key);
    // An anchor no longer shown (decided, or filtered out) starts no range.
    const at = event.shiftKey && anchor.current ? visible.findIndex(item => item.line.bomLineKey === anchor.current) : -1;
    const [from, to] = at < 0 ? [index, index] : [Math.min(at, index), Math.max(at, index)];
    setSelected(current => { const next = new Set(current); for (const item of visible.slice(from, to + 1)) if (on) next.add(item.line.bomLineKey); else next.delete(item.line.bomLineKey); return next; });
    anchor.current = key;
  };
  const selectSubassembly = (sub: Subassembly) => setSelected(current => new Set([...current, ...items.filter(item => inSubassembly(item.line, sub)).map(item => item.line.bomLineKey)]));
  async function applyType(choice: ClassificationOverride) {
    setBulkRunning(true); setBulkNote(null);
    try {
      const { saved, failed } = await kit.setDispositions(chosen, choice);
      // Failures stay selected so one more click retries just them.
      setSelected(new Set(failed.map(line => line.bomLineKey)));
      anchor.current = null;
      setBulkNote(failed.length
        ? { tone: 'danger', text: `${failed.length} of ${saved.length + failed.length} could not be saved: ${failed.slice(0, 5).map(line => line.name).join(', ')}${failed.length > 5 ? ', …' : ''}. They are still selected; try again.` }
        : { tone: 'success', text: `${saved.length} ${saved.length === 1 ? 'part' : 'parts'} moved to ${shortLabel[choice]}.` });
    } finally { setBulkRunning(false); }
  }

  // The highlighted row stays at its position: a decided part leaves the list and the next one slides under it.
  const [active, setActive] = useState(0);
  const current = visible[Math.min(active, visible.length - 1)];
  useEffect(() => { if (active > visible.length - 1) setActive(Math.max(0, visible.length - 1)); }, [visible.length, active]);
  useEffect(() => { document.getElementById(`review-${current?.line.bomLineKey}`)?.scrollIntoView({ block: 'nearest' }); }, [current?.line.bomLineKey]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Keys act on the list: not while typing, not with a drawer or dialog open, not with modifiers, and not once
      // another control handled the key. A selection checkbox is not typing.
      const target = event.target as HTMLElement | null;
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || target?.closest('input:not([type="checkbox"]), textarea, select, [contenteditable], [role="dialog"]') || document.querySelector('[role="dialog"]')) return;
      if (!current) return;
      const { line, kind } = current;
      const ready = !kit.pending && Boolean(result.scanId) && !kit.saving.has(line.bomLineKey);
      const key = event.key.toLowerCase();
      // After a click on a filter, a row button, or a checkbox, the letter keys still work; Enter, Space, and the arrows
      // keep that control's own meaning (pressing it, toggling it, or moving between filter options).
      if (target?.closest('button, a, input, [role="button"], [role="radio"], [role="tab"]') && (key === 'enter' || key === ' ' || key.startsWith('arrow'))) return;
      // A held key repeats: moving may repeat, deciding may not (each repeat would decide the next part as it slides up).
      if (event.repeat && !['arrowdown', 'arrowup', 'j', 'k'].includes(key)) return;
      if (key === 'arrowdown' || key === 'j') setActive(index => Math.min(index + 1, visible.length - 1));
      else if (key === 'arrowup' || key === 'k') setActive(index => Math.max(index - 1, 0));
      else if (key === 'enter') openPart(line.bomLineKey);
      else if (key === ' ') { setSelected(now => { const next = new Set(now); if (next.has(line.bomLineKey)) next.delete(line.bomLineKey); else next.add(line.bomLineKey); return next; }); anchor.current = line.bomLineKey; }
      else if (!ready) return;
      else if (key === 'a') {
        if (kind === 'match' || (kind === 'product' && line.matchStatus === 'possible' && line.vendor)) void kit.decide(line, 'confirmed');
        else if (kind === 'suggested') void kit.setDisposition(line, line.suggestedDisposition!); else return;
      }
      else if (key === 'i' && line.aiSuggestion) void kit.acceptAi(line);
      else if (key === 'x' && line.aiSuggestion) kit.dismissAi(line);
      else if (key === 'b' && kind !== 'product') void kit.setDisposition(line, 'buy');
      else if (key === 'p') void kit.setDisposition(line, 'print');
      else if (key === 'n') void kit.setDisposition(line, 'ignore');
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const suggestedBy = suggested.reduce<Record<string, number>>((counts, item) => ({ ...counts, [item.line.suggestedDisposition!]: (counts[item.line.suggestedDisposition!] ?? 0) + 1 }), {});

  const uncertain = result.lines.filter(needsAiReview).length;
  const aiButton = kit.ai.enabled && uncertain > 0 && <Button size="sm" variant="secondary" loading={kit.ai.running} disabled={!result.scanId || result.vendorMatching === 'pending'} onClick={() => void kit.runAiReview()}>Recheck {uncertain} with AI</Button>;
  if (!queue.length) return <>
    <SectionHead icon={<CheckCircle2 />} tone="done" title="Review complete" actions={aiButton}>Every part has a decision and every part to buy has its product. New or changed parts show up here after a rescan.</SectionHead>
    {kit.ai.note && <p className="muted small" role="status">{kit.ai.note}</p>}
    {bulkNote && <Alert tone={bulkNote.tone} title={bulkNote.text} onDismiss={() => setBulkNote(null)} />}
  </>;
  const allShown = visible.length > 0 && visible.every(item => selected.has(item.line.bomLineKey));
  return <>
    <SectionHead icon={<ListChecks />} tone="attention" title={`${queue.length} ${queue.length === 1 ? 'part needs' : 'parts need'} a decision`} actions={aiButton}>Choose how each part is made, and the product for each part to buy. Choices apply to everyone who scans this document and are kept across rescans.</SectionHead>
    {kit.ai.note && <p className="muted small" role="status">{kit.ai.note}</p>}
    <SegmentedControl label="Show" value={filter} onValueChange={value => { setFilter(value as ReviewFilter); setShown(page); }} options={[
      { value: 'all', label: `All ${queue.length}` },
      { value: 'match', label: `Vendor matches ${count('match')}` },
      { value: 'suggested', label: `Suggested ${count('suggested')}` },
      { value: 'undecided', label: `Undecided ${count('undecided')}` },
      ...(count('product') ? [{ value: 'product', label: `No product ${count('product')}` }] : []),
      ...(count('ai') ? [{ value: 'ai', label: `AI on other parts ${count('ai')}` }] : []),
    ]} />
    {bulkNote && <Alert tone={bulkNote.tone} title={bulkNote.text} onDismiss={() => setBulkNote(null)} />}
    <section className="panel">
      {suggested.length > 1 && (filter === 'all' || filter === 'suggested') && !selected.size && <div className="panel-head">
        <div><h3>{kit.bulk ? `Saving ${kit.bulk.done + 1} of ${kit.bulk.total}…` : `${suggested.length} parts have a suggestion`}</h3>
          <p>{Object.entries(suggestedBy).map(([choice, n]) => `${n} ${shortLabel[choice as keyof typeof shortLabel]}`).join(', ')}. Accepting saves each one as if you chose it; you can change any of them later.</p></div>
        <Button size="sm" variant="secondary" loading={Boolean(kit.bulk)} disabled={Boolean(kit.pending) && !kit.bulk} onClick={() => void kit.acceptSuggestions(suggested.map(item => item.line))}>Accept all {suggested.length}</Button>
      </div>}
      <div className={`bulk-bar ${selected.size ? 'on' : ''}`} role="toolbar" aria-label="Selected parts">
        <label className="check"><input type="checkbox" checked={allShown} aria-label={allShown ? 'Clear the selection' : `Select all ${visible.length} shown`}
          onChange={() => { setSelected(allShown ? new Set() : new Set([...selected, ...visible.map(item => item.line.bomLineKey)])); anchor.current = null; }} />
          <span>{selected.size ? `${selected.size} selected` : `Select all ${visible.length} shown`}</span></label>
        {selected.size > 0 && <>
          <span className="muted small">Set to</span>
          {bulkChoices.map(choice => <Button key={choice} size="sm" variant="secondary" disabled={bulkRunning || Boolean(kit.pending) || !result.scanId} onClick={() => void applyType(choice)}>{shortLabel[choice]}</Button>)}
          <Button size="sm" variant="ghost" disabled={bulkRunning} onClick={() => { setSelected(new Set()); anchor.current = null; }}>Clear</Button>
          {bulkRunning && <span className="muted small" role="status">Saving {chosen.filter(line => kit.saving.has(line.bomLineKey)).length || chosen.length}…</span>}
        </>}
        {!selected.size && <span className="muted small">Tick parts (shift-click for a range) to give them one type.</span>}
      </div>
      <p className="muted small keys-hint">Keys: <kbd>A</kbd> accept suggestion · <kbd>B</kbd> buy · <kbd>P</kbd> 3D print · <kbd>N</kbd> not needed · <kbd>Space</kbd> select · {kit.ai.enabled && <><kbd>I</kbd> accept AI · <kbd>X</kbd> dismiss AI · </>}<kbd>↑</kbd><kbd>↓</kbd> move · <kbd>Enter</kbd> details</p>
      <div className="rows" role="list" aria-label="Parts to decide">{visible.map(({ line, kind }, index) => {
        const busy = kit.saving.has(line.bomLineKey);
        // Only a whole-list operation (Accept all, loading shared choices) blocks every row; one save blocks only its own.
        const locked = Boolean(kit.pending) || !result.scanId || busy;
        // Only the highlighted row's likely answer is primary, so the list never shows a column of volt buttons.
        const lead = index === active ? 'primary' : 'secondary';
        const sub = subassemblyOf(line);
        const siblings = sub ? items.filter(item => inSubassembly(item.line, sub)).length : 0;
        const options = kind === 'product' && !(line.matchStatus === 'possible' && line.vendor) ? productOptions(line) : [];
        const lookup = kind === 'product' ? vendorLookup(line) : null;
        return <div key={line.bomLineKey} id={`review-${line.bomLineKey}`} role="listitem" aria-current={index === active ? 'true' : undefined} aria-busy={busy || undefined}
          className={`row review-row selectable ${index === active ? 'focused' : ''} ${selected.has(line.bomLineKey) ? 'selected' : ''} ${kind === 'product' ? 'kind-product' : ''}`} onMouseEnter={() => setActive(index)}>
          <input type="checkbox" className="row-check" checked={selected.has(line.bomLineKey)} aria-label={`Select ${line.name}`} onClick={event => toggle(index, event)} onChange={() => undefined} />
          <div className="row-main">
            <button type="button" className="row-title link-button" onClick={() => openPart(line.bomLineKey)}><Thumbnail line={line} /><span>{line.name}</span></button>
            <PartMeta line={line} />
            <span className="muted small">{kind === 'match' ? `Possible match: ${vendorLabel[line.vendor!.vendorId]} ${line.vendor!.sku}, ${line.vendor!.name}` : kind === 'product' ? productReason(line, complete, options.length, Boolean(lookup)) : line.reviewReason ?? (line.vendor && !line.vendor.packSizeVerified ? 'Pack size unknown, so no total yet' : '')}</span>
            {line.aiSuggestion && <span className="small">{aiText(line)}</span>}
            {busy && <span className="small muted" role="status">Saving…</span>}
            {siblings > 1 && <button type="button" className="link-button small sub-select" onClick={() => selectSubassembly(sub!)}><span>Select all {siblings} in {sub!.name}</span></button>}
          </div>
          <div className="row-aside">
            {line.aiSuggestion && <>
              <Button size="sm" variant={lead} disabled={locked} onClick={() => void kit.acceptAi(line)}>Use AI suggestion</Button>
              <Button size="sm" variant="ghost" disabled={locked} onClick={() => kit.dismissAi(line)}>Dismiss</Button>
            </>}
            {(kind === 'match' || (kind === 'product' && line.matchStatus === 'possible' && line.vendor)) && <>
              <Button size="sm" variant={line.aiSuggestion ? 'secondary' : lead} disabled={locked} onClick={() => void kit.decide(line, 'confirmed')}>Confirm match</Button>
              <Button size="sm" variant="ghost" disabled={locked} onClick={() => void kit.decide(line, 'rejected')}>Not this</Button>
            </>}
            {options.map((option, at) => <Button key={`${option.vendorId}:${option.normalizedSku}`} size="sm" variant={at === 0 && !line.aiSuggestion ? lead : 'secondary'} disabled={locked}
              title={`${option.name}${option.priceUsd !== null ? `, ${money(option.priceUsd)}` : ''}`} aria-label={`Use ${vendorLabel[option.vendorId]} ${option.sku}, ${option.name}`}
              onClick={() => void kit.decide(line, 'confirmed', option).then(saved => { if (saved) setBulkNote({ tone: 'success', text: matchedText(line.name, option) + '.' }); })}>Use {vendorLabel[option.vendorId]} {option.sku}</Button>)}
            {lookup && <a className="link small" href={lookup.url} target="_blank" rel="noopener noreferrer">Search {lookup.vendor} <ExternalLink aria-hidden size={11} /></a>}
            {kind === 'suggested' && <Button size="sm" variant={line.aiSuggestion ? 'secondary' : lead} disabled={locked} onClick={() => void kit.setDisposition(line, line.suggestedDisposition!)}>Mark {shortLabel[line.suggestedDisposition!]}</Button>}
            {kind !== 'product' && (kind === 'match' || line.suggestedDisposition !== 'buy') && <Button size="sm" variant="secondary" disabled={locked} onClick={() => void kit.setDisposition(line, 'buy')}>Buy</Button>}
            {line.suggestedDisposition !== 'print' && <Button size="sm" variant="secondary" disabled={locked} onClick={() => void kit.setDisposition(line, 'print')}>3D print</Button>}
            <Button size="sm" variant="ghost" disabled={locked} title="Not a real part to buy or make, such as a body that is part of an imported product" onClick={() => void kit.setDisposition(line, 'ignore')}>Not needed</Button>
            <Button size="sm" variant="ghost" disabled={locked} onClick={() => openPart(line.bomLineKey)}>Other</Button>
          </div>
        </div>;
      })}</div>
      {items.length > shown && <div className="subtotal"><span className="muted">Showing {shown} of {items.length}</span><Button size="sm" variant="ghost" onClick={() => setShown(shown + page)}>Show {Math.min(page, items.length - shown)} more</Button></div>}
      {!items.length && <EmptyState title="None in this group" description="Pick another group above." />}
    </section>
  </>;
}
