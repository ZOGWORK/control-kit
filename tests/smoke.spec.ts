import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { unzipSync } from 'fflate';
import { aggregateAssembly, type AssemblyDefinition } from '../packages/shared/src/index';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/assembly-simple.json', import.meta.url), 'utf8')) as AssemblyDefinition;
const result = aggregateAssembly(fixture, { documentId: 'simple', workspaceOrVersion: 'w', workspaceOrVersionId: 'work1', elementId: 'elem1' }, 'Simple FTC Assembly');

test('embedded connection opens outside the panel and can be rechecked', async ({ page }) => {
  let connected = false;
  await page.route('**/api/session', route => route.fulfill({ status: connected ? 200 : 401, contentType: 'application/json', body: JSON.stringify({ connected, ...(connected ? { user: { id: 'fixture', name: 'Test User' } } : {}) }) }));
  await page.route('**/api/settings', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ teamNumber: null }) }));
  await page.context().route('**/oauth/start?**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Mock Onshape authorization</title>' }));
  await page.route('**/host', route => route.fulfill({ contentType: 'text/html', body: '<iframe title="Onshape right panel" src="/?documentId=simple&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1"></iframe>' }));
  await page.goto('/host');
  const panel = page.frameLocator('iframe[title="Onshape right panel"]');
  const connect = panel.getByRole('link', { name: 'Connect Onshape' });
  await expect(connect).toHaveAttribute('target', '_blank');
  await expect(connect).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(connect).toHaveAttribute('href', /\/oauth\/start\?.*documentId=simple/);
  const opened = page.context().waitForEvent('page');
  await connect.click();
  const auth = await opened;
  await expect(auth).toHaveTitle('Mock Onshape authorization');
  await expect(auth).toHaveURL(/\/oauth\/start\?.*documentId=simple.*elementId=elem1/);
  await expect(panel.getByRole('link', { name: 'Connect Onshape' })).toBeVisible();
  expect(page.url()).toMatch(/\/host$/);
  connected = true;
  await panel.getByRole('button', { name: 'Check connection' }).click();
  await expect(panel.getByRole('button', { name: 'Scan Assembly' })).toBeVisible();
});

test('mock-backed scan downloads the fixture BOM workbook', async ({ page }) => {
  await page.route('**/api/session', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ connected: true, user: { id: 'fixture', name: 'Test User' } }) }));
  await page.route('**/api/settings', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ teamNumber: null }) }));
  await page.route('**/api/scan?**', route => route.fulfill({ status: 200, contentType: 'application/x-ndjson',
    body: `${JSON.stringify({ type: 'progress', stage: 'Mock Onshape fixture', current: 1, total: 1, instances: result.stats.totalInstances })}\n${JSON.stringify({ type: 'result', result })}\n` }));
  await page.goto('/?documentId=simple&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1');
  await expect(page.locator('header img.brand-mark')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Scan Assembly' })).toBeVisible();
  await page.getByRole('button', { name: 'Scan Assembly' }).click();
  await expect(page.getByRole('button', { name: 'Download Excel BOM' })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download Excel BOM' }).click();
  const workbook = await download;
  expect(workbook.suggestedFilename()).toMatch(/^Simple_FTC_Assembly_BOM_\d{4}-\d{2}-\d{2}\.xlsx$/);
  expect(unzipSync(new Uint8Array(readFileSync(await workbook.path())))['xl/media/control-kit-logo.png']).toBeDefined();
  await page.route('**/control-kit-logo.png', route => route.fulfill({ status: 503 }));
  await expect(page.getByRole('button', { name: 'Download Excel BOM' })).toBeEnabled();
  const fallbackDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download Excel BOM' }).click();
  const fallback = await fallbackDownload;
  expect(fallback.suggestedFilename()).toMatch(/\.xlsx$/);
  expect(unzipSync(new Uint8Array(readFileSync(await fallback.path())))['xl/media/control-kit-logo.png']).toBeUndefined();
  await expect(page.getByRole('button', { name: 'Download CSV instead' })).toHaveCount(0);
  await page.evaluate(() => {
    const original = URL.createObjectURL.bind(URL);
    let failOnce = true;
    URL.createObjectURL = blob => {
      if (failOnce) { failOnce = false; throw new Error('simulated download failure'); }
      return original(blob);
    };
  });
  await expect(page.getByRole('button', { name: 'Download Excel BOM' })).toBeEnabled();
  await page.getByRole('button', { name: 'Download Excel BOM' }).click();
  await expect(page.getByRole('button', { name: 'Download CSV instead' })).toBeVisible();
  const csvDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download CSV instead' }).click();
  expect((await csvDownload).suggestedFilename()).toMatch(/^Simple_FTC_Assembly_BOM_\d{4}-\d{2}-\d{2}\.csv$/);
});

