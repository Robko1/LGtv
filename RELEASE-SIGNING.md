# Kiadás aláírása

## GitHub Verified commit/tag

A GitHub zöld **Verified** jelzése a commit/tag aláírása. Nem az IPK belső aláírása.

A `webos-build.yml` támogatja a valódi GPG- vagy SSH-aláírást, de biztonsági okból csak akkor kapcsolja be, ha a repó Actions secretjei léteznek.

### GPG-út

- `RELEASE_GPG_PRIVATE_KEY` – a GPG privát kulcs ASCII-armored tartalma;
- `RELEASE_GPG_KEY_ID` – a kulcs rövid vagy hosszú azonosítója;
- `RELEASE_COMMIT_EMAIL` – olyan e-mail cím, amelyet a kulcs tartalmaz, és amely a GitHub-fiókhoz van rendelve;
- opcionális `RELEASE_COMMIT_NAME` – megjelenő név.

### SSH-út

- `RELEASE_SSH_PRIVATE_KEY` – az SSH-aláíró privát kulcs OpenSSH formátumban;
- `RELEASE_COMMIT_EMAIL` – a GitHub-fiókhoz rendelt e-mail cím;
- opcionális `RELEASE_COMMIT_NAME` – megjelenő név.

Az SSH kulcs publikus részét a GitHub-fiók **SSH signing keys** listájában, a GPG kulcs publikus részét a **GPG keys** listájában kell hozzáadni. Ha a publikus kulcs nincs a megfelelő fiókhoz rendelve, az Actions ugyan aláírhatja a commitot/taget, de GitHubon nem jelenik meg Verifiedként. A privát kulcsot nem szabad a repóba, issue-ba vagy chatbe tenni.

SSH-kulcs előállításának helyi példája:

```bash
ssh-keygen -t ed25519 -C "GitHub commit signing" -f release-signing-key -N ''
# release-signing-key.pub → GitHub SSH signing keys
# release-signing-key tartalma → RELEASE_SSH_PRIVATE_KEY Actions secret
```

Secret nélkül a workflow szándékosan nem állít elő hamis aláírást; a build összefoglalója jelzi, hogy a commit/tag aláírása nincs bekapcsolva.

## LG/webOS IPK

Az LG Developer Mode saját teszttelepítéséhez az aktuális IPK használható; ehhez nem kell production aláírás. Az LG Content Store-ba vagy más hivatalos terjesztési csatornára szánt csomaghoz LG/webOS fejlesztői vagy disztribúciós tanúsítvány és az LG által előírt kiadási folyamat szükséges.

Az LG-tanúsítvány privát része nem kerülhet GitHubba. A jelenlegi `webos/tools/build-ipk.py` fejlesztői IPK-t csomagol, nem állít elő hamis LG-tanúsítványt. Ha az LG a projekthez kiad tanúsítványt és a hivatalos automatizált aláíró eszköz dokumentált, akkor külön, zárt Actions secret-alapú release-lépés adható hozzá; addig a Developer Mode-os csomag a helyes és őszinte megoldás.
