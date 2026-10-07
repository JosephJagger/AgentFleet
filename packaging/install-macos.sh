#!/bin/sh
set -eu
AGENTFLEET_INSTALLER_PID=$$
export AGENTFLEET_INSTALLER_PID

MODE=onboard
SERVICE_ACTION=update
case "${1:-}" in
  --update-only) MODE=update; shift ;;
  --repair) MODE=update; SERVICE_ACTION=install; shift ;;
  --stage-only) MODE=stage; shift ;;
  --prepare-only) MODE=prepare; shift ;;
  --rollback) MODE=rollback; shift ;;
  --uninstall) MODE=uninstall; shift ;;
esac

: "${HOME:?installer: HOME is required}"
case "$HOME" in /*) ;; *) echo "installer: HOME must be absolute" >&2; exit 2 ;; esac
DATA_ROOT="$HOME/Library/Application Support/AgentFleet"
BIN_ROOT="$HOME/.local/share/agentfleet/bin"
USER_BIN="$HOME/.local/bin"
CURRENT_LINK="$USER_BIN/agentfleet"
PREVIOUS_LINK="$USER_BIN/agentfleet.previous"
RUNTIME_PROFILE="$DATA_ROOT/runtime-profile.json"

INSTALL_LOCK="$DATA_ROOT/.installer-lock"
INSTALL_LOCK_ACQUIRED=no
TEMP_DIR=""
cleanup_install() {
  if [ -n "$TEMP_DIR" ]; then rm -rf -- "$TEMP_DIR"; fi
  if [ "$INSTALL_LOCK_ACQUIRED" = yes ] && [ "$(cat "$INSTALL_LOCK/pid" 2>/dev/null)" = "$$" ]; then rm -f "$INSTALL_LOCK/pid"; rmdir "$INSTALL_LOCK" 2>/dev/null || true; fi
}
acquire_install_lock() {
  mkdir -p "$(dirname "$INSTALL_LOCK")"
  if ! mkdir "$INSTALL_LOCK" 2>/dev/null; then
    [ ! -L "$INSTALL_LOCK" ] && [ -f "$INSTALL_LOCK/pid" ] && [ ! -L "$INSTALL_LOCK/pid" ] || { echo "installer: install lock cannot be verified" >&2; exit 1; }
    LOCK_PID=$(cat "$INSTALL_LOCK/pid")
    case "$LOCK_PID" in ''|*[!0-9]*) echo "installer: invalid install lock" >&2; exit 1 ;; esac
    if kill -0 "$LOCK_PID" 2>/dev/null; then echo "installer: another installation is running (PID $LOCK_PID)" >&2; exit 1; fi
    # A recovery guard prevents two installers from deleting a newly acquired lock.
    if ! mkdir "$INSTALL_LOCK.recovery" 2>/dev/null; then echo "installer: lock recovery in progress" >&2; exit 1; fi
    if [ "$(cat "$INSTALL_LOCK/pid" 2>/dev/null)" != "$LOCK_PID" ]; then rmdir "$INSTALL_LOCK.recovery"; exit 1; fi
    rm -f "$INSTALL_LOCK/pid"
    rmdir "$INSTALL_LOCK" || { rmdir "$INSTALL_LOCK.recovery"; exit 1; }
    mkdir "$INSTALL_LOCK" || { rmdir "$INSTALL_LOCK.recovery"; exit 1; }
    printf '%s\n' "$$" > "$INSTALL_LOCK/pid"
    rmdir "$INSTALL_LOCK.recovery"
  else
    printf '%s\n' "$$" > "$INSTALL_LOCK/pid"
  fi
  INSTALL_LOCK_ACQUIRED=yes
}
trap cleanup_install EXIT HUP INT TERM
acquire_install_lock

atomic_link() {
  LINK_TEMP="$1.tmp-$$"
  [ ! -e "$LINK_TEMP" ] && [ ! -L "$LINK_TEMP" ] || { echo "installer: temporary link already exists" >&2; exit 1; }
  ln -s "$2" "$LINK_TEMP"
  mv -f "$LINK_TEMP" "$1"
}

if [ "$MODE" = rollback ]; then
  [ -L "$CURRENT_LINK" ] && [ -x "$CURRENT_LINK" ] || { echo "installer: no managed installation to roll back" >&2; exit 1; }
  "$CURRENT_LINK" service rollback --data-dir "$DATA_ROOT"
  exit $?
fi

if [ "$MODE" = uninstall ]; then
  PURGE=no
  for value in "$@"; do case "$value" in --purge) PURGE=yes ;; *) echo "installer: unknown uninstall option: $value" >&2; exit 2 ;; esac; done
  if [ -x "$CURRENT_LINK" ]; then "$CURRENT_LINK" service uninstall || true; fi
  rm -f -- "$CURRENT_LINK" "$PREVIOUS_LINK"
  rm -rf -- "$BIN_ROOT"
  if [ "$PURGE" = yes ]; then rm -rf -- "$DATA_ROOT"; fi
  echo "Removed AgentFleet. Codex history and project files were not changed."
  exit 0
fi

CONTROL_URL=""
EXPECT_URL=no
for value in "$@"; do
  if [ "$EXPECT_URL" = yes ]; then CONTROL_URL=$value; EXPECT_URL=no; continue; fi
  case "$value" in --url) EXPECT_URL=yes ;; --url=*) CONTROL_URL=${value#--url=} ;; esac
done
if [ "$EXPECT_URL" = yes ] || [ -z "$CONTROL_URL" ]; then echo "installer: --url is required" >&2; exit 2; fi
case "$CONTROL_URL" in *\?*|*\#*|*@*) echo "installer: --url must not contain credentials, query, or fragment" >&2; exit 2 ;; esac
case "$CONTROL_URL" in
  https://*) ;;
  http://localhost|http://localhost:*|http://localhost/*|http://127.0.0.1|http://127.0.0.1:*|http://127.0.0.1/*) ;;
  *) echo "installer: --url must use HTTPS" >&2; exit 2 ;;
esac
CONTROL_URL=${CONTROL_URL%/}
case "$(uname -m)" in arm64) PLATFORM=darwin-arm64; CODEX_NAME=codex-aarch64-apple-darwin ;; x86_64) PLATFORM=darwin-x64; CODEX_NAME=codex-x86_64-apple-darwin ;; *) echo "installer: unsupported macOS architecture" >&2; exit 1 ;; esac

TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/agentfleet-install.XXXXXX")
trap cleanup_install EXIT HUP INT TERM
mkdir -p "$DATA_ROOT"
chmod 700 "$DATA_ROOT"
[ ! -L "$DATA_ROOT" ] && [ ! -L "$RUNTIME_PROFILE" ] || { echo "installer: refusing a symlinked runtime profile" >&2; exit 1; }
PROFILE_EXISTED=no
CODEX_EXISTED=no
if [ -f "$RUNTIME_PROFILE" ] && [ ! -L "$RUNTIME_PROFILE" ]; then
  cp "$RUNTIME_PROFILE" "$TEMP_DIR/runtime-profile.previous"
  PROFILE_EXISTED=yes
  PROFILE_COMPACT=$(tr -d '\r\n' < "$RUNTIME_PROFILE")
  EXISTING_CODEX_EXECUTABLE=$(printf '%s' "$PROFILE_COMPACT" | sed -n 's/.*"codexExecutable":"\([^"\\]*\)".*/\1/p')
  EXISTING_CODEX_HOME=$(printf '%s' "$PROFILE_COMPACT" | sed -n 's/.*"codexHome":"\([^"\\]*\)".*/\1/p')
  EXISTING_CODEX_SOURCE=$(printf '%s' "$PROFILE_COMPACT" | sed -n 's/.*"source":"\(host\|managed\)".*/\1/p')
