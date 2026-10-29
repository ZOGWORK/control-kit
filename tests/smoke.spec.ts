import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { unzipSync } from 'fflate';
import { aggregateAssembly, classifyScan, type AssemblyDefinition, type ScanResult } from '../packages/shared/src/index';
import { mockPlateBody } from '../apps/worker/src/mock-onshape';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/assembly-simple.json', import.meta.url), 'utf8')) as AssemblyDefinition;
const result = classifyScan(aggregateAssembly(fixture, { documentId: 'simple', workspaceOrVersion: 'w', workspaceOrVersionId: 'work1', elementId: 'elem1' }, 'Simple FTC Assembly'), { teamNumber: null }, {});
result.scanId = '00000000-0000-4000-8000-000000000001';
/** The same assembly with two more printed parts, so Review keeps several print suggestions to accept and step through. */
const withPrints = classifyScan(aggregateAssembly({ ...fixture, rootAssembly: { ...fixture.rootAssembly, instances: [...(fixture.rootAssembly.instances ?? []),
  { id: 'pa', name: 'Printed guide A', type: 'Part', documentId: 'simple', elementId: 'printed', partId: 'pa' },
  { id: 'pb', name: 'Printed guide B', type: 'Part', documentId: 'simple', elementId: 'printed', partId: 'pb' }] } },
  { documentId: 'simple', workspaceOrVersion: 'w', workspaceOrVersionId: 'work1', elementId: 'elem1' }, 'Simple FTC Assembly'), { teamNumber: null }, {});
withPrints.scanId = result.scanId;
const appUrl = '/?documentId=simple&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1';

async function connected(page: Page, scan: ScanResult | (() => ScanResult) = result) {
  await page.route('**/api/session', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ connected: true, user: { id: 'fixture', name: 'Test User' } }) }));
  await page.route('**/api/settings', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ teamNumber: null }) }));
  await page.route('**/api/scan?**', route => route.fulfill({ status: 200, contentType: 'application/x-ndjson',
    body: `${JSON.stringify({ type: 'progress', stage: 'Reading assembly…', current: 1, total: 3, instances: 0 })}\n${JSON.stringify({ type: 'result', result: typeof scan === 'function' ? scan() : scan })}\n` }));
  await page.goto(appUrl);
  await page.getByRole('button', { name: 'Scan assembly' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Simple FTC Assembly' })).toBeVisible();
}
const section = (page: Page, name: RegExp) => page.locator('.sidebar').getByRole('button', { name });

test('embedded connection opens outside the panel and can be rechecked', async ({ page }) => {
  let isConnected = false;
  await page.route('**/api/session', route => route.fulfill({ status: isConnected ? 200 : 401, contentType: 'application/json', body: JSON.stringify({ connected: isConnected, ...(isConnected ? { user: { id: 'fixture', name: 'Test User' } } : {}) }) }));
  await page.route('**/api/settings', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ teamNumber: null }) }));
  await page.context().route('**/oauth/start?**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Mock Onshape authorization</title>' }));
  await page.route('**/host', route => route.fulfill({ contentType: 'text/html', body: `<iframe title="Onshape right panel" src="${appUrl}"></iframe>` }));
  await page.goto('/host');
  const panel = page.frameLocator('iframe[title="Onshape right panel"]');
  const opened = page.context().waitForEvent('page');
  await panel.getByRole('button', { name: 'Connect Onshape' }).click();
  const auth = await opened;
  await expect(auth).toHaveTitle('Mock Onshape authorization');
  await expect(auth).toHaveURL(/\/oauth\/start\?.*documentId=simple.*elementId=elem1/);
  expect(page.url()).toMatch(/\/host$/);
  isConnected = true;
  await panel.getByRole('button', { name: "I've connected" }).click();
  await expect(panel.getByRole('button', { name: 'Scan assembly' })).toBeVisible();
});

