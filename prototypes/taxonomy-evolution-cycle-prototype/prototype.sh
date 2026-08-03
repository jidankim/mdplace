#!/usr/bin/env bash

set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
. "$script_dir/taxonomy_cycle_logic.sh"

bold='\033[1m'
dim='\033[2m'
reset='\033[0m'
state=$(initial_taxonomy_cycle_state)

render() {
  local revision='' day='' bootstrap='' leaf_grant='' alias_grant='' cycle=''
  local recurrence='' proposal='' proposal_label='' auto_eligible='' human_gate=''
  local unresolved_notes='' source_origins='' parent_fit='' leaf_active=''
  local alias_active='' leaf_observation_until='' leaf_change_revision=''
  local alias_change_revision='' transition_count='' negative_evidence=''
  local corrections='' circuit='' cooldown_until='' transition_ledger='' last_event=''

  load_taxonomy_cycle_state "$state"

  transition_ledger_tail=$transition_ledger
  hidden_transitions=$transition_count
  while [ "$hidden_transitions" -gt 4 ]; do
    transition_ledger_tail=${transition_ledger_tail#* <> }
    hidden_transitions=$((hidden_transitions - 1))
  done
  transition_ledger_display=${transition_ledger_tail// <> /$'\n    '}

  if [ "$leaf_observation_until" -gt 0 ]; then
    if [ "$day" -lt "$leaf_observation_until" ]; then
      leaf_correction_status="available; grant attribution through day $leaf_observation_until"
    else
      leaf_correction_status="available; grant attribution expired on day $leaf_observation_until"
    fi
  else
    leaf_correction_status=none
  fi

  candidate_parent='not applicable'
  parent_alternative='not applicable'
  label_evidence='not applicable'
  accepted_notes_affected=0
  projected_moves=0
  proposal_impact='none'

  case "$proposal" in
    bootstrap_seed)
      candidate_parent='stable non-placeable root'
      parent_alternative='flat Inbox-only operation'
      label_evidence='three seed branches from the frozen corpus snapshot'
      proposal_impact='high: first accepted taxonomy'
      ;;
    leaf_shadow|leaf_ready|leaf_review|leaf_promoted_auto|leaf_promoted_manual)
      candidate_parent='Research (fit 0.82)'
      parent_alternative='Projects (fit 0.61)'
      label_evidence="normalized label recurred in $recurrence cycle(s); one prior label rejected"
      proposal_impact='low only when additive and grant-gated'
      ;;
    alias_ready|alias_review|alias_promoted_auto|alias_promoted_manual)
      candidate_parent='target: Graph orchestration'
      parent_alternative='none; mapping must be unambiguous'
      label_evidence='Graph ops recurred across three source origins without collision'
      proposal_impact='low: lookup vocabulary only'
      ;;
    merge)
      candidate_parent='not applicable'
      parent_alternative='keep both categories active'
      label_evidence='overlap plus reviewed counterexamples required'
      accepted_notes_affected=12
      projected_moves=10
      proposal_impact='high: structural and placement-bearing'
      ;;
    split)
      candidate_parent='successors retain explicit source mapping'
      parent_alternative='keep source active and refine definitions'
      label_evidence='separable cohorts plus reviewed counterexamples required'
      accepted_notes_affected=8
      projected_moves=8
      proposal_impact='high: structural and placement-bearing'
      ;;
    reparent)
      candidate_parent='Research'
      parent_alternative='current parent'
      label_evidence='parent-fit evidence cannot override the human gate'
      accepted_notes_affected=6
      projected_moves=6
      proposal_impact='medium: path-bearing structural change'
      ;;
    deprecate)
      candidate_parent='not applicable'
      parent_alternative='retain Active with narrowed definition'
      label_evidence='usage decline alone is insufficient'
      accepted_notes_affected=4
      proposal_impact='high: accepted placements require review'
      ;;
  esac

  if [ -t 1 ] && [ "${MDPLACE_PROTOTYPE_NO_CLEAR:-0}" != 1 ]; then
    printf '\033[2J\033[H'
  fi

  printf '%bPROTOTYPE: Taxonomy Evolution Cycle%b\n' "$bold" "$reset"
  printf '%bThrowaway, in memory, no semantic or filesystem writes%b\n\n' "$dim" "$reset"

  printf '%bAccepted state%b\n' "$bold" "$reset"
  printf '  taxonomy revision: %s\n' "$revision"
  printf '  bootstrap:         %s\n' "$bootstrap"
  printf '  simulated day:     %s\n' "$day"
  printf '  cycle count:       %s\n\n' "$cycle"
  printf '  Graph orchestration leaf active: %s\n' "$leaf_active"
  printf '  Graph orchestration accepted change revision: %s\n' "$leaf_change_revision"
  printf '  Graph ops alias active:           %s\n\n' "$alias_active"
  printf '  Graph ops accepted change revision: %s\n\n' "$alias_change_revision"

  printf '%bFrozen evidence snapshot%b\n' "$bold" "$reset"
  printf '  unresolved no-fit notes: %s\n' "$unresolved_notes"
  printf '  distinct source origins: %s\n' "$source_origins"
  printf '  shadow recurrence count: %s\n' "$recurrence"
  printf '  parent-fit condition:     %s\n' "$parent_fit"
  printf '  version-bound rejections: %s\n' "$negative_evidence"
  printf '  same-cycle feedback:      forbidden\n'
  printf '  auto-output as exemplar:  forbidden until reviewed\n\n'

  printf '%bCurrent proposal%b\n' "$bold" "$reset"
  printf '  operation:          %s\n' "$proposal"
  printf '  label / scope:      %s\n' "$proposal_label"
  printf '  automatic eligible: %s\n' "$auto_eligible"
  printf '  human gate:         %s\n' "$human_gate"
  printf '  candidate parent:   %s\n' "$candidate_parent"
  printf '  alternate parent:   %s\n' "$parent_alternative"
  printf '  naming evidence:    %s\n' "$label_evidence"
  printf '  accepted notes:     %s affected\n' "$accepted_notes_affected"
  printf '  projected moves:    %s\n' "$projected_moves"
  printf '  impact:             %s\n\n' "$proposal_impact"

  printf '%bAutomation safety%b\n' "$bold" "$reset"
  printf '  scoped new-leaf grant: %s\n' "$leaf_grant"
  printf '  scoped alias grant:    %s\n' "$alias_grant"
  printf '  leaf circuit breaker:  %s\n' "$circuit"
  printf '  leaf correction:    %s\n' "$leaf_correction_status"
  printf '  attributed corrections: %s\n' "$corrections"
  printf '  cooldown until day: %s\n' "$cooldown_until"
  printf '  supporting notes:   %s remain Unresolved after taxonomy promotion\n\n' "$unresolved_notes"

  printf '%bAppend-only in-memory transition ledger (%s events; latest five shown)%b\n' \
    "$bold" "$transition_count" "$reset"
  printf '    %s\n\n' "$transition_ledger_display"

  printf '%bLast transition%b\n  %s\n\n' "$bold" "$reset" "$last_event"

  printf '%bKeys%b\n' "$bold" "$reset"
  printf '  [b] draft bootstrap  [a] human approve\n'
  printf '  [g] toggle leaf grant  [k] toggle alias grant\n'
  printf '  [c] run cycle        [p] automatic promote eligible leaf/alias\n'
  printf '  [l] alias proposal   [y] toggle clear/ambiguous parent evidence\n'
  printf '  [m] merge            [s] split          [r] reparent  [d] deprecate\n'
  printf '  [n] reject proposal  [x] correct auto-promotion      [t] +30 days\n'
  printf '  [q] quit\n'
}

render
while IFS= read -r -n 1 key; do
  case "$key" in
    q)
      break
      ;;
    $'\n'|$'\r')
      continue
      ;;
    *)
      state=$(reduce_taxonomy_cycle_state "$state" "$key")
      render
      ;;
  esac
done

printf '\nPrototype ended. No state was persisted.\n'
