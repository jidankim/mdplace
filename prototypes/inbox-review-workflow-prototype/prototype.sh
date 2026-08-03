#!/usr/bin/env bash

set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
prototype_vault="$script_dir/PROTOTYPE-VAULT"

# shellcheck source=review_logic.sh
. "$script_dir/review_logic.sh"
# shellcheck source=review_sheet.sh
. "$script_dir/review_sheet.sh"

bold='\033[1m'
dim='\033[2m'
reset='\033[0m'
state=$(initial_review_workflow_state)
command_words=()

value_for_flag() {
  local wanted_flag=$1
  local word_index=0

  while [ "$word_index" -lt "${#command_words[@]}" ]; do
    if [ "${command_words[$word_index]}" = "$wanted_flag" ]; then
      word_index=$((word_index + 1))
      printf '%s' "${command_words[$word_index]:-}"
      return
    fi
    word_index=$((word_index + 1))
  done
}

set_feedback() {
  state=$(review_workflow_state_with_feedback "$state" "$1")
}

apply_action() {
  state=$(reduce_review_workflow_state "$state" "$1")
}

require_rationale() {
  if [ -z "$(value_for_flag --because)" ]; then
    set_feedback 'CommandBlocked: an explicit --because rationale is required'
    return 1
  fi
}

dispatch_placement_command() {
  local operation=${command_words[2]:-}
  local review_id=${command_words[3]:-}
  local expected_binding=''
  local expected_outcome=''
  local category=''

  if [ "$review_id" != review:placement-42 ]; then
    set_feedback 'CommandBlocked: unknown placement review identity'
    return
  fi

  expected_binding=$(value_for_flag --expect)
  expected_outcome=$(value_for_flag --expect-outcome)
  category=$(value_for_flag --category)

  case "$operation" in
    accept)
      if ! require_rationale; then return; fi
      if [ "$category" != cat:research/graph-systems ]; then
        set_feedback 'CommandBlocked: this prototype accepts only the displayed leading Category Identity'
        return
      fi
      apply_action "placement_accept~$expected_binding~$expected_outcome"
      ;;
    override)
      if ! require_rationale; then return; fi
      if [ "$category" != cat:projects/knowledge-tools ]; then
        set_feedback 'CommandBlocked: this prototype overrides only to the displayed alternative Category Identity'
        return
      fi
      apply_action "placement_override~$expected_binding~$expected_outcome"
      ;;
    defer)
      if ! require_rationale; then return; fi
      apply_action "placement_defer~$expected_binding~$expected_outcome"
      ;;
    no-fit)
      if ! require_rationale; then return; fi
      apply_action "placement_no_fit~$expected_binding~$expected_outcome"
      ;;
    resume)
      apply_action "placement_resume~$expected_binding~$expected_outcome"
      ;;
    evaluate)
      apply_action "placement_evaluate~$expected_binding~$expected_outcome"
      ;;
    retract)
      if ! require_rationale; then return; fi
      apply_action "placement_retract~$expected_outcome"
      ;;
    *)
      set_feedback 'CommandIgnored: unknown placement review operation'
      ;;
  esac
}

dispatch_taxonomy_command() {
  local operation=${command_words[3]:-}
  local target=${command_words[4]:-}
  local expected_revision=''
  local validation=''

  expected_revision=$(value_for_flag --expect)
  validation=$(value_for_flag --validation)

  case "$operation" in
    validate)
      if [ "$target" != txp:reparent-17 ]; then
        set_feedback 'CommandBlocked: unknown Taxonomy Proposal identity'
        return
      fi
      apply_action "taxonomy_validate~$expected_revision"
      ;;
    approve)
      if [ "$target" != txp:reparent-17 ]; then
        set_feedback 'CommandBlocked: unknown Taxonomy Proposal identity'
        return
      fi
      if ! require_rationale; then return; fi
      if [ "$validation" != validation:preview-17 ]; then
        set_feedback 'CommandBlocked: approval must cite the displayed validation receipt'
        return
      fi
      apply_action "taxonomy_stage~$expected_revision"
      ;;
    confirm)
      apply_action "taxonomy_confirm~$target~$expected_revision"
      ;;
    reject)
      if [ "$target" != txp:reparent-17 ]; then
        set_feedback 'CommandBlocked: unknown Taxonomy Proposal identity'
        return
      fi
      if ! require_rationale; then return; fi
      apply_action "taxonomy_reject~$expected_revision"
      ;;
    reevaluate)
      if [ "$target" != txp:reparent-17 ]; then
        set_feedback 'CommandBlocked: unknown Taxonomy Proposal identity'
        return
      fi
      apply_action "taxonomy_reevaluate~$expected_revision"
      ;;
    *)
      set_feedback 'CommandIgnored: unknown taxonomy review operation'
      ;;
  esac
}