test('overview totals, next steps, and Excel and CSV downloads', async ({ page }) => {
  await connected(page);
  const review = result.lines.filter(line => line.disposition === 'review').length;
  // Review also holds parts to buy without a vendor product (none match here: no catalog is served).
  const toReview = review + result.lines.filter(line => line.disposition === 'buy').length;
  // One primary action, led by the parts still waiting for a decision; the money card never shows a $0 total.
  await expect(page.locator('.primary-bar button')).toHaveText(new RegExp(`^Review ${toReview} parts?$`));
  await expect(page.locator('.sidebar').getByRole('button', { name: /^Review/ })).toContainText(String(toReview));
  await expect(page.locator('.share-legend')).toContainText(`Undecided ${review}`);
  await expect(page.locator('.money-value')).toHaveText('None priced');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Excel BOM' }).click();
  const workbook = await download;
  expect(workbook.suggestedFilename()).toMatch(/^Simple_FTC_Assembly_BOM_\d{4}-\d{2}-\d{2}\.xlsx$/);
  expect(unzipSync(new Uint8Array(readFileSync(await workbook.path())))['xl/media/control-kit-logo.png']).toBeDefined();
  // Without the logo the workbook still builds.
  await page.route('**/control-kit-logo.png', route => route.fulfill({ status: 503 }));
  const fallbackDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Excel BOM' }).click();
  expect(unzipSync(new Uint8Array(readFileSync(await (await fallbackDownload).path())))['xl/media/control-kit-logo.png']).toBeUndefined();
  // A failed Excel download points to the CSV, which has the same rows.
  await page.evaluate(() => {
    const original = URL.createObjectURL.bind(URL);
    let failOnce = true;
    URL.createObjectURL = blob => { if (failOnce) { failOnce = false; throw new Error('simulated download failure'); } return original(blob); };
  });
  await page.getByRole('button', { name: 'Excel BOM' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'The Excel file could not be built' })).toBeVisible();
  const csvDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'CSV', exact: true }).click();
  expect((await csvDownload).suggestedFilename()).toMatch(/^Simple_FTC_Assembly_BOM_\d{4}-\d{2}-\d{2}\.csv$/);
});

test('an unpublished vendor catalog is called out even when no line matched', async ({ page }) => {
  const now = new Date().toISOString();
  const vendor = (vendorId: string, state: string, complete = state === 'published') => ({ vendorId, state, complete, skipped: {}, recordCount: state === 'published' ? 10 : 0, updatedAt: state === 'published' ? now : null, lastRunAt: now, stale: false, lastRunFailed: state === 'failing', error: state === 'failing' ? 'Vendor returned HTTP 503' : null, progress: null });
  const unmatched = { ...result, lines: result.lines.map(line => ({ ...line, vendor: null, matchStatus: 'unmatched' as const })),
    catalogHealth: { checkedAt: now, vendors: [vendor('gobilda', 'failing'), vendor('servocity', 'building'), vendor('andymark', 'building'), vendor('rev', 'published'), vendor('pitsco', 'never-run')] } } as ScanResult;
  let scan = unmatched;
  await connected(page, () => scan);
  const step = page.locator('.move').filter({ hasText: 'vendor catalogs are still loading' });
  await expect(step).toContainText('goBILDA (failing), ServoCity (loading), AndyMark (loading), Pitsco (loading)');
  await expect(step).not.toContainText('REV (');
  await page.locator('.catalog-strip summary').click();
  await expect(page.locator('.vendor.published')).toContainText('REV');
  scan = { ...unmatched, catalogHealth: { ...unmatched.catalogHealth!, vendors: unmatched.catalogHealth!.vendors.map(item => item.vendorId === 'rev' ? { ...item, complete: false } : item) } };
  await page.getByRole('button', { name: 'Rescan' }).click();
  await expect(page.locator('.move').filter({ hasText: 'vendor catalogs are still loading' })).toContainText('REV (partial)');
});

