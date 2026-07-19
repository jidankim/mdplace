#!/usr/bin/env bash

set -u

bold=$'\033[1m'
dim=$'\033[2m'
reset=$'\033[0m'

render_header() {
	printf '\033[2J\033[H'
	printf '%sCaptured Tab Note contract prototype%s\n' "$bold" "$reset"
	printf '%sNo files are written; choose a case to inspect the complete proposed state.%s\n\n' "$dim" "$reset"
}

render_full() {
	render_header
	printf '%sCase%s: readable main content\n\n' "$bold" "$reset"
	printf '%sInput%s\n' "$bold" "$reset"
	printf '  source_url: https://example.com/guide\n'
	printf '  selection: absent\n'
	printf '  highlights: absent\n'
	printf '  readable_content: present\n'
	printf '  images: absent\n\n'
	printf '%sCaptured note%s\n' "$bold" "$reset"
	printf '  path: Inbox/20260719-142503--example.com--A-Practical-Guide.md\n'
	printf '  capture_workflow_status: valid\n'
	printf '  capture_article_status: captured\n'
	printf '  capture_selection_status: absent\n'
	printf '  capture_highlights_status: absent\n'
	printf '  capture_image_policy: remote_url\n'
	printf '  mdplace_id: absent until mdplace ingestion\n'
	printf '  placement keys: absent\n'
	printf '  article stream:\n'
	printf '    A durable Markdown article body extracted from one browser tab.\n\n'
	printf '%sIngestion state%s\n' "$bold" "$reset"
	printf '  valid Captured Tab Note: yes\n'
	printf '  article_content_hash input: normalized article stream\n'
	printf '  source metadata hash input: adapter-owned frontmatter only\n'
	printf '  accepted placement: none\n'
}

render_selection() {
	render_header
	printf '%sCase%s: invalid workflow — live selection was not promoted\n\n' "$bold" "$reset"
	printf '%sInput%s\n' "$bold" "$reset"
	printf '  source_url: https://example.com/guide\n'
	printf '  selection: "This paragraph is the current selection."\n'
	printf '  highlights: 3 older highlights\n'
	printf '  readable_content: present\n'
	printf '  images: absent\n\n'
	printf '%sCaptured artifact%s\n' "$bold" "$reset"
	printf '  capture_workflow_status: invalid_live_selection\n'
	printf '  capture_article_status: unavailable_active_selection\n'
	printf '  capture_selection_status: captured\n'
	printf '  capture_highlights_status: captured\n'
	printf '  article stream: unavailable from the generic Web Clipper template\n'
	printf '  selection stream:\n'
	printf '    This paragraph is the current selection.\n'
	printf '  highlights stream:\n'
	printf '    3 structured saved highlights with timestamps\n'
	printf '  omitted by precedence: nothing\n\n'
	printf '%sIngestion state%s\n' "$bold" "$reset"
	printf '  valid Captured Tab Note: no, readable article is required\n'
	printf '  preserved recovery data: selection and highlights\n'
	printf '  required action: promote selection to highlight, clear it, recapture\n'
	printf '  selection_hash: computed independently\n'
	printf '  highlights_hash: computed independently\n'
	printf '  accepted placement: none\n'
}

render_highlights() {
	render_header
	printf '%sCase%s: article plus durable highlights\n\n' "$bold" "$reset"
	printf '%sInput%s\n' "$bold" "$reset"
	printf '  source_url: https://example.com/guide\n'
	printf '  selection: absent\n'
	printf '  highlights: 3 text or block highlights, newest promoted from selection\n'
	printf '  readable_content: present\n'
	printf '  required Web Clipper setting: Do nothing\n\n'
	printf '%sCaptured note%s\n' "$bold" "$reset"
	printf '  capture_workflow_status: valid\n'
	printf '  capture_article_status: captured\n'
	printf '  capture_selection_status: absent\n'
	printf '  capture_highlights_status: captured\n'
	printf '  article stream: complete normalized readable article\n'
	printf '  highlights stream: 3 structured highlights with timestamps\n'
	printf '  omitted by precedence: nothing\n\n'
	printf '%sIngestion state%s\n' "$bold" "$reset"
	printf '  valid Captured Tab Note: yes\n'
	printf '  article_content_hash: computed independently\n'
	printf '  highlights_hash: computed independently\n'
	printf '  capture_stream_manifest_hash: binds both streams\n'
	printf '  accepted placement: none\n'
}

