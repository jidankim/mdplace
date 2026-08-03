#!/usr/bin/env bash

initial_review_workflow_state() {
  printf '%s\n' '7|current|ambiguous_candidates|none|0|open|not_requested|Inbox/Graph orchestration.md|none|12|12|review|pending|none|not_requested|0|e0:Prototype initialized|Prototype initialized|no'
}

load_review_workflow_state() {
  local remaining_state=$1
  local state_fields=()

  while [[ "$remaining_state" == *'|'* ]]; do
    state_fields+=("${remaining_state%%|*}")
    remaining_state=${remaining_state#*|}
  done
  state_fields+=("$remaining_state")

  note_version=${state_fields[0]}
  candidate_binding=${state_fields[1]}
  placement_outcome=${state_fields[2]}
  accepted_category=${state_fields[3]}
  outcome_revision=${state_fields[4]}
  placement_review=${state_fields[5]}
  placement_projection=${state_fields[6]}
  current_path=${state_fields[7]}
  planned_path=${state_fields[8]}
  taxonomy_revision=${state_fields[9]}
  proposal_base_revision=${state_fields[10]}
  taxonomy_proposal=${state_fields[11]}
  taxonomy_validation=${state_fields[12]}
  taxonomy_approval=${state_fields[13]}
  taxonomy_projection=${state_fields[14]}
  event_count=${state_fields[15]}
  semantic_ledger=${state_fields[16]}
  last_feedback=${state_fields[17]}
  no_fit_evidence=${state_fields[18]}
}

serialize_review_workflow_state() {
  printf '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\n' \
    "$note_version" "$candidate_binding" "$placement_outcome" \
    "$accepted_category" "$outcome_revision" "$placement_review" \
    "$placement_projection" "$current_path" "$planned_path" \
    "$taxonomy_revision" "$proposal_base_revision" "$taxonomy_proposal" \
    "$taxonomy_validation" "$taxonomy_approval" "$taxonomy_projection" \
    "$event_count" "$semantic_ledger" "$last_feedback" "$no_fit_evidence"
}

review_workflow_state_with_feedback() {
  local state=$1
  local feedback=$2

  load_review_workflow_state "$state"
  last_feedback=$feedback
  serialize_review_workflow_state
}

append_semantic_event() {
  event_count=$((event_count + 1))
  semantic_ledger="$semantic_ledger <> e$event_count:$last_feedback"
}

invalidate_placement_candidates_for_taxonomy_change() {
  candidate_binding=stale
  case "$placement_outcome" in
    accepted_primary_category)
      placement_review=accepted_under_review
      ;;
    user_deferred)
      placement_review=resolved
      ;;
    *)
      if [ "$placement_outcome" != awaiting_evaluation ]; then
        outcome_revision=$((outcome_revision + 1))
      fi
      placement_outcome=awaiting_evaluation
      accepted_category=none
      placement_review=waiting_for_evaluation
      placement_projection=not_requested
      planned_path=none
      ;;
  esac
}

expect_current_note_binding() {
  local expected=$1

  if [ "$expected" != "note-v$note_version/taxrev-$taxonomy_revision" ]; then
    last_feedback="CommandBlocked: expected note-v$note_version/taxrev-$taxonomy_revision; regenerate the Review Sheet"
    return 1
  fi
}

expect_current_note_version() {
  local expected=$1

  if [ "$expected" != "note-v$note_version" ]; then
    last_feedback="CommandBlocked: expected note-v$note_version; regenerate the Review Sheet"
    return 1
  fi
}

expect_current_outcome() {
  local expected=$1

  if [ "$expected" != "outcome-v$outcome_revision" ]; then
    last_feedback="CommandBlocked: expected outcome-v$outcome_revision; another placement decision won"
    return 1
  fi
}

expect_current_taxonomy_revision() {
  local expected=$1

  if [ "$expected" != "taxrev-$taxonomy_revision" ]; then
    last_feedback="CommandBlocked: expected taxrev-$taxonomy_revision; regenerate the Review Sheet"
    return 1
  fi
}

accept_placement_category() {
  local category=$1
  local path=$2
  local expected_binding=$3
  local expected_outcome=$4
  local decision_kind=$5

  if ! expect_current_note_binding "$expected_binding" || \
     ! expect_current_outcome "$expected_outcome"; then
    return
  fi

  if [ "$placement_outcome" = user_deferred ]; then
    last_feedback='PlacementDecisionBlocked: User Deferred requires explicit resume first'
    return
  fi

  if [ "$candidate_binding" != current ]; then
    last_feedback='PlacementDecisionBlocked: candidate binding is stale; run a current evaluation'
    return
  fi

  if [ "$placement_outcome" = accepted_primary_category ] && [ "$accepted_category" = "$category" ]; then
    last_feedback='PlacementDecisionIgnored: that Category Identity is already accepted'
    return
  fi

  if [ "$placement_outcome" = accepted_primary_category ]; then
    local prior_category=$accepted_category
    last_feedback="PlacementReplaced: $prior_category superseded by $category through $decision_kind"
  else
    last_feedback="PlacementAccepted: $category through $decision_kind"
  fi

  placement_outcome=accepted_primary_category
  accepted_category=$category
  outcome_revision=$((outcome_revision + 1))
  placement_review=resolved
  placement_projection=requested
  planned_path=$path
  semantic_change=yes
}

