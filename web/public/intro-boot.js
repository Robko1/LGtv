/*
 * INDULÓ (BEJELENTKEZŐ) VIDEÓ – önálló, ES5-ös bootstrap.
 *
 * FONTOS: ez a fájl a HTML <head>-jében, az ALKALMAZÁS ELŐTT fut (a
 * tools/build-webos.sh a helyére fűzi be a kész HTML-be). Korábban az
 * induló videó csak az 1 MB-os alkalmazás-csomag lefutása UTÁN indult el,
 * ezért a TV 5 másodpercig fagyott állóképet mutatott. Most a videó az
 * első pillanatban elindul, és a nagy csomag elemzése EZ ALATT történik.
 *
 * A fájl SZÁNDÉKOSAN ES5 (var, function, nincs nyíl-függvény, nincs
 * template literal): a régi LG webOS motorok (Chrome 38–53) a modern
 * szintaxison elhasalnának, és akkor nem lenne induló videó.
 */
(function () {
  'use strict';

  if (window.__IPTV_INTRO_BOOTED__) return; // ne fusson le kétszer
  window.__IPTV_INTRO_BOOTED__ = true;

  var INTRO_SRC = 'assets/intro.mp4';
  var POSTER_SRC = 'assets/intro-poster.jpg';
  var INTRO_MAX_MS = 9800;      // a videó hossza (9,7 mp) + ráhagyás
  var startedAt = Date.now();

  var logEntries = [];
  window.__IPTV_INTRO_LOG__ = logEntries;
  window.__IPTV_INTRO_ACTIVE__ = true;   // amíg true, a lejátszó nem indul el
  window.__IPTV_STARTUP_STAGE__ = 1;
  window.__IPTV_STARTUP_DIAG__ = true;

  function byId(id) { return document.getElementById(id); }

  function log(message) {
    try {
      logEntries.push(Math.round(Date.now() - startedAt) + ' ms: ' + message);
      if (logEntries.length > 14) logEntries.shift();
      console.log('INTRO ' + message);
    } catch (e) {}
  }

  // ---------- Indulási lépés / hiba API (a main.tsx ezt hívja) ----------
  function show(stage, label) {
    window.__IPTV_STARTUP_STAGE__ = stage;
    var el = byId('boot-stage');
    var tm = byId('boot-time');
    if (el) el.textContent = stage + '/7 ' + label;
    if (tm) tm.textContent = (Date.now() - startedAt) + ' ms';
    try { console.log('STARTUP ' + stage + '/7 ' + label + ' @ ' + (Date.now() - startedAt) + ' ms'); } catch (e) {}
  }
  window.__IPTV_STARTUP_STAGE_SET__ = show;

  // ---------- Overlay ----------
  function createVideoElement() {
    var video = document.createElement('video');
    video.id = 'boot-video';
    video.className = 'boot-video';
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.setAttribute('preload', 'auto');
    video.setAttribute('poster', POSTER_SRC);
    video.setAttribute('disablepictureinpicture', '');
    // NÉMÁN indulunk: a TV a hangos automatikus indítást tiltja, ettől korábban
    // KÉT indítási kísérlet látszott (elutasított hangos + néma újrapróbálás).
    // A hangot a lejátszás elindulása után kapcsoljuk be.
    video.muted = true;
    try { video.volume = 1; } catch (e) {}
    try { video.src = INTRO_SRC; video.load(); } catch (e) {}
    return video;
  }

  function buildOverlay() {
    if (byId('boot-splash')) return byId('boot-splash');
    var splash = document.createElement('div');
    splash.id = 'boot-splash';
    splash.setAttribute('aria-label', 'Induló videó');

    var poster = document.createElement('img');
    poster.id = 'boot-poster';
    poster.className = 'boot-poster';
    poster.alt = '';
    poster.src = POSTER_SRC;

    var hint = document.createElement('div');
    hint.id = 'boot-hint';
    hint.className = 'boot-hint';
    var stage = document.createElement('div');
    stage.id = 'boot-stage';
    stage.className = 'boot-stage';
    var time = document.createElement('div');
    time.id = 'boot-time';
    time.className = 'boot-time';
    var error = document.createElement('div');
    error.id = 'boot-error';
    error.className = 'boot-error';
    hint.appendChild(stage);
    hint.appendChild(time);
    hint.appendChild(error);

    splash.appendChild(poster);
    splash.appendChild(createVideoElement());
    splash.appendChild(hint);

    // A <body> még nem biztos, hogy létezik (a <head>-ben futunk): ilyenkor a
    // documentElement-re kerül, a DOM kész után átkerül a body-ba.
    try { (document.body || document.documentElement).appendChild(splash); } catch (e) { log('overlay beszúrás hiba: ' + e); }
    return splash;
  }

  var splashEl = buildOverlay();
  var videoEl = byId('boot-video');

  function moveOverlayToBody() {
    try {
      var splash = byId('boot-splash');
      if (splash && document.body && splash.parentNode !== document.body) {
        document.body.appendChild(splash);
      }
    } catch (e) {}
  }

  // ---------- Lejátszás ----------
  var introEnded = false;
  var introStartedAt = 0;
  var posterTimer = null;

  function releasePlayback() {
    try { window.__IPTV_INTRO_ACTIVE__ = false; } catch (e) {}
    try {
      var ev = document.createEvent('Event');
      ev.initEvent('iptv-intro-done', true, true);
      window.dispatchEvent(ev);
    } catch (e2) {}
    log('lejátszás engedélyezve (iptv-intro-done)');
  }

  function hideVideoShowPoster() {
    try { if (videoEl) videoEl.style.display = 'none'; } catch (e) {}
    try { if (videoEl) videoEl.pause(); } catch (e2) {}
  }

  // A videó hibája / megakadása esetén NEM ugrunk azonnal a főoldalra: a
  // plakát (a videó első kockája) marad a tervezett ideig.
  function posterMode(reason) {
    if (introEnded || posterTimer) { log('plakát kérés (már fut): ' + reason); return; }
    log('plakátra váltás: ' + reason);
    hideVideoShowPoster();
    var elapsed = introStartedAt ? (Date.now() - introStartedAt) : 0;
    var remaining = Math.max(1200, INTRO_MAX_MS - elapsed);
    posterTimer = window.setTimeout(function () {
      endIntro('tervezett idő letelt (plakát)');
    }, remaining);
  }

  function removeSplash() {
    var splash = byId('boot-splash');
    if (splash && splash.parentNode) splash.parentNode.removeChild(splash);
  }

  function endIntro(reason) {
    if (introEnded) return;
    introEnded = true;
    log('vége: ' + reason);
    var splash = byId('boot-splash');
    try { if (videoEl) videoEl.pause(); } catch (e) {}
    if (!splash) return;
    if (splash.className.indexOf('boot-failed') >= 0) return; // hiba: marad a hibaüzenet
    releasePlayback();
    splash.className += ' is-hidden';
    window.setTimeout(removeSplash, 650);
  }

  function attachVideoEvents(video) {
    try {
      video.addEventListener('loadedmetadata', function () {
        log('videó kész (' + (Math.round((video.duration || 0) * 10) / 10) + ' s)');
      });

      video.addEventListener('playing', function () {
        log('lejátszás elindult (' + (Math.round((video.currentTime || 0) * 100) / 100) + ' s)');
        // Néma indítás után itt kapcsoljuk be a hangot. Ha a TV ezt nem
        // engedi (megállna a lejátszás), azonnal visszanémítunk - a videó
        // soha nem áll meg csak a hang miatt.
        if (!video.muted) return;
        log('hang visszakapcsolása');
        try { video.muted = false; } catch (e) {}
        window.setTimeout(function () {
          if (video.paused) {
            log('a hang visszakapcsolása megállította – újra némán');
            try { video.muted = true; video.play(); } catch (e) {}
          }
        }, 700);
      });

      video.addEventListener('ended', function () {
        var duration = 0;
        var position = 0;
        try { duration = video.duration || 0; } catch (e) {}
        try { position = video.currentTime || 0; } catch (e2) {}
        if (duration > 1 && position < duration - 0.5) {
          // Nem valódi befejezés: a TV dekódere adta fel a végét.
          posterMode('korán véget ért (' + (Math.round(position * 10) / 10) + '/' +
            (Math.round(duration * 10) / 10) + ' s)');
          return;
        }
        endIntro('ended esemény');
      });

      video.addEventListener('error', function () {
        var code = 'ismeretlen';
        try { code = video.error ? video.error.code : 'nincs error objektum'; } catch (e) {}
        posterMode('error esemény (code ' + code + ')');
      });
    } catch (e) {}
  }

  function startIntro() {
    if (!videoEl) { videoEl = byId('boot-video'); }
    if (!videoEl) { endIntro('nincs videó elem'); return; }
    introStartedAt = Date.now();
    attachVideoEvents(videoEl);

    var played = null;
    try { played = videoEl.play(); } catch (e) { log('play() kivétel: ' + e); }
    if (played && played.catch) {
      played.catch(function (err) {
        var name = (err && err.name) ? err.name : String(err);
        log('a néma indítás sem sikerült (' + name + ')');
        posterMode('a videó nem indult el (' + name + ')');
      });
    } else if (!played) {
      log('play() nem adott Promise-t (régi motor)');
    }

    // Ha 8 mp alatt el sem indult (és még kép sincs), nem tartjuk fogva.
    window.setTimeout(function () {
      if (introEnded || posterTimer) return;
      if (!videoEl) return;
      if ((videoEl.currentTime || 0) > 0.05) return;
      if (videoEl.readyState >= 2) { log('8 mp után is lassan indul, de van kép – várunk'); return; }
      posterMode('8 mp alatt nem indult el (readyState ' + videoEl.readyState + ')');
    }, 8000);

    // Megakadás-figyelő: 10 mp türelem (a háttérben épülő felület elveheti a
    // processzort, ilyenkor rövid ideig állhat a kép).
    var lastTime = -1;
    var stuck = 0;
    var watchdog = window.setInterval(function () {
      if (introEnded || !videoEl) { window.clearInterval(watchdog); return; }
      if (!videoEl.paused && (videoEl.currentTime || 0) > lastTime + 0.01) {
        lastTime = videoEl.currentTime;
        stuck = 0;
        return;
      }
      stuck++;
      if (stuck >= 10) {
        window.clearInterval(watchdog);
        posterMode('megakadt (' + (Math.round((videoEl.currentTime || 0) * 10) / 10) +
          ' s-nál, paused=' + videoEl.paused + ')');
      }
    }, 1000);
  }

  // ---------- Hibaképernyő (csak VALÓDI hiba esetén) ----------
  function appReady() {
    return !!(window.__IPTV_APP_READY__ || (window.__IPTV_STARTUP_STAGE__ || 0) >= 7);
  }

  window.__IPTV_STARTUP_FAIL__ = function (message) {
    try { console.error('STARTUP FAIL stage=' + window.__IPTV_STARTUP_STAGE__ + ': ' + String(message)); } catch (e) {}

    hideVideoShowPoster();
    var splash = byId('boot-splash');
    if (!splash) return;
    splash.className = 'boot-failed';
    introEnded = true;
    var el = byId('boot-stage');
    var err = byId('boot-error');
    if (el) el.textContent = 'HIBA a(z) ' + (window.__IPTV_STARTUP_STAGE__ || '?') + '/7 lépésnél';
    if (err) err.textContent = String(message || 'Ismeretlen JavaScript hiba');
  };

  function isResourceError(e) {
    var t = e && e.target;
    return !!(t && t !== window && t !== document && t.tagName);
  }

  function resourceLabel(e) {
    try {
      var t = e.target;
      var src = t.src || t.href || t.currentSrc || '';
      return t.tagName + (src ? ' – ' + src : '');
    } catch (e2) { return 'ismeretlen erőforrás'; }
  }

  window.addEventListener('error', function (e) {
    // Erőforrás-betöltési hiba (betűtípus internet nélkül, logó, videó stb.)
    // NEM apphiba: csak naplózzuk.
    if (isResourceError(e)) {
      if (e.target && e.target.id === 'boot-video') return; // a videónak saját kezelője van
      try { console.warn('STARTUP: erőforrás nem töltődött be: ' + resourceLabel(e)); } catch (e2) {}
      return;
    }
    if (!e || !e.message) return;
    if (appReady()) {
      try {
        console.error('IPTV-RT hiba (a felület már fut): ' + e.message + ' @ ' +
          (e.filename || '') + ':' + (e.lineno || 0));
      } catch (e2) {}
      return;
    }
    window.__IPTV_STARTUP_FAIL__('JS: ' + e.message + '\n' + (e.filename || '') + ':' + (e.lineno || 0));
  }, true);

  window.addEventListener('unhandledrejection', function (e) {
    var reason = e && e.reason;
    var message = (reason && (reason.stack || reason.message)) || String(reason);
    if (appReady()) {
      try { console.error('IPTV-RT promise hiba (a felület már fut): ' + message); } catch (e2) {}
      return;
    }
    window.__IPTV_STARTUP_FAIL__('Promise: ' + message);
  });

  // ---------- Indítás ----------
  // A videó AZONNAL indul (a nagy app-csomag elemzése még el sem kezdődött).
  startIntro();
  show(1, 'webOS HTML');

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      moveOverlayToBody();
      show(2, 'DOM kész');
    }, false);
  } else {
    moveOverlayToBody();
    show(2, 'DOM kész');
  }
})();
