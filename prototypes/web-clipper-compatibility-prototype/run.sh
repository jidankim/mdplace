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

terminate() {
  local pid=$1
  if [[ -z "$pid" ]]; then return; fi
  kill "$pid" 2>/dev/null || true
  for _ in {1..30}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" 2>/dev/null || true
      return
    fi
    sleep 0.1
  done
  kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  trap - EXIT INT TERM
  terminate "$chrome_pid"
  terminate "$server_pid"
  rm -rf -- "$work_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for command in curl git node python3 shasum unzip; do
  command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 1; }
done
node -e '
  if(typeof fetch!=="function"||typeof WebSocket!=="function"||typeof AbortSignal.timeout!=="function")process.exit(1)
' || { echo 'Node.js must provide fetch, WebSocket, and AbortSignal.timeout' >&2; exit 1; }

if [[ $(uname -s) != Darwin || $(uname -m) != arm64 ]]; then
  echo "this throwaway runner currently supports macOS arm64 only" >&2
  exit 1
fi

extension_zip="$work_dir/obsidian-web-clipper-1.7.0-chrome.zip"
if [[ -n ${WEB_CLIPPER_ZIP:-} ]]; then
  cp -- "$WEB_CLIPPER_ZIP" "$extension_zip"
else
  curl -fL --connect-timeout 10 --max-time 120 --retry 2 \
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
  curl -fL --connect-timeout 10 --max-time 120 --retry 2 \
    https://storage.googleapis.com/chrome-for-testing-public/150.0.7871.124/mac-arm64/chrome-mac-arm64.zip \
    -o "$chrome_zip"
fi
printf '%s  %s\n' \
  36c8b5fe04c08a418a172206bb392600ec1550941bde6af2d4353df21db87a47 \
  "$chrome_zip" | shasum -a 256 -c -
unzip -q "$chrome_zip" -d "$work_dir/chrome"
chrome_bin="$work_dir/chrome/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
"$chrome_bin" --version | grep -F 'Google Chrome for Testing 150.0.7871.124' >/dev/null

extension_realpath=$(CDPATH='' cd -- "$work_dir/extension" && pwd -P)
extension_id=$(node -e '
  const {createHash}=require("node:crypto");
  const hex=createHash("sha256").update(process.argv[1]).digest("hex").slice(0,32);
  console.log(hex.replace(/[0-9a-f]/g,value=>String.fromCharCode(97+parseInt(value,16))));
' "$extension_realpath")
extension_origin="chrome-extension://${extension_id}/"

if [[ "$fixture_port" == "$debug_port" ]]; then
  echo "fixture and debug ports must differ" >&2
  exit 1
fi
python3 -c '
import socket, sys
for value in sys.argv[1:]:
    probe = socket.socket()
    try:
        probe.bind(("127.0.0.1", int(value)))
    except OSError as error:
        raise SystemExit(f"local port {value} is unavailable: {error}")
    finally:
        probe.close()
' "$fixture_port" "$debug_port"

python3 -m http.server "$fixture_port" --bind 127.0.0.1 \
  --directory "$prototype_dir/fixtures" >"$work_dir/server.log" 2>&1 &
server_pid=$!
for _ in {1..120}; do
  if curl -fsS "$fixture_base/semantic-article.html" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
curl -fsS "$fixture_base/semantic-article.html" >/dev/null
if ! kill -0 "$server_pid" 2>/dev/null; then
  echo "fixture server exited before readiness" >&2
  exit 1
fi

"$chrome_bin" \
  --disable-gpu \
  --no-first-run \
  --no-default-browser-check \
  --remote-debugging-address=127.0.0.1 \
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
if ! kill -0 "$chrome_pid" 2>/dev/null; then
  echo "Chrome exited before DevTools readiness" >&2
  exit 1
fi

extension_target_ready=false
for _ in {1..120}; do
  if curl -fsS "$debug_base/json/list" -o "$work_dir/targets.json" && \
    node -e '
      const {readFileSync}=require("node:fs");
      const targets=JSON.parse(readFileSync(process.argv[1],"utf8"));
      process.exit(targets.some(target=>target.url.startsWith(process.argv[2]))?0:1);
    ' "$work_dir/targets.json" "$extension_origin"
  then
    extension_target_ready=true
    break
  fi
  sleep 0.1
done
if [[ "$extension_target_ready" != true ]]; then
  echo "Web Clipper extension target did not become ready" >&2
  exit 1
fi

frontmost=$(/usr/bin/osascript \
  -e "tell application \"System Events\" to set frontmost of first process whose unix id is ${chrome_pid} to true" \
  -e "tell application \"System Events\" to get frontmost of first process whose unix id is ${chrome_pid}")
if [[ "$frontmost" != true ]]; then
  echo "Chrome did not become the frontmost macOS application" >&2
  exit 1
fi

env \
  CHROME_DEBUG_BASE="$debug_base" \
  FIXTURE_BASE="$fixture_base" \
  WEB_CLIPPER_EXTENSION_ID="$extension_id" \
  WITHHELD_TEMPLATE="$prototype_dir/mdplace-web-clipper-candidate-url-withheld.json" \
  RETAINED_TEMPLATE="$prototype_dir/mdplace-web-clipper-candidate-url-retained.json" \
  node "$prototype_dir/bootstrap.mjs"

fixture_suite_revision=${FIXTURE_SUITE_REVISION:-$(git -C "$prototype_dir" rev-parse HEAD)}
capture_contract_digest=$(shasum -a 256 "$prototype_dir/../../docs/captured-tab-note-intake-contract-v1.md")
capture_contract_sha256=${capture_contract_digest%% *}
matrix_output="$work_dir/matrix.json"
matrix_status=0
env \
  BROWSER_FAMILY='Chrome for Testing' \
  BROWSER_VERSION='150.0.7871.124' \
  CAPTURE_CONTRACT_SHA256="$capture_contract_sha256" \
  CHROME_ARCHIVE_SHA256='36c8b5fe04c08a418a172206bb392600ec1550941bde6af2d4353df21db87a47' \
  CHROME_DEBUG_BASE="$debug_base" \
  FIXTURE_BASE="$fixture_base" \
  FIXTURE_SUITE_REVISION="$fixture_suite_revision" \
  WEB_CLIPPER_ARCHIVE_SHA256='8861e7a77c3aaa27d5ac0b22b66a02aea4c03f67c56c700800d4c977c384de96' \
  WEB_CLIPPER_EXTENSION_ID="$extension_id" \
  node "$prototype_dir/matrix.mjs" >"$matrix_output" || matrix_status=$?
cat "$matrix_output"

if [[ -n ${EVIDENCE_OUTPUT:-} ]]; then
  mkdir -p -- "$(dirname -- "$EVIDENCE_OUTPUT")"
  evidence_temp=$(mktemp "${EVIDENCE_OUTPUT}.tmp.XXXXXX")
  cp -- "$matrix_output" "$evidence_temp"
  mv -- "$evidence_temp" "$EVIDENCE_OUTPUT"
fi

exit "$matrix_status"
