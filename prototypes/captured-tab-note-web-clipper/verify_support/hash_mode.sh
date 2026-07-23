#!/usr/bin/env bash

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	printf '%s\n' 'ERROR: verifier support is private; invoke verify.sh' >&2
	exit 64
fi

run_hash_contract_check() {
	local readme_path="$1"
	local output_dir="$2"

	python3 "$VERIFY_SUPPORT_DIR/hash_contract.py" check "$readme_path" "$output_dir"
}

run_hash_mode() {
	local tracked_diff_before
	local tracked_diff_after
	local staged_diff_before
	local staged_diff_after
	local oracle_stdout
	local oracle_stderr
	local oracle_dir
	local metadata_digest
	local manifest_digest
	local malformed_readme="$TMP_ROOT/README-malformed.md"
	local forged_readme="$TMP_ROOT/README-forged-pass.md"
	local mutation_stdout="$TMP_ROOT/readme-mutations.stdout"
	local mutation_stderr="$TMP_ROOT/readme-mutations.stderr"
	local negative_stdout
	local negative_stderr
	local negative_readme
	local negative_status

	tracked_diff_before="$(git -C "$REPO_ROOT" diff --binary | shasum -a 256 | awk '{print $1}')"
	staged_diff_before="$(git -C "$REPO_ROOT" diff --cached --binary | shasum -a 256 | awk '{print $1}')"

	log "SCENARIO: future-adapter canonical stream, JCS, and fixed hash-vector contract"
	log "COMMAND: LC_ALL=${LC_ALL:-<unset>} MDPLACE_EVIDENCE_DIR=<evidence-dir> bash prototypes/captured-tab-note-web-clipper/verify.sh hash"
	log "MDPLACE_HEAD: $(git -C "$REPO_ROOT" rev-parse HEAD)"
	log "PINNED_UPSTREAM_SHA: $EXPECTED_UPSTREAM_SHA"
	log "BASH_VERSION: $BASH_VERSION"
	log "PYTHON_VERSION: $(python3 --version 2>&1)"
	log "SHASUM_VERSION: $(shasum --version 2>&1 | head -n 1)"
	log "LOCALE_ALL: ${LC_ALL:-<unset>}"
	log "LOCALE_CHARMAP: $(locale charmap 2>&1)"
	log "README_SHA256: $(sha256_file "$README_PATH")"
	log "VERIFY_SHA256: $(sha256_file "$SCRIPT_DIR/verify.sh")"
	log "EXPECTED_SOURCE_METADATA_HASH: sha256:13932d5ded70ed0a97dab4dc24043bbfc42b6dc95a60db846bdb153c5da02bb2"
	log "EXPECTED_CONTENT_HASH: sha256:90dd96398830cd225452be04490e7d3b241e8b8a947ca8c590f8803871e5246c"

	for iteration in 1 2; do
		oracle_dir="$TMP_ROOT/oracle-${iteration}"
		oracle_stdout="$TMP_ROOT/oracle-${iteration}.stdout"
		oracle_stderr="$TMP_ROOT/oracle-${iteration}.stderr"
		log "ITERATION: $iteration"
		if run_hash_contract_check "$README_PATH" "$oracle_dir" > "$oracle_stdout" 2> "$oracle_stderr"; then
			pass "README-coupled byte/JCS oracle passes (iteration $iteration)"
		else
			fail "README-coupled byte/JCS oracle passes (iteration $iteration)"
		fi
		log "ORACLE_STDOUT_BEGIN"
		while IFS= read -r line || [[ -n "$line" ]]; do
			log "  $line"
		done < "$oracle_stdout"
		log "ORACLE_STDOUT_END"
		if [[ -s "$oracle_stderr" ]]; then
			log "ORACLE_STDERR_BEGIN"
			while IFS= read -r line || [[ -n "$line" ]]; do
				log "  $line"
			done < "$oracle_stderr"
			log "ORACLE_STDERR_END"
		else
			log "ORACLE_STDERR: <empty>"
		fi

		if [[ -f "$oracle_dir/source-metadata.jcs" ]]; then
			metadata_digest="$(sha256_file "$oracle_dir/source-metadata.jcs")"
		else
			metadata_digest="<missing>"
		fi
		if [[ -f "$oracle_dir/stream-manifest.jcs" ]]; then
			manifest_digest="$(sha256_file "$oracle_dir/stream-manifest.jcs")"
		else
			manifest_digest="<missing>"
		fi
		log "SYSTEM_SOURCE_METADATA_HASH: sha256:$metadata_digest"
		log "SYSTEM_CONTENT_HASH: sha256:$manifest_digest"
		if [[ "$metadata_digest" == "13932d5ded70ed0a97dab4dc24043bbfc42b6dc95a60db846bdb153c5da02bb2" ]]; then
			pass "independent shasum metadata digest matches fixed vector (iteration $iteration)"
		else
			fail "independent shasum metadata digest matches fixed vector (iteration $iteration)"
		fi
		if [[ "$manifest_digest" == "90dd96398830cd225452be04490e7d3b241e8b8a947ca8c590f8803871e5246c" ]]; then
			pass "independent shasum manifest digest matches fixed vector (iteration $iteration)"
		else
			fail "independent shasum manifest digest matches fixed vector (iteration $iteration)"
		fi
	done

	if cmp -s "$TMP_ROOT/oracle-1/source-metadata.jcs" "$TMP_ROOT/oracle-2/source-metadata.jcs" \
		&& cmp -s "$TMP_ROOT/oracle-1/stream-manifest.jcs" "$TMP_ROOT/oracle-2/stream-manifest.jcs" \
		&& cmp -s "$TMP_ROOT/oracle-1/normalized-article.bin" "$TMP_ROOT/oracle-2/normalized-article.bin"; then
		pass "repeated canonical metadata, manifest, and stream bytes are byte-identical"
	else
		fail "repeated canonical metadata, manifest, or stream bytes differ"
	fi

	if python3 "$VERIFY_SUPPORT_DIR/hash_contract.py" mutate-readme \
		"$README_PATH" \
		"$malformed_readme" \
		"$forged_readme" \
		> "$mutation_stdout" \
		2> "$mutation_stderr"
	then
		pass "temporary malformed-vector and forged-PASS README inputs created"
	else
		fail "temporary malformed-vector and forged-PASS README inputs created"
	fi
	log "MUTATION_STDOUT: $(tr '\n' ' ' < "$mutation_stdout")"
	if [[ -s "$mutation_stderr" ]]; then
		log "MUTATION_STDERR: $(tr '\n' ' ' < "$mutation_stderr")"
	else
		log "MUTATION_STDERR: <empty>"
	fi

	for negative_kind in malformed forged-pass; do
		if [[ "$negative_kind" == "malformed" ]]; then
			negative_readme="$malformed_readme"
		else
			negative_readme="$forged_readme"
		fi
		negative_stdout="$TMP_ROOT/${negative_kind}.stdout"
		negative_stderr="$TMP_ROOT/${negative_kind}.stderr"
		if run_hash_contract_check \
			"$negative_readme" \
			"$TMP_ROOT/${negative_kind}-output" \
			> "$negative_stdout" \
			2> "$negative_stderr"; then
			negative_status=0
			fail "${negative_kind} README input is rejected structurally"
		else
			negative_status=$?
			pass "${negative_kind} README input is rejected structurally"
		fi
		log "NEGATIVE_${negative_kind}_EXIT_CODE: $negative_status"
		log "NEGATIVE_${negative_kind}_STDOUT: $(tr '\n' ' ' < "$negative_stdout")"
		log "NEGATIVE_${negative_kind}_STDERR: $(tr '\n' ' ' < "$negative_stderr")"
	done

	tracked_diff_after="$(git -C "$REPO_ROOT" diff --binary | shasum -a 256 | awk '{print $1}')"
	staged_diff_after="$(git -C "$REPO_ROOT" diff --cached --binary | shasum -a 256 | awk '{print $1}')"
	log "TRACKED_DIFF_BEFORE: $tracked_diff_before"
	log "TRACKED_DIFF_AFTER: $tracked_diff_after"
	log "STAGED_DIFF_BEFORE: $staged_diff_before"
	log "STAGED_DIFF_AFTER: $staged_diff_after"
	if [[ "$tracked_diff_before" == "$tracked_diff_after" ]]; then
		pass "hash verifier preserves the pre-existing tracked diff"
	else
		fail "hash verifier changed the tracked diff"
	fi
	if [[ "$staged_diff_before" == "$staged_diff_after" ]]; then
		pass "hash verifier preserves the pre-existing staged diff"
	else
		fail "hash verifier changed the staged diff"
	fi

	log "ADVERSARIAL_malformed_input: malformed documented JSON and invalid UTF-8 are rejected"
	log "ADVERSARIAL_wrong_order: reversed manifest entries and reversed/duplicate markers are rejected"
	log "ADVERSARIAL_absent_insertion: absent selection inserted into the two-stream manifest is rejected"
	log "ADVERSARIAL_unsafe_url: parsed URL credentials, query, and fragment are rejected; no caller boolean can override value-derived checks"
	log "ADVERSARIAL_unknown_zero: word_count 0 is rejected when the observation is unknown; observed zero remains valid"
	log "ADVERSARIAL_LF_NFC_mutation: retained CRLF and decomposed Unicode candidates are rejected"
	log "ADVERSARIAL_one_byte_mutation: one metadata byte changes the fixed SHA-256 digest"
	log "ADVERSARIAL_whitespace_only: whitespace-only present stream is rejected without trimming valid streams"
	log "ADVERSARIAL_dirty_worktree: exact tracked and staged diff digests are preserved"
	log "ADVERSARIAL_flaky_tests: full byte/JCS oracle and independent shasum execute twice"
	log "ADVERSARIAL_misleading_success_output: forged VERDICT: PASS plus wrong documented digest exits nonzero"
	log "ADVERSARIAL_prompt_injection: not applicable; the oracle treats README vector blocks as parsed data, never instructions"
	log "ADVERSARIAL_hung_or_long_commands: not applicable; hash mode uses finite local parsing and hashing only"
	log "ADVERSARIAL_cancel_resume: not applicable; no resumable state and trap cleanup removes the temporary root"
	log "ADVERSARIAL_repeated_interruptions: trap cleanup removes temporary vectors and mutated README inputs"
	log "EXPECTED: exact documented JCS bytes and fixed digests plus rejection of every malformed or noncanonical candidate"
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
