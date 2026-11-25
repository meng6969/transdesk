set -u
cd "$(dirname "$0")"
log(){ echo "[$(date +%H:%M:%S)] $*"; }
BASE=https://mirrors.tuna.tsinghua.edu.cn/Adoptium/17/jdk/x64/windows/
F=$(curl -sSL -m 60 "$BASE" | grep -o 'OpenJDK17U-jdk_x64_windows_hotspot_[0-9._]*\.zip' | sort -u | tail -1)
log "file=$F"
[ -z "$F" ] && { log NOFILE; exit 1; }
curl -sSL --retry 3 -m 1800 -o jdk17.zip "$BASE$F" && log "jdk17.zip $(stat -c%s jdk17.zip)"
python -m zipfile -e jdk17.zip jdk17-tmp && log extracted
D=$(ls -d jdk17-tmp/jdk-17* | head -1)
rm -rf jdk17 && mv "$D" jdk17 && log "JAVA_HOME=$(cygpath -w "$PWD/jdk17")"
"$PWD/jdk17/bin/java.exe" -version 2>&1 | head -2
log JDKDONE
