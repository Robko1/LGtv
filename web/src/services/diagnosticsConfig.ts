/**
 * TESZT IDŐSZAK – AUTOMATIKUS INDULÁSI DIAGNOSZTIKA (KI/BE KAPCSOLÓ).
 *
 * A felhasználó kérése: a tesztelés idején a hibakeresési naplózás MAGÁTÓL
 * induljon el az IPK minden indításakor, és részletesen rögzítse a teljes
 * alkalmazásindítást (mit ellenőriz és tölt be a webOS, milyen folyamatok
 * futnak, hol keletkezik késés, mi jelenik meg a képernyőn).
 *
 * EZ AZ EGYETLEN KAPCSOLÓ:
 *   • `true`  – a naplózás az indításkor automatikusan elindul, a részletes
 *               indulási diagnosztika (BOOT-DIAG sorok) is fut;
 *   • `false` – a régi viselkedés: a naplózás csak a SÁRGA ablak
 *               „Naplózás indítása” gombjára indul, és semmilyen háttérfigyelő
 *               nem fut.
 *
 * A hibák kijavítása után ezt az egyetlen értéket kell `false`-ra állítani –
 * a naplózás, a küldés és a naplózott események köre változatlan marad.
 */
export const TEST_STARTUP_DIAGNOSTICS = true;