render_images() {
	render_header
	printf '%sCase%s: readable content contains images\n\n' "$bold" "$reset"
	printf '%sInput%s\n' "$bold" "$reset"
	printf '  source_url: https://example.com/illustrated-guide\n'
	printf '  readable_content: present\n'
	printf '  image reference: https://cdn.example.com/diagram.png\n'
	printf '  image bytes: not downloaded\n\n'
	printf '%sCaptured note%s\n' "$bold" "$reset"
	printf '  capture_workflow_status: valid\n'
	printf '  capture_article_status: captured\n'
	printf '  capture_selection_status: absent\n'
	printf '  capture_highlights_status: absent\n'
	printf '  capture_image_policy: remote_url\n'
	printf '  article stream:\n'
	printf '    ![System diagram](https://cdn.example.com/diagram.png)\n\n'
	printf '%sIngestion state%s\n' "$bold" "$reset"
	printf '  valid Captured Tab Note: yes\n'
	printf '  article hash includes: Markdown image syntax, alt text, and remote URL\n'
	printf '  article hash excludes: remote image bytes\n'
	printf '  later image download: new observed file version, same file identity\n'
}

render_hashes() {
	render_header
	printf '%sCase%s: mdplace hashes a captured note during ingestion\n\n' "$bold" "$reset"
	printf '%sCapture Adapter output%s\n' "$bold" "$reset"
	printf '  hashes written by Web Clipper: none\n'
	printf '  article stream: present\n'
	printf '  selection stream: absent\n'
	printf '  highlights stream: present\n'
	printf '  adapter-owned source metadata: present\n\n'
	printf '%sIngestion normalization%s\n' "$bold" "$reset"
	printf '  text encoding: valid UTF-8\n'
	printf '  line endings: LF\n'
	printf '  Unicode: NFC\n'
	printf '  Markdown whitespace, links, and remote image URLs: preserved\n\n'
	printf '%sSemantic-ledger evidence%s\n' "$bold" "$reset"
	printf '  article_content_hash: sha256:<64 lowercase hex>\n'
	printf '  selection_hash: absent\n'
	printf '  highlights_hash: sha256:<64 lowercase hex>\n'
	printf '  source_metadata_hash: SHA-256 of RFC 8785 canonical JSON\n'
	printf '  capture_stream_manifest_hash: binds the ordered present streams\n'
	printf '  identity or placement authority: none\n'
}

render_storage() {
	render_header
	printf '%sCase%s: Web Clipper chooses the initial vault coordinate\n\n' "$bold" "$reset"
	printf '%sCapture input%s\n' "$bold" "$reset"
	printf '  captured_at: 2026-07-20T14:25:03+09:00\n'
	printf '  source_domain: example.com\n'
	printf '  source_title: A Practical Guide\n\n'
	printf '%sWeb Clipper output%s\n' "$bold" "$reset"
	printf '  behavior: create\n'
	printf '  vault-relative path: Inbox\n'
	printf '  filename: 20260720-142503--example.com--A-Practical-Guide.md\n\n'
	printf '%sContract meaning%s\n' "$bold" "$reset"
	printf '  Inbox: workflow holding area\n'
	printf '  filename and path: operational coordinates only\n'
	printf '  note identity: not derived from filename or path\n'
	printf '  semantic placement: not asserted by Capture Adapter\n'
	printf '  collision and recapture semantics: decided by the source-identity contract\n'
}

render_metadata() {
	render_header
	printf '%sCase%s: Web Clipper writes adapter-owned frontmatter\n\n' "$bold" "$reset"
	printf '%sCapture Adapter-owned fields%s\n' "$bold" "$reset"
	printf '  contract: capture_contract, capture_adapter, capture_template_version\n'
	printf '  observation: captured_at, capture_workflow_status\n'
	printf '  streams: capture_article_status, capture_selection_status,\n'
	printf '           capture_highlights_status, capture_image_policy\n'
	printf '  source: source_url, source_title, source_author, source_published_at,\n'
	printf '          source_site, source_domain, source_language,\n'
	printf '          source_description, source_image_url, source_word_count\n\n'
	printf '%sFields absent at capture%s\n' "$bold" "$reset"
	printf '  mdplace_id\n'
	printf '  identity fields\n'
	printf '  placement and Category Tree fields\n'
	printf '  review, hypothesis, and projection fields\n\n'
	printf '%sOwnership boundary%s\n' "$bold" "$reset"
	printf '  Capture Adapter: observed provenance only\n'
	printf '  mdplace: managed fields added after successful ingestion\n'
	printf '  user-added fields: preserved semantically\n'
}

render_body() {
	render_header
	printf '%sCase%s: a valid note carries article and highlight streams\n\n' "$bold" "$reset"
	printf '%sRendered Markdown body%s\n' "$bold" "$reset"
	printf '  # A Practical Guide\n\n'
	printf '  > [!info] Source\n'
	printf '  > [example.com](https://example.com/guide) — Ada Author\n\n'
	printf '  ## Article\n\n'
	printf '  <!-- mdplace:article:start -->\n'
	printf '  Complete normalized readable article Markdown.\n'
	printf '  <!-- mdplace:article:end -->\n\n'
	printf '  ## Saved highlights\n\n'
	printf '  <!-- mdplace:highlights:start -->\n'
	printf '  Structured saved highlights with Web Clipper timestamps.\n'
	printf '  <!-- mdplace:highlights:end -->\n\n'
	printf '%sContract meaning%s\n' "$bold" "$reset"
	printf '  marker pairs: canonical ingestion and hashing boundaries\n'
	printf '  unexpected selection section: present only for invalid recovery artifacts\n'
	printf '  category, placement, generated semantic summary: absent\n'
}

