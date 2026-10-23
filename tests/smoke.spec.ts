import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { aggregateAssembly, type AssemblyDefinition } from '../packages/shared/src/index';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/assembly-simple.json', import.meta.url), 'utf8')) as AssemblyDefinition;
const result = aggregateAssembly(fixture, { documentId: 'simple', workspaceOrVersion: 'w', workspaceOrVersionId: 'work1', elementId: 'elem1' }, 'Simple FTC Assembly');

test('mock-backed scan downloads the fixture BOM workbook', async ({ page }) => {
  await page.route('**/api/session', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ connected: true, user: { id: 'fixture', name: 'Test User' } }) }));
  await page.route('**/api/settings', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ teamNumber: null }) }));
  await page.route('**/api/scan?**', route => route.fulfill({ status: 200, contentType: 'application/x-ndjson',
    body: `${JSON.stringify({ type: 'progress', stage: 'Mock Onshape fixture', current: 1, total: 1, instances: result.stats.totalInstances })}\n${JSON.stringify({ type: 'result', result })}\n` }));
  await page.goto('/?documentId=simple&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1');
  await expect(page.getByRole('button', { name: 'Scan Assembly' })).toBeVisible();
  await page.getByRole('button', { name: 'Scan Assembly' }).click();
  await expect(page.getByRole('button', { name: 'Download Excel BOM' })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download Excel BOM' }).click();
  expect((await download).suggestedFilename()).toMatch(/^Simple_FTC_Assembly_BOM_\d{4}-\d{2}-\d{2}\.xlsx$/);
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
