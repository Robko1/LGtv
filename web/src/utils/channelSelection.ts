import type { Channel } from '../types/iptv';

/**
 * Magyar csatorna-e? Ugyanaz a szabály, mint a `hungaryFirst` sorrendnél:
 * az országkód, az országnév vagy a kategórianév dönt.
 */
export function isHungarianChannel(channel: Channel): boolean {
  return channel.countryCode?.toUpperCase() === 'HU'
    || channel.country === 'Magyarország'
    || /\b(magyarország|hungary|hungarian)\b/i.test(channel.categoryName || '');
}

/**
 * Lejátszható csatorna-e?
 *
 * A szolgáltatók listájában gyakran vannak „##### HUNGARIA #####”, „=====”
 * vagy „***” alakú ELVÁLASZTÓ sorok: ezek csatornaként jelennek meg, de nem
 * játszhatók le. Ha a betöltés után ezekre állnánk, a néző egy üres adást
 * kapna. Az elválasztó sor díszítőjelekkel kezdődik, és nincs valódi
 * stream-címe.
 */
export function isPlayableChannel(channel: Channel): boolean {
  const name = (channel.name || '').trim();
  if (!name) return false;
  if (/^[#*=~_+\-\s]{2,}/.test(name)) return false;
  return String(channel.streamUrl || '').trim().length > 0;
}

/**
 * Az ELSŐ VALÓBAN LEJÁTSZHATÓ magyar csatorna.
 *
 * Ezt használja a program az első betöltés után (Magyarország az
 * alapértelmezett ország), és ez a tartalék akkor is, ha a kiválasztott
 * csatorna eltűnt a listából. Sorrend:
 *
 *   1. az első lejátszható magyar csatorna (a lista sorrendjében),
 *   2. ha nincs ilyen: az első magyar csatorna,
 *   3. ha egyáltalán nincs magyar: az első lejátszható, végül az első elem.
 *
 * TELJESÍTMÉNY: egyetlen végigolvasás, köztes tömb nélkül – a lista a TV-n
 * 20-60 ezer elemű is lehet, és ez a függvény minden betöltésnél lefut.
 */
export function firstPlayableHungarianChannel(list: Channel[]): Channel | undefined {
  if (!Array.isArray(list) || list.length === 0) return undefined;
  let firstHungarian: Channel | undefined;
  let firstPlayable: Channel | undefined;
  let firstAny: Channel | undefined;
  for (let index = 0; index < list.length; index++) {
    const channel = list[index];
    if (!firstAny) firstAny = channel;
    const playable = isPlayableChannel(channel);
    if (playable && !firstPlayable) firstPlayable = channel;
    if (!isHungarianChannel(channel)) continue;
    if (!firstHungarian) firstHungarian = channel;
    if (playable) return channel;
  }
  return firstHungarian || firstPlayable || firstAny;
}
