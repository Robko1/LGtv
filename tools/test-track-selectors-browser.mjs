/** Optional real-browser layout test; build web and set PLAYWRIGHT_MODULE/BROWSER_EXECUTABLE. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const enabled = Boolean(process.env.PLAYWRIGHT_MODULE && process.env.BROWSER_EXECUTABLE);
test('track selector panels keep text centered, readable and inside rows', { skip: !enabled }, async () => {
  const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href);
  const esbuild = createRequire(resolve('web/package.json'))('esbuild');
  const bundle = await esbuild.build({ entryPoints:[resolve('tools/fixtures/track-selector-harness.tsx')], bundle:true, write:false,
    platform:'browser', format:'iife', jsx:'automatic', nodePaths:[resolve('web/node_modules')],
    define:{'process.env.NODE_ENV':'"production"'}, logLevel:'silent' });
  const html = readFileSync(resolve('build/web/index.html'), 'utf8');
  const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(x => x[1]).join('\n');
  assert.ok(css.includes('data-track-panel'), 'run web build first');
  const browser = await chromium.launch({ executablePath:process.env.BROWSER_EXECUTABLE, args:['--no-sandbox'] });
  try {
    for (const [width,height] of [[1920,1080],[1280,720],[640,360],[360,640]]) {
      const page = await browser.newPage({ viewport:{width,height} });
      await page.setContent(`<!doctype html><html class="webos-tv-root"><head><style>${css}</style></head><body class="webos-tv"><div id="root"></div></body></html>`);
      await page.addScriptTag({ content:readFileSync(resolve('webos/webos.js'),'utf8') });
      await page.addScriptTag({ content:bundle.outputFiles[0].text });
      for (const view of ['vod-audio','vod-subtitle','live','audio','subtitle']) {
        await page.evaluate(view => window.trackTest.show(view), view);
        await page.waitForSelector('[data-track-panel]');
        await page.waitForTimeout(100);
        const result = await page.evaluate(() => {
          const panel = document.querySelector('[data-track-panel]');
          const pr = panel.getBoundingClientRect();
          const issues = [];
          for (const row of panel.querySelectorAll('[data-track-option]')) {
            const rr = row.getBoundingClientRect();
            const titles = row.querySelectorAll('[data-track-title]');
            if (titles.length !== 1 || row.querySelector('[data-track-meta]') || row.textContent.trim() !== titles[0].textContent.trim()) issues.push('duplicate track text');
            for (const child of row.querySelectorAll('[data-track-title], [data-track-meta]')) {
              const r = child.getBoundingClientRect(), style = getComputedStyle(child);
              if (child.scrollWidth > child.clientWidth + 1 || child.scrollHeight > child.clientHeight + 1) issues.push(`overflow ${child.textContent}`);
              if (r.left < rr.left - 1 || r.right > rr.right + 1 || r.top < rr.top - 1 || r.bottom > rr.bottom + 1) issues.push(`outside row ${child.textContent}`);
              if (Math.abs((r.left + r.right) / 2 - (rr.left + rr.right) / 2) > 1) issues.push(`not centered ${child.textContent}`);
              if (style.textAlign !== 'center') issues.push(`not text-aligned ${child.textContent}`);
              if (child.hasAttribute('data-track-title') && parseFloat(style.fontSize) < 20) issues.push(`too small ${child.textContent}`);
            }
          }
          for (const text of panel.querySelectorAll('p, h2, h3, [data-track-help] span')) {
            if (text.scrollWidth > text.clientWidth + 1 || text.scrollHeight > text.clientHeight + 1) issues.push(`overflow other text ${text.textContent}`);
          }
          return { width:pr.width, height:pr.height, issues, html:panel.textContent };
        });
        assert.ok(result.width <= Math.min(width - 20, view === 'live' ? 800 : 520) + 1, `${width}x${height} ${view} width ${result.width}`);
        assert.ok(result.height <= height * .75 + 1, `${width}x${height} ${view} height ${result.height}`);
        assert.deepEqual(result.issues, [], `${width}x${height} ${view}: ${result.issues.join('; ')}`);
        assert.match(result.html, /Francia/); assert.match(result.html, /Német/);
        if (width === 1920 && (view === 'live' || view === 'vod-audio')) {
          mkdirSync(resolve('build/tests'), {recursive:true});
          await page.screenshot({ path:resolve(`build/tests/track-${view}.png`) });
        }
        if (view === 'vod-audio' || view === 'vod-subtitle') {
          for (let i=0; i<20; i++) { await page.keyboard.press('ArrowDown'); await page.waitForTimeout(30); }
          const focused = await page.evaluate(() => {
            const row = document.activeElement, list = row.closest('[data-track-list]');
            const r = row.getBoundingClientRect(), l = list.getBoundingClientRect();
            return { visible:r.top >= l.top-1 && r.bottom <= l.bottom+1, scroll:list.scrollTop };
          });
          assert.ok(focused.scroll > 0 && focused.visible, `${width}x${height}: VOD focus follows scroll ${JSON.stringify(focused)}`);
          await page.keyboard.press('Enter');
          if (view === 'vod-audio') assert.deepEqual(await page.evaluate(() => window.trackTest.calls.audio), ['a16']);
          else assert.deepEqual(await page.evaluate(() => window.trackTest.calls.subtitle), ['s16']);
        }
        if (view === 'live') {
          for (let i=0; i<20; i++) { await page.keyboard.press('ArrowDown'); await page.waitForTimeout(30); }
          const focus = await page.evaluate(() => {
            const row = document.querySelector('[data-track-focused="1"]'), list = row.closest('[data-track-list]');
            const r = row.getBoundingClientRect(), l = list.getBoundingClientRect();
            return { visible:r.top >= l.top-1 && r.bottom <= l.bottom+1, scroll:list.scrollTop, id:row.textContent };
          });
          assert.ok(focus.scroll > 0 && focus.visible, `${width}x${height}: selected live row must scroll into view ${JSON.stringify(focus)}`);
          await page.keyboard.press('ArrowRight');
          for (let i=0; i<20; i++) { await page.keyboard.press('ArrowDown'); await page.waitForTimeout(30); }
          const subFocus = await page.evaluate(() => {
            const row = document.querySelector('[data-track-focused="1"]'), list = row.closest('[data-track-list]');
            const r = row.getBoundingClientRect(), l = list.getBoundingClientRect();
            return { visible:r.top >= l.top-1 && r.bottom <= l.bottom+1, scroll:list.scrollTop };
          });
          assert.ok(subFocus.scroll > 0 && subFocus.visible, `${width}x${height}: selected subtitle row must scroll into view ${JSON.stringify(subFocus)}`);
          await page.keyboard.press('Enter');
          assert.deepEqual(await page.evaluate(() => window.trackTest.calls.subtitle), ['s16']);
        }
      }
      await page.close();
    }
  } finally { await browser.close(); }
});
