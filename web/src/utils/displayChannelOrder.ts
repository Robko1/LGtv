/** Index the displayed order only when the list or its sort order changes.
 * Keep Array.indexOf's first-occurrence semantics, including duplicate IDs.
 */
export function displayChannelPositions(channels: readonly { id: string }[], displayedOrder: readonly string[]): Map<string, number> {
  let matches = displayedOrder.length === channels.length;
  if (matches) {
    const ids = new Set(channels.map((channel) => channel.id));
    for (const id of displayedOrder) {
      if (!ids.has(id)) { matches = false; break; }
    }
  }
  const positions = new Map<string, number>();
  if (matches) {
    displayedOrder.forEach((id, index) => { if (!positions.has(id)) positions.set(id, index + 1); });
  } else {
    channels.forEach((channel, index) => { if (!positions.has(channel.id)) positions.set(channel.id, index + 1); });
  }
  return positions;
}
