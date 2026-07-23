#!/usr/bin/env bash

set -euo pipefail

readonly EXPECTED_UPSTREAM_SHA="48228dce63195681e9dfc4fb8760c3c36db51079"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
readonly REPO_ROOT
readonly TEMPLATE_PATH="$SCRIPT_DIR/mdplace-captured-tab-note-clipper.json"
readonly README_PATH="$SCRIPT_DIR/README.md"
readonly CONTEXT_PATH="$REPO_ROOT/CONTEXT.md"
readonly EXPECTED_NOTE_NAME='NONCONFORMING-{{date|date:"YYYYMMDD-HHmmss"}}'
readonly VERIFY_TIMEOUT_SECONDS="${MDPLACE_VERIFY_TIMEOUT_SECONDS:-60}"
readonly VERIFY_SUPPORT_DIR="$SCRIPT_DIR/verify_support"
readonly -a VERIFY_SUPPORT_RELATIVE_PATHS=(
	"verify_support/common.sh"
	"verify_support/bounded_runner.sh"
	"verify_support/bounded_runner.py"
	"verify_support/bounded_runner_qa.py"
	"verify_support/docs_contract.py"
	"verify_support/docs_mode.sh"
	"verify_support/hash_contract.py"
	"verify_support/hash_mode.sh"
	"verify_support/shell_mode.sh"
	"verify_support/template_mode.sh"
	"verify_support/template_contract.py"
	"verify_support/template_cancellation.py"
)
readonly MODE="${1:-}"

for support_relative_path in "${VERIFY_SUPPORT_RELATIVE_PATHS[@]}"; do
	if [[ ! -f "$SCRIPT_DIR/$support_relative_path" || ! -r "$SCRIPT_DIR/$support_relative_path" ]]; then
		printf 'ERROR: verifier support is missing or unreadable: %s\n' "$support_relative_path" >&2
		exit 66
	fi
done

for support_relative_path in "${VERIFY_SUPPORT_RELATIVE_PATHS[@]}"; do
	case "$support_relative_path" in
		*.sh)
			# shellcheck disable=SC1090
			source "$SCRIPT_DIR/$support_relative_path"
			;;
	esac
done

compute_verify_bundle_sha256() {
	local relative_path
	{
		printf '%s\t%s\n' "verify.sh" "$(sha256_file "$SCRIPT_DIR/verify.sh")"
		for relative_path in "${VERIFY_SUPPORT_RELATIVE_PATHS[@]}"; do
			printf '%s\t%s\n' "$relative_path" "$(sha256_file "$SCRIPT_DIR/$relative_path")"
		done
	} | shasum -a 256 | awk '{print $1}'
}

VERIFY_BUNDLE_SHA256="$(compute_verify_bundle_sha256)"
readonly VERIFY_BUNDLE_SHA256

initialize_evidence() {
	local mode="$1"
	local phase="${2:-}"

	case "$mode" in
		shell)
			TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/mdplace-clipper-shell.XXXXXX")"
			if [[ -n "${MDPLACE_EVIDENCE_DIR:-}" ]]; then
				mkdir -p -- "$MDPLACE_EVIDENCE_DIR"
				EVIDENCE_FILE="$MDPLACE_EVIDENCE_DIR/task-3-shell-green.txt"
				: > "$EVIDENCE_FILE"
			else
				EVIDENCE_FILE="$TMP_ROOT/shell-evidence.txt"
			fi
			;;
		docs)
			TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/mdplace-clipper-docs.XXXXXX")"
			if [[ -n "${MDPLACE_EVIDENCE_DIR:-}" ]]; then
				mkdir -p -- "$MDPLACE_EVIDENCE_DIR"
				EVIDENCE_FILE="$MDPLACE_EVIDENCE_DIR/task-4-contract-consistency.txt"
				if [[ "${MDPLACE_EVIDENCE_APPEND:-0}" == "1" ]]; then
					printf '\nDOCS_RUN_SEPARATOR\n' >> "$EVIDENCE_FILE"
				else
					: > "$EVIDENCE_FILE"
				fi
			else
				EVIDENCE_FILE="$TMP_ROOT/docs-evidence.txt"
			fi
			;;
		hash)
			TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/mdplace-clipper-hash.XXXXXX")"
			if [[ -n "${MDPLACE_EVIDENCE_DIR:-}" ]]; then
				mkdir -p -- "$MDPLACE_EVIDENCE_DIR"
				EVIDENCE_FILE="$MDPLACE_EVIDENCE_DIR/task-5-hash-vectors.txt"
				if [[ "${MDPLACE_EVIDENCE_APPEND:-0}" == "1" ]]; then
					printf '\nHASH_RUN_SEPARATOR\n' >> "$EVIDENCE_FILE"
				else
					: > "$EVIDENCE_FILE"
				fi
			else
				EVIDENCE_FILE="$TMP_ROOT/hash-evidence.txt"
			fi
			;;
		template)
			if [[ -z "${MDPLACE_EVIDENCE_DIR:-}" ]]; then
				return 0
			fi
			mkdir -p -- "$MDPLACE_EVIDENCE_DIR"
			case "$phase" in
				wrong-upstream)
					EVIDENCE_FILE="$MDPLACE_EVIDENCE_DIR/task-2-wrong-upstream-sha.txt"
					;;
				attached-upstream)
					EVIDENCE_FILE="$MDPLACE_EVIDENCE_DIR/task-2-attached-upstream.txt"
					;;
				dirty-upstream)
					EVIDENCE_FILE="$MDPLACE_EVIDENCE_DIR/task-8-dirty-upstream.txt"
					;;
				green|red)
					EVIDENCE_FILE="$MDPLACE_EVIDENCE_DIR/task-2-template-${phase}.txt"
					;;
			esac
			: > "$EVIDENCE_FILE"
			;;
	esac
}

print_usage() {
	printf 'Usage: WEB_CLIPPER_DIR=/path/to/pinned/checkout %s template | %s shell | %s docs | %s hash\n' "$0" "$0" "$0" "$0" >&2
}

install_common_traps

case "$MODE" in
	shell)
		initialize_evidence shell
		run_shell_mode
		exit $?
		;;
	docs)
		initialize_evidence docs
		run_docs_mode
		exit $?
		;;
	hash)
		initialize_evidence hash
		run_hash_mode
		exit $?
		;;
	template)
		run_template_mode
		exit $?
		;;
	*)
		print_usage
		exit 64
		;;
esac
