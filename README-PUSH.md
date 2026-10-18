# LGtv repo push – hogyan töltsd fel GitHub-ra

Ez a mappa az LG webOS TV külön repo-ja (v2.3.0).

## Ha a GitHub-on már létrehoztad https://github.com/Robko1/LGtv (Private) üres repo-t:

### 1. Tömörített projekt letöltése

- Arena-ból letöltöd: `LGtv-project.tar.gz` (634K)
- Kicsomagolod:

```bash
tar xzf LGtv-project.tar.gz
cd LGtv
```

### 2. Git push

```bash
git init -b main
git add -A
git commit -m "v2.3.0 LG webOS TV külön repo – távirányító fix + külön kinézet + QR + workflow fix"
git remote add origin https://github.com/Robko1/LGtv.git
git push -u origin main
```

Ha már van benne valami (pl. README), akkor:

```bash
git remote add origin https://github.com/Robko1/LGtv.git
git fetch origin
git branch -M main
git push -u origin main --force
```

### 3. Ellenőrzés

- GitHub-on: https://github.com/Robko1/LGtv → fájlok látszanak
- Actions fül: 2 workflow
  - `IPTV – LG webOS diagnosztika + kinézet build` (kézi)
  - `IPTV – webOS TV IPK építése` (kézi)

### 4. IPK építés

- Actions → `IPTV – LG webOS diagnosztika` → Run workflow → ha OK
- Actions → `IPTV – webOS TV IPK építése` → Run workflow → artifact + Release `v2.3.0` → `IPTV-RT-webOS-2.3.0.ipk`

## Mi változott a korábbi hibás futáshoz képest (39110438592)?

- `tools/build-webos.sh`: `type="module"` + `crossorigin` eltávolítása – file:// nem támogatja, CORS hibát okozott webOS-en
- `webos-diagnosis.yml`: 6. lépés már csak FIGYELMEZTETÉS, nem HIBA, ha type=module marad (build-webos.sh javítja)
- Markerek keresése HTML-ben ÉS webos.js-ben: `webOS`, `IS_WEBOS_TV`, `IS_LG_WEBOS`

## Telepítés TV-re

- IPK: `webos/IPTV-RT-webOS-2.3.0.ipk` vagy Release-ből
- Dev Manager: https://github.com/webosbrew/dev-manager-desktop
- TV Developer Mode be, IPK Install

## QR telefonos

- `provision.html` + `QR-TELEFONOS-BEALLITAS.md`
- Bucket: `IPTV_RT_QR_8bc03776` kvdb.io