fi
if [ "$MODE" = onboard ] && [ -f "$DATA_ROOT/codex/codex" ] && [ ! -L "$DATA_ROOT/codex/codex" ]; then cp "$DATA_ROOT/codex/codex" "$TEMP_DIR/codex.previous"; CODEX_EXISTED=yes; fi
download() {
  DOWNLOAD_ATTEMPT=1
  while [ "$DOWNLOAD_ATTEMPT" -le 6 ]; do
    if curl -fLsS --http1.1 --proto '=https' --tlsv1.2 \
      --connect-timeout 20 --max-time 90 --continue-at - "$1" -o "$2"; then
      return 0
    fi
    DOWNLOAD_ATTEMPT=$((DOWNLOAD_ATTEMPT + 1))
    [ "$DOWNLOAD_ATTEMPT" -le 6 ] && sleep 2
  done
  # Exact manifest size and SHA-256 checks immediately follow artifact downloads.
  # A complete file can be present even when the peer reset during TLS shutdown.
  [ -s "$2" ]
}
field() { printf '%s' "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p"; }

MANIFEST="$TEMP_DIR/manifest.json"
download "$CONTROL_URL/downloads/manifest.json" "$MANIFEST"
COMPACT=$(tr -d '\r\n' < "$MANIFEST")
VERSION=$(field "$COMPACT" version)
BLOCK=$(printf '%s' "$COMPACT" | sed -n "s/.*\"$PLATFORM\":{\(\"file\":\"agentfleet-$PLATFORM-[^}]*\)}.*/\1/p")
FILE=$(field "$BLOCK" file); SHA256=$(field "$BLOCK" sha256)
SIZE=$(printf '%s' "$BLOCK" | sed -n 's/.*"size":\([0-9]*\).*/\1/p')
case "$FILE" in "agentfleet-$PLATFORM-$VERSION.tar.gz") ;; *) echo "installer: invalid macOS release manifest" >&2; exit 1 ;; esac
test "${#SHA256}" -eq 64 && test -n "$SIZE" || { echo "installer: invalid release digest" >&2; exit 1; }
ARTIFACT="$TEMP_DIR/$FILE"
CACHE_DIR="$DATA_ROOT/download-cache"
[ ! -L "$CACHE_DIR" ] || { echo "installer: unsafe download cache" >&2; exit 1; }
mkdir -p "$CACHE_DIR"
AVAILABLE_KB=$(df -Pk "$CACHE_DIR" | awk 'END { print $4 }')
REQUIRED_KB=$((SIZE / 1024 * 3 + 524288))
[ "$AVAILABLE_KB" -ge "$REQUIRED_KB" ] || { echo "installer: insufficient disk space; free at least $REQUIRED_KB KB before retrying" >&2; exit 1; }
CACHE_FILE="$CACHE_DIR/$FILE"
[ ! -L "$CACHE_FILE" ] || { echo "installer: unsafe cache file" >&2; exit 1; }
if [ -f "$CACHE_FILE" ] && { [ "$(wc -c < "$CACHE_FILE" | tr -d ' ')" != "$SIZE" ] || [ "$(shasum -a 256 "$CACHE_FILE" | awk '{print $1}')" != "$SHA256" ]; }; then
  rm -f "$CACHE_FILE"