render_activation() {
	render_header
	printf '%sCase%s: Web Clipper is configured for a conforming capture\n\n' "$bold" "$reset"
	printf '%sRequired setup%s\n' "$bold" "$reset"
	printf '  imported template: mdplace-captured-tab-note-clipper.json\n'
	printf '  template schema: 0.1.0\n'
	printf '  template selection: explicit or first fallback\n'
	printf '  highlight note-content behavior: Do nothing\n'
	printf '  Interpreter: not invoked\n\n'
	printf '%sBefore each capture%s\n' "$bold" "$reset"
	printf '  live browser selection: promote to highlight, then clear\n'
	printf '  saved highlights: retained as independent side data\n\n'
	printf '%sValidity boundary%s\n' "$bold" "$reset"
	printf '  exact template selected: required\n'
	printf '  readable article stream: required for a valid Captured Tab Note\n'
	printf '  different template or transformed body: not contract-conforming\n'
}

render_failure() {
	render_header
	printf '%sCase%s: a file reaches the vault without readable content\n\n' "$bold" "$reset"
	printf '%sInput%s\n' "$bold" "$reset"
	printf '  source_url: https://example.com/script-only-app\n'
	printf '  selection: absent\n'
	printf '  highlights: absent\n'
	printf '  readable_content: empty\n'
	printf '  source metadata: present\n\n'
	printf '%sCaptured artifact%s\n' "$bold" "$reset"
	printf '  path: Inbox/20260719-142503--example.com--Script-Only-App.md\n'
	printf '  capture_workflow_status: valid\n'
	printf '  capture_article_status: extraction_failed\n'
	printf '  capture_selection_status: absent\n'
	printf '  capture_highlights_status: absent\n'
	printf '  article stream: absent\n\n'
	printf '%sIngestion state%s\n' "$bold" "$reset"
	printf '  source metadata: retained\n'
	printf '  artifact status: invalid_capture\n'
	printf '  valid Captured Tab Note: no\n'
	printf '  placement eligibility: forbidden\n'
	printf '  blocking diagnostic: article markers absent\n'
	printf '  action: leave in Inbox for recapture or manual inspection\n'
	printf '  forbidden fallback: fullHtml, Interpreter, remote inference\n'
	printf '  hard extension or transport failure: no file\n'
}

render_start() {
	render_header
	printf '%sConfirmed rules%s\n\n' "$bold" "$reset"
	printf 'Preserve every available stream independently:\n\n'
	printf '  readable article + current selection + saved highlights\n\n'
	printf 'Before clipping: promote a live selection to a highlight, then clear it.\n'
	printf 'No stream deletes another through precedence.\n'
	printf 'Keep a metadata-preserving extraction failure as an invalid Inbox artifact.\n'
	printf 'A hard extension or transport failure creates no file.\n'
	printf 'Keep image references as remote URLs; do not download image bytes automatically.\n'
	printf 'Web Clipper omits hashes; mdplace computes them during ingestion.\n'
	printf 'Create every clip in Inbox with a timestamp-domain-title filename.\n'
	printf 'Frontmatter contains observed provenance only; semantic fields stay absent.\n'
	printf 'The body uses readable context and strict independent stream markers.\n'
	printf 'Require the exact template, Do nothing highlight handling, a cleared live\n'
	printf 'selection, and no Interpreter.\n\n'
	printf '%sVerdict%s: the complete v1 prototype contract is accepted.\n' "$bold" "$reset"
	printf 'Inspect any case below to see its full proposed state.\n'
}

render_menu() {
	printf '\n%s[f]%s full  %s[s]%s selection  %s[h]%s highlights  %s[i]%s images  %s[c]%s hashes  %s[p]%s path  %s[m]%s metadata  %s[b]%s body  %s[a]%s activation  %s[e]%s failure  %s[q]%s quit\n' \
		"$bold" "$reset" "$bold" "$reset" "$bold" "$reset" "$bold" "$reset" "$bold" "$reset" "$bold" "$reset" "$bold" "$reset" "$bold" "$reset" "$bold" "$reset" "$bold" "$reset" "$bold" "$reset"
}

render_start

while true; do
	render_menu
	IFS= read -r -n 1 key
	case "$key" in
		f) render_full ;;
		s) render_selection ;;
		h) render_highlights ;;
		i) render_images ;;
		c) render_hashes ;;
		p) render_storage ;;
		m) render_metadata ;;
		b) render_body ;;
		a) render_activation ;;
		e) render_failure ;;
		q)
			printf '\n'
			exit 0
			;;
	esac
done
