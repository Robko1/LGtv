#!/usr/bin/env node
/**
 * A csatornaelrendezés mentése kizárólag Supabase-en történik.
 * A TV-n csak a kis állapotjelző metaadat maradhat; JSON-pillanatkép/fájl nem.
 * A teszt a tényleges forráskódot ellenőrzi, nem régi implementációs részleteket.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const service = read('web/src/services/channelLayoutBackup.ts');
const settings = read('web/src/components/MenuSettingsModal.tsx');
const header = read('web/src/components/Header.tsx');
const channels = read('web/src/components/ChannelList.tsx');

// A korábbi nagy helyi snapshotok maradványait egyszer eltávolítjuk.
assert.match(service, /removeLegacyLocalLayoutSnapshots/);
assert.match(service, /iptv_rt_layout_snapshot_v1_/);
assert.match(service, /iptv_rt_layout_cloud_last_fetch_v1/);

// Nincs több helyi snapshot API, illetve JSON-fájl export/import.
for (const obsolete of [
  'saveSnapshotLocal',
  'loadSnapshotLocal',
  'exportSnapshotToFile',
  'importSnapshotFromFile',
  'handleExportFile',
  'handleImportFileClick',
  'handleImportFileChange',
  'layoutFileInputRef',
  'Mentés fájlba',
  'Visszaállítás fájlból',
]) {
  assert.equal(service.includes(obsolete) || settings.includes(obsolete), false,
    `A megszüntetett helyi JSON/fájl funkció még szerepel: ${obsolete}`);
}

// Mentéskor a Supabase-válasz az igazolás; hiba esetén nincs helyi snapshot fallback.
assert.match(settings, /saveSnapshotToCloud\(snap\)/);
assert.match(settings, /Helyi másolat nem készült/);
assert.doesNotMatch(settings, /saveSnapshotLocal|loadSnapshotLocal/);

// Visszaállítás kizárólag a felhőből lekért snapshotot használja.
assert.match(service, /uniqueNameMatch/); // provider-váltáskor ID/kategória-ID eltérés mellett is illeszt
assert.match(settings, /fetchSnapshotFromCloud\(activeProviderForLayout\.id\)/);
assert.match(settings, /Supabase-ben tárolt pillanatképből/);
assert.doesNotMatch(settings, /loadSnapshotLocal|localSnap|source: 'helyi'/);

// A két aktív művelet megmarad, a beállítási rész nem üres.
assert.match(settings, /onClick=\{handleSaveLayout\}/);
assert.match(settings, /onClick=\{handleRestoreLayout\}/);
assert.match(settings, /Mentés most/);
assert.match(settings, /Visszaállítás/);

// A korábban kért nagy sárga fókusz a menü és mindkét kedvencmappa-gombtípuson megmarad.
for (const source of [header, channels]) {
  assert.match(source, /focus:ring-\[10px\]/);
  assert.match(source, /focus:scale-110/);
  assert.match(source, /focus:z-50/);
  assert.match(source, /focus:shadow-\[0_0_42px_8px_rgba\(252,211,77,1\)\]/);
}
const folderFocusCount = (channels.match(/focus:ring-\[10px\]/g) || []).length;
assert.equal(folderFocusCount, 2, 'mindkét kedvencmappa-megjelenítésen megvan a nagy fókusz');

console.log('OK – Supabase-only elrendezésmentés, fájlgombok eltávolítva, nagy sárga fókusz megmaradt.');
