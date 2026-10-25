# QR Telefonos Beállítás – TV-n nem kell pötyögni

## Probléma
LG webOS TV-n borzasztó a távirányítóval beírni a szolgáltató host / user / pass / M3U URL-t.

## Megoldás – QR kód + telefon

### Hogyan működik?

1. **TV-n:** Beállítások → Listák → **📱 Telefon** gomb
2. TV generál egy 6 jegyű kódot (pl. `482917`) + QR kódot
3. QR kód tartalma: `https://robko1.github.io/LGtv/provision.html?tv=tv_abc123&code=482917`
4. **Telefonon:** beolvasod QR-t kamerával → megnyílik egy weboldal
5. Telefonon beírod kényelmesen:
   - Xtream: host, port, username, password
   - vagy M3U URL
6. Nyomod: **Küldés TV-re**
7. Telefon POST-ol `https://kvdb.io/IPTV_RT_QR_8bc03776/<tvId>`-re (ingyenes, CORS, 5 perc TTL)
8. TV 3 másodpercenként GET-tel poll-olja ugyanezt, ha megjön, automatikusan importálja a csatornákat, mozikat, sorozatokat, EPG-t
9. TV törli a kódot, kész

**Adatvédelem:** adatok 5 percig élnek kvdb.io-n, utána auto törlődnek. TV csak egyszer olvassa ki, majd DELETE. HTTPS titkosított. Ha nem bízol benne, továbbra is beírhatod kézzel TV-n.

### Technikailag

- `web/src/services/qrProvisioningService.ts` – TV oldali logika: `createProvisionSession()`, `getProvisionUrl()`, `pollForProvider()`, `pushProvider()`
- `web/src/components/QrProvisionModal.tsx` – TV modal: kód kijelző + QRCodeSVG + countdown + polling + auto import
- `web/public/provision.html` – telefonos oldal: Xtream / M3U tabok, validálás, POST kvdb.io-ra
- `web/src/App.tsx` – `handleQrProviderReceived()` – bejövő payload → ProviderAccount → `handleAddProvider()`
- `tools/build-webos.sh` – `provision.html` másolása az IPK-ba

### Fallback ha nincs internet

Ha kvdb.io nem elérhető:
- TV-n továbbra is működik kézi bevitel: Beállítások → Listák → Új lista
- Vagy: GitHub Pages-en a `web/public/provision.html` közzétehető és lokálisan is használható, ha a TV és a telefon egy WiFi-n (jövőbeli fejlesztés: WebRTC).

### Jövőbeli lehetőségek

1. **Firebase / Supabase** – saját bucket, te kezeled az adatokat, nem kvdb.io
2. **Saját Node szerver** – `https://your-domain.com/api/provision` – te hostolod
3. **QR ami magát a providert kódolja** – telefon generál QR-t ami `xtream://...` formátumú, de LG TV-n nincs kamera, ezért nem jó
4. **USB import** – nincs megvalósítva; a webOS fájlhozzáférése korlátozott.
5. **GitHub Gist sync** – nincs megvalósítva a webOS-verzióban.

### Használat TV-n

- **LG webOS TV:** Beállítások → Listák → 📱 Telefon gomb, Magic Remote-tal navigálható, Enterrel nyílik

### Tesztelés

- `npm run dev --prefix web` → http://localhost:5173 → Beállítások → Telefon → QR megjelenik
- Telefonon (vagy másik böngésző ablakban) nyisd meg a QR URL-t → írd be teszt adatokat → Küldés TV-re → TV 3mp-en belül behozza
