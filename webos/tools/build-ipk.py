#!/usr/bin/env python3
"""
LG webOS TV .ipk csomag készítése ar archívummal
Formátum: ar archive -> debian-binary (2.0), control.tar.gz, data.tar.gz
data.tar.gz tartalmazza: ./usr/palm/applications/<id>/ (appinfo.json, index.html, stb)
"""

import os
import sys
import tarfile
import tempfile
import shutil
import struct
import time
from pathlib import Path

def create_ar_archive(output_path, files):
    """
    Egyszerű ar archívum készítése (GNU ar formátum)
    files: lista (name, path) tuple-ok
    """
    with open(output_path, 'wb') as f:
        # ar magic
        f.write(b'!<arch>\n')
        
        for name, file_path in files:
            # ar header: 16 char file name, 12 char mtime, 6 char uid, 6 char gid, 8 char mode, 10 char size, 2 char end
            stat = os.stat(file_path)
            size = stat.st_size
            
            # File name: 16 chars, space padded, ends with /
            # Ha hosszabb mint 16, GNU long filename? Egyszerűen csonkoljuk vagy használjuk #1/ formátumot
            # De a webOS-nál a nevek rövidek: control.tar.gz, data.tar.gz, debian-binary
            name_field = (name + '/').ljust(16)[:16]
            
            mtime = str(int(time.time())).ljust(12)[:12]
            uid = '0'.ljust(6)[:6]
            gid = '0'.ljust(6)[:6]
            mode = '100644'.ljust(8)[:8]
            size_field = str(size).ljust(10)[:10]
            end = b'`\n'
            
            header = f"{name_field}{mtime}{uid}{gid}{mode}{size_field}".encode('ascii') + end
            f.write(header)
            
            with open(file_path, 'rb') as src:
                f.write(src.read())
            
            # Páros byte-ra igazítás
            if size % 2 == 1:
                f.write(b'\n')

def create_control_tar_gz(control_dir, output_path):
    """control.tar.gz: tartalmazza a control fájlt"""
    with tarfile.open(output_path, 'w:gz') as tar:
        # control fájl
        control_file = os.path.join(control_dir, 'control')
        if os.path.exists(control_file):
            tar.add(control_file, arcname='./control')
        # Opcionális: postinst, prerm, stb
        for fname in ['postinst', 'prerm', 'preinst', 'postrm']:
            fpath = os.path.join(control_dir, fname)
            if os.path.exists(fpath):
                tar.add(fpath, arcname=f'./{fname}')

def create_data_tar_gz(app_dir, app_id, output_path):
    """data.tar.gz: tartalmazza az app fájlokat /usr/palm/applications/<id>/ alatt"""
    with tarfile.open(output_path, 'w:gz') as tar:
        # webOS TV-n az appok ide kerülnek: /media/developer/apps/usr/palm/applications/<id>/
        # De a csomagban: ./usr/palm/applications/<id>/
        base_path = f'./usr/palm/applications/{app_id}'
        
        for root, dirs, files in os.walk(app_dir):
            for file in files:
                full_path = os.path.join(root, file)
                rel_path = os.path.relpath(full_path, app_dir)
                arcname = f'{base_path}/{rel_path}'
                tar.add(full_path, arcname=arcname)

def build_ipk(app_dir, output_ipk, app_id, version):
    """Teljes .ipk build"""
    print(f"==> webOS IPK build: {app_id} v{version}")
    print(f"    App dir: {app_dir}")
    print(f"    Output: {output_ipk}")
    
    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir = Path(tmpdir)
        
        # debian-binary
        debian_binary = tmpdir / 'debian-binary'
        debian_binary.write_text('2.0\n')
        
        # control fájl
        control_dir = tmpdir / 'control'
        control_dir.mkdir()
        control_content = f"""Package: {app_id}
Version: {version}
Section: misc
Priority: optional
Architecture: all
Maintainer: TV
Description: TV - Elo TV, Mozi, Sorozat LG webOS TV-re
"""
        (control_dir / 'control').write_text(control_content)
        
        control_tar_gz = tmpdir / 'control.tar.gz'
        create_control_tar_gz(str(control_dir), str(control_tar_gz))
        
        # data.tar.gz
        data_tar_gz = tmpdir / 'data.tar.gz'
        create_data_tar_gz(app_dir, app_id, str(data_tar_gz))
        
        # ar archive -> .ipk
        files = [
            ('debian-binary', str(debian_binary)),
            ('control.tar.gz', str(control_tar_gz)),
            ('data.tar.gz', str(data_tar_gz)),
        ]
        
        create_ar_archive(output_ipk, files)
        
        size = os.path.getsize(output_ipk)
        print(f"==> Kész: {output_ipk} ({size // 1024} KB)")

def main():
    import argparse
    ap = argparse.ArgumentParser(description='LG webOS TV .ipk builder')
    ap.add_argument('--app-dir', required=True, help='App forrás mappa (appinfo.json, index.html, stb)')
    ap.add_argument('--out', required=True, help='Kimeneti .ipk fájl')
    ap.add_argument('--id', required=True, help='App ID (pl. hu.rt.iptv.webos)')
    ap.add_argument('--version', required=True, help='Verzió (pl. 1.25.0)')
    args = ap.parse_args()
    
    build_ipk(args.app_dir, args.out, args.id, args.version)

if __name__ == '__main__':
    main()
