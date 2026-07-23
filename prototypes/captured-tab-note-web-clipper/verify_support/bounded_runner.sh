#!/usr/bin/env bash

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	printf '%s\n' 'ERROR: verifier support is private; invoke verify.sh' >&2
	exit 64
fi

bounded_runner_validate_test_handoff() {
	if [[ "${MDPLACE_VERIFY_INTERNAL_TEST:-0}" != "1" ]]; then
		return 0
	fi
	case "${MDPLACE_VERIFY_TEST_HANDOFF:-}" in
		"")
			return 0
			;;
		launch|wait)
			if [[ -z "${MDPLACE_VERIFY_TEST_CONTROL_FILE:-}" || -z "${MDPLACE_VERIFY_TEST_LATCH_FILE:-}" ]]; then
				printf '%s\n' 'ERROR: private runner handoff requires control and latch files' >&2
				return 64
			fi
			;;
		*)
			printf 'ERROR: invalid private runner handoff: %s\n' "$MDPLACE_VERIFY_TEST_HANDOFF" >&2
			return 64
			;;
	esac
}

bounded_runner_test_handoff() {
	local phase="$1"
	local active_supervisor_pid="$2"
	local deadline=$((SECONDS + 5))

	if [[ "${MDPLACE_VERIFY_INTERNAL_TEST:-0}" != "1" || "${MDPLACE_VERIFY_TEST_HANDOFF:-}" != "$phase" ]]; then
		return 0
	fi
	while [[ ! -s "$MDPLACE_VERIFY_TEST_CONTROL_FILE" ]]; do
		if ! kill -0 "$active_supervisor_pid" 2>/dev/null || (( SECONDS >= deadline )); then
			return 125
		fi
		sleep 0.005
	done
	printf '%s\n' "$phase" > "$MDPLACE_VERIFY_TEST_LATCH_FILE" || return 125
	if [[ "$phase" == "launch" ]]; then
		kill -STOP "$BASHPID"
	fi
}

bounded_runner_test_signal_observed() {
	if [[ "${MDPLACE_VERIFY_INTERNAL_TEST:-0}" == "1" \
		&& -n "${MDPLACE_VERIFY_TEST_HANDOFF:-}" \
		&& -n "${MDPLACE_VERIFY_TEST_LATCH_FILE:-}" ]]; then
		printf '%s\n' signal >> "$MDPLACE_VERIFY_TEST_LATCH_FILE"
	fi
}

run_bounded() {
	local timeout_seconds="$1"
	local stdout_path="$2"
	local stderr_path="$3"
	local supervisor_pid=""
	local supervisor_status=0
	local supervisor_wait_interrupted=false
	local test_validation_status=0
	shift 3

	bounded_runner_validate_test_handoff || test_validation_status=$?
	if [[ "$test_validation_status" -ne 0 ]]; then
		return "$test_validation_status"
	fi
	trap 'if [[ "$CANCELLATION_STATUS" -eq 0 ]]; then CANCELLATION_STATUS=130; fi; bounded_runner_test_signal_observed' INT
	trap 'if [[ "$CANCELLATION_STATUS" -eq 0 ]]; then CANCELLATION_STATUS=143; fi; bounded_runner_test_signal_observed' TERM
	python3 "$VERIFY_SUPPORT_DIR/bounded_runner.py" "$timeout_seconds" "$stdout_path" "$stderr_path" "$@" &
	supervisor_pid=$!
	if ! bounded_runner_test_handoff launch "$supervisor_pid"; then
		kill -TERM "$supervisor_pid" 2>/dev/null || true
		wait "$supervisor_pid" 2>/dev/null || true
		return 125
	fi
	trap 'supervisor_wait_interrupted=true; if [[ "$CANCELLATION_STATUS" -eq 0 ]]; then CANCELLATION_STATUS=130; kill -INT "$supervisor_pid" 2>/dev/null || true; fi; bounded_runner_test_signal_observed' INT
	trap 'supervisor_wait_interrupted=true; if [[ "$CANCELLATION_STATUS" -eq 0 ]]; then CANCELLATION_STATUS=143; kill -TERM "$supervisor_pid" 2>/dev/null || true; fi; bounded_runner_test_signal_observed' TERM
	if [[ "$CANCELLATION_STATUS" -eq 130 ]]; then
		kill -INT "$supervisor_pid" 2>/dev/null || true
	elif [[ "$CANCELLATION_STATUS" -eq 143 ]]; then
		kill -TERM "$supervisor_pid" 2>/dev/null || true
	fi
	if ! bounded_runner_test_handoff wait "$supervisor_pid"; then
		kill -TERM "$supervisor_pid" 2>/dev/null || true
		wait "$supervisor_pid" 2>/dev/null || true
		return 125
	fi
	while :; do
		supervisor_wait_interrupted=false
		if wait "$supervisor_pid"; then
			supervisor_status=0
		else
			supervisor_status=$?
		fi
		if [[ "$supervisor_wait_interrupted" == "false" ]]; then
			break
		fi
	done
	trap 'if [[ "$CANCELLATION_STATUS" -eq 0 ]]; then CANCELLATION_STATUS=130; fi; bounded_runner_test_signal_observed' INT
	trap 'if [[ "$CANCELLATION_STATUS" -eq 0 ]]; then CANCELLATION_STATUS=143; fi; bounded_runner_test_signal_observed' TERM
	supervisor_pid=""
	trap 'handle_cancellation 130' INT
	trap 'handle_cancellation 143' TERM
	if [[ "$CANCELLATION_STATUS" -ne 0 ]]; then
		exit "$CANCELLATION_STATUS"
	fi
	return "$supervisor_status"
}