fi
if [ -f "$CACHE_FILE" ]; then cp "$CACHE_FILE" "$ARTIFACT"; else download "$CONTROL_URL/downloads/$FILE" "$ARTIFACT"; fi
test "$(wc -c < "$ARTIFACT" | tr -d ' ')" = "$SIZE" || { echo "installer: release size mismatch" >&2; exit 1; }
test "$(shasum -a 256 "$ARTIFACT" | awk '{print $1}')" = "$SHA256" || { echo "installer: release SHA-256 mismatch" >&2; exit 1; }
cp "$ARTIFACT" "$CACHE_FILE.new-$$"
mv -f "$CACHE_FILE.new-$$" "$CACHE_FILE"
tar -tzf "$ARTIFACT" | awk '{ if ($0 !~ /^agentfleet\// || $0 ~ /(^|\/)\.\.?(\/|$)/) bad=1 } END { exit bad ? 1 : 0 }' || { echo "installer: unsafe release archive" >&2; exit 1; }
tar -tvzf "$ARTIFACT" | awk 'substr($1,1,1) != "-" && substr($1,1,1) != "d" { bad=1 } END { exit bad ? 1 : 0 }' || { echo "installer: release archive contains a link or special file" >&2; exit 1; }

if [ -n "${AGENTFLEET_EXPECTED_VERSION:-}" ] && [ "$VERSION" != "$AGENTFLEET_EXPECTED_VERSION" ]; then echo "installer: release channel changed; retry preparation" >&2; exit 1; fi
TARGET="$BIN_ROOT/$VERSION"
mkdir -p "$BIN_ROOT" "$USER_BIN"
if [ ! -d "$TARGET" ]; then
  STAGE="$BIN_ROOT/.staging-$VERSION-$$"
  mkdir "$STAGE"
  tar -xzf "$ARTIFACT" -C "$STAGE" --strip-components=1
  test "$("$STAGE/agentfleet" --version)" = "$VERSION" || { echo "installer: release version mismatch" >&2; exit 1; }
  mv "$STAGE" "$TARGET"
