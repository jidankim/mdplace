#!/usr/bin/env bash

# Pure scenario model for the throwaway terminal driver.
# Input: one scenario name.
# Output: tab-separated state fields in a stable order.

evaluate_intake_case() {
	local scenario="$1"

	case "$scenario" in
		happy)
			printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
				'processed' 'matched' 'absent' 'valid' 'retained' \
				'inert' 'committed' 'inbox' 'candidate/article/content' \
				'promoted'
			;;
		url-withheld)
			printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
				'processed' 'matched' 'absent' 'valid' 'withheld_by_policy' \
				'inert' 'committed' 'inbox' 'candidate/article/content' \
				'promoted with canonical_url null'
			;;
		live-selection)
			printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
				'failed' 'matched' 'present' 'valid' 'retained' \
				'unprocessed' 'none' 'absent' 'candidate only' \
				'live_selection_present'
			;;
		marker-collision)
			printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
				'failed' 'matched' 'absent' 'duplicate' 'retained' \
				'unprocessed' 'none' 'absent' 'candidate only' \
				'duplicate_or_injected_marker'
			;;
		version-mismatch)
			printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
				'failed' 'mismatch' 'absent' 'valid' 'retained' \
				'unprocessed' 'none' 'absent' 'candidate only' \
				'source_profile_mismatch'
			;;
		pre-file-failure)
			printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
				'none' 'not-evaluated' 'unknown' 'none' 'unknown' \
				'none' 'none' 'absent' 'none' \
				'stock_source_failed_before_template_rendering'
			;;
		remote-image)
			printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
				'processed' 'matched' 'absent' 'valid' 'retained' \
				'inert' 'committed' 'inbox' 'candidate/article/content' \
				'promoted; image localization deferred'
			;;
		crash-recovery)
			printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
				'processed' 'matched' 'absent' 'valid' 'retained' \
				'inert' 'recovered-and-committed' 'inbox' \
				'candidate/article/content' \
				'resumed same promotion_id without duplicate'
			;;
		*)
			return 1
			;;
	esac
}