dispatch_command() {
  local command_line=$1

  command_words=()
  read -r -a command_words <<< "$command_line"

  if [ "${command_words[0]:-}" != mdplace ]; then
    set_feedback 'CommandIgnored: paste a command beginning with mdplace'
    return
  fi

  case "${command_words[1]:-}:${command_words[2]:-}" in
    review:show)
      set_feedback 'ReviewSheetShown: _mdplace/Reviews/placement-review-42.md'
      ;;
    review:*)
      dispatch_placement_command
      ;;
    taxonomy:review)
      if [ "${command_words[3]:-}" = show ]; then
        set_feedback 'ReviewSheetShown: _mdplace/Reviews/taxonomy-reparent-17.md'
      else
        dispatch_taxonomy_command
      fi
      ;;
    prototype:note-drift)
      apply_action placement_note_drift
      ;;
    prototype:taxonomy-drift)
      apply_action taxonomy_drift
      ;;
    *)
      set_feedback 'CommandIgnored: unsupported prototype command'
      ;;
  esac
}

render() {
  local note_version='' candidate_binding='' placement_outcome=''
  local accepted_category='' outcome_revision='' placement_review=''
  local placement_projection='' current_path='' planned_path=''
  local taxonomy_revision='' proposal_base_revision=''
  local taxonomy_proposal='' taxonomy_validation='' taxonomy_approval=''
  local taxonomy_projection='' event_count='' semantic_ledger=''
  local last_feedback='' no_fit_evidence=''

  load_review_workflow_state "$state"

  if [ -t 1 ] && [ "${MDPLACE_PROTOTYPE_NO_CLEAR:-0}" != 1 ]; then
    printf '\033[2J\033[H'
  fi

  printf '%bPROTOTYPE: Markdown Review Sheet + CLI workflow%b\n' "$bold" "$reset"
  printf '%bThrowaway vault; generated sheets are read-only views; state is in memory%b\n' "$dim" "$reset"
  printf '%bPlacement%b  note-v%s / taxrev-%s / outcome-v%s / candidates %s\n' \
    "$bold" "$reset" "$note_version" "$taxonomy_revision" "$outcome_revision" "$candidate_binding"
  printf '  outcome: %-25s accepted: %s\n' "$placement_outcome" "$accepted_category"
  printf '  review:  %s\n' "$placement_review"
  printf '  projection: %s -> %s\n\n' "$placement_projection" "$planned_path"
  printf '%bTaxonomy%b   proposal: %-8s base/current: taxrev-%s/taxrev-%s\n' \
    "$bold" "$reset" "$taxonomy_proposal" "$proposal_base_revision" "$taxonomy_revision"
  printf '  validation: %-8s approval: %s\n' "$taxonomy_validation" "$taxonomy_approval"
  printf '  projection: %s\n\n' "$taxonomy_projection"
  printf '%bAccepted history and review records%b  %s\n' "$bold" "$reset" "$event_count"
  printf '%bLast command feedback%b\n' "$bold" "$reset"
  printf '%s\n' "$last_feedback" | fold -s -w 74 | sed 's/^/  /'
  printf '\n'
  printf '%bOpen as an Obsidian vault from the repository root%b\n' "$bold" "$reset"
  printf '  prototypes/inbox-review-workflow-prototype/PROTOTYPE-VAULT\n'
  printf '  placement sheet: _mdplace/Reviews/placement-review-42.md\n'
  printf '  taxonomy sheet:  _mdplace/Reviews/taxonomy-reparent-17.md\n\n'
  printf '%bPaste one offered command from a sheet; [q] quits.%b\n' "$bold" "$reset"
}

write_prototype_vault "$state" "$prototype_vault"
render
pending_command=''
while IFS= read -r command_line; do
  if [[ "$command_line" == *\\ ]]; then
    pending_command="$pending_command ${command_line%\\}"
    continue
  fi
  command_line="$pending_command $command_line"
  pending_command=''
  command_line=${command_line# }
  if [ "$command_line" = q ]; then
    break
  fi
  if [ -z "$command_line" ]; then
    continue
  fi
  dispatch_command "$command_line"
  write_prototype_vault "$state" "$prototype_vault"
  render
done

printf '\nPrototype ended. Generated vault remains at %s; no semantic state was persisted.\n' "$prototype_vault"
