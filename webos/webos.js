// webOS TV specifikus – Magic Remote + távirányító + egér + fókusz fix 2.5.1
//
// FONTOS: ez a fájl SZÁNDÉKOSAN ES5 szintaxissal készült (var, function,
// catch (err), nincs template literal, nincs nyíl-függvény, nincs
// Array.find / String.startsWith). A régebbi LG webOS TV-k böngészőmotorja
// (Chrome 38–53) a modern szintaxison SyntaxError-ral elhasal, és akkor a
// TELJES távirányító-kezelő script meg sem töltődik – az app kinyílik, de a
// távirányító egyetlen gombjára sem reagál. Ne írj bele modern szintaxist!
(function() {
  'use strict';

  window.IS_WEBOS_TV = true;
  window.IS_LG_WEBOS = true;
  window.WEBOS_LANDSCAPE_SPLASH = true;
  window.WEBOS_FAST_LOAD = true;
  window.WEBOS_SMALL_PLAYER = true;
  window.WEBOS_NATIVE_HLS = true;

  try { console.log('[webOS] TV webOS 2.5.1 inicializálás – induló videó + távirányító fix (ES5)'); } catch (e) {}

  // ---------- Gombkód / kulcsnév egységesítés ----------
  // A régi webOS a nyilakra 'Up'/'Down'/'Left'/'Right' nevet (vagy semmit,
  // csak keyCode-ot) küld. OK = 13, VISSZA = 461, CH+/- = 33/34.
  var KEYCODE_TO_KEY = {
    37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown',
    13: 'Enter', 32: ' ', 8: 'Backspace', 27: 'Escape',
    33: 'PageUp', 34: 'PageDown',
    461: 'Escape',
    415: 'MediaPlay', 19: 'MediaPause', 413: 'MediaStop',
    412: 'MediaRewind', 417: 'MediaFastForward',
    403: 'ColorF0Red', 404: 'ColorF1Green', 405: 'ColorF2Yellow', 406: 'ColorF3Blue'
  };
  var LEGACY_KEY_TO_KEY = {
    'Up': 'ArrowUp', 'Down': 'ArrowDown', 'Left': 'ArrowLeft', 'Right': 'ArrowRight',
    'Esc': 'Escape', 'Spacebar': ' ', 'U+0020': ' ',
    'OK': 'Enter', 'Accept': 'Enter', 'Select': 'Enter', 'NumpadEnter': 'Enter',
    'Back': 'Escape', 'GoBack': 'Escape', 'BrowserBack': 'Escape', 'XF86Back': 'Escape'
  };
  var KEY_TO_KEYCODE = {
    'ArrowLeft': 37, 'ArrowUp': 38, 'ArrowRight': 39, 'ArrowDown': 40,
    'Enter': 13, ' ': 32, 'Backspace': 8, 'Escape': 27,
    'PageUp': 33, 'PageDown': 34
  };

  function normalizeKey(e) {
    var kc = e.keyCode || e.which || 0;
    if (kc && KEYCODE_TO_KEY[kc]) return KEYCODE_TO_KEY[kc];
    var raw = e.key || '';
    if (raw && LEGACY_KEY_TO_KEY[raw]) return LEGACY_KEY_TO_KEY[raw];
    if (raw === 'Unidentified') return '';
    return raw;
  }

  function isArrowKey(key) {
    return key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight';
  }

  // ---------- Kompatibilitási polyfillek régi webOS motorokhoz ----------
  // Element.matches / Element.closest – Chrome 41 előtt nincs (webOS 3.x!)
  try {
    var elProto = window.Element && Element.prototype;
    if (elProto) {
      if (!elProto.matches) {
        elProto.matches = elProto.webkitMatchesSelector || elProto.msMatchesSelector ||
          function(sel) {
            var all = (this.document || this.ownerDocument).querySelectorAll(sel);
            for (var i = 0; i < all.length; i++) { if (all[i] === this) return true; }
            return false;
          };
      }
      if (!elProto.closest) {
        elProto.closest = function(sel) {
          var el = this;
          while (el && el.nodeType === 1) {
            if (el.matches(sel)) return el;
            el = el.parentElement || el.parentNode;
          }
          return null;
        };
      }
    }
  } catch (ePoly1) {}
  // AbortController – Chrome 66 előtt nincs; a hálózati kód (net.ts) enélkül
  // már a betöltésnél elszállna. Minimál változat: a jelzőt beállítja,
  // a fetch polyfill (whatwg-fetch) együttműködik vele.
  try {
    if (typeof window.AbortController === 'undefined') {
      var AbortSignalPoly = function() {
        this.aborted = false;
        this.onabort = null;
        this._listeners = [];
      };
      AbortSignalPoly.prototype.addEventListener = function(type, fn) {
        if (type === 'abort') this._listeners.push(fn);
      };
      AbortSignalPoly.prototype.removeEventListener = function(type, fn) {
        if (type !== 'abort') return;
        var idx = this._listeners.indexOf(fn);
        if (idx >= 0) this._listeners.splice(idx, 1);
      };
      AbortSignalPoly.prototype.dispatchEvent = function(ev) {
        if (ev && ev.type === 'abort') {
          this.aborted = true;
          if (typeof this.onabort === 'function') { try { this.onabort(ev); } catch (eA) {} }
          for (var i = 0; i < this._listeners.length; i++) { try { this._listeners[i](ev); } catch (eB) {} }
        }
        return true;
      };
      var AbortControllerPoly = function() { this.signal = new AbortSignalPoly(); };
      AbortControllerPoly.prototype.abort = function() {
        if (this.signal.aborted) return;
        this.signal.dispatchEvent({ type: 'abort' });
      };
      window.AbortController = AbortControllerPoly;
      window.AbortSignal = AbortSignalPoly;
    }
  } catch (ePoly2) {}
  // requestIdleCallback – Chrome 47 előtt nincs
  try {
    if (typeof window.requestIdleCallback === 'undefined') {
      window.requestIdleCallback = function(cb) {
        return window.setTimeout(function() {
          cb({ didTimeout: false, timeRemaining: function() { return 16; } });
        }, 1);
      };
      window.cancelIdleCallback = function(id) { window.clearTimeout(id); };
    }
  } catch (ePoly3) {}

  // ---------- Képernyős diagnosztika – távirányító teszt a TV-n ----------
  // Az induláskor 2 percig látható kis sáv megmutatja:
  //  - a TV böngészőmotorját,
  //  - betöltődött-e a React felület,
  //  - az utoljára lenyomott távirányító-gombot (keyCode + név).
  // A külön képernyős diagnosztika csak felülethiba esetén jelenik meg; a piros gomb a napló QR-kódját nyitja.
  var diag = {
    el: null, keyLine: null, uiLine: null, mouseLine: null,
    keyCount: 0, mouseMoves: 0, clicks: 0, hideTimer: 0, uiLoaded: false, forced: false
  };

  function chromeVersion() {
    try {
      var m = (navigator.userAgent || '').match(/Chr[o0]me\/(\d+)/i);
      return m ? ('Chrome ' + m[1]) : (navigator.userAgent || 'ismeretlen').slice(0, 60);
    } catch (e) { return 'ismeretlen'; }
  }

  function diagEnsure() {
    if (diag.el || !document.body) return diag.el;
    try {
      var box = document.createElement('div');
      box.id = 'webos-rc-diag';
      box.setAttribute('style',
        'position:fixed;left:16px;bottom:16px;z-index:2147483000;max-width:72vw;' +
        'background:rgba(2,10,25,0.88);border:2px solid #00BFFF;border-radius:10px;' +
        'padding:10px 16px;color:#aee9ff;font:600 20px/1.45 monospace;pointer-events:none;' +
        'white-space:pre-wrap;word-break:break-word;display:none;');
      var title = document.createElement('div');
      // A verziószám a futó alkalmazásból jön (appVersion.ts teszi közzé),
      // így a diagnosztika SOHA nem mutathat régi, beégetett számot.
      var appVer = '';
      try { appVer = String(window.IPTV_RT_WEB_VERSION || ''); } catch (e) {}
      title.textContent = 'TV diagnosztika ' + (appVer || '2.5.1') + ' \u2013 ' + chromeVersion();
      title.setAttribute('style', 'color:#00BFFF;');
      diag.uiLine = document.createElement('div');
      diag.uiLine.textContent = 'Felület: betöltés...';
      diag.keyLine = document.createElement('div');
      diag.keyLine.textContent = 'Nyomj egy gombot a távirányítón...';
      diag.mouseLine = document.createElement('div');
      diag.mouseLine.textContent = 'Egér/kattintás: 0 / 0';
      // Tároló-próba: kiderül, miért veszik el a csatornalista újraindításkor.
      var storLine = document.createElement('div');
      storLine.textContent = 'Tároló: próba...';
      try {
        var caps = [262144, 1048576, 2097152];
        var okCap = 0;
        var filler = new Array(1025).join('x'); // 1 KB
        for (var ci = 0; ci < caps.length; ci++) {
          try {
            var chunkKB = Math.floor(caps[ci] / 1024);
            var big = '';
            for (var bi = 0; bi < chunkKB; bi++) { big += filler; }
            window.localStorage.setItem('iptv_rt_captest', big);
            window.localStorage.removeItem('iptv_rt_captest');
            okCap = caps[ci];
          } catch (capErr) { break; }
        }
        var saved = 0;
        for (var ki = 0; ki < window.localStorage.length; ki++) {
          var kk = window.localStorage.key(ki) || '';
          if (kk.indexOf('iptv') === 0) { saved += (window.localStorage.getItem(kk) || '').length; }
        }
        storLine.textContent = 'T\u00e1rol\u00f3: localStorage OK, \u00edrhat\u00f3 ~' + Math.round(okCap / 1048576 * 10) / 10 + ' MB, mentve ' + Math.round(saved / 1024) + ' KB';
      } catch (storErr) {
        storLine.textContent = 'T\u00e1rol\u00f3 HIBA: localStorage nem el\u00e9rhet\u0151 (' + (storErr && storErr.name ? storErr.name : storErr) + ') - ez\u00e9rt v\u00e9sz el a lista!';
        storLine.setAttribute('style', 'color:#f87171;');
      }
      var hint = document.createElement('div');
      hint.textContent = 'PIROS: napló QR · ZÖLD: hangsáv · SÁRGA: kedvenc · KÉK: csatornamozgatás';
      hint.setAttribute('style', 'color:#64748b;font-size:16px;margin-top:4px;');
      box.appendChild(title);
      box.appendChild(diag.uiLine);
      box.appendChild(diag.keyLine);
      box.appendChild(diag.mouseLine);
      box.appendChild(storLine);
      box.appendChild(hint);
      document.body.appendChild(box);
      diag.el = box;
    } catch (e) {}
    return diag.el;
  }

  function diagShow() {
    if (!diagEnsure()) return;
    diag.el.style.display = 'block';
    if (diag.hideTimer) clearTimeout(diag.hideTimer);
    // 2 perc után magától eltűnik, HA a felület betöltődött.
    diag.hideTimer = setTimeout(function() {
      if (diag.el && diag.uiLoaded && !diag.forced) diag.el.style.display = 'none';
    }, 120000);
  }

  function diagKey(e, normalized) {
    try {
      if (!diagEnsure()) return;
      diag.keyCount++;
      var kc = e.keyCode || e.which || 0;
      diag.keyLine.textContent = 'Gomb #' + diag.keyCount + ': keyCode=' + kc +
        ' key="' + (e.key || '') + '" \u2192 ' + (normalized || '?');
    } catch (eD) {}
  }

  function diagUiCheck() {
    try {
      if (!diagEnsure()) return;
      // A kirajzolt app (fejléc) számít, nem a splash megléte.
      var list = document.querySelector('[role="listbox"], [role="dialog"], header');
      if (list || window.__IPTV_APP_READY__) {
        diag.uiLoaded = true;
        diag.uiLine.textContent = 'Felület: BET\u00d6LT\u0150D\u00d6TT \u2713';
        diag.uiLine.style.color = '#4ade80';
      } else {
        diag.uiLine.textContent = 'Felület: M\u00c9G NEM t\u00f6lt\u0151d\u00f6tt be...';
        diag.uiLine.style.color = '#facc15';
      }
    } catch (e) {}
  }

  function diagUiFail() {
    try {
      if (!diagEnsure() || diag.uiLoaded) return;
      diag.uiLine.textContent = 'Felület: NEM t\u00f6lt\u0151d\u00f6tt be \u2013 a TV motorja nem futtatta az appot!';
      diag.uiLine.style.color = '#f87171';
      diagShow();
    } catch (e) {}
  }

  function arrayFind(list, fn) {
    for (var i = 0; i < list.length; i++) {
      if (fn(list[i])) return list[i];
    }
    return null;
  }

  // ---------- CSS – TV fókusz gyűrű, kisebb lejátszó, gyors betöltés ----------
  function markRootForTv() {
    try {
      var h = document.documentElement;
      if (h && h.className.indexOf('webos-tv-root') < 0) {
        h.className = (h.className ? h.className + ' ' : '') + 'webos-tv-root';
      }
    } catch (e) {}
  }

  function injectTvCss() {
    markRootForTv();
    try {
      var css = [
        'body.webos-tv, body.lg-webos { background:#000; overflow:hidden; }',
        '/* NAGY TV-KIJELZŐ: a korábbi zoom 1.4 megoldás kilógó ablakokat és',
        '   levágott széleket okozott ezen a webOS-en. Helyette rem-alapú',
        '   betűméret-nagyítás: a felület minden eleme arányosan nő, de a',
        '   képernyőhöz (vh/vw) igazodó méretek pontosak maradnak - semmi',
        '   nem lóghat ki. */',
        'html.webos-tv-root { font-size: 125%; }',
        '/* OVERSCAN-VÉDELEM: a TV a kép legszélét levághatja (az óra doboz',
        '   bal széle és a lejátszó széle lógott ki) - biztonsági szegély. */',
        '.webos-tv #root { padding: 6px 14px 24px 14px; box-sizing: border-box; height: 100vh; overflow: hidden; }',
        '/* A FO KERET magassaga: a regi webOS Chrome nem ismeri a 100dvh',
        '   egyseget, igy a keret automata magassagu lett es a jobb oldali',
        '   csatornalista doboz alja lelogott a kepernyorol - fix 100%. */',
        '.webos-tv [data-app-root] { height: 100% !important; min-height: 0 !important; max-height: 100% !important; }',
        '/* Teljes kepernyos lejatszo: dvh helyett vh a regi Chrome-on. */',
        '.webos-tv [data-tv-player].fixed { width: 100vw !important; height: 100vh !important; z-index: 2147483000 !important; }',
        '/* TELJES KEPERNYO: a regi Chrome a 100dvh-t nem ismeri, ezert a doboz',
        '   magassaga 0 lehetett, a kep pedig balrol elcsuszott. Itt fixen a',
        '   teljes kijelzot hasznaljuk - bal oldali fekete sav nem maradhat. */',
        '.webos-tv [data-tv-player].fixed { left:0 !important; top:0 !important; right:0 !important; bottom:0 !important; margin:0 !important; padding:0 !important; border:0 !important; max-width:none !important; max-height:none !important; transform:none !important; outline:none !important; box-shadow:none !important; }',
        '.webos-tv [data-tv-player].fixed video { position:absolute !important; left:0 !important; top:0 !important; width:100% !important; height:100% !important; max-width:none !important; object-fit:fill !important; }',
        '/* Teljes kepernyon a #root belső margoja es a fo keret kék szegelye sem',
        '   latszhat (ezek adtak kek csíkot a bal also/felso sarokba). */',
        'body.iptv-tv-fullscreen #root { padding:0 !important; }',
        'body.iptv-tv-fullscreen [data-app-root] { border:0 !important; padding:0 !important; }',
        'body.iptv-tv-fullscreen [data-tv-player].fixed:focus { outline:none !important; }',
        '/* Teljes kepernyon a fooldal SEMMI eleme nem latszhat at (a bal',
        '   felso sarokban a fejlec kek ora doboza latszott at). */',
        'body.iptv-tv-fullscreen header { visibility: hidden !important; }',
        '/* A fooldali kis lejatszo folott az OSD retegek TV-n nem jelennek',
        '   meg (es a kijelolo sem ugorhat rajuk) - tiszta TV-kep a dobozban. */',
        '.webos-tv [data-tv-player]:not(.fixed) [data-player-osd] { display: none !important; }',
        '/* Regi webOS flexbox: a lista sose nojon a tartalommal a kepernyon tulra. */',
        '.webos-tv [role="listbox"] { min-height: 0 !important; }',
        '/* A felugró ablak sose lógjon ki fent és lent. A korlát a BELSŐ',
        '   panelre vonatkozik, NEM a teljes képernyős sötét háttérrétegre',
        '   (a 86vh a háttérréteget rövidítette meg: alul vastag sáv látszott,',
        '   ami a Rendszer fül alját takarta, a QR teteje pedig kilógott). */',
        '.webos-tv [role="dialog"]:not(.fixed) { max-height: 92vh !important; }',
        '.webos-tv [role="dialog"].items-center > div { max-height: 92vh !important; }',
        '/* A modal belső görgetője az aljáig elérhető legyen (Rendszer fül vége). */',
        '/* NAGYOBB IRAS a beallitasok ablakban (Kedvencek es Rendszer ful is,',
        '   a Listak dobozaihoz hasonlo, TV-rol olvashato meretek). */',
        '.webos-tv [role="dialog"][aria-label="Menü és beállítások"] .text-\\[10px\\] { font-size: 16px !important; line-height: 1.35 !important; }',
        '.webos-tv [role="dialog"][aria-label="Menü és beállítások"] .text-\\[11px\\] { font-size: 17px !important; line-height: 1.35 !important; }',
        '.webos-tv [role="dialog"][aria-label="Menü és beállítások"] .text-xs { font-size: 19px !important; line-height: 1.4 !important; }',
        '.webos-tv [role="dialog"][aria-label="Menü és beállítások"] .text-sm { font-size: 21px !important; line-height: 1.4 !important; }',
        '.webos-tv [role="dialog"][aria-label="Menü és beállítások"] .text-base { font-size: 23px !important; line-height: 1.4 !important; }',
        '.webos-tv [role="dialog"] .overflow-y-auto { padding-bottom: 56px !important; }',
        '/* DOBOZ NAVIGÁCIÓ: a kijelölt beállítás-doboz jól látható sárga keretet kap. */',
        '/* A kék óra teljes képernyőn a jobb felső sarokban kilógott a',
        '   képernyőből (overscan) - TV-n beljebb toljuk. */',
        '.webos-tv [data-blue-clock] { right: 36px !important; top: 16px !important; left: auto !important; }',
        '/* A LEJATSZO DOBOZ SOSEM kap kek fokuszkeretet: a kijelolo a listan jar. */',
        '.webos-tv [data-tv-player]:focus, .webos-tv [data-tv-player]:focus-visible { outline:none !important; box-shadow:none !important; }',
        '.webos-tv [data-tv-box] { scroll-margin: 40px; transition: none !important; }',
        '.webos-tv [data-tv-box]:focus { outline: 3px solid #fbbf24 !important; outline-offset: 3px; }',
        '/* AZONNALI kijelölő-ugrálás MINDENHOL: a 150-300 ms-os CSS átmenetek',
        '   a TV lassú processzorán vánszorgássá teszik a sárga kijelölés',
        '   mozgását - az átmenetek a teljes felületen ki vannak kapcsolva.',
        '   (A folyamatos animációk - pörgő töltés, óra - megmaradnak.) */',
        '.webos-tv *, .webos-tv *:before, .webos-tv *:after { transition-duration: 0s !important; transition-delay: 0s !important; }',
        '.webos-tv, .webos-tv * { scroll-behavior: auto !important; }',
        '/* ELMOSÁS KI: a backdrop-blur a teljes alatta levo kepet ujraszamolja',
        '   minden kockaban - a regi webOS GPU-n ez a legdragabb muvelet. */',
        '.webos-tv *, .webos-tv *:before, .webos-tv *:after {',
        '  -webkit-backdrop-filter: none !important; backdrop-filter: none !important; }',
        '/* TV-n a hover-transform (translate/scale) is felesleges ujrarajzolas. */',
        'body.has-mouse [role="option"]:hover { transform: none !important; }',
        '/* NYUGODT ANIMÁCIÓK TV-N: az óra ikon pislogása és a fogaskerék',
        '   pörgése sokkal lassabb, saját keyframe-mel (a Tailwind 4 arbitrary',
        '   animációk CSS-változós időtartama a régi webOS Chrome-on elveszhet,',
        '   ettől pörgött őrült gyorsan a fogaskerék). */',
        '@keyframes iptvSlowSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }',
        '@keyframes iptvSlowPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }',
        '.webos-tv .animate-spin { animation: iptvSlowSpin 2.5s linear infinite !important; }',
        '.webos-tv .video-player-container { max-width:1280px; margin:0 auto; }',
        '.webos-tv .channel-list { max-height:70vh; }',
        '/* Erős fókusz gyűrű TV-re – távirányítóhoz */',
        '.webos-tv *:focus { outline:3px solid #00BFFF !important; outline-offset:2px; }',
        '/* NINCS NAGY DOBOZ: a csatornalista konténerének fokusza nem rajzol',
        '   keretet - a néző csak a sorok sárga kijelölését látja. */',
        '.webos-tv [role="listbox"]:focus, .webos-tv [role="listbox"]:focus-visible { outline:none !important; box-shadow:none !important; }',
        '/* A fejlec es a mappasav kijeloloje is sarga (ugyanaz, mint a soroké). */',
        '.webos-tv header [data-tv-header]:focus, .webos-tv [data-tv-folders]:focus,',
        '.webos-tv [data-tv-folder]:focus { outline:3px solid #fbbf24 !important; outline-offset:2px; box-shadow:0 0 0 4px rgba(251,191,36,0.30) !important; }',
        '.webos-tv [role="option"]:focus, .webos-tv [role="option"]:focus-visible {',
        '  outline:3px solid #06b6d4 !important; outline-offset:2px;',
        '  box-shadow:0 0 0 6px rgba(6,182,212,0.3), 0 0 20px rgba(6,182,212,0.2) !important;',
        '  z-index:10;',
        '}',
        '.webos-tv button:focus-visible, .webos-tv [role="button"]:focus-visible {',
        '  outline:3px solid #06b6d4 !important; outline-offset:2px;',
        '  box-shadow:0 0 0 4px rgba(6,182,212,0.2);',
        '}',
        '/* Egér – Magic Remote pointer */',
        'body.has-mouse [role="option"], body.has-mouse button { cursor:pointer; }',
        'body.has-mouse [role="option"]:hover { transform:translateY(-1px); filter:brightness(1.1); }',
        '/* FONTOS: korábban itt minden elem animációja 0.15s-re volt gyorsítva,',
        '   ettől a töltéskerék és az óra őrülten pörgött/villogott a TV-n. Törölve. */',
        '/* Modal fókusz */',
        '.webos-tv [role="dialog"]:focus { outline:none; }',
        '.webos-tv [role="dialog"] button:focus { outline:3px solid #facc15 !important; }',
        '/* Nincs induló videó (2.5.0): a TV saját indítóképernyője után',
        '   azonnal a főoldal jön. Csak a hibaképernyő maradt. */',
        '#boot-error-screen { z-index:2147483000; }'
      ].join('\n');
      var style = document.createElement('style');
      style.id = 'webos-tv-fix-css';
      style.textContent = css;
      document.head.appendChild(style);
    } catch (e) { try { console.warn('[webOS] CSS inject fail', e); } catch (e2) {} }
  }

  // ---------- Fókusz helper – csatornalista + modalok ----------
  function getFocusable(container) {
    try {
      var root = container || document;
      var list = root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      return Array.prototype.slice.call(list).filter(function(el) {
        // Az offsetParent a position:fixed elemeknél null lehet, pedig láthatók.
        // A látható rect megbízhatóbban működik webOS-en és modális ablakokban.
        var hiddenAncestor = el.closest ? el.closest('[hidden]') : null;
        // A TV lejátszó dobozába (és az OSD gombjaira) a kijelölő SOHA nem
        // ugorhat át a főoldalról - csak teljes képernyőn (.fixed) él a doboz.
        var playerBox = el.closest ? el.closest('[data-tv-player]') : null;
        if (playerBox && playerBox.className.indexOf('fixed') === -1) return false;
        return !el.hasAttribute('disabled') && el.getClientRects().length > 0 &&
          !hiddenAncestor && el.getAttribute('aria-hidden') !== 'true';
      });
    } catch (e) { return []; }
  }

  /**
   * Csak a látható elemek, de biztonsági tartalékkal: ha a motor nem ad
   * befoglaló méretet (pl. régi webOS vagy tesztkörnyezet), akkor a teljes
   * listát használjuk - így a kijelölő soha nem akad el.
   */
  function visibleOrAll(items) {
    var visible = items.filter(function(el) {
      return el.getClientRects && el.getClientRects().length > 0;
    });
    return visible.length ? visible : items;
  }

  function focusFirstChannelList() {
    try {
      // FONTOS – fókuszrablás tiltása: korábban ez a függvény akkor is
      // visszarántotta a fókuszt a csatornalistára/első gombra, ha a néző
      // épp a menüben vagy egy gombon állt ("magától visszaugrik" hiba).
      // Csak akkor fókuszálunk, ha jelenleg SENKINÉL sincs a fókusz.
      var current = document.activeElement;
      if (current && current !== document.body && current !== document.documentElement) {
        return false;
      }
      // Ha modal nyitva van, fókusz a modalra, ne a listára
      var dialog = document.querySelector('[role="dialog"]');
      if (dialog) {
        var focusable = getFocusable(dialog);
        if (focusable.length) {
          var btn = arrayFind(focusable, function(el) { return el.tagName === 'BUTTON'; });
          (btn || focusable[0]).focus({preventScroll:true});
          return true;
        }
        dialog.focus();
        return true;
      }
      var list = document.querySelector('[role="listbox"]');
      if (list) {
        if (!list.hasAttribute('tabindex')) list.setAttribute('tabindex', '0');
        var active = document.activeElement;
        if (active && active.tagName === 'INPUT') return false;
        if (active && active.closest && active.closest('[role="dialog"]')) return false;
        if (!list.contains(active)) {
          list.focus({preventScroll:true});
          var selId = null;
          try { selId = list.getAttribute('data-selected-id'); } catch (e) {}
          if (!selId) {
            // Próbáljuk meg az első csatornát fókuszba
            var first = document.querySelector('[data-channel-id]');
            if (first && first.scrollIntoView) first.scrollIntoView({block:'nearest'});
          }
        }
        return true;
      }
      var firstFocusable = arrayFind(getFocusable(document), function(el) {
        return !(el.closest && el.closest('[role="dialog"]'));
      });
      if (firstFocusable) { firstFocusable.focus({preventScroll:true}); return true; }
    } catch (e) { try { console.warn('[webOS] focus fail', e); } catch (e2) {} }
    return false;
  }

  function focusNextInModal(container, dir) {
    try {
      var focusable = getFocusable(container);
      if (!focusable.length) return;
      var idx = focusable.indexOf(document.activeElement);
      if (idx === -1) idx = dir > 0 ? -1 : 0;
      var next = focusable[(idx + dir + focusable.length) % focusable.length];
      if (next) {
        next.focus();
        if (next.scrollIntoView) next.scrollIntoView({block:'nearest', behavior:'smooth'});
      }
    } catch (e) {}
  }

  // Magic Remote térbeli fókusznavigáció a gombok és menük között.
  // A csatornalistát külön hagyjuk, mert annak saját fel/le navigációja van.
  // Ha container meg van adva (pl. nyitott modal), CSAK azon belül keresünk –
  // így a fókusz nem szökhet ki a háttérbe, és irány szerint lép, nem sorban.
  var dlgSeqCounter = 0;
  function stampDialogs() {
    // Minden dialog kap egy NYITASI sorszamot - igy akkor is tudjuk,
    // melyik ablak van legfelul, ha a DOM-sorrend mast mutatna.
    try {
      var l = document.querySelectorAll('[role="dialog"]');
      for (var i = 0; i < l.length; i++) {
        if (!l[i].hasAttribute('data-iptv-dlgseq')) {
          dlgSeqCounter = dlgSeqCounter + 1;
          l[i].setAttribute('data-iptv-dlgseq', String(dlgSeqCounter));
        }
      }
    } catch (e) {}
  }

  function topDialog() {
    // Egymasra nyilo ablakoknal (pl. Beallitasok folott a QR vagy az Uj mappa)
    // MINDIG a legkesobb nyitott (legfelso) dialogban kell navigalni.
    stampDialogs();
    try {
      var l = document.querySelectorAll('[role="dialog"]');
      if (!l.length) return null;
      var best = l[l.length - 1];
      var bestSeq = -1;
      for (var i = 0; i < l.length; i++) {
        var sq = parseInt(l[i].getAttribute('data-iptv-dlgseq') || '0', 10);
        if (sq >= bestSeq) { best = l[i]; bestSeq = sq; }
      }
      return best;
    } catch (e) {
      var l2 = document.querySelectorAll('[role="dialog"]');
      return l2.length ? l2[l2.length - 1] : null;
    }
  }

  function revealEl(el) {
    try {
      if (!el) return;
      // A scrollIntoView({block:'nearest'}) a regi webOS Chrome-on (38) a
      // parametert igaznak veszi -> mindig a tetejere gorget, ettol tunt
      // lassunak/ugralonak a leptetes. A scrollIntoViewIfNeeded azonnali,
      // es csak akkor gorget, ha tenyleg kell.
      if (el.scrollIntoViewIfNeeded) { el.scrollIntoViewIfNeeded(true); return; }
      if (el.scrollIntoView) el.scrollIntoView({block:'nearest', inline:'nearest'});
    } catch (e) {}
  }

  function spatialPick(active, key, items) {
    try {
      if (!items || !items.length) return false;
      if (!active || active === document.body || active === document.documentElement) {
        items[0].focus({preventScroll:true});
        return true;
      }
      var from = active.getBoundingClientRect();
      var fx = from.left + from.width / 2;
      var fy = from.top + from.height / 2;
      var best = null;
      var bestScore = Infinity;
      items.forEach(function(el) {
        if (el === active) return;
        if (active.contains && active.contains(el)) return;
        if (el.contains && el.contains(active)) return;
        var r = el.getBoundingClientRect();
        var x = r.left + r.width / 2;
        var y = r.top + r.height / 2;
        var dx = x - fx;
        var dy = y - fy;
        var primary, cross, aligned;
        if (key === 'ArrowLeft' || key === 'ArrowRight') {
          if (key === 'ArrowLeft') { if (dx >= -2) return; primary = -dx; }
          else { if (dx <= 2) return; primary = dx; }
          cross = Math.abs(dy);
          // EGY SORBAN van-e a két elem? Vízszintes lépésnél az azonos sorban
          // lévő szomszéd mindig nyerjen a fent/lent lévő gombokkal (pl. a
          // bezáró X-szel) szemben – e nélkül "kavarodott" a kijelölés.
          aligned = Math.min(from.bottom, r.bottom) - Math.max(from.top, r.top) > 0;
        } else {
          if (key === 'ArrowUp') { if (dy >= -2) return; primary = -dy; }
          else { if (dy <= 2) return; primary = dy; }
          cross = Math.abs(dx);
          // EGY OSZLOPBAN van-e a két elem? Függőleges lépésnél ugyanígy.
          aligned = Math.min(from.right, r.right) - Math.max(from.left, r.left) > 0;
        }
        var score = primary + cross * (aligned ? 0.4 : 3.5);
        if (score < bestScore) { best = el; bestScore = score; }
      });
      if (!best) return false;
      best.focus({preventScroll:true});
      revealEl(best);
      return true;
    } catch (e) { return false; }
  }

  function focusSpatially(active, key, container) {
    try {
      var items = getFocusable(container || document).filter(function(el) {
        if (container) return true;
        return !(el.closest && el.closest('[role="dialog"]'));
      });
      if (!items.length) return false;
      if (container && active && !container.contains(active)) {
        // A fókusz kint ragadt a háttérben: azonnal behúzzuk a modalba.
        items[0].focus({preventScroll:true});
        return true;
      }
      return spatialPick(active, key, items);
    } catch (e) { return false; }
  }

  // ---------- Keyboard – Magic Remote + D-pad ----------
  function makeKeyEvent(key, keyCode) {
    // Régebbi webOS-en a KeyboardEvent konstruktor nem minden mezőt tölt ki,
    // ezért a keyCode/which mezőket utólag is rögzítjük.
    var ev = null;
    try {
      ev = new KeyboardEvent('keydown', {
        key: key, code: key, keyCode: keyCode, which: keyCode,
        bubbles: true, cancelable: true
      });
    } catch (e) {
      try {
        ev = document.createEvent('Event');
        ev.initEvent('keydown', true, true);
        ev.key = key;
        ev.code = key;
      } catch (e2) { return null; }
    }
    try {
      if (ev.keyCode !== keyCode) {
        Object.defineProperty(ev, 'keyCode', { get: function() { return keyCode; } });
        Object.defineProperty(ev, 'which', { get: function() { return keyCode; } });
      }
      if (ev.key !== key) {
        Object.defineProperty(ev, 'key', { get: function() { return key; } });
      }
    } catch (e3) {}
    return ev;
  }

  function injectKey(key, keyCode) {
    try {
      var ev = makeKeyEvent(key, keyCode);
      if (!ev) return;
      var target = document.activeElement;
      if (!target || target === document.body || target === document.documentElement) {
        var dialogTarget = topDialog();
        var dialogFocusable = dialogTarget ? getFocusable(dialogTarget) : [];
        target = (dialogFocusable.length ? dialogFocusable[0] : dialogTarget) ||
          document.querySelector('[role="listbox"]') || document;
      }
      // Egyszer küldjük ki a DOM-fába, így a React és a window/document kezelők
      // ugyanazt az eseményt kapják buborékolással, duplikálás nélkül.
      target.dispatchEvent(ev);
    } catch (e) { try { console.warn('[webOS] injectKey fail', e); } catch (e2) {} }
  }

  document.addEventListener('keydown', function(e) {
    // Egységes kulcsnév: régi webOS-en a nyilak 'Up'/'Down'/… néven vagy csak
    // keyCode-dal érkeznek, az OK 13, a VISSZA 461.
    var key = normalizeKey(e);
    var kc = e.keyCode || e.which || KEY_TO_KEYCODE[key] || 0;

    // Diagnosztika: minden gombnyomás látszik a képernyős sávban.
    diagKey(e, key);
    // A színes gombokat a legkorábbi ponton egyedi eseményként adjuk át a Reactnek,
    // hogy minden fókuszhelyzetben megbízhatóan működjenek.
    if (kc === 403 || kc === 404 || kc === 405 || kc === 406) {
      e.preventDefault();
      e.stopPropagation();
      // PIROS (403) = naplómegosztó QR; ZÖLD (404) = hangsáv; SÁRGA (405) = kedvenc;
      // KÉK (406) = csatornamozgatás mód a listában.
      var tvAction = kc === 403 ? 'diagnostic-share' : (kc === 404 ? 'audio' : (kc === 405 ? 'favorite' : 'move'));
      var evAction = null;
      try {
        evAction = new CustomEvent('iptv-tv-action', { detail: { action: tvAction } });
      } catch (eCE) {
        try {
          evAction = document.createEvent('CustomEvent');
          evAction.initCustomEvent('iptv-tv-action', true, true, { action: tvAction });
        } catch (eCE2) { evAction = null; }
      }
      if (evAction) window.dispatchEvent(evAction);
      return;
    }

    // Szövegmezőben ragadt fókusz (pl. Mozi kereső): VISSZA gomb vagy Escape
    // kilép a mezőből (lezárja a virtuális billentyűzet utáni beragadást),
    // FEL/LE nyíl pedig kinavigál a mezőből a környező vezérlőkre.
    var activeNow = document.activeElement;
    var inTextNow = activeNow && /^(INPUT|TEXTAREA)$/.test(activeNow.tagName);
    if (inTextNow && (kc === 461 || (key === 'Escape' && kc !== 8))) {
      e.preventDefault();
      e.stopPropagation();
      activeNow.blur();
      var dlgOfInput = activeNow.closest ? activeNow.closest('[role="dialog"]') : null;
      if (dlgOfInput) {
        // Ha a mező egy data-tv-box dobozban van, a dobozra lépünk vissza.
        var boxOfInput = activeNow.closest ? activeNow.closest('[data-tv-box]') : null;
        if (boxOfInput && dlgOfInput.contains(boxOfInput)) {
          boxOfInput.focus({preventScroll:true});
        } else {
          var fIn = getFocusable(dlgOfInput);
          if (fIn.length) fIn[0].focus({preventScroll:true});
        }
      } else {
        var hdrBtn = document.querySelector('header button');
        var lst = document.querySelector('[role="listbox"]');
        if (hdrBtn) hdrBtn.focus({preventScroll:true});
        else if (lst) lst.focus({preventScroll:true});
      }
      return;
    }
    if (inTextNow && (key === 'ArrowUp' || key === 'ArrowDown')) {
      e.preventDefault();
      e.stopPropagation();
      var inputEl = activeNow;
      inputEl.blur();
      var dlgOfInput2 = inputEl.closest ? inputEl.closest('[role="dialog"]') : null;
      if (!focusSpatially(inputEl, key, dlgOfInput2 || undefined)) {
        if (dlgOfInput2) focusNextInModal(dlgOfInput2, key === 'ArrowDown' ? 1 : -1);
        else inputEl.focus();
      }
      return;
    }

    // Ha a gombot már át kellett nevezni (régi webOS), újraküldjük az egységes
    // névvel, hogy a React kezelők is megkapják érthető formában.
    var rawKey = e.key || '';
    var needsRedispatch = key && rawKey !== key && (isArrowKey(key) || key === 'Enter' || key === 'Escape');

    // A webOS néha a body-n hagyja a fókuszt. Ilyenkor az első gombnyomást
    // közvetlenül a csatornalistának adjuk át, nem veszítjük el fókuszváltáskor.
    var active = document.activeElement;
    var inTextEntry = active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName);
    var dialogAtStart = topDialog();
    var isArrow = isArrowKey(key);
    var isConfirm = key === 'Enter';

    // OK gomb egy kijelölt "dobozon" (data-tv-box): BELÉPÉS a dobozba –
    // a fókusz a doboz első vezérlőjére kerül, ott lehet választani.
    // Ha a dobozban EGYETLEN vezérlő van (pl. egy kapcsoló), az OK azonnal
    // átkapcsolja, nem kell külön belépni.
    if (isConfirm && active && active.hasAttribute && active.hasAttribute('data-tv-box')) {
      e.preventDefault();
      e.stopPropagation();
      var innerF = getFocusable(active);
      if (innerF.length === 1 && (innerF[0].tagName === 'BUTTON' || innerF[0].tagName === 'A' ||
          innerF[0].getAttribute('role') === 'button' || innerF[0].type === 'checkbox')) {
        innerF[0].click();
        return;
      }
      if (innerF.length) {
        innerF[0].focus({preventScroll:true});
        revealEl(innerF[0]);
      }
      return;
    }

    // VISSZA gomb egy doboz BELSEJÉBEN: először csak a doboz szintre lép ki
    // (a doboz lesz kijelölve), nem zárja be az egész ablakot.
    if ((kc === 461 || key === 'Escape') && dialogAtStart && active && active.closest) {
      var backBox = active.closest('[data-tv-box]');
      if (backBox && backBox !== active && dialogAtStart.contains(backBox)) {
        e.preventDefault();
        e.stopPropagation();
        backBox.focus({preventScroll:true});
        revealEl(backBox);
        return;
      }
    }

    if (!dialogAtStart && !inTextEntry &&
        (!active || active === document.body || active === document.documentElement) &&
        (isArrow || isConfirm)) {
      var listAtStart = document.querySelector('[role="listbox"]');
      if (listAtStart) {
        e.preventDefault();
        e.stopPropagation();
        if (!listAtStart.hasAttribute('tabindex')) listAtStart.setAttribute('tabindex', '0');
        listAtStart.focus({preventScroll:true});
        var normalizedKey = isConfirm ? 'Enter' : key;
        var normalizedCode = KEY_TO_KEYCODE[normalizedKey] || kc;
        var evList = makeKeyEvent(normalizedKey, normalizedCode);
        if (evList) listAtStart.dispatchEvent(evList);
        return;
      }
    }
    // OK/Select/Enter: a távirányító különböző kulcsneveit egységesítjük.
    if (isConfirm && rawKey !== 'Enter' && !inTextEntry) {
      var focused = document.activeElement;
      var listForOk = document.querySelector('[role="listbox"]');
      if (listForOk && (!focused || focused === document.body || focused === document.documentElement || listForOk.contains(focused))) {
        e.preventDefault();
        e.stopPropagation();
        listForOk.focus({preventScroll:true});
        var evOk = makeKeyEvent('Enter', 13);
        if (evOk) listForOk.dispatchEvent(evOk);
        return;
      }
      if (focused && (focused.tagName === 'BUTTON' || focused.tagName === 'A' || focused.getAttribute('role') === 'button')) {
        e.preventDefault();
        focused.click();
        return;
      }
    }

    // webOS Back (461) → Escape (bezár modal, kilép fullscreen)
    if (kc === 461 || key === 'Escape') {
      if (kc === 461 || rawKey !== 'Escape') {
        try { console.log('[webOS] Back → Escape'); } catch (eLog) {}
        e.preventDefault();
        e.stopPropagation();
        // Egymasra nyilo ablakoknal MINDIG a legfelso ablak zarodjon:
        // ha a fokusz nem benne van, eloszor oda visszuk, kulonben az
        // Escape az also ablakot zarna be.
        var tdlg = topDialog();
        if (tdlg && !tdlg.contains(document.activeElement)) {
          var tf = getFocusable(tdlg);
          if (tf.length) {
            tf[0].focus({preventScroll:true});
          } else {
            if (!tdlg.hasAttribute('tabindex')) tdlg.setAttribute('tabindex', '-1');
            tdlg.focus({preventScroll:true});
          }
        }
        injectKey('Escape', 27);
        return;
      }
    }

    // Channel Up/Down (33/34): a listára küldjük, mert a documentre
    // dispatcholt esemény nem jut el a lista React onKeyDown kezelőjéhez.
    if (key === 'PageUp' || key === 'PageDown') {
      var channelList = document.querySelector('[role="listbox"]');
      if (channelList && !dialogAtStart) {
        e.preventDefault();
        e.stopPropagation();
        channelList.focus({preventScroll:true});
        var up = key === 'PageUp';
        var evCh = makeKeyEvent(up ? 'ArrowUp' : 'ArrowDown', up ? 38 : 40);
        if (evCh) channelList.dispatchEvent(evCh);
        return;
      }
    }

    // D-pad modalban: TÉRBELI navigáció a modalon BELÜL (irány szerint lép,
    // nem sorban minden gombon), a fókusz nem szökhet ki a háttérbe.
    if (isArrow && dialogAtStart) {
      var dialog = dialogAtStart;
      var activeInDialog = document.activeElement;
      var inInput = activeInDialog && /^(INPUT|TEXTAREA|SELECT)$/.test(activeInDialog.tagName);
      if (inInput && (key === 'ArrowLeft' || key === 'ArrowRight')) {
        // Szövegmezőben balra/jobbra = kurzor mozgatás, hagyjuk.
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (inInput) activeInDialog.blur();
      var curEl = document.activeElement;
      // KÉTSZINTŰ "DOBOZ" NAVIGÁCIÓ: ha a modalban data-tv-box szekciók
      // vannak (pl. Beállítások → Rendszer), a nyilak a DOBOZOK között
      // ugrálnak; OK-val lép be a néző egy dobozba, és ott választ.
      var boxes = Array.prototype.slice.call(dialog.querySelectorAll('[data-tv-box]')).filter(function(b) {
        return b.getClientRects().length > 0;
      });
      var defEl = dialog.querySelector('[data-tv-default]') || dialog.querySelector('[data-tv-open-focus]');
      if (boxes.length || defEl) {
        if (!curEl || curEl === document.body || curEl === document.documentElement || !dialog.contains(curEl)) {
          var pullTo = defEl || boxes[0];
          pullTo.focus({preventScroll:true});
          revealEl(pullTo);
          return;
        }
        if (!boxes.length) {
          // Csak alapgomb van (pl. Listak ful): sima terbeli lepes a modalban.
          if (!focusSpatially(curEl, key, dialog)) {
            focusNextInModal(dialog, (key === 'ArrowDown' || key === 'ArrowRight') ? 1 : -1);
          }
          return;
        }
        var curBox = curEl.closest ? curEl.closest('[data-tv-box]') : null;
        if (curBox && curBox !== curEl) {
          // A dobozon BELÜL vagyunk: csak a dobozban lévő elemek közt lépünk.
          if (!focusSpatially(curEl, key, curBox)) {
            // A doboz széléhez értünk: vissza a doboz szintre (kijelölt doboz).
            curBox.focus({preventScroll:true});
            revealEl(curBox);
          }
          return;
        }
        var curIsBox = curEl.hasAttribute && curEl.hasAttribute('data-tv-box');
        if (curIsBox) {
          // Doboz szinten CSAK FEL/LE lehet lepkedni a dobozok kozott.
          // A fulekre (Listak/Kedvencek/Rendszer) kizarolag a LEGFELSO
          // dobozrol felfele lepve kerul a jelolo - az aljarol vagy
          // kozeprol nem ugorhat at masik menure.
          if (key === 'ArrowLeft' || key === 'ArrowRight') return;
          if (spatialPick(curEl, key, boxes)) return;
          if (key === 'ArrowUp') {
            var outside = getFocusable(dialog).filter(function(el) {
              if (el.hasAttribute && el.hasAttribute('data-tv-box')) return false;
              return !(el.closest && el.closest('[data-tv-box]'));
            });
            spatialPick(curEl, key, outside);
          }
          return;
        }
        // Nem dobozon allunk (fulek, also gombok): dobozok + kivul eso vezerlok.
        var levelItems = getFocusable(dialog).filter(function(el) {
          if (el.hasAttribute && el.hasAttribute('data-tv-box')) return true;
          return !(el.closest && el.closest('[data-tv-box]'));
        });
        spatialPick(curEl, key, levelItems);
        return;
      }
      if (!focusSpatially(document.activeElement, key, dialog)) {
        // Nincs elem abban az irányban: lineáris lépés tartalékként.
        focusNextInModal(dialog, (key === 'ArrowDown' || key === 'ArrowRight') ? 1 : -1);
      }
      return;
    }

    // ---------- FŐOLDAL: SZIGORÚ, ZÓNÁS KIJELÖLŐ-NAVIGÁCIÓ ----------
    //
    // FONTOS (a "kijelölő össze-vissza ugrál" hiba javítása):
    // Korábban itt térbeli (legközelebbi elem) keresés futott, ami a főoldalon
    // a lejátszó OSD-jére, a nagy lejátszó dobozra és a fejléc gombjaira is
    // átugrott. Most a főoldalnak pontosan három zónája van, és a kijelölő
    // csak ezek között, kiszámíthatóan mozog:
    //
    //   [fejléc menüsor]  <-fel/le->  [kedvencek mappasáv]  <-fel/le->  [csatornalista]
    //
    // A csatornalistán belül a nyilakat a lista saját kezelője viszi (soronként),
    // a lejátszóra és az OSD-re a kijelölő SOHA nem lép.
    if (isArrow && !dialogAtStart && !inTextEntry) {
      var focusedNow = document.activeElement;
      var playerNow = focusedNow && focusedNow.closest ? focusedNow.closest('[data-tv-player]') : null;
      // Teljes képernyős lejátszó: a lejátszó saját gombkezelése viszi a nyilakat.
      if (playerNow && playerNow.className.indexOf('fixed') !== -1) return;

      var listEl = document.querySelector('[role="listbox"]');
      var inList = listEl && focusedNow && (focusedNow === listEl || listEl.contains(focusedNow));
      if (inList) {
        // A lista saját React kezelője mozgatja a sárga kijelölést.
        return;
      }

      var contentItems = function() {
        return getFocusable(document).filter(function(el) {
          if (el.hasAttribute('data-tv-skip')) return false;
          if (el.closest && el.closest('header')) return false;
          var box = el.closest ? el.closest('[data-tv-player]') : null;
          if (box && box.className.indexOf('fixed') === -1) return false;
          if (el.closest && el.closest('[data-osd]')) return false;
          return true;
        });
      };

      var headerItems = visibleOrAll(Array.prototype.slice.call(
        document.querySelectorAll('header [data-tv-header]:not([data-tv-skip])')
      ));
      var folderBar = document.querySelector('[data-tv-folders]');
      var folderItems = folderBar ? visibleOrAll(Array.prototype.slice.call(
        folderBar.querySelectorAll('[data-tv-folder]')
      )) : [];
      var inHeader = focusedNow && focusedNow.closest && focusedNow.closest('header');
      var inFolders = focusedNow && folderBar && (focusedNow === folderBar || folderBar.contains(focusedNow));
      var headerDefault = document.querySelector('header [data-tv-header-default]');

      var focusAndReveal = function(el) {
        if (!el) return false;
        if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
        el.focus({preventScroll:true});
        revealEl(el);
        return true;
      };

      if (inHeader && headerItems.length) {
        e.preventDefault();
        e.stopPropagation();
        var hi = headerItems.indexOf(focusedNow);
        var kindOf = function(el) {
          return (el && el.getAttribute && el.getAttribute('data-tv-header-kind')) || '';
        };
        var kind = kindOf(focusedNow);

        if (key === 'ArrowLeft' || key === 'ArrowRight') {
          // A menüsor KÖRBEN jár:
          //   Sorozat -> Mozi -> Országok -> Beállítások -> X -> (körbe) Sorozat
          // A LEGELSŐ gombon (Sorozat) csak jobbra lehet lépni, balra nem.
          if (key === 'ArrowLeft' && hi <= 0) return;
          var dir = key === 'ArrowRight' ? 1 : -1;
          var nextIndex;
          if (hi < 0) {
            nextIndex = 0;
          } else {
            nextIndex = hi + dir;
            if (nextIndex >= headerItems.length) nextIndex = 0;
            if (nextIndex < 0) nextIndex = headerItems.length - 1;
          }
          focusAndReveal(headerItems[nextIndex]);
          return;
        }

        if (key === 'ArrowDown') {
          // LEFELÉ KIZÁRÓLAG a Beállításokról: onnan a kedvencek mappasávjára,
          // onnan a csatornalista 1. sorára. A Mozi/Sorozat/Országok/X gombokról
          // NEM lehet lefelé menni (a kijelölő nem ugorhat a lejátszóra/OSD-re).
          if (kind !== 'settings') return;
          if (!focusAndReveal(folderItems[0] || folderBar) && !focusAndReveal(listEl)) {
            focusAndReveal(contentItems()[0]);
          }
          return;
        }

        if (key === 'ArrowUp') {
          // A menüsorból felfelé nincs hova lépni.
          return;
        }
        return;
      }

      if (inFolders) {
        e.preventDefault();
        e.stopPropagation();
        var fi = folderItems.indexOf(focusedNow);
        if (key === 'ArrowRight') {
          if (folderItems.length) focusAndReveal(folderItems[Math.min(folderItems.length - 1, (fi < 0 ? -1 : fi) + 1)]);
        } else if (key === 'ArrowLeft') {
          if (folderItems.length) focusAndReveal(folderItems[Math.max(0, (fi < 0 ? folderItems.length : fi) - 1)]);
        } else if (key === 'ArrowUp') {
          focusAndReveal(headerDefault || headerItems[headerItems.length - 1]);
        } else if (key === 'ArrowDown') {
          focusAndReveal(listEl);
        }
        return;
      }

      // Nincs értelmes fókusz (pl. a body-n ragadt): a csatornalistára visszük.
      // Mozi/Sorozat nézetben (nincs csatornalista) a látható vezérlők között
      // lépünk, de a lejátszó és az OSD továbbra is tiltott.
      if (!listEl) {
        // Mozi/Sorozat nézet: a lejátszó és az OSD kizárásával lépünk tovább.
        var safeItems = contentItems();
        if (focusedNow && spatialPick(focusedNow, key, safeItems)) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (needsRedispatch) {
          e.preventDefault();
          e.stopPropagation();
          injectKey(key, KEY_TO_KEYCODE[key] || kc);
        }
        return;
      }
      if (listEl) {
        e.preventDefault();
        e.stopPropagation();
        focusAndReveal(listEl);
        return;
      }
    }

    // Modalon belül régi kulcsnév: egységes néven továbbadjuk a Reactnek.
    if (needsRedispatch && dialogAtStart && !inTextEntry && !isArrow) {
      e.preventDefault();
      e.stopPropagation();
      injectKey(key, KEY_TO_KEYCODE[key] || kc);
      return;
    }

    // Színes gombok – jövőbeli funkciók, most logoljuk
    if (kc >= 403 && kc <= 406) {
      try { console.log('[webOS] Color key', kc); } catch (eC) {}
    }

    // Média gombok
    if (kc === 412 || kc === 413 || kc === 415 || kc === 19 || kc === 417) {
      try { console.log('[webOS] Media key', kc); } catch (eM) {}
    }
  }, true);

  // ---------- Pointer – Magic Remote egér ----------
  document.addEventListener('mousemove', function() {
    try { document.body.classList.add('has-mouse'); } catch (e) {}
    try {
      diag.mouseMoves++;
      if (diag.mouseLine && diag.mouseMoves % 20 === 1) {
        diag.mouseLine.textContent = 'Egér/kattintás: ' + diag.mouseMoves + ' / ' + diag.clicks;
      }
    } catch (e2) {}
  });
  document.addEventListener('mousedown', function() {
    try {
      diag.clicks++;
      if (diag.mouseLine) diag.mouseLine.textContent = 'Egér/kattintás: ' + diag.mouseMoves + ' / ' + diag.clicks;
    } catch (e) {}
  }, true);
  document.addEventListener('keydown', function(e) {
    var key = normalizeKey(e);
    if (isArrowKey(key) || key === 'Enter') {
      try { document.body.classList.remove('has-mouse'); } catch (e2) {}
    }
  });

  // ---------- webOS lifecycle ----------
  if (window.webOS) {
    try { console.log('[webOS] webOS API elérhető'); } catch (e) {}
    window.addEventListener('webOSRelaunch', function(e) {
      try { console.log('[webOS] Relaunch:', e); } catch (e2) {}
      setTimeout(focusFirstChannelList, 300);
    });
    document.addEventListener('visibilitychange', function() {
      if (!document.hidden) {
        try { console.log('[webOS] App előtérbe került – fókusz vissza'); } catch (e) {}
        setTimeout(focusFirstChannelList, 300);
      }
    });
  }

  // ---------- DOM ready – fókusz + CSS ----------
  function onReady() {
    injectTvCss();
    try {
      document.body.classList.add('webos-tv', 'lg-webos', 'tv-mode');
    } catch (e) {}
    // Képernyős diagnosztika: normál működéskor rejtve marad, és csak akkor
    // jelenik meg, ha a felület 12 mp alatt sem töltődik be.
    diagUiCheck();
    var uiPoll = setInterval(function() {
      diagUiCheck();
      if (diag.uiLoaded) clearInterval(uiPoll);
    }, 1000);
    setTimeout(function() {
      clearInterval(uiPoll);
      if (!diag.uiLoaded) diagUiFail();
    }, 12000);
    // Többszöri fókusz próbálkozás – lista később töltődik
    setTimeout(focusFirstChannelList, 300);
    setTimeout(focusFirstChannelList, 1000);
    setTimeout(focusFirstChannelList, 2500);
    setTimeout(focusFirstChannelList, 4000);

    // Figyeljük a dialog megjelenését – ha nyílik, fókusz rá
    try {
      // FONTOS (TV-lassulás): a teljes DOM-fára figyelő observer korábban
      // MINDEN változásnál (minden új csatornasor, minden EPG-szöveg) lefutott
      // és két teljes querySelectorAll-t végzett. Most legfeljebb ~8-szor
      // másodpercenként fut, és ha nincs egyetlen nyitott ablak sem, azonnal
      // visszatér - így a lista görgetése/újrarajzolása nem lassul tőle.
      var dialogSweepTimer = 0;
      var observer = new MutationObserver(function() {
        if (dialogSweepTimer) return;
        dialogSweepTimer = setTimeout(function() {
          dialogSweepTimer = 0;
          var dlg = topDialog();
          if (!dlg) return;
          if (dlg.contains(document.activeElement)) return;
          setTimeout(function(){
            var dlgNow = topDialog();
            if (!dlgNow || dlgNow.contains(document.activeElement)) return;
            var f = getFocusable(dlgNow);
            if (f.length) {
              var btn = arrayFind(f, function(el) { return el.tagName === 'BUTTON'; });
              (btn || f[0]).focus();
            }
          }, 100);
        }, 120);
      });
      observer.observe(document.body, { childList:true, subtree:true });
    } catch (e) {}

    // Ha modal bezárul, fókusz vissza a listára
    var lastDialogState = false;
    setInterval(function(){
      var hasDialog = !!document.querySelector('[role="dialog"]');
      if (lastDialogState && !hasDialog) {
        // Bezárult
        setTimeout(focusFirstChannelList, 150);
      }
      lastDialogState = hasDialog;
    }, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }

  window.__webosTvFocusFix = {
    focusFirst: focusFirstChannelList,
    getFocusable: getFocusable,
    injectKey: injectKey,
    normalizeKey: normalizeKey
  };

  try { console.log('[webOS] TV webOS ready 2.4.3 – távirányító fix (ES5) + QR provisioning'); } catch (e) {}
})();
