// webOS TV specifikus – Magic Remote + távirányító + egér + fókusz fix 2.3.1
(function() {
  'use strict';

  window.IS_WEBOS_TV = true;
  window.IS_LG_WEBOS = true;
  window.WEBOS_LANDSCAPE_SPLASH = true;
  window.WEBOS_FAST_LOAD = true;
  window.WEBOS_SMALL_PLAYER = true;
  window.WEBOS_NATIVE_HLS = true;

  console.log('[webOS] IPTV R.T webOS TV 2.3.1 inicializálás – távirányító fix + QR');

  // ---------- CSS – TV fókusz gyűrű, kisebb lejátszó, gyors betöltés ----------
  function injectTvCss() {
    try {
      var css = `
        body.webos-tv, body.lg-webos { background:#000; overflow:hidden; }
        .webos-tv .video-player-container { max-width:1280px; margin:0 auto; }
        .webos-tv .channel-list { max-height:70vh; }
        .webos-tv .intro-video { object-fit:cover; width:100vw; height:100vh; }
        /* Erős fókusz gyűrű TV-re – távirányítóhoz */
        .webos-tv *:focus { outline:3px solid #00BFFF !important; outline-offset:2px; }
        .webos-tv [role="listbox"]:focus { outline:3px solid #06b6d4 !important; outline-offset:-2px; box-shadow:0 0 0 4px rgba(6,182,212,0.25), inset 0 0 0 2px rgba(6,182,212,0.4); }
        .webos-tv [role="option"]:focus, .webos-tv [role="option"]:focus-visible {
          outline:3px solid #06b6d4 !important; outline-offset:2px;
          box-shadow:0 0 0 6px rgba(6,182,212,0.3), 0 0 20px rgba(6,182,212,0.2) !important;
          z-index:10;
        }
        .webos-tv button:focus-visible, .webos-tv [role="button"]:focus-visible {
          outline:3px solid #06b6d4 !important; outline-offset:2px;
          box-shadow:0 0 0 4px rgba(6,182,212,0.2);
        }
        /* Egér – Magic Remote pointer */
        body.has-mouse [role="option"], body.has-mouse button { cursor:pointer; }
        body.has-mouse [role="option"]:hover { transform:translateY(-1px); filter:brightness(1.1); }
        /* Gyorsabb animációk TV-n */
        .webos-tv * { transition-duration:0.15s !important; }
        /* Modal fókusz */
        .webos-tv [role="dialog"]:focus { outline:none; }
        .webos-tv [role="dialog"] button:focus { outline:3px solid #facc15 !important; }
        /* Splash */
        .webos-splash { position:fixed; inset:0; width:100vw; height:100vh; background:#000 url('assets/splash.png') center/cover no-repeat; z-index:99999; display:flex; align-items:center; justify-content:center; }
        .webos-splash img { width:400px; height:400px; object-fit:contain; }
      `;
      var style = document.createElement('style');
      style.id = 'webos-tv-fix-css';
      style.textContent = css;
      document.head.appendChild(style);
    } catch (e) { console.warn('[webOS] CSS inject fail', e); }
  }

  // ---------- Fókusz helper – csatornalista + modalok ----------
  function getFocusable(container) {
    try {
      var root = container || document;
      var list = root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      return Array.prototype.slice.call(list).filter(function(el) {
        return !el.hasAttribute('disabled') && el.offsetParent !== null;
      });
    } catch { return []; }
  }

  function focusFirstChannelList() {
    try {
      // Ha modal nyitva van, fókusz a modalra, ne a listára
      var dialog = document.querySelector('[role="dialog"]');
      if (dialog) {
        var focusable = getFocusable(dialog);
        if (focusable.length) {
          var btn = focusable.find(function(el){ return el.tagName==='BUTTON'; });
          (btn || focusable[0]).focus({preventScroll:true});
          return true;
        }
        dialog.focus();
        return true;
      }
      var list = document.querySelector('[role="listbox"]');
      if (list) {
        var active = document.activeElement;
        if (active && active.tagName === 'INPUT') return false;
        if (active && active.closest && active.closest('[role="dialog"]')) return false;
        if (!list.contains(active)) {
          list.focus({preventScroll:true});
          var selId = null;
          try { selId = list.getAttribute('data-selected-id'); } catch {}
          if (!selId) {
            // Próbáljuk meg az első csatornát fókuszba
            var first = document.querySelector('[data-channel-id]');
            if (first) first.scrollIntoView({block:'nearest'});
          }
        }
        return true;
      }
    } catch (e) { console.warn('[webOS] focus fail', e); }
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
        next.scrollIntoView({block:'nearest', behavior:'smooth'});
      }
    } catch {}
  }

  // ---------- Keyboard – Magic Remote + D-pad ----------
  function injectKey(key, keyCode) {
    try {
      var ev = new KeyboardEvent('keydown', {
        key: key,
        code: key,
        keyCode: keyCode,
        which: keyCode,
        bubbles: true,
        cancelable: true
      });
      document.dispatchEvent(ev);
      window.dispatchEvent(ev);
      var ae = document.activeElement;
      if (ae && ae.dispatchEvent) ae.dispatchEvent(ev);
    } catch (e) { console.warn('[webOS] injectKey fail', e); }
  }

  document.addEventListener('keydown', function(e) {
    var kc = e.keyCode;
    var key = e.key;

    // webOS Back (461) → Escape (bezár modal, kilép fullscreen)
    if (kc === 461 || kc === 27) {
      console.log('[webOS] Back → Escape');
      if (kc === 461) {
        e.preventDefault();
        e.stopPropagation();
        injectKey('Escape', 27);
        // Ha van dialog, zárjuk JS-ből is
        var dlg = document.querySelector('[role="dialog"]');
        if (dlg) {
          // A React modal saját Escape handlerje bezárja, de biztosíték
          var closeBtn = dlg.querySelector('button[aria-label*="Bezár"], button:has(.lucide-x)');
          // Nem kattintunk, csak Escape eventet küldtünk
        }
        return;
      }
    }

    // Channel Up/Down (33/34) → ArrowUp/Down (csatornaváltás vagy lista navigáció)
    if (kc === 33) { // Ch Up
      e.preventDefault();
      injectKey('ArrowUp', 38);
      return;
    }
    if (kc === 34) { // Ch Down
      e.preventDefault();
      injectKey('ArrowDown', 40);
      return;
    }

    // D-pad (37-40) már Arrow* – de biztosítjuk hogy modalban is működjön
    if (kc >= 37 && kc <= 40) {
      var dialog = document.querySelector('[role="dialog"]');
      if (dialog) {
        // Modalban ArrowUp/Down → fókusz navigáció
        if (kc === 38) { // Up
          e.preventDefault();
          e.stopPropagation();
          focusNextInModal(dialog, -1);
        } else if (kc === 40) { // Down
          e.preventDefault();
          e.stopPropagation();
          focusNextInModal(dialog, 1);
        } else if (kc === 37 || kc === 39) {
          // Left/Right modalban is fel/le-ként kezeljük ha nincs input fókuszban
          var active = document.activeElement;
          if (!active || active.tagName !== 'INPUT') {
            e.preventDefault();
            e.stopPropagation();
            focusNextInModal(dialog, kc === 39 ? 1 : -1);
          }
        }
      }
    }

    // Színes gombok – jövőbeli funkciók, most logoljuk
    if (kc >= 403 && kc <= 406) {
      console.log('[webOS] Color key', kc);
    }

    // Média gombok
    if (kc === 412 || kc === 413 || kc === 415 || kc === 19 || kc === 417) {
      console.log('[webOS] Media key', kc);
    }
  }, true);

  // ---------- Pointer – Magic Remote egér ----------
  document.addEventListener('mousemove', function() {
    try { document.body.classList.add('has-mouse'); } catch {}
  });
  document.addEventListener('keydown', function(e) {
    if (e.key && (e.key.startsWith('Arrow') || e.key === 'Enter')) {
      try { document.body.classList.remove('has-mouse'); } catch {}
    }
  });

  // ---------- webOS lifecycle ----------
  if (window.webOS) {
    console.log('[webOS] webOS API elérhető');
    window.addEventListener('webOSRelaunch', function(e) {
      console.log('[webOS] Relaunch:', e);
      setTimeout(focusFirstChannelList, 300);
    });
    document.addEventListener('visibilitychange', function() {
      if (!document.hidden) {
        console.log('[webOS] App előtérbe került – fókusz vissza');
        setTimeout(focusFirstChannelList, 300);
      }
    });
  }

  // ---------- DOM ready – fókusz + CSS ----------
  function onReady() {
    injectTvCss();
    try {
      document.body.classList.add('webos-tv', 'lg-webos', 'tv-mode');
    } catch {}
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
              var btn = f.find(function(el){ return el.tagName==='BUTTON'; });
              (btn || f[0]).focus();
            }
          }, 100);
        }
      });
      observer.observe(document.body, { childList:true, subtree:true });
    } catch {}

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
    injectKey: injectKey
  };

  console.log('[webOS] IPTV R.T webOS TV ready 2.3.1 – Magic Remote fix + QR provisioning');
})();
