#!/usr/bin/env bash
# =============================================================================
# make-icons.sh — regenerate all app icons from build/icon.svg (macOS).
# -----------------------------------------------------------------------------
# Produces the decorated neon "CoS" app icon in every desktop format:
#   icon.icns  (macOS)   icon.ico  (Windows)   icon.png (Linux, 512px)
# Uses only built-in macOS tools (qlmanage, sips, iconutil) + node.
# Run from the build/ directory:  ./make-icons.sh
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"

SVG="icon.svg"
SRC="icon.svg.png"

echo "==> Rasterizing $SVG -> $SRC (1024px)"
qlmanage -t -s 1024 -o . "$SVG" >/dev/null 2>&1
[ -f "$SRC" ] || { echo "ERROR: failed to rasterize $SVG" >&2; exit 1; }

# --- macOS .icns -----------------------------------------------------------
echo "==> Building icon.icns (macOS)"
SET="icon.iconset"
rm -rf "$SET"; mkdir -p "$SET"
sips -z 16 16     "$SRC" --out "$SET/icon_16x16.png"      >/dev/null
sips -z 32 32     "$SRC" --out "$SET/icon_16x16@2x.png"   >/dev/null
sips -z 32 32     "$SRC" --out "$SET/icon_32x32.png"      >/dev/null
sips -z 64 64     "$SRC" --out "$SET/icon_32x32@2x.png"   >/dev/null
sips -z 128 128   "$SRC" --out "$SET/icon_128x128.png"    >/dev/null
sips -z 256 256   "$SRC" --out "$SET/icon_128x128@2x.png" >/dev/null
sips -z 256 256   "$SRC" --out "$SET/icon_256x256.png"    >/dev/null
sips -z 512 512   "$SRC" --out "$SET/icon_256x256@2x.png" >/dev/null
sips -z 512 512   "$SRC" --out "$SET/icon_512x512.png"    >/dev/null
cp "$SRC" "$SET/icon_512x512@2x.png"
iconutil -c icns "$SET" -o icon.icns
rm -rf "$SET"

# --- Linux .png ------------------------------------------------------------
echo "==> Building icon.png (Linux, 512px)"
sips -z 512 512 "$SRC" --out icon.png >/dev/null

# --- Windows .ico (multi-resolution) ---------------------------------------
echo "==> Building icon.ico (Windows)"
rm -rf .icotmp; mkdir -p .icotmp
for s in 16 32 48 64 128 256; do sips -z $s $s "$SRC" --out ".icotmp/$s.png" >/dev/null; done
node -e '
const fs=require("fs");
const sizes=[16,32,48,64,128,256];
const imgs=sizes.map(s=>({s,buf:fs.readFileSync(`.icotmp/${s}.png`)}));
const header=Buffer.alloc(6);
header.writeUInt16LE(0,0); header.writeUInt16LE(1,2); header.writeUInt16LE(imgs.length,4);
const dir=Buffer.alloc(16*imgs.length);
let off=6+16*imgs.length;
imgs.forEach((im,i)=>{const b=i*16;
  dir.writeUInt8(im.s>=256?0:im.s,b); dir.writeUInt8(im.s>=256?0:im.s,b+1);
  dir.writeUInt16LE(1,b+4); dir.writeUInt16LE(32,b+6);
  dir.writeUInt32LE(im.buf.length,b+8); dir.writeUInt32LE(off,b+12); off+=im.buf.length;});
fs.writeFileSync("icon.ico",Buffer.concat([header,dir,...imgs.map(i=>i.buf)]));
'
rm -rf .icotmp

echo "==> Done: icon.icns, icon.ico, icon.png"