test('an out-of-date catalog never reads as ready', async ({ page }) => {
  const now = new Date().toISOString();
  const vendors = ['gobilda', 'servocity', 'andymark', 'rev', 'pitsco'].map(vendorId => ({ vendorId, state: 'published', complete: true, skipped: {}, recordCount: 10, updatedAt: now, lastRunAt: now,
    stale: vendorId === 'gobilda', lastRunFailed: vendorId === 'rev', error: null, progress: null }));
  await connected(page, { ...result, catalogHealth: { checkedAt: now, vendors } } as ScanResult);
  await expect(page.locator('.stale-note')).toContainText('goBILDA (out of date), REV (last update failed)');
  await page.locator('.catalog-strip summary').click();
  await expect(page.locator('.vendor.stale')).toHaveCount(2);
  await expect(page.locator('.vendor.stale').first()).not.toContainText('Ready');
});

test('sign-out keeps the work when the server fails, then ends the session', async ({ page }) => {
  await connected(page);
  let fail = true;
  await page.route('**/api/logout', route => route.fulfill({ status: fail ? 500 : 204 }));
  await page.locator('.sidebar').getByRole('button', { name: /Sign out/ }).click();
  await expect(page.getByText('Could not sign out. Try again.')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Simple FTC Assembly' })).toBeVisible();
  fail = false;
  await page.locator('.sidebar').getByRole('button', { name: /Sign out/ }).click();
  await expect(page.getByRole('button', { name: 'Connect Onshape' })).toBeVisible();
});

test('review explains each part, saves a one-click choice, and accepts all suggestions', async ({ page }) => {
  const saved: Array<{ identity: string; classification: string | null }> = [];
  await page.route('**/api/classification/override', async route => { saved.push(route.request().postDataJSON()); await route.fulfill({ status: 200, contentType: 'application/json', body: '{"saved":true}' }); });
  await connected(page, withPrints);
  await section(page, /^Review/).click();
  // Fasteners never wait for a decision.
  await expect(page.locator('.row').filter({ hasText: 'M3 Screw' })).toHaveCount(0);
  // Standard hardware is decided Buy automatically, but with no vendor product it waits here for one.
  await expect(page.locator('.row').filter({ hasText: 'Bearing' })).toContainText('Buy, but no vendor product matched');
  await expect(page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'No product 2' })).toBeVisible();
  const first = page.locator('.row').filter({ has: page.getByRole('button', { name: 'Buy' }) }).first();
  const firstName = (await first.locator('.row-title').innerText()).trim();
  await first.getByRole('button', { name: 'Buy', exact: true }).click();
  // Marked Buy, it still needs its product, so it stays in Review as one.
  await expect(page.locator('.row').filter({ hasText: firstName })).toContainText('Buy, but no vendor product matched');
  await expect(page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'No product 3' })).toBeVisible();
  expect(saved.at(-1)).toMatchObject({ classification: 'buy' });
  const remaining = withPrints.lines.filter(line => line.disposition === 'review' && line.suggestedDisposition && line.name !== firstName).length;
  expect(remaining).toBeGreaterThan(1);
  await page.getByRole('button', { name: `Accept all ${remaining}` }).click();
  await expect.poll(() => saved.length).toBe(1 + remaining);
  // The part drawer explains a decision and offers every choice.
  await section(page, /^Parts/).click();
  await page.getByRole('button', { name: /Custom Printed Sensor Mount/ }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toContainText('How the team gets it');
  await expect(drawer.getByRole('button', { name: 'CNC machine' })).toBeVisible();
  await expect(drawer.getByRole('button', { name: /Show its tab in Onshape/ })).toBeVisible();
  // The picture area explains itself when Onshape cannot draw the part (here the local server has no picture route).
  await expect(drawer.locator('.part-picture')).not.toContainText('Drawing the part');
  await page.keyboard.press('Escape');
  await section(page, /^Buy list/).click();
  await expect(page.getByRole('region', { name: 'Fasteners' })).toContainText('M3 Screw');
});

