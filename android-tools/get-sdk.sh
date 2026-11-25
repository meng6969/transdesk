set -u
cd "$(dirname "$0")"
log(){ echo "[$(date +%H:%M:%S)] $*"; }
ZIP=""
for u in https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip \
         https://dl.google.com/android/repository/commandlinetools-win-13114758_latest.zip \
         https://dl.google.com/android/repository/commandlinetools-win-9477386_latest.zip; do
  code=$(curl -sS -m 30 -o /dev/null -w '%{http_code}' -I "$u")
  log "probe $u -> $code"
  if [ "$code" = "200" ]; then ZIP="$u"; break; fi
done
[ -z "$ZIP" ] && { log "NO_CMDLINE_TOOLS_URL"; exit 1; }
curl -sSL --retry 3 -m 1200 -o cmdtools.zip "$ZIP" && log "cmdtools.zip $(stat -c%s cmdtools.zip)"
python -m zipfile -e cmdtools.zip sdk-tmp && log extracted
mkdir -p android-sdk/cmdline-tools && rm -rf android-sdk/cmdline-tools/latest && mv sdk-tmp/cmdline-tools android-sdk/cmdline-tools/latest && log "cmdline-tools/latest ready"
export JAVA_HOME="$(cygpath -w "$(cd /c/Program\ Files/Java && ls -d jdk-* | head -1 | sed 's|^|/c/Program Files/Java/|')" 2>/dev/null)"
log "JAVA_HOME=$JAVA_HOME"
SDKROOT="$(cygpath -w "$PWD/android-sdk")"
SM="android-sdk/cmdline-tools/latest/bin/sdkmanager.bat"
yes | "$SM" --sdk_root="$SDKROOT" --licenses > licenses.log 2>&1; log "licenses rc=$?"
"$SM" --sdk_root="$SDKROOT" "platforms;android-34" "build-tools;34.0.0" > install.log 2>&1; log "install rc=$?"
tail -5 install.log
ls android-sdk/platforms android-sdk/build-tools 2>/dev/null
log SDKDONE
