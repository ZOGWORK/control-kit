import { useState } from 'react';
import { EmptyState } from '../components/arc/empty-state/empty-state';
import { SearchField } from '../components/arc/search-field/search-field';
import SegmentedControl from '../components/arc/segmented-control/segmented-control';
import { Select } from '../components/arc/select/select';
import type { ControlKit } from './useControlKit';
import { filterParts, isMake, type PartFilter, type PartSort } from './model';
import { Button, DispositionChip, LineCost, PartMeta } from './bits';

const page = 50;

/** Every part in the assembly, filterable by what happens to it. A row opens the part's details. */
export function Parts({ kit, open }: { kit: ControlKit; open: (key: string) => void }) {
  const result = kit.result!;
  const [filter, setFilter] = useState<PartFilter>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<PartSort>('name');
  const [shown, setShown] = useState(page);
  const rows = filterParts(result, filter, query, sort);
  const count = { all: result.lines.length, buy: result.lines.filter(line => line.disposition === 'buy').length, hardware: result.lines.filter(line => line.disposition === 'hardware').length, make: result.lines.filter(isMake).length,
    review: result.lines.filter(line => line.disposition === 'review').length, suppressed: result.suppressed.length };

  return <>
    <div className="section-head"><div><h2>Parts</h2><p>{result.lines.length} distinct parts, {result.stats.totalInstances} in the assembly. Quantities count every active instance, including inside subassemblies.</p></div></div>
    <SegmentedControl label="Show" value={filter} onValueChange={value => { setFilter(value as PartFilter); setShown(page); }} options={[
      { value: 'all', label: `All ${count.all}` }, { value: 'buy', label: `Buy ${count.buy}` }, { value: 'hardware', label: `Fasteners ${count.hardware}` }, { value: 'make', label: `Make ${count.make}` },
      { value: 'review', label: `Review ${count.review}` }, { value: 'suppressed', label: `Suppressed ${count.suppressed}` },
    ]} />
    <div className="toolbar">
      <SearchField label="Search parts" placeholder="Name, part number, or SKU" value={query} onValueChange={value => { setQuery(value); setShown(page); }} />
      <Select label="Sort by" value={sort} onValueChange={value => setSort(value as PartSort)} options={[{ value: 'name', label: 'Name' }, { value: 'qty', label: 'Quantity' }]} />
    </div>
    {filter === 'suppressed' && <p className="muted small">Suppressed parts are not counted in quantities or purchasing.</p>}
    <section className="panel">
      <div className="rows">{rows.slice(0, shown).map(line => <button key={line.bomLineKey} type="button" className={`row ${line.suppressed ? 'dim' : ''}`} onClick={() => open(line.bomLineKey)}>
        <span className="row-main"><span className="row-title"><span>{line.name}</span></span><PartMeta line={line} />
          {line.metadataIssue && !line.suppressed && <span className="small" style={{ color: 'var(--ck-warning)' }}>{line.missingMetadataReason}</span>}</span>
        <span className="row-aside"><LineCost line={line} /><DispositionChip line={line} /></span>
      </button>)}</div>
      {rows.length > shown && <div className="subtotal"><span className="muted">Showing {shown} of {rows.length}</span><Button size="sm" variant="ghost" onClick={() => setShown(shown + page)}>Show more</Button></div>}
      {!rows.length && <EmptyState title={query ? 'No parts match' : 'No parts here'} description={query ? 'Try a shorter search, or another group.' : 'Pick another group above.'} />}
    </section>
  </>;
}
