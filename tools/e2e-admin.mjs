/**
 * Browser smoke test for the admin dashboard.
 *
 * Runs against a built admin and a running API with the demo seed applied. It exists
 * because "the build succeeded" and "a business owner can actually use this" are
 * different claims, and only one of them is worth making.
 *
 *   node tools/e2e-admin.mjs
 */
import { chromium } from 'playwright';

const ADMIN = process.env.ADMIN_URL ?? 'http://localhost:3001';
const EXECUTABLE = process.env.CHROMIUM_PATH ?? undefined;

const browser = await chromium.launch(EXECUTABLE ? { executablePath: EXECUTABLE } : {});
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });

const failures = [];
page.on('pageerror', (error) => failures.push(String(error)));
page.on('response', (response) => {
  // Pre-login probes legitimately 401; anything else is a real failure.
  if (response.url().includes('/v1/') && response.status() >= 400 && !response.url().includes('/auth/')) {
    failures.push(`${response.status()} ${response.url()}`);
  }
});

const steps = [];
const step = (name, detail) => { steps.push(`✓ ${name}${detail ? ` — ${detail}` : ''}`); };

await page.goto(`${ADMIN}/auth/login`, { waitUntil: 'domcontentloaded' });
await page.fill('input[type="email"]', process.env.DEMO_EMAIL ?? 'anor@bizbot.uz');
await page.fill('input[type="password"]', process.env.DEMO_PASSWORD ?? 'BizBotDemo2026');
await page.getByRole('button', { name: /Kirish/ }).click();
await page.waitForURL(`${ADMIN}/`);
await page.waitForSelector("text=/so‘m|so'm/", { timeout: 20000 });
step('signed in', (await page.locator('header p').first().textContent())?.trim());

const nav = (await page.locator('aside nav a').allTextContents()).map((s) => s.replace(/[^\p{L}\s]/gu, '').trim());
step('navigation derived from enabled modules', nav.join(', '));

for (const [label, urlPart, readySelector] of [
  ['Mahsulotlar', 'products', 'table tbody tr td p'],
  ['Buyurtmalar', 'orders', 'table tbody tr td span.tabular'],
  ['Mijozlar', 'customers', 'table tbody tr td p'],
]) {
  if (!nav.some((n) => n.includes(label))) continue;
  await page.getByRole('link', { name: new RegExp(label) }).click();
  await page.waitForURL(`**/${urlPart}`);
  await page.waitForSelector(readySelector, { timeout: 20000 });
  step(`${label} loaded`, `${await page.locator('table tbody tr').count()} rows`);
}

await page.locator('table tbody tr').first().click().catch(() => undefined);
if (await page.locator('[role="dialog"]').count()) {
  await page.keyboard.press('Escape');
  step('dialog opens and closes with Escape');
}

await browser.close();

console.log(steps.join('\n'));
if (failures.length > 0) {
  console.error('\nFailures:\n' + failures.slice(0, 10).join('\n'));
  process.exit(1);
}
console.log('\nNo console errors, no failed API calls.');
