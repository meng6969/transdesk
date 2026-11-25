set -u
cd "$(dirname "$0")/.."
log(){ echo "[$(date +%H:%M:%S)] $*"; }
tail -3 android-tools/get-jdk17.log 2>/dev/null
if [ -x android-tools/jdk17/bin/java.exe ]; then
  export JAVA_HOME="$(cygpath -w "$PWD/android-tools/jdk17")"
  export PATH="$PWD/android-tools/jdk17/bin:$PATH"
  log "using JDK17: $(java -version 2>&1 | head -1)"
else
  log "JDK17 未就绪，沿用系统 java: $(java -version 2>&1 | head -1)"
fi
log "pack assets"; PYTHONIOENCODING=utf-8 python -Xutf8 android/pack-www.py || { log PACKFAIL; exit 1; }
log "build apk"; bash android/build-apk.sh 2>&1 | tail -25
log "artifact:"; ls -l android/build/TransDesk.apk 2>/dev/null || echo "APK MISSING"
log REBUILDDONE
