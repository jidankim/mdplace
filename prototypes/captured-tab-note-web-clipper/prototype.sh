#!/usr/bin/env bash

set -u

bold=$'\033[1m'
dim=$'\033[2m'
reset=$'\033[0m'

render_header() {
	printf '\033[2J\033[H'
	printf '%sCaptured Tab Note stock-capability report%s\n' "$bold" "$reset"
	printf '%sRead-only and deterministic; this report writes no files and emits no note artifact.%s\n\n' "$dim" "$reset"
}

render_case() {
	local heading="$1"
	local outcome="$2"
	local explanation="$3"

	render_header
	printf '%sCase: %s%s\n' "$bold" "$heading" "$reset"
	printf 'Outcome: %s\n\n' "$outcome"
	printf '%sExplanation%s\n' "$bold" "$reset"
	printf '  %s\n' "$explanation"
}

render_filename() {
	render_case \
		'filename' \
		'SUPPORTED' \
		'Controlled pinned compiler semantics support slice:0,80, safe_name, and the Untitled fallback; the pinned CLI still supplies blank HTML-derived title variables because its API passes an HTMLElement to Defuddle.'
}

render_yaml_safety() {
	render_case \
		'YAML/frontmatter safety' \
		'UNSUPPORTED' \
		'The stock template cannot safely serialize arbitrary free-text YAML or enforce the required field allowlist; this diagnostic therefore retains no page-derived values.'
}

render_selection_provenance() {
	render_case \
		'selection provenance' \
		'UNSUPPORTED' \
		'Stock selection promotion becomes an ordinary highlight without a reliable origin marker and may merge; the template has no provenance channel.'
}

render_metadata_artifact() {
	render_case \
		'metadata-only extraction artifact' \
		'UNSUPPORTED' \
		'Stock browser capture throws before template rendering when readable content is empty, so it cannot produce the required metadata-only recovery artifact.'
}

render_template_compiler() {
	render_case \
		'template/content compiler' \
		'SUPPORTED' \
		'The pinned template/content compiler can render the static diagnostic and availability conditionals locally; this capability does not make stock Web Clipper a Capture Adapter.'
}

render_url_policy() {
	render_case \
		'URL persistence policy' \
		'UNSUPPORTED' \
		'The stock template cannot perform mandatory URL sanitation before persistence or transmission; the diagnostic intentionally renders no source URL.'
}

render_word_count() {
	render_case \
		'missing word count' \
		'UNSUPPORTED' \
		'The pinned CLI reports an unknown word count as 0, making missing metadata indistinguishable from a genuine zero-word value.'
}

render_hash_shape() {
	render_case \
		'deterministic hash shape' \
		'TARGET CONTRACT' \
		'The canonical metadata and stream-manifest hash shape is a future adapter target; stock Web Clipper emits no hashes and this read-only report computes none.'
}

render_activation() {
	render_case \
		'import/activation mechanics' \
		'SUPPORTED' \
		'The stock template imports and renders the static diagnostic in a local fixture; activation supplies no missing conformance guarantees.'
}

render_conformance() {
	render_case \
		'Captured Tab Note conformance' \
		'UNSUPPORTED' \
		'Stock Obsidian Web Clipper 1.7.0 does not satisfy the required safe persistence, provenance, recovery, metadata, and hashing boundaries; this report is not a Captured Tab Note.'
}

render_menu() {
	printf '\n%s[f]%s filename  %s[s]%s YAML/frontmatter safety  %s[h]%s selection provenance  %s[i]%s metadata-only extraction artifact  %s[c]%s template/content compiler  %s[p]%s URL persistence policy  %s[m]%s missing word count  %s[b]%s deterministic hash shape  %s[a]%s import/activation mechanics  %s[e]%s Captured Tab Note conformance  %s[q]%s quit\n' \
		"$bold" "$reset" "$bold" "$reset" "$bold" "$reset" "$bold" "$reset" "$bold" "$reset" "$bold" "$reset" "$bold" "$reset" "$bold" "$reset" "$bold" "$reset" "$bold" "$reset" "$bold" "$reset"
}

render_start() {
	render_header
	printf '%sVerdict%s: stock Obsidian Web Clipper 1.7.0 is NOT A SUPPORTED CAPTURE ADAPTER.\n' "$bold" "$reset"
	printf 'Inspect one pinned capability below; each case reports an observation and outcome only.\n'
}

render_start

while true; do
	render_menu
	if ! IFS= read -r -n 1 key; then
		exit 0
	fi
	case "$key" in
		f) render_filename ;;
		s) render_yaml_safety ;;
		h) render_selection_provenance ;;
		i) render_metadata_artifact ;;
		c) render_template_compiler ;;
		p) render_url_policy ;;
		m) render_word_count ;;
		b) render_hash_shape ;;
		a) render_activation ;;
		e) render_conformance ;;
		q)
			printf '\n'
			exit 0
			;;
	esac
done