reduce_review_workflow_state() {
  local state=$1
  local action=$2
  local action_name=''
  local action_arg_1=''
  local action_arg_2=''
  local semantic_change=no

  load_review_workflow_state "$state"
  IFS='~' read -r action_name action_arg_1 action_arg_2 _ <<< "$action"

  case "$action_name" in
    placement_accept)
      accept_placement_category \
        'cat:research/graph-systems' \
        'Research/Graph systems/Graph orchestration.md' \
        "$action_arg_1" "$action_arg_2" \
        'reviewed candidate acceptance'
      ;;
    placement_override)
      accept_placement_category \
        'cat:projects/knowledge-tools' \
        'Projects/Knowledge tools/Graph orchestration.md' \
        "$action_arg_1" "$action_arg_2" \
        'explicit human override with rationale'
      ;;
    placement_defer)
      if ! expect_current_note_version "$action_arg_1" || \
         ! expect_current_outcome "$action_arg_2"; then
        :
      elif [ "$placement_outcome" = accepted_primary_category ]; then
        last_feedback='DeferBlocked: retract the accepted Primary Category before deferring'
      elif [ "$placement_outcome" = user_deferred ]; then
        last_feedback='DeferIgnored: User Deferred is already current'
      else
        placement_outcome=user_deferred
        accepted_category=none
        outcome_revision=$((outcome_revision + 1))
        placement_review=resolved
        placement_projection=not_requested
        planned_path=none
        last_feedback='PlacementDeferred: User Deferred remains current until explicit resume'
        semantic_change=yes
      fi
      ;;
    placement_no_fit)
      if ! expect_current_note_binding "$action_arg_1" || \
         ! expect_current_outcome "$action_arg_2"; then
        :
      elif [ "$placement_outcome" = accepted_primary_category ]; then
        last_feedback='NoFitBlocked: retract the accepted Primary Category before confirming no fit'
      elif [ "$placement_outcome" = user_deferred ]; then
        last_feedback='NoFitBlocked: User Deferred requires explicit resume first'
      elif [ "$candidate_binding" != current ]; then
        last_feedback='NoFitBlocked: the review requires a current candidate and evidence binding'
      else
        placement_outcome=no_fitting_category
        accepted_category=none
        outcome_revision=$((outcome_revision + 1))
        placement_review=resolved
        placement_projection=not_requested
        planned_path=none
        no_fit_evidence=yes
        last_feedback='NoFitConfirmed: version-bound Review Decision recorded; no category was created'
        semantic_change=yes
      fi
      ;;
    placement_resume)
      if ! expect_current_note_version "$action_arg_1" || \
         ! expect_current_outcome "$action_arg_2"; then
        :
      elif [ "$placement_outcome" != user_deferred ]; then
        last_feedback='ResumeBlocked: only User Deferred can be resumed'
      else
        placement_outcome=awaiting_evaluation
        accepted_category=none
        outcome_revision=$((outcome_revision + 1))
        candidate_binding=stale
        placement_review=waiting_for_evaluation
        placement_projection=not_requested
        planned_path=none
        last_feedback='PlacementEvaluationResumed: Awaiting Evaluation until a new bound run completes'
        semantic_change=yes
      fi
      ;;
    placement_evaluate)
      if ! expect_current_note_version "$action_arg_1" || \
         ! expect_current_outcome "$action_arg_2"; then
        :
      elif [ "$placement_outcome" = user_deferred ]; then
        last_feedback='EvaluationBlocked: User Deferred requires explicit resume first'
      else
        candidate_binding=current
        if [ "$placement_outcome" = accepted_primary_category ]; then
          placement_review=accepted_under_review
          last_feedback="PlacementEvaluationCompleted[note-v$note_version/taxrev-$taxonomy_revision]: accepted Primary Category remains authoritative"
        else
          if [ "$placement_outcome" != ambiguous_candidates ]; then
            outcome_revision=$((outcome_revision + 1))
          fi
          placement_outcome=ambiguous_candidates
          accepted_category=none
          placement_review=open
          placement_projection=not_requested
          planned_path=none
          last_feedback="PlacementEvaluationCompleted[note-v$note_version/taxrev-$taxonomy_revision]: Ambiguous Candidates"
        fi
        semantic_change=yes
      fi
      ;;
    placement_note_drift)
      note_version=$((note_version + 1))
      candidate_binding=stale
      if [ "$placement_outcome" = accepted_primary_category ]; then
        placement_review=accepted_under_review
        last_feedback="ObservedNoteVersionChanged[note-v$note_version]: accepted placement persists; evaluation is advisory"
      elif [ "$placement_outcome" = user_deferred ]; then
        placement_review=resolved
        last_feedback="ObservedNoteVersionChanged[note-v$note_version]: User Deferred persists; candidates became stale"
      else
        if [ "$placement_outcome" != awaiting_evaluation ]; then
          outcome_revision=$((outcome_revision + 1))
        fi
        placement_outcome=awaiting_evaluation
        placement_review=waiting_for_evaluation
        last_feedback="ObservedNoteVersionChanged[note-v$note_version]: prior evaluation became stale; Awaiting Evaluation"
      fi
      semantic_change=yes
      ;;
    placement_retract)
      if ! expect_current_outcome "$action_arg_1"; then
        :
      elif [ "$placement_outcome" != accepted_primary_category ]; then
        last_feedback='PlacementRetractionBlocked: no Primary Category is currently accepted'
      else
        local retracted_category=$accepted_category
        placement_outcome=awaiting_evaluation
        accepted_category=none
        outcome_revision=$((outcome_revision + 1))
        candidate_binding=stale
        placement_review=waiting_for_evaluation
        placement_projection=requested
        planned_path='Inbox/Graph orchestration.md'
        last_feedback="PlacementRetracted: $retracted_category superseded; Awaiting Evaluation and Inbox projection requested"
        semantic_change=yes
      fi
      ;;
    taxonomy_validate)
      if ! expect_current_taxonomy_revision "$action_arg_1"; then
        :
      elif [ "$taxonomy_proposal" != review ] || [ "$proposal_base_revision" != "$taxonomy_revision" ]; then
        last_feedback='TaxonomyValidationBlocked: only a current review proposal can be validated'
      else
        taxonomy_validation=passed
        taxonomy_approval=none
        last_feedback="TaxonomyProposalValidated[taxrev-$taxonomy_revision]: semantic diff, projection preview, inverse, and gates passed"
        semantic_change=yes
      fi
      ;;
    taxonomy_stage)
      if ! expect_current_taxonomy_revision "$action_arg_1"; then
        :
      elif [ "$taxonomy_proposal" != review ] || [ "$taxonomy_validation" != passed ]; then
        last_feedback='TaxonomyApprovalBlocked: current validation must pass before staged approval'
      else
        taxonomy_approval="confirm:txp-reparent-17/taxrev-$taxonomy_revision"
        last_feedback="TaxonomyApprovalStaged[$taxonomy_approval]: no accepted semantic effect"
        semantic_change=yes
      fi
      ;;
    taxonomy_confirm)
      if ! expect_current_taxonomy_revision "$action_arg_2"; then
        :
      elif [ "$taxonomy_proposal" != review ] || [ "$taxonomy_approval" != "$action_arg_1" ]; then
        last_feedback='FinalConfirmationBlocked: use the current staged confirmation challenge'
      else
        local accepted_base_revision=$proposal_base_revision
        taxonomy_revision=$((taxonomy_revision + 1))
        invalidate_placement_candidates_for_taxonomy_change
        taxonomy_proposal=accepted
        taxonomy_approval=confirmed
        taxonomy_projection=requested
        last_feedback="TaxonomyChangeSetAccepted[taxrev-$taxonomy_revision]: final confirmation consumed taxrev-$accepted_base_revision challenge; projection remains pending"
        semantic_change=yes
      fi
      ;;
    taxonomy_reject)
      if ! expect_current_taxonomy_revision "$action_arg_1"; then
        :
      elif [ "$taxonomy_proposal" != review ] && [ "$taxonomy_proposal" != stale ]; then
        last_feedback='TaxonomyRejectionBlocked: no reviewable proposal is current'
      else
        taxonomy_proposal=rejected
        taxonomy_validation=pending
        taxonomy_approval=none
        taxonomy_projection=not_requested
        last_feedback='TaxonomyProposalRejected: negative decision recorded without accepted or projection effect'
        semantic_change=yes
      fi
      ;;
    taxonomy_drift)
      if [ "$taxonomy_proposal" = accepted ] || [ "$taxonomy_proposal" = rejected ]; then
        last_feedback='TaxonomyDriftIgnored: the proposal already has a terminal disposition'
      else
        taxonomy_revision=$((taxonomy_revision + 1))
        invalidate_placement_candidates_for_taxonomy_change
        taxonomy_proposal=stale
        taxonomy_validation=pending
        taxonomy_approval=none
        last_feedback="TaxonomyRevisionAdvanced[taxrev-$taxonomy_revision]: proposal and confirmation challenge became stale"
        semantic_change=yes
      fi
      ;;
    taxonomy_reevaluate)
      if ! expect_current_taxonomy_revision "$action_arg_1"; then
        :
      elif [ "$taxonomy_proposal" != stale ]; then
        last_feedback='TaxonomyReevaluationBlocked: the proposal is not stale'
      else
        taxonomy_proposal=review
        proposal_base_revision=$taxonomy_revision
        taxonomy_validation=pending
        taxonomy_approval=none
        last_feedback="TaxonomyProposalReevaluated[taxrev-$taxonomy_revision]: new immutable review proposal emitted"
        semantic_change=yes
      fi
      ;;
    *)
      last_feedback='CommandIgnored: unsupported prototype action'
      ;;
  esac

  if [ "$semantic_change" = yes ]; then
    append_semantic_event
  fi

  serialize_review_workflow_state
}
