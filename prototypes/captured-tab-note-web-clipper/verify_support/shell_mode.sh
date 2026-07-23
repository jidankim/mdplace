#!/usr/bin/env bash

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	printf '%s\n' 'ERROR: verifier support is private; invoke verify.sh' >&2
	exit 64
fi

run_prototype_case() {
	local prototype_path="$1"
	local case_key="$2"
	local input="$3"
	local command_label="$4"
	local success_label="$5"
	local emit_sizes="$6"
	local stdout_path="$TMP_ROOT/${case_key}.stdout"
	local stderr_path="$TMP_ROOT/${case_key}.stderr"
	local status=0
	local prefix="${case_key^^}"

	log "$command_label"
	printf '%s' "$input" | bash "$prototype_path" > "$stdout_path" 2> "$stderr_path" || status=$?
	if [[ "$status" -eq 0 ]]; then
		pass "$success_label"
	else
		fail "$success_label (exit $status)"
	fi
	log "${prefix}_EXIT_CODE: $status"
	if [[ "$case_key" == "sequence" ]]; then log "SEQUENCE_STDOUT_SHA256: $(sha256_file "$stdout_path")"; fi
	if [[ "$emit_sizes" == "true" ]]; then
		log "${prefix}_STDOUT_BYTES: $(wc -c < "$stdout_path" | tr -d ' ')"
		log "${prefix}_STDERR_BYTES: $(wc -c < "$stderr_path" | tr -d ' ')"
	fi
}

verify_prototype_capture() {
	python3 -c "
import re, subprocess, sys
from pathlib import Path

mode, target, maximum, headings_raw, outcomes_raw, stdout_path, stderr_path = sys.argv[1:]
limit = int(maximum)

def require(condition, message):
    if not condition:
        raise SystemExit(message)

if mode == 'eof':
    try:
        completed = subprocess.run(['bash', target], input=b'', timeout=2, capture_output=True)
    except subprocess.TimeoutExpired as exc:
        Path(stdout_path).write_bytes((exc.output or b'')[:limit])
        Path(stderr_path).write_bytes((exc.stderr or b'')[:limit])
        raise SystemExit('EOF did not terminate within two seconds')
    Path(stdout_path).write_bytes(completed.stdout[:limit])
    Path(stderr_path).write_bytes(completed.stderr[:limit])
    require(completed.returncode == 0, f'EOF exited {completed.returncode}, expected 0')
    require(len(completed.stdout) < limit, f'EOF output was {len(completed.stdout)} bytes, expected < {limit}')
    require(not completed.stderr, 'EOF emitted stderr')
else:
    raw = Path(target).read_bytes()
    text = re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', raw.decode('utf-8', 'replace'))
    bound_error = f'output is not bounded: {len(raw)} bytes' if mode == 'sequence' else {
        'unknown': 'unknown-key output is not bounded',
        'repeated': 'repeated-key output is not bounded',
        'blanks': 'blank-line output is not bounded',
    }[mode]
    require(len(raw) < limit, bound_error)
    if mode == 'sequence':
        expected_headings = headings_raw.split('|')
        expected_outcomes = outcomes_raw.split('|')
        headings = re.findall(r'^Case: (.+)$', text, re.MULTILINE)
        outcomes = re.findall(r'^Outcome: (.+)$', text, re.MULTILINE)
        require(headings == expected_headings, f'headings differ: {headings!r}')
        require(outcomes == expected_outcomes, f'outcomes differ: {outcomes!r}')
        require(all(text.count(f'Case: {heading}') == 1 for heading in expected_headings), 'one or more case headings are not emitted exactly once')
        require(len(outcomes) == len(expected_outcomes), 'outcome lines are not emitted once per case')
        forbidden = next((value for value in ('Inbox/', 'Captured note', 'Captured artifact', 'source_url:', 'mdplace:article:start', 'mdplace:selection:start', 'mdplace:highlights:start') if value in text), None)
        require(forbidden is None, f'fictional or canonical note output found: {forbidden!r}')
    elif mode == 'unknown':
        require('Case: ' not in text and 'Outcome: ' not in text, 'unknown key emitted a capability case')
        require(text.count('[f] filename') == 2, 'unknown key did not leave the menu bounded and redisplayed once')
    elif mode == 'repeated':
        require(text.count('Case: filename') == 2 and text.count('Outcome: SUPPORTED') == 2, 'repeated filename key did not render exactly twice')
    elif mode == 'blanks':
        require('Case: ' not in text and 'Outcome: ' not in text, 'blank lines emitted a capability case')
" "$@"
}

