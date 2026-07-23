#!/usr/bin/env bash

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	printf '%s\n' 'ERROR: verifier support is private; invoke verify.sh' >&2
	exit 64
fi

run_docs_contract_check() {
	local readme_path="$1"
	local driver_output="$2"

	python3 "$VERIFY_SUPPORT_DIR/docs_contract.py" check \
		"$readme_path" \
		"$CONTEXT_PATH" \
		"$TEMPLATE_PATH" \
		"$driver_output" \
		"$EXPECTED_UPSTREAM_SHA"
}

run_docs_mode() {
	local prototype_path="$SCRIPT_DIR/prototype.sh"
	local tracked_diff_before
	local tracked_diff_after
	local staged_diff_before
	local staged_diff_after
	local driver_stdout
	local driver_stderr
	local checker_stdout
	local checker_stderr
	local mutated_readme="$TMP_ROOT/README-mutated.md"
	local mutation_stdout="$TMP_ROOT/mutation.stdout"
	local mutation_stderr="$TMP_ROOT/mutation.stderr"
	local negative_stdout="$TMP_ROOT/negative.stdout"
	local negative_stderr="$TMP_ROOT/negative.stderr"
	local negative_status

	tracked_diff_before="$(git -C "$REPO_ROOT" diff --binary | shasum -a 256 | awk '{print $1}')"
	staged_diff_before="$(git -C "$REPO_ROOT" diff --cached --binary | shasum -a 256 | awk '{print $1}')"

	log "SCENARIO: README, live diagnostic, terminal driver, and domain contract consistency"
	log "COMMAND: MDPLACE_EVIDENCE_DIR=<evidence-dir> bash prototypes/captured-tab-note-web-clipper/verify.sh docs"
	log "MDPLACE_HEAD: $(git -C "$REPO_ROOT" rev-parse HEAD)"
	log "PINNED_UPSTREAM_SHA: $EXPECTED_UPSTREAM_SHA"
	log "README_SHA256: $(sha256_file "$README_PATH")"
	log "CONTEXT_SHA256: $(sha256_file "$CONTEXT_PATH")"
	log "TEMPLATE_SHA256: $(sha256_file "$TEMPLATE_PATH")"
	log "PROTOTYPE_SHA256: $(sha256_file "$prototype_path")"
	log "VERIFY_SHA256: $(sha256_file "$SCRIPT_DIR/verify.sh")"
	log "JSON_FACTS: $(jq -c '{name,path,behavior,noteNameFormat,properties,noteContentFormat}' "$TEMPLATE_PATH")"

	if jq empty "$TEMPLATE_PATH"; then
		pass "live diagnostic JSON parses"
	else
		fail "live diagnostic JSON parses"
	fi

	for iteration in 1 2; do
		driver_stdout="$TMP_ROOT/driver-${iteration}.stdout"
		driver_stderr="$TMP_ROOT/driver-${iteration}.stderr"
		checker_stdout="$TMP_ROOT/checker-${iteration}.stdout"
		checker_stderr="$TMP_ROOT/checker-${iteration}.stderr"
		log "ITERATION: $iteration"
		log "DRIVER_COMMAND: printf fshicpmbaeq | bash $prototype_path"
		if printf 'fshicpmbaeq' | bash "$prototype_path" > "$driver_stdout" 2> "$driver_stderr"; then
			pass "live ten-case driver exits successfully (iteration $iteration)"
		else
			fail "live ten-case driver exits successfully (iteration $iteration)"
		fi
		log "DRIVER_STDOUT_SHA256: $(sha256_file "$driver_stdout")"
		log "DRIVER_STDERR_BYTES: $(wc -c < "$driver_stderr" | tr -d ' ')"

		if run_docs_contract_check "$README_PATH" "$driver_stdout" > "$checker_stdout" 2> "$checker_stderr"; then
			pass "cross-artifact documentation contract passes (iteration $iteration)"
		else
			fail "cross-artifact documentation contract passes (iteration $iteration)"
		fi
		log "DOCS_CHECK_STDOUT_BEGIN"
		while IFS= read -r line || [[ -n "$line" ]]; do
			log "  $line"
		done < "$checker_stdout"
		log "DOCS_CHECK_STDOUT_END"
		if [[ -s "$checker_stderr" ]]; then
			log "DOCS_CHECK_STDERR_BEGIN"
			while IFS= read -r line || [[ -n "$line" ]]; do
				log "  $line"
			done < "$checker_stderr"
			log "DOCS_CHECK_STDERR_END"
		else
			log "DOCS_CHECK_STDERR: <empty>"
		fi
	done

	if python3 "$VERIFY_SUPPORT_DIR/docs_contract.py" mutate-readme \
		"$README_PATH" \
		"$mutated_readme" \
		> "$mutation_stdout" \
		2> "$mutation_stderr"
	then
		pass "temporary README mutation fixture created"
	else
		fail "temporary README mutation fixture created"
	fi
	log "MUTATION_STDOUT: $(tr '\n' ' ' < "$mutation_stdout")"
	if [[ -s "$mutation_stderr" ]]; then
		log "MUTATION_STDERR: $(tr '\n' ' ' < "$mutation_stderr")"
	else
		log "MUTATION_STDERR: <empty>"
	fi

	if run_docs_contract_check "$mutated_readme" "$driver_stdout" > "$negative_stdout" 2> "$negative_stderr"; then
		negative_status=0
		fail "mutated README with SUPPORTED conformance and wrong path is rejected"
	else
		negative_status=$?
		pass "mutated README with SUPPORTED conformance and wrong path is rejected"
	fi
	log "NEGATIVE_CHECK_EXIT_CODE: $negative_status"
	log "NEGATIVE_CHECK_STDOUT_BEGIN"
	while IFS= read -r line || [[ -n "$line" ]]; do
		log "  $line"
	done < "$negative_stdout"
	log "NEGATIVE_CHECK_STDOUT_END"
	if [[ -s "$negative_stderr" ]]; then
		log "NEGATIVE_CHECK_STDERR: $(tr '\n' ' ' < "$negative_stderr")"
	else
		log "NEGATIVE_CHECK_STDERR: <empty>"
	fi

	tracked_diff_after="$(git -C "$REPO_ROOT" diff --binary | shasum -a 256 | awk '{print $1}')"
	staged_diff_after="$(git -C "$REPO_ROOT" diff --cached --binary | shasum -a 256 | awk '{print $1}')"
	if [[ "$tracked_diff_before" == "$tracked_diff_after" ]]; then
		pass "docs verifier preserves the pre-existing tracked diff"
	else
		fail "docs verifier changed the tracked diff"
	fi
	if [[ "$staged_diff_before" == "$staged_diff_after" ]]; then
		pass "docs verifier preserves the pre-existing staged diff"
	else
		fail "docs verifier changed the staged diff"
	fi

	log "ADVERSARIAL_malformed_input: temporary README flips Captured Tab Note conformance to SUPPORTED and changes the diagnostic path; checker rejects it"
	log "ADVERSARIAL_stale_state: JSON structure and driver headings/outcomes are loaded from live files on each run"
	log "ADVERSARIAL_dirty_worktree: tracked and staged diff digests are compared before and after the verifier"
	log "ADVERSARIAL_flaky_tests: live driver and cross-artifact checker execute twice per docs-mode run"
	log "ADVERSARIAL_misleading_success_output: exact parsed matrix relationships are required; PASS text alone cannot satisfy the checker"
	log "ADVERSARIAL_prompt_injection: not applicable; documentation and local fixture metadata are repository-controlled inputs"
	log "ADVERSARIAL_hung_or_long_commands: not applicable; docs mode runs only bounded local parsing and the finite ten-key driver"
	log "ADVERSARIAL_cancel_resume: not applicable; docs mode has no resumable state and removes its temporary root on exit"
	log "ADVERSARIAL_repeated_interruptions: not applicable; trap cleanup removes the temporary mutation fixture"
	log "EXPECTED: live JSON/driver/README/CONTEXT agree, unsafe claims are absent, and mutated README exits nonzero without tracked edits"
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
