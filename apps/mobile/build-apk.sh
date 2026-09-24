#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$APP_DIR/../.." && pwd -P)"
cd "$APP_DIR"

npm ci

if [[ ! -d "$REPO_ROOT/platform/dist" ]]; then
  pnpm --dir "$REPO_ROOT/platform" install --frozen-lockfile
  pnpm --dir "$REPO_ROOT/platform" build:ui
fi

npm run prepare-web

if [[ -z "${JAVA_HOME:-}" ]]; then
  JAVA_BIN="$(command -v java || true)"
  if [[ -z "$JAVA_BIN" ]]; then
    echo 'Java was not found; install JDK 17 or newer and set JAVA_HOME.' >&2
    exit 1
  fi
  JAVA_HOME="$(dirname -- "$(dirname -- "$(readlink -f -- "$JAVA_BIN")")")"
fi
if [[ ! -x "$JAVA_HOME/bin/java" || ! -x "$JAVA_HOME/bin/javac" ]]; then
  echo "JAVA_HOME must point to a JDK: $JAVA_HOME" >&2
  exit 1
fi
export JAVA_HOME
export PATH="$JAVA_HOME/bin:$PATH"

ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-/opt/android-sdk}}"
export ANDROID_SDK_ROOT
export ANDROID_HOME="$ANDROID_SDK_ROOT"
BUILD_TOOLS_VERSION="${ITLES_ANDROID_BUILD_TOOLS_VERSION:-36.0.0}"
BUILD_TOOLS="$ANDROID_SDK_ROOT/build-tools/$BUILD_TOOLS_VERSION"
for tool in zipalign apksigner aapt; do
  if [[ ! -x "$BUILD_TOOLS/$tool" ]]; then
    echo "Missing $BUILD_TOOLS/$tool; install build-tools;$BUILD_TOOLS_VERSION in $ANDROID_SDK_ROOT." >&2
    exit 1
  fi
done
if [[ ! -d "$ANDROID_SDK_ROOT/platforms/android-36" ]]; then
  echo "Missing $ANDROID_SDK_ROOT/platforms/android-36; install platform android-36." >&2
  exit 1
fi

npx cap sync android
./android/gradlew --no-daemon --project-dir android :app:assembleRelease

UNSIGNED_APK="$APP_DIR/android/app/build/outputs/apk/release/app-release-unsigned.apk"
if [[ ! -f "$UNSIGNED_APK" ]]; then
  echo "Gradle did not produce $UNSIGNED_APK" >&2
  exit 1
fi

KEYSTORE="${ITLES_KEYSTORE:-/opt/itles-keystore/itles-release.jks}"
case "$KEYSTORE" in
  /*) ;;
  *) KEYSTORE="$PWD/$KEYSTORE" ;;
esac
KEYSTORE="$(python3 - "$KEYSTORE" <<'PY'
from pathlib import Path
import sys

print(Path(sys.argv[1]).resolve(strict=False))
PY
)"
case "$KEYSTORE" in
  "$REPO_ROOT"|"$REPO_ROOT"/*)
    echo 'ITLES_KEYSTORE must be outside the repository.' >&2
    exit 1
    ;;
esac
KEYSTORE_DIR="$(dirname -- "$KEYSTORE")"
mkdir -p "$KEYSTORE_DIR"
PASSWORD_FILE="${KEYSTORE}.password"
KEY_ALIAS='itles-release'

if [[ ! -f "$PASSWORD_FILE" ]]; then
  if [[ -e "$KEYSTORE" ]]; then
    echo "Keystore exists but its password file is missing: $PASSWORD_FILE" >&2
    exit 1
  fi
  python3 - "$PASSWORD_FILE" <<'PY'
import secrets
import sys

with open(sys.argv[1], 'x', encoding='ascii') as password_file:
    password_file.write(secrets.token_hex(32) + '\n')
PY
fi
chmod 600 "$PASSWORD_FILE"
python3 - "$PASSWORD_FILE" <<'PY'
import os
import sys

with open(sys.argv[1], 'r+b') as password_file:
    password_file.seek(0, os.SEEK_END)
    if password_file.tell() == 0:
        raise SystemExit('The keystore password file is empty.')
    password_file.seek(-1, os.SEEK_END)
    if password_file.read(1) != b'\n':
        password_file.seek(0, os.SEEK_END)
        password_file.write(b'\n')
PY

if [[ ! -f "$KEYSTORE" ]]; then
  "$JAVA_HOME/bin/keytool" -genkeypair \
    -keystore "$KEYSTORE" \
    -storetype PKCS12 \
    -alias "$KEY_ALIAS" \
    -keyalg RSA \
    -keysize 3072 \
    -validity 10000 \
    -dname 'CN=ITles Android Release' \
    -storepass:file "$PASSWORD_FILE" \
    -keypass:file "$PASSWORD_FILE"
fi

APK_BUILD_DIR="$APP_DIR/android/app/build/outputs/apk/release"
ALIGNED_APK="$APK_BUILD_DIR/itles-aligned.apk"
SIGNED_APK="$APK_BUILD_DIR/itles-signed.apk"
OUTPUT_DIR="$APP_DIR/dist"
OUTPUT_APK="$OUTPUT_DIR/itles-android.apk"
mkdir -p "$OUTPUT_DIR"
chmod 755 "$OUTPUT_DIR"

"$BUILD_TOOLS/zipalign" -f -p 4 "$UNSIGNED_APK" "$ALIGNED_APK"
"$BUILD_TOOLS/zipalign" -c -p 4 "$ALIGNED_APK"
"$BUILD_TOOLS/apksigner" sign \
  --ks "$KEYSTORE" \
  --ks-key-alias "$KEY_ALIAS" \
  --ks-pass "file:$PASSWORD_FILE" \
  --out "$SIGNED_APK" \
  "$ALIGNED_APK"
"$BUILD_TOOLS/apksigner" verify --verbose --print-certs "$SIGNED_APK"

mv -- "$SIGNED_APK" "$OUTPUT_APK"
chmod 644 "$OUTPUT_APK"
printf '\nAPK: %s\n' "$OUTPUT_APK"
printf 'SHA-256: '
sha256sum "$OUTPUT_APK"
printf 'Size: '
du -h "$OUTPUT_APK" | cut -f1
