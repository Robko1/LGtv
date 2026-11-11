/**
 * Optional real-layout regression: build web first, then set PLAYWRIGHT_MODULE
 * to a playwright-core module path and BROWSER_EXECUTABLE to Chromium.
 * Unlike jsdom this checks actual flex geometry and coverage, not TV painting.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const enabled = Boolean(process.env.PLAYWRIGHT_MODULE && process.env.BROWSER_EXECUTABLE);
test('fullscreen keeps the home OSD and player slot in place', { skip: !enabled }, async () => {
  const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href);
  const html = readFileSync(resolve('build/web/index.html'), 'utf8');
  const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[1]).join('\n');
  assert.ok(css?.includes('data-live-player-slot'), 'build the current web app before running the browser test');
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox'] });
  try {
    for (const [width, height] of [[1920, 1080], [1280, 720], [1366, 768], [900, 600]]) {
      for (const mirror of [false, true]) for (const osdVisible of [false, true]) {
        const page = await browser.newPage({ viewport: { width, height } });
        const player = `<div data-tv-player class="relative w-full flex-1 min-h-0 max-h-none bg-black overflow-hidden group select-none shadow-2xl border-b border-cyan-900/30" style="width:100%;height:auto;min-height:0;max-height:none;aspect-ratio:16 / 9"><video></video></div>`;
        const osd = `<div data-live-osd ${osdVisible ? '' : 'style="display:none"'}><div class="relative box-border w-full h-[260px] min-h-[260px] max-h-[260px] overflow-hidden px-4 pt-2 pb-2 gap-1 bg-[#0e1d3b]/95 border-2 border-cyan-500/60 rounded-xl flex flex-col select-none shadow-sm main-live-osd"><button>EPG</button></div></div>`;
        const fixture = (content) => `<!doctype html><style>${css}</style><div class="flex flex-col" style="height:100vh;width:100vw"><header style="height:64px;flex:none">TV Mozi Sorozat</header><div class="flex-1 flex flex-col ${mirror ? 'md:flex-row-reverse' : 'md:flex-row'} overflow-hidden min-h-0"><div class="flex-1 flex flex-col overflow-hidden min-h-0 md:min-w-0">${content}${osd}</div><div data-live-sidebar class="flex-1 md:flex-none md:w-[380px] lg:w-[420px] xl:w-[480px] 2xl:w-[560px] flex flex-col overflow-hidden min-h-0 bg-[#070e1e]"></div></div></div>`;
        const rect = (el) => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
        // Compare the unmodified home layout to the new wrapper, not just to itself.
        await page.setContent(fixture(player));
        const old = await page.locator('[data-tv-player]').evaluate(rect);
        const oldOsd = await page.locator('[data-live-osd]').evaluate(rect);
        // Keep the fullscreen overlay mounted, simulating a delayed parent
        // React commit while the player itself has already exited fullscreen.
        const fullscreenOsd = `<div data-fullscreen-osd class="fixed inset-0 flex flex-col justify-between pointer-events-none text-white" style="z-index:2147483001"><div class="bg-gradient-to-b from-black/85 via-black/40 to-transparent">FULLSCREEN TITLE</div><div class="bg-gradient-to-t from-black/90 via-black/55 to-transparent">FULLSCREEN EPG</div></div>`;
        await page.setContent(fixture(`<div data-live-player-slot>${player}</div>${fullscreenOsd}`));
        const fullscreenOverlay = page.locator('[data-fullscreen-osd]');
        assert.equal(await fullscreenOverlay.evaluate(el => getComputedStyle(el).display), 'none', 'stale fullscreen OSD is hidden on home');
        const slot = page.locator('[data-live-player-slot]');
        const video = page.locator('[data-tv-player]');
        const controls = page.locator('[data-live-osd]');
        const before = await slot.evaluate(rect);
        const homePlayer = await video.evaluate(rect);
        const homeOsd = await controls.evaluate(rect);
        const compare = (a, b, what) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) <= 1, `${width}x${height} mirror=${mirror} osd=${osdVisible}: ${what} ${a} != ${b}`));
        compare(homePlayer, old, 'home player geometry changed');
        compare(homeOsd, oldOsd, 'home OSD geometry changed');
        await video.evaluate(el => el.className = el.className.replace('flex-1 min-h-0 max-h-none', 'iptv-fs h-screen max-h-none aspect-auto fixed inset-0 z-[9999]'));
        await page.evaluate(() => { document.body.classList.add('iptv-tv-fullscreen'); document.querySelector('[data-live-osd]').setAttribute('data-view-hidden', ''); });
        assert.notEqual(await fullscreenOverlay.evaluate(el => getComputedStyle(el).display), 'none', 'fullscreen OSD is visible in fullscreen');
        compare(await slot.evaluate(rect), before, 'slot moved in fullscreen');
        compare(await controls.evaluate(rect), homeOsd, 'OSD moved in fullscreen');
        if (osdVisible) {
          assert.equal(await controls.evaluate(el => getComputedStyle(el).visibility), 'visible');
          assert.equal(await page.evaluate(() => document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest('[data-tv-player]') !== null), true, 'fullscreen player covers the page');
        }
        await video.evaluate(el => el.className = el.className.replace('iptv-fs h-screen max-h-none aspect-auto fixed inset-0 z-[9999]', 'flex-1 min-h-0 max-h-none'));
        await page.evaluate(() => { document.body.classList.remove('iptv-tv-fullscreen'); document.querySelector('[data-live-osd]').removeAttribute('data-view-hidden'); });
        assert.equal(await fullscreenOverlay.evaluate(el => getComputedStyle(el).display), 'none', 'mounted fullscreen OSD and gradients disappear immediately on exit');
        assert.equal(await fullscreenOverlay.locator('div').first().evaluate(el => el.getClientRects().length), 0, 'fullscreen title and shadow are not painted');
        compare(await slot.evaluate(rect), before, 'slot moved after exit');
        compare(await video.evaluate(rect), old, 'player moved after exit');
        compare(await controls.evaluate(rect), homeOsd, 'OSD moved after exit');
        await page.close();
      }
    }
  } finally { await browser.close(); }
});