test('STEP export polls the job, zips ready files and a 2D-cut DXF with a manifest, and shows failures', async ({ page }) => {
  const printed = { ...result, lines: result.lines.map((line, index) => index === 0 ? { ...line, disposition: 'print' as const } : { ...line, disposition: 'buy' as const }) };
  const step = "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1=PRODUCT('Guide','Guide','',(#2));\nENDSEC;\nEND-ISO-10303-21;\n";
  const parts = (state: string) => [
    { lineKey: 'a', name: 'Guide', qty: 2, disposition: 'print', partId: 'p1', configuration: null, sourceUrl: 'https://cad.onshape.com/documents/a', fileName: 'Guide__p1.step', state, error: null, units: 'mm', nameMatches: true, bytes: 80 },
    { lineKey: 'b', name: 'Motor', qty: 1, disposition: 'print', partId: 'p2', configuration: null, sourceUrl: 'https://cad.onshape.com/documents/b', fileName: 'Motor__p2.step', state: 'failed', error: 'Deliberate failure', units: null, nameMatches: null, bytes: null },
    { lineKey: 'c', name: 'Plate', qty: 2, disposition: 'cut-2d', partId: 'p3', configuration: null, sourceUrl: 'https://cad.onshape.com/documents/c', fileName: 'Plate__p3.step', state, error: null, units: 'mm', nameMatches: true, bytes: 80,
      dxf: { fileName: 'Plate__p3.dxf', state: state === 'translating' ? 'pending' : 'ready', error: null, bytes: null, widthMm: null, heightMm: null, thicknessMm: null, edges: false } },
  ];
  const job = (done: boolean, state: string) => ({ jobId: '11111111-1111-4111-8111-111111111111', done, assemblyName: 'Simple FTC Assembly', scannedAt: '2026-10-24T00:00:00Z', revision: { type: 'm', id: 'mv' }, parts: parts(state) });
  let polls = 0;
  await page.route('**/api/exports', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(job(false, 'translating')) }));
  await page.route('**/api/exports/11111111-1111-4111-8111-111111111111', route => { polls++; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(job(true, 'ready')) }); });
  await page.route('**/api/exports/11111111-1111-4111-8111-111111111111/files/0', route => route.fulfill({ status: 200, contentType: 'application/step', body: step }));
  await page.route('**/api/exports/11111111-1111-4111-8111-111111111111/files/2', route => route.fulfill({ status: 200, contentType: 'application/step', body: step }));
  // The app draws the plate's DXF from the Onshape geometry the Worker stored.
  await page.route('**/api/exports/11111111-1111-4111-8111-111111111111/files/2.body', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockPlateBody('p3')) }));
  await connected(page, printed);
  await section(page, /^Make/).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download STEP files' }).click();
  const zip = await download;
  expect(polls).toBeGreaterThanOrEqual(1);
  expect(zip.suggestedFilename()).toBe('Simple_FTC_Assembly_STEP.zip');
  const files = unzipSync(new Uint8Array(readFileSync(await zip.path())));
  expect(Object.keys(files).sort()).toEqual(['Simple_FTC_Assembly_STEP/2D_cut/Plate__p3.dxf', 'Simple_FTC_Assembly_STEP/2D_cut/Plate__p3.step', 'Simple_FTC_Assembly_STEP/3D_print/Guide__p1.step', 'Simple_FTC_Assembly_STEP/MANIFEST.txt']);
  expect(new TextDecoder().decode(files['Simple_FTC_Assembly_STEP/2D_cut/Plate__p3.dxf']).startsWith('0\nSECTION')).toBe(true);
  expect(new TextDecoder().decode(files['Simple_FTC_Assembly_STEP/MANIFEST.txt'])).toContain('Plate__p3.dxf | Plate | 2 | 100 x 60 | 3 |');
  await expect(page.getByRole('status').filter({ hasText: '2 of 3 STEP files and 1 of 1 DXF cut files downloaded' })).toBeVisible();
  await expect(page.locator('.row').filter({ hasText: 'Motor' })).toContainText('Deliberate failure');
  // When every part fails there is no ZIP, only an explanation, and each reason stays visible.
  await page.unroute('**/api/exports/11111111-1111-4111-8111-111111111111');
  await page.route('**/api/exports/11111111-1111-4111-8111-111111111111', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...job(true, 'failed'), parts: parts('failed').map(item => ({ ...item, state: 'failed', error: 'Deliberate failure', ...(item.dxf ? { dxf: { ...item.dxf, state: 'failed', error: 'Deliberate DXF failure' } } : {}) })) }) }));
  await page.getByRole('button', { name: 'Download STEP files' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'No STEP file could be exported (3 parts failed).' })).toBeVisible();
  await expect(page.locator('.row').filter({ hasText: 'Plate (DXF)' })).toContainText('Deliberate DXF failure');
  await expect(page.locator('.row').filter({ hasText: 'Guide' })).toContainText('Deliberate failure');
});