assert_prototype_capture() {
	local label="$1"; shift
	if verify_prototype_capture "$@"; then pass "$label"; else fail "$label"; fi
}

run_shell_mode() {
	local prototype_path="$SCRIPT_DIR/prototype.sh"
	local expected_sequence='filename|YAML/frontmatter safety|selection provenance|metadata-only extraction artifact|template/content compiler|URL persistence policy|missing word count|deterministic hash shape|import/activation mechanics|Captured Tab Note conformance'
	local expected_outcomes='SUPPORTED|UNSUPPORTED|UNSUPPORTED|UNSUPPORTED|SUPPORTED|UNSUPPORTED|UNSUPPORTED|TARGET CONTRACT|SUPPORTED|UNSUPPORTED'
	local timeout_stdout="$TMP_ROOT/timeout.stdout" timeout_stderr="$TMP_ROOT/timeout.stderr" timeout_pid_file="$TMP_ROOT/timeout-pids.txt"
	local exiting_stdout="$TMP_ROOT/exiting-seam.stdout" exiting_stderr="$TMP_ROOT/exiting-seam.stderr"
	local cwd_root="$TMP_ROOT/prototype-cwd" cwd_before="$TMP_ROOT/cwd-before.txt" cwd_after="$TMP_ROOT/cwd-after.txt"
	local tracked_diff_before tracked_diff_after staged_diff_before staged_diff_after
	local timeout_status=0 exiting_status=0 timeout_started_at timeout_elapsed_seconds
	local timeout_direct_pid timeout_descendant_pid timeout_direct_live timeout_descendant_live
	local max_output_bytes=131072 support_relative_path
	local -a syntax_paths=("$prototype_path" "$SCRIPT_DIR/verify.sh")

	if [[ ! -f "$prototype_path" ]]; then
		fail "prototype script exists"
		return 1
	fi

	tracked_diff_before="$(git -C "$REPO_ROOT" diff --binary | shasum -a 256 | awk '{print $1}')"
	staged_diff_before="$(git -C "$REPO_ROOT" diff --cached --binary | shasum -a 256 | awk '{print $1}')"

	log "SCENARIO: terminal prototype capability report and EOF behavior"
	log "COMMAND: MDPLACE_EVIDENCE_DIR=<evidence-dir> bash prototypes/captured-tab-note-web-clipper/verify.sh shell"
	log "MDPLACE_HEAD: $(git -C "$REPO_ROOT" rev-parse HEAD)"
	log "BASH_VERSION: $BASH_VERSION"
	log "PYTHON_VERSION: $(python3 --version 2>&1)"
	log "PROTOTYPE_SHA256: $(sha256_file "$prototype_path")"
	log "MAX_OUTPUT_BYTES: $max_output_bytes"

	for support_relative_path in "${VERIFY_SUPPORT_RELATIVE_PATHS[@]}"; do
		case "$support_relative_path" in *.sh) syntax_paths+=("$SCRIPT_DIR/$support_relative_path") ;; esac
	done
	if bash -n "${syntax_paths[@]}"; then
		pass "both shell scripts pass bash -n"
	else
		fail "both shell scripts pass bash -n"
	fi

	log "TIMEOUT_COMMAND: run_bounded 1 <stdout> <stderr> bash -c <TERM-ignoring direct-and-descendant fixture>"
	timeout_started_at=$SECONDS
	# shellcheck disable=SC2016 # Fixture variables expand only inside the child Bash process.
	run_bounded 1 "$timeout_stdout" "$timeout_stderr" bash -c '
		trap "" TERM
		(trap "" TERM; while :; do sleep 1; done) &
		descendant_pid=$!
		printf "%s\n%s\n" "$$" "$descendant_pid" > "$1"
		wait "$descendant_pid"
	' _ "$timeout_pid_file" || timeout_status=$?
	timeout_elapsed_seconds=$((SECONDS - timeout_started_at))
	timeout_direct_pid="$(sed -n '1p' "$timeout_pid_file" 2>/dev/null || true)"
	timeout_descendant_pid="$(sed -n '2p' "$timeout_pid_file" 2>/dev/null || true)"
	timeout_direct_live=false
	timeout_descendant_live=false
	for _ in {1..20}; do
		timeout_direct_live=false
		timeout_descendant_live=false
		if [[ "$timeout_direct_pid" =~ ^[0-9]+$ ]] && kill -0 "$timeout_direct_pid" 2>/dev/null; then
			timeout_direct_live=true
		fi
		if [[ "$timeout_descendant_pid" =~ ^[0-9]+$ ]] && kill -0 "$timeout_descendant_pid" 2>/dev/null; then
			timeout_descendant_live=true
		fi
		if [[ "$timeout_direct_live" == "false" && "$timeout_descendant_live" == "false" ]]; then
			break
		fi
		sleep 0.05
	done
	log "TIMEOUT_EXIT_CODE: $timeout_status"
	log "TIMEOUT_ELAPSED_SECONDS: $timeout_elapsed_seconds"
	log "TIMEOUT_DIRECT_PID: ${timeout_direct_pid:-missing}"
	log "TIMEOUT_DESCENDANT_PID: ${timeout_descendant_pid:-missing}"
	log "TIMEOUT_DIRECT_LIVE_AFTER_RETURN: $timeout_direct_live"
	log "TIMEOUT_DESCENDANT_LIVE_AFTER_RETURN: $timeout_descendant_live"
	if [[ "$timeout_status" -eq 124 \
		&& "$timeout_elapsed_seconds" -le 3 \
		&& "$timeout_direct_pid" =~ ^[0-9]+$ \
		&& "$timeout_descendant_pid" =~ ^[0-9]+$ \
		&& "$timeout_direct_live" == "false" \
		&& "$timeout_descendant_live" == "false" ]]; then
		log "RUN_BOUNDED_REGRESSION: PASS"
	else
		fail "run_bounded returns 124 within three seconds and leaves no direct or descendant process"
		if [[ "$timeout_direct_pid" =~ ^[0-9]+$ ]]; then
			kill -KILL -- "-$timeout_direct_pid" 2>/dev/null || true
		fi
	fi

	log "FINAL_TWO_SEAM_COMMAND: explicit private dispatch-pretransition and exiting-posttransition latches; signal exited-leader/TERM-ignoring-descendant group"
	python3 "$VERIFY_SUPPORT_DIR/bounded_runner_qa.py" "$VERIFY_SUPPORT_DIR/bounded_runner.py" > "$exiting_stdout" 2> "$exiting_stderr" || exiting_status=$?
	log "FINAL_TWO_SEAM_EXIT_CODE: $exiting_status"
	log "FINAL_TWO_SEAM_STDOUT_BEGIN"
	while IFS= read -r line || [[ -n "$line" ]]; do
		log "  $line"
	done < "$exiting_stdout"
	log "FINAL_TWO_SEAM_STDOUT_END"
	if [[ -s "$exiting_stderr" ]]; then
		log "FINAL_TWO_SEAM_STDERR: $(tr '\n' ' ' < "$exiting_stderr")"
	else
		log "FINAL_TWO_SEAM_STDERR: <empty>"
	fi
	if [[ "$exiting_status" -eq 0 && ! -s "$exiting_stderr" ]]; then
		pass "first INT/TERM before and during EXITING returns exact status only after immediate descendant and PGID absence"
	else
		fail "first INT/TERM before and during EXITING returns exact status only after immediate descendant and PGID absence"
	fi

	run_prototype_case "$prototype_path" q q "Q_COMMAND: printf q | bash $prototype_path" "q-only input exits successfully" true
	run_prototype_case "$prototype_path" sequence fshicpmbaeq "SEQUENCE_COMMAND: printf fshicpmbaeq | bash $prototype_path" "complete ten-case key sequence exits successfully" true
	assert_prototype_capture "ten exact capability headings and outcomes appear once with no fictional note output" sequence "$TMP_ROOT/sequence.stdout" "$max_output_bytes" "$expected_sequence" "$expected_outcomes" "" ""
	if [[ ! -s "$TMP_ROOT/sequence.stderr" && ! -s "$TMP_ROOT/q.stderr" ]]; then
		pass "complete and q-only runs emit no stderr"
	else
		fail "complete and q-only runs emit no stderr"
	fi

	run_prototype_case "$prototype_path" unknown xq "UNKNOWN_COMMAND: printf xq | bash $prototype_path" "unknown key followed by q exits successfully" false
	assert_prototype_capture "unknown key is ignored without a false capability case" unknown "$TMP_ROOT/unknown.stdout" "$max_output_bytes" "" "" "" ""
	run_prototype_case "$prototype_path" repeated ffq "REPEATED_COMMAND: printf ffq | bash $prototype_path" "repeated key input exits successfully" false
	assert_prototype_capture "repeated key renders exactly its repeated case and remains bounded" repeated "$TMP_ROOT/repeated.stdout" "$max_output_bytes" "" "" "" ""
	run_prototype_case "$prototype_path" blanks $'\n\nq' "BLANKS_COMMAND: printf '\\n\\nq' | bash $prototype_path" "blank-line input exits successfully" false
	assert_prototype_capture "blank lines are ignored without a false capability case" blanks "$TMP_ROOT/blanks.stdout" "$max_output_bytes" "" "" "" ""

	log "EOF_COMMAND: python3 subprocess.run(['bash', prototype], input=b'', timeout=2, capture_output=True)"
	assert_prototype_capture "closed stdin exits 0 within two seconds and emits less than 128 KiB" eof "$prototype_path" "$max_output_bytes" "" "" "$TMP_ROOT/eof.stdout" "$TMP_ROOT/eof.stderr"
	log "EOF_STDOUT_BYTES: $(wc -c < "$TMP_ROOT/eof.stdout" | tr -d ' ')"
	log "EOF_STDERR_BYTES: $(wc -c < "$TMP_ROOT/eof.stderr" | tr -d ' ')"
	if [[ ! -s "$TMP_ROOT/unknown.stderr" && ! -s "$TMP_ROOT/repeated.stderr" && ! -s "$TMP_ROOT/blanks.stderr" && ! -s "$TMP_ROOT/eof.stderr" ]]; then
		pass "unknown, repeated, blank-line, and EOF runs emit no stderr"
	else
		fail "unknown, repeated, blank-line, and EOF runs emit no stderr"
	fi

	log "NO_WRITE_COMMAND: (cd <mktemp-empty-cwd> && printf q | bash $prototype_path); compare find snapshots"
	mkdir -p -- "$cwd_root"
	find "$cwd_root" -mindepth 1 -print | sort > "$cwd_before"
	if (cd -- "$cwd_root" && printf 'q' | bash "$prototype_path" > "$TMP_ROOT/cwd.stdout" 2> "$TMP_ROOT/cwd.stderr"); then
		pass "prototype exits successfully from an empty working directory"
	else
		fail "prototype exits successfully from an empty working directory"
	fi
	find "$cwd_root" -mindepth 1 -print | sort > "$cwd_after"
	if cmp -s "$cwd_before" "$cwd_after"; then
		pass "prototype performs no filesystem write"
	else
		fail "prototype performs no filesystem write"
	fi

	tracked_diff_after="$(git -C "$REPO_ROOT" diff --binary | shasum -a 256 | awk '{print $1}')"
	staged_diff_after="$(git -C "$REPO_ROOT" diff --cached --binary | shasum -a 256 | awk '{print $1}')"
	if [[ "$tracked_diff_before" == "$tracked_diff_after" ]]; then
		pass "shell verifier preserves the pre-existing tracked diff"
	else
		fail "shell verifier changed the tracked diff"
	fi
	if [[ "$staged_diff_before" == "$staged_diff_after" ]]; then
		pass "shell verifier preserves the pre-existing staged diff"
	else
		fail "shell verifier changed the staged diff"
	fi

	log "ADVERSARIAL_malformed_input: unknown, blank, repeated, and mixed keys asserted"
	log "ADVERSARIAL_stale_state: live prototype headings/outcomes parsed from current output"
	log "ADVERSARIAL_dirty_worktree: tracked and staged diff digests compared before/after"
	log "ADVERSARIAL_hung_or_long_commands: run_bounded kills a TERM-ignoring command group within three seconds; EOF is bounded at two seconds and 128 KiB"
	log "ADVERSARIAL_flaky_tests: timeout, complete, repeated, blank, unknown, q, and EOF runs executed"
	log "ADVERSARIAL_misleading_success_output: exact content assertions reject false PASS text and note artifacts"
	log "ADVERSARIAL_prompt_injection: not applicable; menu input is one-byte local key data"
	log "ADVERSARIAL_cancel_resume: not applicable; prototype has no resumable state"
	log "ADVERSARIAL_repeated_interruptions: bounded runner handles signals and reaps its direct child after terminating the child process group"
	log "EXPECTED: process-group timeout cleanup, ten exact headings/outcomes, clean EOF, bounded output, no stderr, and no filesystem write"
	log "ACTUAL: passes=$PASSES failures=$FAILURES"

	if [[ "$FAILURES" -eq 0 ]]; then
		log "EXIT_CODE: 0"
		log "VERDICT: PASS"
		return 0
	fi
	log "EXIT_CODE: 1"
	log "VERDICT: FAIL"
	return 1
}
