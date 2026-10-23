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
