#!/usr/bin/env bash
# 出 APK：aapt2 编资源 -> javac -> d8 出 dex -> zipalign -> apksigner。
# 不走 Gradle：整条链路只读本机文件，不联网拉依赖，也不会被 Maven 的可达性卡住。
#
# 前置：
#   android-tools/android-sdk/{platforms/android-34,build-tools/34.0.0}   （android-tools/get-pkgs.sh 下载）
#   android/app/src/main/assets/www                                        （pack-www.py 组装）
#   PATH 里有 javac / keytool（JDK 17+）
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
SDK="$ROOT/android-tools/android-sdk"
BT="$SDK/build-tools/34.0.0"
PLATFORM="$SDK/platforms/android-34/android.jar"
SRC="$HERE/app/src/main"
OUT="$HERE/build"
KEYSTORE="$HERE/transdesk.keystore"
KSPASS="${TRANSDESK_KSPASS:-transdesk}"

pick(){ for e in "$BT/$1.exe" "$BT/$1.bat" "$BT/$1"; do [ -e "$e" ] && { echo "$e"; return; }; done; echo "$BT/$1"; }
AAPT2="$(pick aapt2)"; D8="$(pick d8)"; ZIPALIGN="$(pick zipalign)"; APKSIGNER="$(pick apksigner)"
[ -e "$AAPT2" ] || { echo "找不到 build-tools 34.0.0：$BT"; exit 1; }
[ -e "$PLATFORM" ] || { echo "找不到 android.jar：$PLATFORM"; exit 1; }
[ -d "$SRC/assets/www" ] || { echo "先跑 python pack-www.py 组装 assets/www"; exit 1; }

rm -rf "$OUT"; mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex"

echo "[1/6] aapt2 compile（资源）"
"$AAPT2" compile --dir "$SRC/res" -o "$OUT/res.zip"

echo "[2/6] aapt2 link（打进 assets/www，约 130 MB，耐心等）"
"$AAPT2" link -o "$OUT/base.apk" -I "$PLATFORM" \
  --manifest "$SRC/AndroidManifest.xml" -A "$SRC/assets" \
  --java "$OUT/gen" --auto-add-overlay "$OUT/res.zip"

echo "[3/6] javac（--release 17，兼容 minSdk 29）"
javac -nowarn --release 17 -encoding UTF-8 -classpath "$PLATFORM" -d "$OUT/classes" \
  $(find "$OUT/gen" "$SRC/java" -name '*.java')

echo "[4/6] d8 -> classes.dex"
"$D8" --release --min-api 29 --lib "$PLATFORM" --output "$OUT/dex" \
  $(find "$OUT/classes" -name '*.class')

echo "[5/6] 装 dex + zipalign"
python - "$OUT/base.apk" "$OUT/dex/classes.dex" <<'PY'
import sys, zipfile
apk, dex = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(apk, 'a', zipfile.ZIP_DEFLATED) as z:
    z.write(dex, 'classes.dex')
PY
"$ZIPALIGN" -f 4 "$OUT/base.apk" "$OUT/aligned.apk"

echo "[6/6] 签名"
if [ ! -f "$KEYSTORE" ]; then
  keytool -genkeypair -keystore "$KEYSTORE" -alias transdesk -keyalg RSA -keysize 2048 \
    -validity 10000 -storepass "$KSPASS" -keypass "$KSPASS" \
    -dname "CN=TransDesk, OU=Local Build, O=TransDesk, C=CN" >/dev/null 2>&1
  echo "      已生成本地签名密钥 $KEYSTORE（口令 $KSPASS，自签名，仅用于侧载）"
fi
"$APKSIGNER" sign --ks "$KEYSTORE" --ks-key-alias transdesk \
  --ks-pass "pass:$KSPASS" --key-pass "pass:$KSPASS" \
  --out "$OUT/TransDesk.apk" "$OUT/aligned.apk"
"$APKSIGNER" verify --print-certs "$OUT/TransDesk.apk" | head -4

python - "$OUT/TransDesk.apk" <<'PY'
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
raw = sum(i.file_size for i in z.infolist()); comp = sum(i.compress_size for i in z.infolist())
print('\nAPK 条目 %d · 内容解压后 %.1f MB · 包体 %.1f MB' % (len(z.infolist()), raw/1048576, comp/1048576))
for i in sorted(z.infolist(), key=lambda x: -x.compress_size)[:8]:
    print('  %-58s %6.2f MB' % (i.filename, i.compress_size/1048576))
PY
echo; echo "APK -> $OUT/TransDesk.apk"
