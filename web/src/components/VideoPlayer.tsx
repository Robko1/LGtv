      if (playObserver && playPromise && typeof playPromise.then === 'function') {
        void playPromise.then(
          () => playObserver('play() ígéret teljesült'),
          (error: unknown) => {
            const name = error && typeof error === 'object' && 'name' in error ? String(error.name).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60) : 'ismeretlen';
            playObserver('play() ígéret elutasítva', `hiba=${name}`);
          },
        );
      }
      setIsPlaying(true);
      // Normál csatorna-/VOD-indításkor nincs TV Doktor-állapotablak.
      // Az állapotablak kizárólag tényleges hibánál vagy beavatkozásnál jelenik meg.
      // Normál élő TV-n, kikapcsolt TV Doktor mellett nincs automatikus
      // indulási watchdog sem: egy időzítő nem töltheti újra a csatornát.
      // A sikertelen indulást a néző kézi csatornaváltással lépteti tovább.
      // A TV Doktor bekapcsolt állapotában az eredeti indulási felügyelet marad.
      if (!customStreamUrl && tvDoctorEnabledRef.current) {
        const { startupWatchdogMs } = bufferTiming();
        /*
         * A normál indulásnak legalább 4,5 másodpercet hagyunk. A #59-ben
         * a szolgáltatói stream első metaadata 3,3–3,7 mp után érkezett;
         * a korábbi 2 mp-es őr saját újratöltéssel növelte a csatornaváltást.
         * Ha már van adat, röviden ellenőrizzük a tényleges haladást.
         */
        const attemptTimeoutMs = effectiveStartupWatchdogMs(startupWatchdogMs);
        zapWatchdogRef.current = window.setTimeout(() => {
          zapWatchdogRef.current = null;
          if (!isCurrentLoad() || playbackStartedRef.current) return;

          const aheadAtCheck = bufferedAheadSeconds(video);
          const framesAtCheck = readPlaybackFrameStats(video)?.total ?? null;
          const readyStateAtCheck = video.readyState;
          const hasStartupData = readyStateAtCheck >= 2 || (aheadAtCheck !== null && aheadAtCheck > 0);

          const retryForRealFailure = (reason: string) => {
            if (!isCurrentLoad() || playbackStartedRef.current) return;
            const mediaError = video.error;
            if (mediaError) {
              notifyTvDoctorIncident(
                'media_error',
                video,
                `MEDIA_ERR_${mediaError.code || 'UNKNOWN'}`,
                mediaError.message || reason,
              );
            } else {
              notifyTvDoctorIncident('startup_timeout', video, 'STARTUP_TIMEOUT', reason);
            }
            scheduleAutoRetry();
          };

          if (hasStartupData) {
            appLog('Zap-őr: már érkezett adat; formátumváltás előtt ellenőrzi a tényleges előrehaladást.');
            zapWatchdogRef.current = window.setTimeout(() => {
              zapWatchdogRef.current = null;
              if (!isCurrentLoad() || playbackStartedRef.current) return;

              const aheadNow = bufferedAheadSeconds(video);
              const framesNow = readPlaybackFrameStats(video)?.total ?? null;
              const bufferProgressed = aheadAtCheck !== null
                && aheadNow !== null
                && aheadNow > aheadAtCheck + 0.15;
              const framesProgressed = framesAtCheck !== null
                && framesNow !== null
                && framesNow > framesAtCheck;
              const readyStateProgressed = video.readyState > readyStateAtCheck;

              if (bufferProgressed || framesProgressed || readyStateProgressed) {
                appLog('Zap-őr: a puffer vagy a képkockák tovább haladnak; nincs felesleges újrapróbálkozás.');
                return;
              }
              retryForRealFailure('az adatfolyam megállt, és nem indult el a lejátszás');
            }, 900);
            return;
          }

          retryForRealFailure('2–2,5 másodperc alatt nem érkezett lejátszható adat');
        }, attemptTimeoutMs);
            } else if (tvDoctorEnabledRef.current) {
        // VOD INDULÁSI ŐR: ha a film vagy sorozat HTTP-kapcsolata némán
        // beragad induláskor, a TV Doktor türelmes ablak után (≥ 8,5 mp)
        // automatikusan újracsatlakoztatja ugyanazt a fájlt.
        const vodStartupLimitMs = Math.max(8500, doctorSessionRef.current.vodStartupWatchdogMs || 8500);
        zapWatchdogRef.current = window.setTimeout(() => {
          zapWatchdogRef.current = null;
          if (isCurrentLoad() && !playbackStartedRef.current && isVodRef.current) {
            /*
             * 2.5.388 (#31 napló): a `buffered.length > 0` ÖNMAGÁBAN nem