import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { unzipSync } from 'fflate';
import { aggregateAssembly, classifyScan, type AssemblyDefinition, type ScanResult } from '../packages/shared/src/index';

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
  await expect(page.locator('.tile').filter({ hasText: 'Needs review' })).toContainText(String(result.lines.filter(line => line.disposition === 'review').length));
  await expect(page.locator('.tile').filter({ hasText: 'Known subtotal' })).toContainText('None yet');
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
  const step = page.locator('.step').filter({ hasText: 'vendor catalogs are still loading' });
  await expect(step).toContainText('goBILDA (failing), ServoCity (loading), AndyMark (loading), Pitsco (loading)');
  await expect(step).not.toContainText('REV (');
  await expect(page.locator('.vendor.published')).toContainText('REV');
  scan = { ...unmatched, catalogHealth: { ...unmatched.catalogHealth!, vendors: unmatched.catalogHealth!.vendors.map(item => item.vendorId === 'rev' ? { ...item, complete: false } : item) } };
  await page.getByRole('button', { name: 'Rescan' }).click();
  await expect(page.locator('.step').filter({ hasText: 'vendor catalogs are still loading' })).toContainText('REV (partial)');
});

test('an out-of-date catalog never reads as ready', async ({ page }) => {
  const now = new Date().toISOString();
  const vendors = ['gobilda', 'servocity', 'andymark', 'rev', 'pitsco'].map(vendorId => ({ vendorId, state: 'published', complete: true, skipped: {}, recordCount: 10, updatedAt: now, lastRunAt: now,
    stale: vendorId === 'gobilda', lastRunFailed: vendorId === 'rev', error: null, progress: null }));
  await connected(page, { ...result, catalogHealth: { checkedAt: now, vendors } } as ScanResult);
  await expect(page.locator('.step').filter({ hasText: 'prices may be out of date' })).toContainText('goBILDA (out of date), REV (last update failed)');
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
  // Standard hardware is decided automatically now; only how team-made parts are produced waits for a person.
  await expect(page.locator('.row').filter({ hasText: 'Bearing' })).toHaveCount(0);
  const first = page.locator('.row').filter({ has: page.getByRole('button', { name: 'Buy' }) }).first();
  const firstName = (await first.locator('.row-title').innerText()).trim();
  await first.getByRole('button', { name: 'Buy', exact: true }).click();
  await expect(page.locator('.row').filter({ hasText: firstName })).toHaveCount(0);
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

test('STEP export polls the job, zips ready files with a manifest, and shows failures', async ({ page }) => {
  const printed = { ...result, lines: result.lines.map((line, index) => index === 0 ? { ...line, disposition: 'print' as const } : { ...line, disposition: 'buy' as const }) };
  const step = "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1=PRODUCT('Guide','Guide','',(#2));\nENDSEC;\nEND-ISO-10303-21;\n";
  const parts = (state: string) => [
    { lineKey: 'a', name: 'Guide', qty: 2, disposition: 'print', partId: 'p1', configuration: null, sourceUrl: 'https://cad.onshape.com/documents/a', fileName: 'Guide__p1.step', state, error: null, units: 'mm', nameMatches: true, bytes: 80 },
    { lineKey: 'b', name: 'Motor', qty: 1, disposition: 'print', partId: 'p2', configuration: null, sourceUrl: 'https://cad.onshape.com/documents/b', fileName: 'Motor__p2.step', state: 'failed', error: 'Deliberate failure', units: null, nameMatches: null, bytes: null },
  ];
  const job = (done: boolean, state: string) => ({ jobId: '11111111-1111-4111-8111-111111111111', done, assemblyName: 'Simple FTC Assembly', scannedAt: '2026-10-24T00:00:00Z', revision: { type: 'm', id: 'mv' }, parts: parts(state) });
  let polls = 0;
  await page.route('**/api/exports', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(job(false, 'translating')) }));
  await page.route('**/api/exports/11111111-1111-4111-8111-111111111111', route => { polls++; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(job(true, 'ready')) }); });
  await page.route('**/api/exports/11111111-1111-4111-8111-111111111111/files/0', route => route.fulfill({ status: 200, contentType: 'application/step', body: step }));
  await connected(page, printed);
  await section(page, /^Make/).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download STEP files' }).click();
  const zip = await download;
  expect(polls).toBeGreaterThanOrEqual(1);
  expect(zip.suggestedFilename()).toBe('Simple_FTC_Assembly_STEP.zip');
  expect(Object.keys(unzipSync(new Uint8Array(readFileSync(await zip.path())))).sort()).toEqual(['Simple_FTC_Assembly_STEP/3D_print/Guide__p1.step', 'Simple_FTC_Assembly_STEP/MANIFEST.txt']);
  await expect(page.getByRole('status').filter({ hasText: '1 of 2 STEP files downloaded' })).toBeVisible();
  await expect(page.locator('.row').filter({ hasText: 'Motor' })).toContainText('Deliberate failure');
  // When every part fails there is no ZIP, only an explanation, and each reason stays visible.
  await page.unroute('**/api/exports/11111111-1111-4111-8111-111111111111');
  await page.route('**/api/exports/11111111-1111-4111-8111-111111111111', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...job(true, 'failed'), parts: parts('failed').map(item => ({ ...item, state: 'failed', error: 'Deliberate failure' })) }) }));
  await page.getByRole('button', { name: 'Download STEP files' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'No STEP file could be exported (2 parts failed).' })).toBeVisible();
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
  // Keyboard: B decides the highlighted part, which leaves the list; the highlight stays on the next one.
  const next = (await page.locator('.row.focused .row-title').innerText()).trim();
  await page.keyboard.press('b');
  await expect(page.locator('.row').filter({ hasText: next })).toHaveCount(0);
  expect(saved.at(-1)).toMatchObject({ classification: 'buy' });
  // Parts remain, and the highlight stays on the next one.
  await expect(page.locator('.rows [role="listitem"]')).not.toHaveCount(0);
  await expect(page.locator('.row.focused')).toHaveCount(1);
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