test('reopening the panel shows the last scan, and Not needed dismisses a part', async ({ page }) => {
  const saved: Array<{ classification: string | null }> = [];
  await page.route('**/api/classification/override', async route => { saved.push(route.request().postDataJSON()); await route.fulfill({ status: 200, contentType: 'application/json', body: '{"saved":true}' }); });
  await connected(page, withPrints);
  let scans = 0;
  await page.route('**/api/scan?**', route => { scans++; return route.fallback(); });
  // Leaving the assembly and coming back reloads the panel; the scan is still there without scanning again.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Simple FTC Assembly' })).toBeVisible();
  expect(scans).toBe(0);
  await section(page, /^Review/).click();
  const row = page.locator('.row').filter({ has: page.getByRole('button', { name: 'Not needed' }) }).first();
  const name = (await row.locator('.row-title').innerText()).trim();
  await row.getByRole('button', { name: 'Not needed' }).click();
  await expect(page.locator('.row').filter({ hasText: name })).toHaveCount(0);
  expect(saved.at(-1)).toMatchObject({ classification: 'ignore' });
  // Keyboard: P decides the highlighted part, which leaves the list; the highlight stays on the next one.
  const next = (await page.locator('.row.focused .row-title').innerText()).trim();
  await page.keyboard.press('p');
  await expect(page.locator('.row').filter({ hasText: next })).toHaveCount(0);
  expect(saved.at(-1)).toMatchObject({ classification: 'print' });
  // Parts remain, and the highlight stays on the next one.
  await expect(page.locator('.rows [role="listitem"]')).not.toHaveCount(0);
  await expect(page.locator('.row.focused')).toHaveCount(1);
});

test('the part drawer moves to the next part after a choice, and closes with a note when none is left', async ({ page }) => {
  const saved: Array<{ classification: string | null }> = [];
  await page.route('**/api/classification/override', async route => { saved.push(route.request().postDataJSON()); await route.fulfill({ status: 200, contentType: 'application/json', body: '{"saved":true}' }); });
  await connected(page, withPrints);
  await section(page, /^Review/).click();
  await page.locator('.review-row').filter({ hasText: 'Printed guide A' }).locator('.row-title').click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByRole('heading', { name: 'Printed guide A' })).toBeVisible();
  await drawer.getByRole('button', { name: 'CNC machine' }).click();
  // The drawer says where the part went and shows the next part in Review's order.
  await expect(drawer.getByRole('status').filter({ hasText: 'Printed guide A moved to CNC' })).toBeVisible();
  await expect(drawer.getByRole('heading', { name: 'Printed guide B' })).toBeVisible();
  expect(saved.at(-1)).toMatchObject({ classification: 'cnc' });
  await page.keyboard.press('Escape');
  await expect(page.locator('.review-row').filter({ hasText: 'Printed guide A' })).toHaveCount(0);
  // A part opened on its own (Overview search) has no list to move through, so the drawer closes and the page says where it went.
  await section(page, /^Overview/).click();
  await page.getByPlaceholder(/Find a part/i).fill('Wheel');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Wheel' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Not needed' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.toast')).toHaveText('Wheel moved to Not needed');
  // A failed save keeps the drawer on the part with its error.
  await page.unroute('**/api/classification/override');
  await page.route('**/api/classification/override', route => route.fulfill({ status: 500 }));
  await section(page, /^Review/).click();
  await page.locator('.review-row').filter({ hasText: 'Printed guide B' }).locator('.row-title').click();
  await page.getByRole('dialog').getByRole('button', { name: 'CNC machine' }).click();
  await expect(page.getByRole('dialog').getByText('Could not save the choice for Printed guide B')).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Printed guide B' })).toBeVisible();
});

