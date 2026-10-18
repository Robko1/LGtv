// webOS TV specifikus – Magic Remote + távirányító + egér + fókusz fix 2.3.7
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

  try { console.log('[webOS] IPTV R.T webOS TV 2.3.7 inicializálás – távirányító fix (ES5)'); } catch (e) {}

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
  // A PIROS színes gombbal bármikor elő-/eltüntethető.
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
        'white-space:pre-wrap;word-break:break-word;');
      var title = document.createElement('div');
      title.textContent = 'IPTV R.T diagnosztika 2.3.7 \u2013 ' + chromeVersion();
      title.setAttribute('style', 'color:#00BFFF;');
      diag.uiLine = document.createElement('div');
      diag.uiLine.textContent = 'Felület: betöltés...';
      diag.keyLine = document.createElement('div');
      diag.keyLine.textContent = 'Nyomj egy gombot a távirányítón...';
      diag.mouseLine = document.createElement('div');
      diag.mouseLine.textContent = 'Egér/kattintás: 0 / 0';
      var hint = document.createElement('div');
      hint.textContent = 'PIROS: diag ki/be \u00b7 Z\u00d6LD: Be\u00e1ll\u00edt\u00e1sok \u00b7 S\u00c1RGA: M\u0171sor\u00fajs\u00e1g \u00b7 K\u00c9K: Kateg\u00f3ri\u00e1k';
      hint.setAttribute('style', 'color:#64748b;font-size:16px;margin-top:4px;');
      box.appendChild(title);
      box.appendChild(diag.uiLine);
      box.appendChild(diag.keyLine);
      box.appendChild(diag.mouseLine);
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

  function diagToggle() {
    if (!diagEnsure()) return;
    diag.forced = diag.el.style.display === 'none';
    diag.el.style.display = diag.forced ? 'block' : 'none';
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
      var splash = document.getElementById('boot-splash');
      var list = document.querySelector('[role="listbox"], [role="dialog"], header');
      if (!splash || list) {
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
  function injectTvCss() {
    try {
      var css = [
        'body.webos-tv, body.lg-webos { background:#000; overflow:hidden; }',
        '/* NAGY TV-KIJELZŐ: a telefonos méretű felület 1.4x nagyítása, hogy a',
        '   feliratok és a menük messziről is olvashatók legyenek. */',
        '.webos-tv #root { zoom: 1.4; }',
        '.webos-tv .video-player-container { max-width:1280px; margin:0 auto; }',
        '.webos-tv .channel-list { max-height:70vh; }',
        '/* Erős fókusz gyűrű TV-re – távirányítóhoz */',
        '.webos-tv *:focus { outline:3px solid #00BFFF !important; outline-offset:2px; }',
        '.webos-tv [role="listbox"]:focus { outline:3px solid #06b6d4 !important; outline-offset:-2px; box-shadow:0 0 0 4px rgba(6,182,212,0.25), inset 0 0 0 2px rgba(6,182,212,0.4); }',
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
        '/* Splash */',
        '.webos-splash { position:fixed; top:0; left:0; right:0; bottom:0; width:100vw; height:100vh; background:#000; z-index:99999; display:flex; flex-direction:column; align-items:center; justify-content:center; color:#00BFFF; text-align:center; }',
        '.webos-splash .splash-title { font-size:8vw; font-weight:800; letter-spacing:0.08em; }',
        '.webos-splash .splash-subtitle { margin-top:22px; font-size:3vw; color:#fff; }'
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
        return !el.hasAttribute('disabled') && el.getClientRects().length > 0 &&
          !hiddenAncestor && el.getAttribute('aria-hidden') !== 'true';
      });
    } catch (e) { return []; }
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
        var r = el.getBoundingClientRect();
        var x = r.left + r.width / 2;
        var y = r.top + r.height / 2;
        var dx = x - fx;
        var dy = y - fy;
        var primary, cross;
        if (key === 'ArrowLeft') { if (dx >= -2) return; primary = -dx; cross = Math.abs(dy); }
        else if (key === 'ArrowRight') { if (dx <= 2) return; primary = dx; cross = Math.abs(dy); }
        else if (key === 'ArrowUp') { if (dy >= -2) return; primary = -dy; cross = Math.abs(dx); }
        else { if (dy <= 2) return; primary = dy; cross = Math.abs(dx); }
        var score = primary + cross * 1.8;
        if (score < bestScore) { best = el; bestScore = score; }
      });
      if (!best) return false;
      best.focus({preventScroll:true});
      if (best.scrollIntoView) best.scrollIntoView({block:'nearest', inline:'nearest'});
      return true;
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
        var dialogTarget = document.querySelector('[role="dialog"]');
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
    // PIROS gomb (403): diagnosztika be/ki
    if (kc === 403) { diagToggle(); return; }
    // ZÖLD/SÁRGA/KÉK gomb: közvetlen menük. Itt, a legkorábbi ponton kezeljük
    // és egyedi eseményként adjuk át a Reactnek – így minden fókuszhelyzetben
    // megbízhatóan működik (gombon, listán, modalban is).
    if (kc === 404 || kc === 405 || kc === 406) {
      e.preventDefault();
      e.stopPropagation();
      var tvAction = kc === 404 ? 'settings' : (kc === 405 ? 'epg' : 'categories');
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
        var fIn = getFocusable(dlgOfInput);
        if (fIn.length) fIn[0].focus({preventScroll:true});
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
    var dialogAtStart = document.querySelector('[role="dialog"]');
    var isArrow = isArrowKey(key);
    var isConfirm = key === 'Enter';
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
      if (!focusSpatially(document.activeElement, key, dialog)) {
        // Nincs elem abban az irányban: lineáris lépés tartalékként.
        focusNextInModal(dialog, (key === 'ArrowDown' || key === 'ArrowRight') ? 1 : -1);
      }
      return;
    }

    // Gombon/menün állva a nyilak a legközelebbi látható vezérlőre lépnek.
    // A csatornalista és a modal saját nyílkezelése változatlan marad.
    if (isArrow && !dialogAtStart && !inTextEntry) {
      var focusedNow = document.activeElement;
      var insideList = focusedNow && focusedNow.closest && focusedNow.closest('[role="listbox"]');
      var isControl = focusedNow && (focusedNow.tagName === 'BUTTON' || focusedNow.tagName === 'A' ||
        (focusedNow.getAttribute && focusedNow.getAttribute('role') === 'button'));
      if (!insideList && isControl) {
        if (focusSpatially(focusedNow, key)) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }
      // Régi webOS kulcsnév ('Up' stb.): adjuk tovább egységes 'Arrow*' néven,
      // hogy a React csatornaváltó / lista kezelői is megkapják.
      if (needsRedispatch) {
        e.preventDefault();
        e.stopPropagation();
        injectKey(key, KEY_TO_KEYCODE[key] || kc);
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
    // Képernyős diagnosztika: induláskor látszik, 2 perc után eltűnik,
    // a PIROS gombbal bármikor visszahozható. Ha a felület 12 mp alatt sem
    // töltődik be, piros hibaüzenet marad a képernyőn.
    diagShow();
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
      var observer = new MutationObserver(function() {
        var dlg = document.querySelector('[role="dialog"]');
        if (dlg && !dlg.contains(document.activeElement)) {
          setTimeout(function(){
            var f = getFocusable(dlg);
            if (f.length) {
              var btn = arrayFind(f, function(el) { return el.tagName === 'BUTTON'; });
              (btn || f[0]).focus();
            }
          }, 100);
        }
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

  try { console.log('[webOS] IPTV R.T webOS TV ready 2.3.7 – távirányító fix (ES5) + QR provisioning'); } catch (e) {}
})();
