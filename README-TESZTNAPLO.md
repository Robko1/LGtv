# IPTV R.T – verziózott tesztnapló és referencia

Ez a fájl a fizikai TV-s mérések és összehasonlítások gyűjtőhelye. A **védett működési alap 2.5.176**: a natív indítókép utáni közvetlen főoldal, a jelenlegi képmegjelenítés és a működő EPG ([README.md](README.md)).

## Hogyan értelmezzük az adatokat?

- A **tesztelt verziót** a tényleges napló `verzió=` sorából vagy a kész IPK manifestjéből kell kiolvasni.
- Teljes nyers naplókat, stream-URL-t vagy hitelesítési adatokat ne másoljunk nyilvános dokumentációba.
- A hiányzó TV-modellt vagy webOS-verziót nem szabad megtippelni (`nem derül ki` / `nem ismert`).
- Az alkalmazásoldali `requestAnimationFrame` és `playing` időbélyegek nem azonosak a fizikai gombnyomás vagy a TV-panel tényleges festésének idejével; a szolgáltató, a hálózat és a készülék médiamotorja egyaránt befolyásolja őket.

## Megőrzött történeti mérések

### 2.5.168 – TV-naplók #39–#42

| Napló | Régi `FELFEDÉS` | Teljes képernyő BE – mért minták | Főoldalra KI – mért minták |
| --- | ---: | --- | --- |
| #39 | 2489 ms | 13,0; 30,9; 54,4; 6,6 ms | 158,5; 143,3; 177,5; 151,6 ms |
| #40 | 2086 ms | 15,9; 8,7; 8,4; 51,2 ms | 149,1; 143,4; 174,3; 170,1 ms |
| #41 | 2233 ms | 15,4; 14,2; 7,7; 14,7 ms | 144,3; 158,6; 155,6; 175,1 ms |
| #42 | 2102 ms | 13,2; 8,4; 8,0; 10,1 ms | 212,0; 160,4; 169,6; 145,9 ms |

A #42 naplóban az első formátumpróbával sikeres MPEG-TS csatornaváltási összesítések között **1256 ms**, **1480 ms**, **1601 ms** és **2419 ms** szerepel (forrásbetöltéstől `playing` eseményig).

### 2.5.170 – TV-napló #46

| Mérőszám | Naplóban szereplő érték | Megjegyzés |
| --- | --- | --- |
| Régi `FELFEDÉS` | 1730 ms | Alkalmazáson belüli jelzés, nem igazolt panel-festési idő. |
| Teljes képernyő BE | 18,7; 18,2; 20,5; 19,8 ms | Négy OK-minta. |
| Főoldalra KI | 271,4; 176,0; 169,5; 199,6 ms | Négy OK-s kilépés. |
| Csatorna, egy MPEG-TS próbával | 3125; 1674; 1809 ms | Három sikeres `playing`-összesítés. |
| XMLTV | 84,0 s; 55 621 KB; 2665 csatorna; 33 685 megtartott műsor | 180 742 feldolgozott blokk. |

### 2.5.176 – elfogadott működési alap

- **Indítás:** natív `splash-screen.png` után közvetlen főoldal (`notifyAppLoaded()`).
- **Kép:** élő teljes képernyőn `cover`, aktív VOD teljes képernyőn `fill`.
- **EPG:** működő csatornalista- és műsorújság-megjelenítés.

### 2.5.178–2.5.184 – csatornaváltási és OSD-mérések (#71, #72, #74, #75, #76)

- **#71 (2.5.178):** teljes képernyő BE a második rAF-ig **298,5 / 266,0 / 338,9 ms**, KI **195,1 / 165,0 / 263,1 ms**; 10 sikeres csatornaváltás `playing`-ig **1282–2948 ms** (átlag **1889 ms**).
- **#72 (2.5.179) és #74 (2.5.181):** az élő lejátszó állandó flex-helyet kapott, a teljes képernyős élő OSD pedig csak az aktív `iptv-tv-fullscreen` jelölés mellett látható, megszüntetve a visszalépési átvillanást. A #74-ben 16 sikeres csatornaváltás átlaga `playing`-ig **1613,7 ms** (1208,5–2116,5 ms).
- **#75 (2.5.183) és #76 (2.5.184):** a #75 naplóban 53 tipikus váltás `playing` átlaga **1544,3 ms** (medián **1505,1 ms**). A 2.5.184-es HLS-őrváltoztatás után a #76-os visszajelzés alapján a lejátszó visszaállt a 2.5.183-as stabil indulási és újrapróbálási logikára. A hangsáv- és feliratválasztó ablakok 32 px-es, TV-ről jól olvasható betűméretet és „Felirat kikapcsolva” opciót kaptak.

## Következő TV-s teszt – rögzítési minta

Új tesztnél másold ezt a blokkot, és csak ténylegesen ellenőrzött adatokat írj bele (`nem ismert` vagy `nem mérhető` a hiányzó értékeknél):

```text
Dátum és idő / időzóna:
Tesztelt IPK verzió és build/commit:
TV-modell, webOS, böngésző (ha ismert):
Naplószám / forrás:
Indítás (natív takarókép -> főoldal):
Kép (élő előnézet / teljes képernyő / film / sorozat):
EPG (csatornalista / most-következő / EPG-ablak):
OK -> teljes képernyő / OK -> főoldal (ms):
Csatornaváltás és VOD-indítás (ms):
TV Doktor diagnosztika / javítási események:
Eredmény (sikeres / probléma / nem tesztelt):
```
