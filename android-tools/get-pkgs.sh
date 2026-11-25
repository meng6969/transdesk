set -u
cd "$(dirname "$0")"
log(){ echo "[$(date +%H:%M:%S)] $*"; }
curl -sSL -m 60 -o repo.xml 'https://dl.google.com/android/repository/repository2-3.xml'; log "repo.xml $(stat -c%s repo.xml)"
PT=$(grep -o 'platform-34[^<"]*\.zip' repo.xml | sort -u | tail -1)
BT=$(grep -o 'build-tools_r34[^<"]*-windows\.zip' repo.xml | sort -u | tail -1)
log "platform=$PT buildtools=$BT"
[ -z "$PT" ] && PT=$(grep -o 'platform-3[45][^<"]*\.zip' repo.xml | sort -u | tail -1) && log "fallback platform=$PT"
curl -sSL --retry 3 -m 1200 -o platform.zip "https://dl.google.com/android/repository/$PT" && log "platform.zip $(stat -c%s platform.zip)"
curl -sSL --retry 3 -m 1200 -o buildtools.zip "https://dl.google.com/android/repository/$BT" && log "buildtools.zip $(stat -c%s buildtools.zip)"
mkdir -p android-sdk/platforms android-sdk/build-tools
python -m zipfile -e platform.zip pt && python -m zipfile -e buildtools.zip bt && log extracted
PD=$(ls -d pt/*/ | head -1); BD=$(ls -d bt/*/ | head -1)
rm -rf android-sdk/platforms/android-34 android-sdk/build-tools/34.0.0
mv "$PD" android-sdk/platforms/android-34 && mv "$BD" android-sdk/build-tools/34.0.0 && log moved
ls android-sdk/platforms/android-34 | head -5; ls android-sdk/build-tools/34.0.0 | head -8
log PKGSDONE