test('an unpublished vendor catalog shows a warning even when no line matched', async ({ page }) => {
  const now = new Date().toISOString();
  const vendor = (vendorId: string, state: string, complete = state === 'published') => ({ vendorId, state, complete, skipped: {}, recordCount: state === 'published' ? 10 : 0, updatedAt: state === 'published' ? now : null, lastRunAt: now, stale: false, lastRunFailed: state === 'failing', error: state === 'failing' ? 'Vendor returned HTTP 503' : null, progress: null });
  const unmatched = { ...result, lines: result.lines.map(line => ({ ...line, vendor: null, matchStatus: 'unmatched' })),
    catalogHealth: { checkedAt: now, vendors: [vendor('gobilda', 'failing'), vendor('servocity', 'building'), vendor('andymark', 'building'), vendor('rev', 'published'), vendor('pitsco', 'never-run')] } };
  const partial = { ...unmatched, catalogHealth: { ...unmatched.catalogHealth, vendors: unmatched.catalogHealth.vendors.map(item => item.vendorId === 'rev' ? { ...item, complete: false } : item) } };
  await page.route('**/api/session', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ connected: true, user: { id: 'fixture', name: 'Test User' } }) }));
  await page.route('**/api/settings', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ teamNumber: null }) }));
  await page.route('**/api/scan?**', route => route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: `${JSON.stringify({ type: 'result', result: unmatched })}\n` }));
  await page.goto('/?documentId=simple&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1');
  await page.getByRole('button', { name: 'Scan Assembly' }).click();
  const warning = page.getByRole('status').filter({ hasText: 'Vendor data incomplete' });
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('goBILDA, ServoCity, AndyMark, Pitsco');
  await expect(warning).not.toContainText('REV');
  await page.unroute('**/api/scan?**');
  await page.route('**/api/scan?**', route => route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: `${JSON.stringify({ type: 'result', result: partial })}
` }));
  await page.getByRole('button', { name: 'Scan Again' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Partial catalogs' })).toContainText('REV (10 products so far)');
});

test('STEP export polls the job, zips ready files with a manifest, and shows failures', async ({ page }) => {
  const printed = { ...result, scanId: '00000000-0000-4000-8000-000000000001', lines: result.lines.map((line, index) => index === 0 ? { ...line, disposition: 'print' } : { ...line, disposition: 'buy' }) };
  const step = "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1=PRODUCT('Guide','Guide','',(#2));\nENDSEC;\nEND-ISO-10303-21;\n";
  const parts = (state: string) => [
    { lineKey: 'a', name: 'Guide', qty: 2, disposition: 'print', partId: 'p1', configuration: null, sourceUrl: 'https://cad.onshape.com/documents/a', fileName: 'Guide__p1.step', state, error: null, units: 'mm', nameMatches: true, bytes: 80 },
    { lineKey: 'b', name: 'Motor', qty: 1, disposition: 'print', partId: 'p2', configuration: null, sourceUrl: 'https://cad.onshape.com/documents/b', fileName: 'Motor__p2.step', state: 'failed', error: 'Deliberate failure', units: null, nameMatches: null, bytes: null },
  ];
  const job = (done: boolean, state: string) => ({ jobId: '11111111-1111-4111-8111-111111111111', done, assemblyName: 'Simple FTC Assembly', scannedAt: '2026-10-24T00:00:00Z', revision: { type: 'm', id: 'mv' }, parts: parts(state) });
  let polls = 0;
  await page.route('**/api/session', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ connected: true, user: { id: 'fixture', name: 'Test User' } }) }));
  await page.route('**/api/settings', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ teamNumber: null }) }));
  await page.route('**/api/scan?**', route => route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: `${JSON.stringify({ type: 'result', result: printed })}\n` }));
  await page.route('**/api/exports', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(job(false, 'translating')) }));
  await page.route('**/api/exports/11111111-1111-4111-8111-111111111111', route => { polls++; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(job(true, 'ready')) }); });
  await page.route('**/api/exports/11111111-1111-4111-8111-111111111111/files/0', route => route.fulfill({ status: 200, contentType: 'application/step', body: step }));
  await page.goto('/?documentId=simple&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1');
  await page.getByRole('button', { name: 'Scan Assembly' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download STEP files' }).click();
  const zip = await download;
  expect(polls).toBeGreaterThanOrEqual(1);
  expect(zip.suggestedFilename()).toBe('Simple_FTC_Assembly_STEP.zip');
  const files = unzipSync(new Uint8Array(readFileSync(await zip.path())));
  expect(Object.keys(files).sort()).toEqual(['Simple_FTC_Assembly_STEP/3D_print/Guide__p1.step', 'Simple_FTC_Assembly_STEP/MANIFEST.txt']);
  await expect(page.getByRole('status').filter({ hasText: 'STEP export failed for some parts' })).toContainText('Motor: Deliberate failure');
  // When every part fails there is no ZIP, only an explanation.
  await page.unroute('**/api/exports/11111111-1111-4111-8111-111111111111');
  await page.route('**/api/exports/11111111-1111-4111-8111-111111111111', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...job(true, 'failed'), parts: parts('failed').map(item => ({ ...item, state: 'failed', error: 'Deliberate failure' })) }) }));
  await page.getByRole('button', { name: 'Download STEP files' }).click();
  await expect(page.getByRole('alert')).toContainText('No STEP file could be exported (2 parts failed).');
});