test('Review sets one type for several parts: a shift-click range or a whole subassembly, with failures kept selected', async ({ page }) => {
  const saved: string[] = [];
  await page.route('**/api/classification/override', async route => {
    const body = route.request().postDataJSON() as { identity: string; classification: string };
    // One part fails, so the others still save and it stays selected to retry.
    if (body.identity.includes(':pb:')) return route.fulfill({ status: 500 });
    saved.push(`${body.identity}=${body.classification}`);
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"saved":true}' });
  });
  await connected(page, withPrints);
  await section(page, /^Review/).click();
  const checks = page.locator('.review-row .row-check');
  await checks.nth(0).click();
  await checks.nth(2).click({ modifiers: ['Shift'] });
  await expect(page.locator('.bulk-bar')).toContainText('3 selected');
  await page.locator('.bulk-bar').getByRole('button', { name: 'Fastener', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '1 of 3 could not be saved: Printed guide B' })).toBeVisible();
  expect(saved).toHaveLength(2);
  await expect(page.locator('.bulk-bar')).toContainText('1 selected');
  await expect(page.locator('.review-row.selected')).toContainText('Printed guide B');
  await page.locator('.bulk-bar').getByRole('button', { name: 'Clear' }).click();
  // Every part in the Left Module subassembly at once: the wheel, and the motor and bearing that still need products.
  await page.locator('.review-row').filter({ hasText: 'Wheel' }).getByRole('button', { name: /Select all 3 in Left Module/ }).click();
  await expect(page.locator('.bulk-bar')).toContainText('3 selected');
  await page.locator('.bulk-bar').getByRole('button', { name: 'Not needed', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '3 parts moved to Not needed' })).toBeVisible();
  await expect(page.locator('.review-row').filter({ hasText: /Wheel|Motor|Bearing/ })).toHaveCount(0);
});

test('privacy, terms, and support pages open from the site footer', async ({ page }) => {
  await page.route('**/api/session', route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ connected: false }) }));
  await page.goto('/');
  for (const [link, heading] of [['Privacy', 'Privacy'], ['Terms of use', 'Terms of use'], ['Support', 'Support']]) {
    await page.locator('.landing-footer').getByRole('link', { name: link }).click();
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  }
  await expect(page.getByRole('link', { name: 'Open an issue on GitHub' })).toHaveAttribute('href', 'https://github.com/ZOGWORK/control-kit/issues');
  await page.goto('/privacy/');
  await expect(page.getByRole('heading', { name: 'What it keeps, and for how long' })).toBeVisible();
});

test('the narrow Onshape panel has no sideways scroll and keeps every section reachable', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 720 });
  await connected(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('.sidebar')).toBeHidden();
  for (const name of ['Review', 'Parts', 'Buy list', 'Make', 'Overview']) {
    await page.locator('.tabs').getByRole('button', { name: new RegExp(`^${name}`) }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test('the site explains and installs Control Kit outside Onshape, while a framed panel without context keeps its hint', async ({ page }) => {
  await page.route('**/api/session', route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ connected: false }) }));
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: /bill of materials, straight from Onshape/ })).toBeVisible();
  await page.getByRole('link', { name: 'How to install' }).click();
  await expect(page.getByRole('heading', { name: 'Install' })).toBeInViewport();
  // Screenshots load lazily; each must load for real (a failed image is also "complete", but has no width).
  for (const image of await page.locator('img.landing-shot').all()) {
    await image.scrollIntoViewIfNeeded();
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  await page.route('**/host', route => route.fulfill({ contentType: 'text/html', body: '<iframe title="Onshape right panel" src="/"></iframe>' }));
  await page.goto('/host');
  await expect(page.frameLocator('iframe[title="Onshape right panel"]').getByRole('heading', { level: 1, name: 'Open Control Kit from an assembly' })).toBeVisible();
});
