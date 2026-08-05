#!/usr/bin/env bash
set -euo pipefail

prototype_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
work_dir=$(mktemp -d "${TMPDIR:-/tmp}/mdplace-web-clipper-compat-XXXXXX")
fixture_port=${FIXTURE_PORT:-8766}
debug_port=${DEBUG_PORT:-9228}
fixture_base="http://127.0.0.1:${fixture_port}"
debug_base="http://127.0.0.1:${debug_port}"
server_pid=
chrome_pid=

cleanup() {
  if [[ -n "$chrome_pid" ]]; then
    kill "$chrome_pid" 2>/dev/null || true
    wait "$chrome_pid" 2>/dev/null || true
  fi
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf -- "$work_dir"
}
trap cleanup EXIT INT TERM

for command in curl node python3 shasum unzip; do
  command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 1; }
done

if [[ $(uname -s) != Darwin || $(uname -m) != arm64 ]]; then
  echo "this throwaway runner currently supports macOS arm64 only" >&2
  exit 1
fi

extension_zip="$work_dir/obsidian-web-clipper-1.7.0-chrome.zip"
if [[ -n ${WEB_CLIPPER_ZIP:-} ]]; then
  cp -- "$WEB_CLIPPER_ZIP" "$extension_zip"
else
  curl -fL \
    https://github.com/obsidianmd/obsidian-clipper/releases/download/1.7.0/obsidian-web-clipper-1.7.0-chrome.zip \
    -o "$extension_zip"
fi
printf '%s  %s\n' \
  8861e7a77c3aaa27d5ac0b22b66a02aea4c03f67c56c700800d4c977c384de96 \
  "$extension_zip" | shasum -a 256 -c -
unzip -q "$extension_zip" -d "$work_dir/extension"

chrome_zip="$work_dir/chrome-mac-arm64.zip"
if [[ -n ${CHROME_FOR_TESTING_ZIP:-} ]]; then
  cp -- "$CHROME_FOR_TESTING_ZIP" "$chrome_zip"
else
  curl -fL \
    https://storage.googleapis.com/chrome-for-testing-public/150.0.7871.124/mac-arm64/chrome-mac-arm64.zip \
    -o "$chrome_zip"
fi
unzip -q "$chrome_zip" -d "$work_dir/chrome"
chrome_bin="$work_dir/chrome/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
"$chrome_bin" --version | grep -F 'Google Chrome for Testing 150.0.7871.124' >/dev/null

python3 -m http.server "$fixture_port" --bind 127.0.0.1 \
  --directory "$prototype_dir/fixtures" >"$work_dir/server.log" 2>&1 &
server_pid=$!

"$chrome_bin" \
  --disable-gpu \
  --no-sandbox \
  --no-first-run \
  --no-default-browser-check \
  --remote-debugging-port="$debug_port" \
  --user-data-dir="$work_dir/profile" \
  --disable-extensions-except="$work_dir/extension" \
  --load-extension="$work_dir/extension" \
  "$fixture_base/semantic-article.html" >"$work_dir/chrome.log" 2>&1 &
chrome_pid=$!

for _ in {1..120}; do
  if curl -fsS "$debug_base/json/version" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
curl -fsS "$debug_base/json/version" >/dev/null

extension_realpath=$(CDPATH='' cd -- "$work_dir/extension" && pwd -P)
extension_id=$(node -e '
  const {createHash}=require("node:crypto");
  const hex=createHash("sha256").update(process.argv[1]).digest("hex").slice(0,32);
  console.log(hex.replace(/[0-9a-f]/g,value=>String.fromCharCode(97+parseInt(value,16))));
' "$extension_realpath")

env \
  CHROME_DEBUG_BASE="$debug_base" \
  FIXTURE_BASE="$fixture_base" \
  WEB_CLIPPER_EXTENSION_ID="$extension_id" \
  WITHHELD_TEMPLATE="$prototype_dir/mdplace-web-clipper-candidate-url-withheld.json" \
  RETAINED_TEMPLATE="$prototype_dir/mdplace-web-clipper-candidate-url-retained.json" \
  node "$prototype_dir/bootstrap.mjs"

env \
  CHROME_DEBUG_BASE="$debug_base" \
  FIXTURE_BASE="$fixture_base" \
  WEB_CLIPPER_EXTENSION_ID="$extension_id" \
  node "$prototype_dir/matrix.mjs"
