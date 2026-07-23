#!/usr/bin/env bash

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	printf '%s\n' 'ERROR: verifier support is private; invoke verify.sh' >&2
	exit 64
fi

EVIDENCE_FILE=""
TMP_ROOT=""
TEMP_VITEST_RELATIVE="src/utils/mdplace-template-compiler.verify.test.ts"
TEMP_VITEST_PATH=""
TEMP_VITEST_OWNED=false
CANCELLATION_STATUS=0
CLEANUP_ACTIVE=false
FAILURES=0
PASSES=0

log() {
	printf '%s\n' "$*"
	if [[ -n "$EVIDENCE_FILE" ]]; then
		printf '%s\n' "$*" >> "$EVIDENCE_FILE"
	fi
}

pass() {
	PASSES=$((PASSES + 1))
	log "PASS: $1"
}

fail() {
	FAILURES=$((FAILURES + 1))
	log "FAIL: $1"
}

# shellcheck disable=SC2329 # Invoked indirectly by trap.
cleanup() {
	local original_status="$1"
	local cleanup_failure_status=0
	local cleanup_failed=false
	local remove_status=0
	CLEANUP_ACTIVE=true
	if [[ "$CANCELLATION_STATUS" -ne 0 ]]; then
		trap '' INT TERM
	fi
	if [[ "$TEMP_VITEST_OWNED" == "true" && -n "$TEMP_VITEST_PATH" ]]; then
		rm -f -- "$TEMP_VITEST_PATH" 2>/dev/null || remove_status=$?
		if [[ "$remove_status" -ne 0 ]]; then
			cleanup_failure_status="$remove_status"
		fi
		if [[ "$remove_status" -ne 0 && "$CANCELLATION_STATUS" -ne 0 ]]; then
			remove_status=0
			rm -f -- "$TEMP_VITEST_PATH" 2>/dev/null || remove_status=$?
		fi
		if [[ "$remove_status" -eq 0 ]]; then
			TEMP_VITEST_OWNED=false
		else
			cleanup_failed=true
		fi
	fi
	remove_status=0
	if [[ -n "$TMP_ROOT" && -d "$TMP_ROOT" ]]; then
		rm -rf -- "$TMP_ROOT" 2>/dev/null || remove_status=$?
		if [[ "$remove_status" -ne 0 && "$cleanup_failure_status" -eq 0 ]]; then
			cleanup_failure_status="$remove_status"
		fi
		if [[ "$remove_status" -ne 0 && "$CANCELLATION_STATUS" -ne 0 ]]; then
			remove_status=0
			rm -rf -- "$TMP_ROOT" 2>/dev/null || remove_status=$?
		fi
		if [[ "$remove_status" -ne 0 ]]; then
			cleanup_failed=true
		fi
	fi
	if [[ "$cleanup_failed" == "true" ]]; then
		printf '%s\n' 'ERROR: verifier cleanup failed; owned resources may remain' >&2
	fi
	trap - EXIT
	exit "$((CANCELLATION_STATUS != 0 ? CANCELLATION_STATUS : original_status != 0 ? original_status : cleanup_failure_status))"
}

# shellcheck disable=SC2329 # Invoked indirectly by trap.
handle_cancellation() {
	if [[ "$CANCELLATION_STATUS" -eq 0 ]]; then
		CANCELLATION_STATUS="$1"
	fi
	if [[ "$CLEANUP_ACTIVE" == "true" ]]; then
		trap '' INT TERM
		return
	fi
	exit "$CANCELLATION_STATUS"
}

install_common_traps() {
	trap 'cleanup $?' EXIT
	trap 'handle_cancellation 130' INT
	trap 'handle_cancellation 143' TERM
}

acquire_temp_vitest_path() {
	local acquisition_status=0
	trap 'if [[ "$CANCELLATION_STATUS" -eq 0 ]]; then CANCELLATION_STATUS=130; fi' INT
	trap 'if [[ "$CANCELLATION_STATUS" -eq 0 ]]; then CANCELLATION_STATUS=143; fi' TERM
	set -o noclobber
	: > "$TEMP_VITEST_PATH" 2>/dev/null || acquisition_status=$?
	if [[ "$acquisition_status" -eq 0 ]]; then
		TEMP_VITEST_OWNED=true
	fi
	set +o noclobber
	trap 'handle_cancellation 130' INT
	trap 'handle_cancellation 143' TERM
	if [[ "$CANCELLATION_STATUS" -ne 0 ]]; then
		exit "$CANCELLATION_STATUS"
	fi
	return "$acquisition_status"
}

sha256_file() {
	shasum -a 256 "$1" | awk '{print $1}'
}

emit_redacted_file() {
	local label="$1"
	local input_path="$2"
	local credential_marker="$3"
	local query_marker="$4"
	local fragment_marker="$5"

	log "${label}_BEGIN"
	while IFS= read -r line || [[ -n "$line" ]]; do
		log "  $line"
	done < <(
		sed -E \
			-e 's#https://[^"[:space:]]+#[REDACTED_RAW_URL]#g' \
			-e "s/${credential_marker}/[REDACTED_CREDENTIAL_MARKER]/g" \
			-e "s/${query_marker}/[REDACTED_QUERY_MARKER]/g" \
			-e "s/${fragment_marker}/[REDACTED_FRAGMENT_MARKER]/g" \
			"$input_path"
	)
	log "${label}_END"
}

check_command() {
	local label="$1"
	shift
	if "$@" >/dev/null 2>&1; then
		pass "$label"
	else
		fail "$label"
	fi
}
