/** Keep an old deferred entry from overwriting a newer exit or entry. */
export function createFullscreenSync(
  apply: (value: boolean) => void,
  requestFrame: (callback: FrameRequestCallback) => number,
) {
  let generation = 0;
  return {
    set(value: boolean) {
      const current = ++generation;
      if (!value) { apply(false); return; }
      requestFrame(() => {
        if (generation !== current) return;
        requestFrame(() => {
          if (generation === current) apply(true);
        });
      });
    },
    invalidate() { generation += 1; },
  };
}