else
  [ ! -L "$TARGET" ] && [ -f "$TARGET/agentfleet" ] && [ ! -L "$TARGET/agentfleet" ] && [ -x "$TARGET/agentfleet" ] && [ "$("$TARGET/agentfleet" --version)" = "$VERSION" ] || { echo "installer: existing release directory is invalid" >&2; exit 1; }
fi
if [ "$MODE" = prepare ]; then echo "Prepared AgentFleet $VERSION; running service unchanged."; exit 0; fi
OLD_TARGET=""
if [ -L "$CURRENT_LINK" ]; then OLD_TARGET=$(readlink "$CURRENT_LINK"); fi
if [ "$MODE" = stage ] || [ "$MODE" = update ]; then
  [ "$PROFILE_EXISTED" = yes ] || { echo "installer: existing runtime profile is required for an update" >&2; exit 1; }
  "$TARGET/agentfleet" service prepare-update --data-dir "$DATA_ROOT"
  if [ -n "$OLD_TARGET" ] && [ "$OLD_TARGET" != "$TARGET/agentfleet" ]; then atomic_link "$PREVIOUS_LINK" "$OLD_TARGET"; fi
  atomic_link "$CURRENT_LINK" "$TARGET/agentfleet"
  "$TARGET/agentfleet" service mark-staged --data-dir "$DATA_ROOT"
  echo "Installed AgentFleet $VERSION. The existing Codex runtime was preserved; awaiting health confirmation."
  if [ "$MODE" = stage ]; then rm -f "$CACHE_FILE"; echo "Staged AgentFleet $VERSION; launchd will restart into it."; exit 0; fi
  if "$CURRENT_LINK" service "$SERVICE_ACTION" --executable "$CURRENT_LINK" --data-dir "$DATA_ROOT"; then
    "$TARGET/agentfleet" service verify-update --data-dir "$DATA_ROOT"
    echo "AgentFleet $VERSION is connected and healthy."
    exit 0
  fi
  echo "installer: service update failed; restoring the previous binary" >&2
  "$TARGET/agentfleet" service abort-update --data-dir "$DATA_ROOT" || true
  if [ -n "$OLD_TARGET" ]; then atomic_link "$CURRENT_LINK" "$OLD_TARGET"; "$TARGET/agentfleet" service update --executable "$CURRENT_LINK" --data-dir "$DATA_ROOT" || true; fi
  exit 1
fi
HOST_CODEX=${EXISTING_CODEX_EXECUTABLE:-}
HOST_CODEX_VERSION=""
if [ -n "$HOST_CODEX" ] && [ "${EXISTING_CODEX_SOURCE:-}" = managed ]; then
  HOST_CODEX_VERSION=$("$TARGET/runtime/node" "$TARGET/lib/dist/src/verify-managed-runtime.js" "$HOST_CODEX" "$DATA_ROOT/codex" || true)
fi
if [ -n "$HOST_CODEX_VERSION" ] && awk -v version="$HOST_CODEX_VERSION" 'BEGIN { split(version,v,"."); exit !((v[1]+0)>0 || (v[2]+0)>153 || ((v[2]+0)==153 && (v[3]+0)>=2)) }'; then
  AGENTFLEET_CODEX_EXECUTABLE=$HOST_CODEX
  CODEX_VERSION=$HOST_CODEX_VERSION
  CODEX_SOURCE=managed
  echo "Reusing verified AgentFleet Codex $CODEX_VERSION. Your own Codex and session data remain unchanged."
