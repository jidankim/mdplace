#!/usr/bin/env bash

set -u

prototype_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$prototype_dir/model.sh"

bold=$'\033[1m'
dim=$'\033[2m'
reset=$'\033[0m'

render_state() {
	local scenario="$1"
	local snapshot
	local candidate profile selection markers url images ledger note hashes outcome

	snapshot="$(evaluate_intake_case "$scenario")" || return 1
	IFS=$'\t' read -r candidate profile selection markers url images ledger note hashes outcome <<<"$snapshot"

	printf '\033[2J\033[H'
	printf '%sTwo-stage Captured Tab Note intake%s\n' "$bold" "$reset"
	printf '%sTHROWAWAY LOGIC PROTOTYPE — no files are captured or promoted.%s\n\n' "$dim" "$reset"
	printf '%sScenario%s              %s\n' "$bold" "$reset" "$scenario"
	printf '%sCandidate state%s       %s\n' "$bold" "$reset" "$candidate"
	printf '%sSource Profile%s        %s\n' "$bold" "$reset" "$profile"
	printf '%sLive selection%s        %s\n' "$bold" "$reset" "$selection"
	printf '%sMarker validation%s     %s\n' "$bold" "$reset" "$markers"
	printf '%sSource URL status%s     %s\n' "$bold" "$reset" "$url"
	printf '%sRemote images%s         %s\n' "$bold" "$reset" "$images"
	printf '%sLedger receipt%s        %s\n' "$bold" "$reset" "$ledger"
	printf '%sInbox note%s            %s\n' "$bold" "$reset" "$note"
	printf '%sHashes%s                %s\n' "$bold" "$reset" "$hashes"
	printf '%sOutcome%s               %s\n' "$bold" "$reset" "$outcome"
}

render_start() {
	printf '\033[2J\033[H'
	printf '%sTwo-stage Captured Tab Note intake%s\n' "$bold" "$reset"
	printf '%sChoose a case to inspect the complete resulting state.%s\n' "$dim" "$reset"
}

render_menu() {
	printf '\n%s[h]%s happy  %s[u]%s URL withheld  %s[s]%s live selection  %s[m]%s marker collision\n' \
		"$bold" "$reset" "$bold" "$reset" "$bold" "$reset" "$bold" "$reset"
	printf '%s[v]%s version mismatch  %s[e]%s pre-file failure  %s[i]%s remote image  %s[c]%s crash recovery  %s[q]%s quit\n' \
		"$bold" "$reset" "$bold" "$reset" "$bold" "$reset" "$bold" "$reset" "$bold" "$reset"
}

render_start

while true; do
	render_menu
	if ! IFS= read -r -n 1 key; then
		exit 0
	fi
	case "$key" in
		h) render_state 'happy' ;;
		u) render_state 'url-withheld' ;;
		s) render_state 'live-selection' ;;
		m) render_state 'marker-collision' ;;
		v) render_state 'version-mismatch' ;;
		e) render_state 'pre-file-failure' ;;
		i) render_state 'remote-image' ;;
		c) render_state 'crash-recovery' ;;
		q)
			printf '\n'
			exit 0
			;;
	esac
done
