/** Optional Chromium integration: web build, PLAYWRIGHT_MODULE and BROWSER_EXECUTABLE required.
 * Real CSS/layout + real React ChannelList + webOS capture; not a physical TV benchmark. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const enabled = Boolean(process.env.PLAYWRIGHT_MODULE && process.env.BROWSER_EXECUTABLE);
test('channel focus follows every fast remote key while the real list scrolls', { skip: !enabled }, async () => {
  const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href);
  const esbuild = createRequire(resolve('web/package.json'))('esbuild');
  const harness = `
import React from 'react'; import { createRoot } from 'react-dom/client';
import { ChannelList } from './web/src/components/ChannelList';
const channels = Array.from({length: 100}, (_, i) => ({id:'ch-'+i, name:'Channel '+i, streamUrl:'http://example.invalid/'+i, isFavorite:false}));
window.selected = [];
createRoot(document.getElementById('root')).render(<ChannelList channels={channels} activeProvider={null} epgReady={false} epgRevision={0} selectedChannelId="ch-0"
 onSelectChannel={c=>window.selected.push(c.id)} onToggleFavorite={()=>{}} onDeleteChannel={()=>{}} categories={[]} folders={[]}
 selectedCategoryId="all" isOnlyFavorites={false} selectedFavoriteFolderId={null} onSelectFavoriteFolder={()=>{}}/>);
`;
  const bundle = await esbuild.build({ stdin: { contents: harness, resolveDir: resolve('.'), loader: 'tsx' }, bundle: true,
    write: false, platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths: [resolve('web/node_modules')],
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const html = readFileSync(resolve('build/web/index.html'), 'utf8');
  const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
  assert.ok(css.includes('data-live-player-slot'), 'build web first');
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.setContent(`<!doctype html><style>${css}</style><body class="webos-tv"><header><button data-tv-header data-tv-header-default>Menü</button></header><div id="root" style="position:absolute;right:0;top:100px;width:560px;height:850px;display:flex"></div></body>`);
    await page.addScriptTag({ content: readFileSync(resolve('webos/webos.js'), 'utf8') });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.waitForSelector('[data-channel-id="ch-0"] [role="option"]');
    await page.waitForTimeout(150);
    await page.locator('[data-channel-id="ch-0"] [role="option"]').focus();
    // A single task deliberately sends every key before any animation frame.
    const result = await page.evaluate(() => {
      const list = document.querySelector('[role="listbox"]');
      const focused = () => document.activeElement?.closest('[data-channel-id]')?.getAttribute('data-channel-id');
      const press = key => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key, keyCode:key === 'ArrowDown' ? 40 : 38, bubbles:true, cancelable:true, repeat:true}));
      const observations = [];
      for (let i = 1; i <= 45; i++) { press('ArrowDown'); observations.push(focused()); }
      const scrollDown = list.scrollTop;
      for (let i = 44; i >= 5; i--) { press('ArrowUp'); observations.push(focused()); }
      const r = document.activeElement.getBoundingClientRect(), lr = list.getBoundingClientRect();
      return { observations, scrollDown, scrollUp: list.scrollTop, inViewport: r.top >= lr.top - 1 && r.bottom <= lr.bottom + 1, selected: window.selected.slice() };
    });
    assert.deepEqual(result.observations, [...Array.from({length:45}, (_, i) => `ch-${i+1}`), ...Array.from({length:40}, (_, i) => `ch-${44-i}`)]);
    assert.ok(result.scrollDown > result.scrollUp && result.inViewport, 'scroll follows the focused row in both directions');
    assert.deepEqual(result.selected, [], 'arrows do not change playback');
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => document.activeElement?.closest('[data-channel-id]')?.getAttribute('data-channel-id')), 'ch-5');
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => window.selected), ['ch-5'], 'OK selects exactly the focused row');
  } finally { await browser.close(); }
});