else
  CODEX_MANIFEST="$TEMP_DIR/codex-manifest.json"
  download "$CONTROL_URL/downloads/codex-manifest.json" "$CODEX_MANIFEST"
  CODEX_COMPACT=$(tr -d '\r\n' < "$CODEX_MANIFEST")
  CODEX_VERSION=$(field "$CODEX_COMPACT" version)
  CODEX_BLOCK=$(printf '%s' "$CODEX_COMPACT" | sed -n "s/.*\"$PLATFORM\":{\(\"file\":\"codex-$PLATFORM-[^}]*\)}.*/\1/p")
  CODEX_FILE=$(field "$CODEX_BLOCK" file); CODEX_SHA=$(field "$CODEX_BLOCK" sha256)
  CODEX_SIZE=$(printf '%s' "$CODEX_BLOCK" | sed -n 's/.*"size":\([0-9]*\).*/\1/p')
  case "$CODEX_FILE" in "codex-$PLATFORM-$CODEX_VERSION.tar.gz") ;; *) echo "installer: invalid Codex manifest" >&2; exit 1 ;; esac
  CODEX_ARCHIVE="$TEMP_DIR/$CODEX_FILE"
  download "$CONTROL_URL/downloads/$CODEX_FILE" "$CODEX_ARCHIVE"
  test "$(wc -c < "$CODEX_ARCHIVE" | tr -d ' ')" = "$CODEX_SIZE" || { echo "installer: Codex size mismatch" >&2; exit 1; }
  test "$(shasum -a 256 "$CODEX_ARCHIVE" | awk '{print $1}')" = "$CODEX_SHA" || { echo "installer: Codex SHA-256 mismatch" >&2; exit 1; }
  mkdir -p "$DATA_ROOT/codex" "$TEMP_DIR/codex"
  tar -xzf "$CODEX_ARCHIVE" -C "$TEMP_DIR/codex"
  test -f "$TEMP_DIR/codex/$CODEX_NAME" || { echo "installer: invalid Codex archive" >&2; exit 1; }
  cp "$TEMP_DIR/codex/$CODEX_NAME" "$DATA_ROOT/codex/codex.new"
  chmod 755 "$DATA_ROOT/codex/codex.new"
  mv -f "$DATA_ROOT/codex/codex.new" "$DATA_ROOT/codex/codex"
  AGENTFLEET_CODEX_EXECUTABLE="$DATA_ROOT/codex/codex"
  CODEX_SOURCE=managed
fi
export AGENTFLEET_CODEX_EXECUTABLE

escape_json() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
PROFILE_EXECUTABLE=$(escape_json "$AGENTFLEET_CODEX_EXECUTABLE")
PROFILE_HOME=$(escape_json "${EXISTING_CODEX_HOME:-${CODEX_HOME:-$HOME/.codex}}")
(umask 077; printf '{"schemaVersion":1,"codexExecutable":"%s","codexHome":"%s","source":"%s"}\n' \
  "$PROFILE_EXECUTABLE" "$PROFILE_HOME" "$CODEX_SOURCE" > "$RUNTIME_PROFILE.new")
mv -f "$RUNTIME_PROFILE.new" "$RUNTIME_PROFILE"

if [ -n "$OLD_TARGET" ] && [ "$OLD_TARGET" != "$TARGET/agentfleet" ]; then atomic_link "$PREVIOUS_LINK" "$OLD_TARGET"; fi
atomic_link "$CURRENT_LINK" "$TARGET/agentfleet"

echo "Installed AgentFleet $VERSION with Codex $CODEX_VERSION."
echo "Registering this Mac. Keep the Add Host dialog open until this command finishes."
exec "$CURRENT_LINK" onboard "$@" --data-dir "$DATA_ROOT" --executable "$CURRENT_LINK"
