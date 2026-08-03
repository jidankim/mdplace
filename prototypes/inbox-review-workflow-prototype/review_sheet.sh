#!/usr/bin/env bash

render_semantic_ledger_markdown() {
  local remaining_ledger=$semantic_ledger
  local ledger_entry=''

  while [[ "$remaining_ledger" == *' <> '* ]]; do
    ledger_entry=${remaining_ledger%% <> *}
    printf -- '- `%s`\n' "$ledger_entry"
    remaining_ledger=${remaining_ledger#* <> }
  done
  printf -- '- `%s`\n' "$remaining_ledger"
}

begin_command_block() {
  printf '**%s**\n\n```console\n' "$1"
}

end_command_block() {
  printf '```\n\n'
}

render_placement_commands_markdown() {
  local note_binding="note-v$note_version/taxrev-$taxonomy_revision"
  local note_token="note-v$note_version"
  local outcome_token="outcome-v$outcome_revision"

  if [ "$placement_outcome" = user_deferred ]; then
    begin_command_block 'Resume evaluation'
    printf '%s\n' \
      'mdplace review resume review:placement-42 \' \
      "  --expect $note_token \\" \
      "  --expect-outcome $outcome_token"
    end_command_block
  elif [ "$placement_outcome" = accepted_primary_category ]; then
    if [ "$candidate_binding" = current ]; then
      begin_command_block 'Override with Knowledge tools'
      printf '%s\n' \
        'mdplace review override review:placement-42 \' \
        '  --category cat:projects/knowledge-tools \' \
        "  --expect $note_binding \\" \
        "  --expect-outcome $outcome_token \\" \
        '  --because reviewed-alternative-is-better'
      end_command_block
    else
      begin_command_block 'Refresh candidate evidence'
      printf '%s\n' \
        'mdplace review evaluate review:placement-42 \' \
        "  --expect $note_token \\" \
        "  --expect-outcome $outcome_token"
      end_command_block
    fi
    begin_command_block 'Retract accepted placement'
    printf '%s\n' \
      'mdplace review retract review:placement-42 \' \
      "  --expect-outcome $outcome_token \\" \
      '  --because accepted-placement-is-wrong'
    end_command_block
  else
    if [ "$candidate_binding" = current ]; then
      begin_command_block 'Accept Graph systems'
      printf '%s\n' \
        'mdplace review accept review:placement-42 \' \
        '  --category cat:research/graph-systems \' \
        "  --expect $note_binding \\" \
        "  --expect-outcome $outcome_token \\" \
        '  --because reviewed-evidence-supports-category'
      end_command_block
      begin_command_block 'Override with Knowledge tools'
      printf '%s\n' \
        'mdplace review override review:placement-42 \' \
        '  --category cat:projects/knowledge-tools \' \
        "  --expect $note_binding \\" \
        "  --expect-outcome $outcome_token \\" \
        '  --because reviewed-alternative-is-better'
      end_command_block
      begin_command_block 'Confirm No Fitting Category'
      printf '%s\n' \
        'mdplace review no-fit review:placement-42 \' \
        "  --expect $note_binding \\" \
        "  --expect-outcome $outcome_token \\" \
        '  --because no-active-category-fits'
      end_command_block
    else
      begin_command_block 'Refresh candidate evidence'
      printf '%s\n' \
        'mdplace review evaluate review:placement-42 \' \
        "  --expect $note_token \\" \
        "  --expect-outcome $outcome_token"
      end_command_block
    fi
    begin_command_block 'Defer review'
    printf '%s\n' \
      'mdplace review defer review:placement-42 \' \
      "  --expect $note_token \\" \
      "  --expect-outcome $outcome_token \\" \
      '  --because decide-later'
    end_command_block
  fi
}

render_taxonomy_commands_markdown() {
  case "$taxonomy_proposal:$taxonomy_validation:$taxonomy_approval" in
    review:pending:none)
      begin_command_block 'Validate current proposal'
      printf '%s\n' \
        'mdplace taxonomy review validate txp:reparent-17 \' \
        "  --expect taxrev-$taxonomy_revision"
      end_command_block
      begin_command_block 'Reject proposal'
      printf '%s\n' \
        'mdplace taxonomy review reject txp:reparent-17 \' \
        "  --expect taxrev-$taxonomy_revision \\" \
        '  --because semantic-change-is-wrong'
      end_command_block
      ;;
    review:passed:none)
      begin_command_block 'Stage approval'
      printf '%s\n' \
        'mdplace taxonomy review approve txp:reparent-17 \' \
        "  --expect taxrev-$taxonomy_revision \\" \
        '  --validation validation:preview-17 \' \
        '  --because diff-and-inverse-are-correct'
      end_command_block
      begin_command_block 'Reject proposal'
      printf '%s\n' \
        'mdplace taxonomy review reject txp:reparent-17 \' \
        "  --expect taxrev-$taxonomy_revision \\" \
        '  --because semantic-change-is-wrong'
      end_command_block
      ;;
    review:passed:confirm:*)
      begin_command_block 'Final confirmation'
      printf '%s\n' \
        "mdplace taxonomy review confirm $taxonomy_approval \\" \
        "  --expect taxrev-$taxonomy_revision"
      end_command_block
      begin_command_block 'Reject proposal'
      printf '%s\n' \
        'mdplace taxonomy review reject txp:reparent-17 \' \
        "  --expect taxrev-$taxonomy_revision \\" \
        '  --because semantic-change-is-wrong'
      end_command_block
      ;;
    stale:*)
      begin_command_block 'Re-evaluate stale proposal'
      printf '%s\n' \
        'mdplace taxonomy review reevaluate txp:reparent-17 \' \
        "  --expect taxrev-$taxonomy_revision"
      end_command_block
      begin_command_block 'Reject proposal'
      printf '%s\n' \
        'mdplace taxonomy review reject txp:reparent-17 \' \
        "  --expect taxrev-$taxonomy_revision \\" \
        '  --because proposal-is-no-longer-wanted'
      end_command_block
      ;;
    *)
      printf 'No review command is valid after a terminal disposition.\n'
      ;;
  esac
}

render_placement_review_sheet() {
  local current_reason=''

  case "$placement_outcome" in
    accepted_primary_category) current_reason='None; a Primary Category is accepted' ;;
    user_deferred) current_reason='User Deferred' ;;
    no_fitting_category) current_reason='No Fitting Category' ;;
    awaiting_evaluation) current_reason='Awaiting Evaluation' ;;
    ambiguous_candidates) current_reason='Ambiguous Candidates' ;;
    *) current_reason=$placement_outcome ;;
  esac

  printf '%s\n' '---'
  printf 'mdplace_generated: true\n'
  printf 'review_id: review:placement-42\n'
  printf 'subject_id: file:01JGRAPH\n'
  printf 'observed_note_version: note-v%s\n' "$note_version"
  printf 'taxonomy_revision: taxrev-%s\n' "$taxonomy_revision"
  printf 'placement_outcome_revision: outcome-v%s\n' "$outcome_revision"
  printf '%s\n\n' '---'
  printf '# Placement Review: Graph orchestration\n\n'
  printf '> [!WARNING] GENERATED READ MODEL — EDITS ARE IGNORED\n'
  printf '> Copy a currently offered command into the prototype terminal. Regeneration replaces this file; Markdown edits never create decisions.\n\n'
  printf 'Subject: [[Inbox/Graph orchestration]] (`file:01JGRAPH`)  \n'
  printf 'Review: `review:placement-42` — **%s**\n\n' "$placement_review"
  printf '## Current Placement Outcome\n\n'
  printf '| Field | Current value |\n| --- | --- |\n'
  printf '| Outcome | `%s` |\n' "$placement_outcome"
  printf '| Accepted Primary Category | `%s` |\n' "$accepted_category"
  printf '| Unresolved Placement Reason | %s |\n' "$current_reason"
  printf '| Compare token | `outcome-v%s` |\n' "$outcome_revision"
  printf '| Candidate binding | `note-v%s` / `taxrev-%s` — **%s** |\n\n' \
    "$note_version" "$taxonomy_revision" "$candidate_binding"
  printf '## Non-authoritative evidence and candidates\n\n'
  printf '> Fit scores are not probabilities; calibrated correctness is shown separately. Neither is accepted truth.\n\n'
  printf '1. **Graph systems** — `cat:research/graph-systems`\n'
  printf '   - fit `0.82`; calibrated correctness `0.74`\n'
  printf '   - for: title and headings; against: project annotation\n'
  printf '2. **Knowledge tools** — `cat:projects/knowledge-tools`\n'
  printf '   - fit `0.76`; calibrated correctness `0.70`\n'
  printf '   - for: tooling terms; against: research exemplar\n\n'
  printf 'Diagnosis: ambiguity margin `0.06` is below the current Placement Policy limit.\n\n'
  printf '## Projection preview — not semantic truth\n\n'
  printf '| Current path | Planned path | Status |\n| --- | --- | --- |\n'
  printf '| `%s` | `%s` | `%s` |\n\n' "$current_path" "$planned_path" "$placement_projection"
  printf 'Review decisions never move files. Folder Projection is a separate operation.\n\n'
  printf '## Available commands for this exact state\n\n'
  render_placement_commands_markdown
  printf '\nSimulation-only input drift: `mdplace prototype note-drift`\n\n'
  printf '## Accepted history and review records\n\n'
  render_semantic_ledger_markdown
  printf '\nLast command feedback: `%s`\n' "$last_feedback"
}

render_taxonomy_review_sheet() {
  local gate_result='Pending'
  local staleness='Current'

  if [ "$taxonomy_validation" = passed ]; then
    gate_result='Pass'
  fi
  case "$taxonomy_proposal" in
    accepted) staleness="Not applicable — accepted as taxrev-$taxonomy_revision" ;;
    rejected) staleness='Not applicable — rejected' ;;
    stale) staleness='Stale — re-evaluation required' ;;
    *)
      if [ "$proposal_base_revision" != "$taxonomy_revision" ]; then
        staleness='Stale — re-evaluation required'
      fi
      ;;
  esac

  printf '%s\n' '---'
  printf 'mdplace_generated: true\n'
  printf 'proposal_id: txp:reparent-17\n'
  printf 'proposal_base_revision: taxrev-%s\n' "$proposal_base_revision"
  printf 'current_taxonomy_revision: taxrev-%s\n' "$taxonomy_revision"
  printf '%s\n\n' '---'
  printf '# High-impact Taxonomy Review: reparent Graph systems\n\n'
  printf '> [!WARNING] GENERATED READ MODEL — EDITS ARE IGNORED\n'
  printf '> Approval and final confirmation are separate CLI actions. Regeneration replaces this file.\n\n'
  printf '## Review gate\n\n'
  printf '| Field | Current value |\n| --- | --- |\n'
  printf '| Proposal | `txp:reparent-17` — **%s** |\n' "$taxonomy_proposal"
  printf '| Base / current revision | `taxrev-%s` / `taxrev-%s` |\n' "$proposal_base_revision" "$taxonomy_revision"
  printf '| Impact | **HIGH** — 3 categories, 12 accepted notes, 12 projected moves |\n'
  printf '| Staleness | **%s** |\n' "$staleness"
  printf '| Validation | `%s` |\n' "$taxonomy_validation"
  printf '| Staged confirmation challenge | `%s` |\n\n' "$taxonomy_approval"
  printf '## Evidence and safety gates\n\n'
  printf '> Illustrative prototype evidence remains non-authoritative until the Taxonomy Change Set is confirmed.\n\n'
  printf '| Review input | Detail |\n| --- | --- |\n'
  printf '| Operation / stable identity | Reparent `cat:graph-systems`; Category Identity is unchanged |\n'
  printf '| Candidate / alternate parent | `cat:research` / retain `cat:knowledge` |\n'
  printf '| Evidence | 8 reviewed research placements across 5 source origins and 3 cycles over 21 days |\n'
  printf '| Counterevidence | 2 reviewed project annotations; neither changes the primary research fit |\n'
  printf '| Examples / counterexample | [[Inbox/Graph orchestration]], [[Research/Graph databases]], [[Projects/Knowledge graph launch]] |\n'
  printf '| Automation authority | Not applicable; reparent is Human-Gated Taxonomy Change |\n'
  printf '| Identity and mapping validation | **%s** |\n' "$gate_result"
  printf '| Collision and dependency validation | **%s** — 0 path collisions; intended inverse currently dependency-safe |\n' "$gate_result"
  printf '| Projection-plan validation | **%s** — 12 identities and before-hashes bound to `taxrev-%s` |\n\n' \
    "$gate_result" "$proposal_base_revision"
  printf '## Full semantic diff and intended inverse\n\n'
  printf '```diff\n'
  printf -- '- cat:graph-systems parent: cat:knowledge\n'
  printf -- '+ cat:graph-systems parent: cat:research\n'
  printf '```\n\n'
  printf -- '- Category Identity remains stable.\n'
  printf -- '- Twelve accepted placements remain accepted.\n'
  printf -- '- Intended inverse: reparent `cat:graph-systems` to `cat:knowledge` when dependency-safe; otherwise emit a Compensating Taxonomy Change.\n\n'
  printf '<details><summary>Affected accepted notes (12)</summary>\n\n'
  printf '%s\n' '- [[Inbox/Graph orchestration]]' '- [[Research/Graph databases]]' '- [[Research/Distributed graph processing]]' '- [[Research/Graph query languages]]' '- [[Research/Knowledge graph evaluation]]' '- [[Research/Graph neural networks]]' '- [[Research/Property graph modeling]]' '- [[Research/Graph storage engines]]' '- [[Research/Graph retrieval systems]]' '- [[Research/Graph visualization]]' '- [[Research/Temporal graphs]]' '- [[Research/Graph provenance]]'
  printf '\n</details>\n\n'
  printf '## Rollback plan\n\n'
  printf 'After acceptance, rollback appends a new Taxonomy Reversal against the accepted revision when the inverse remains dependency-safe. If later taxonomy changes, placements, or projections invalidate that inverse, mdplace must propose a Compensating Taxonomy Change with a fresh impact report and confirmation; history is never rewound.\n\n'
  printf '## Projection preview — not yet applied\n\n'
  printf '| Projection fact | Value |\n| --- | --- |\n'
  printf '| Current prefix | `Knowledge/Graph systems/` |\n'
  printf '| Planned prefix | `Research/Graph systems/` |\n'
  printf '| Projected file moves | 12 |\n'
  printf '| Collisions | 0 |\n'
  printf '| Body-link rewrites | 0 |\n\n'
  printf 'Projection status: `%s`; Folder Projection remains a separate operation.\n\n' "$taxonomy_projection"
  printf '## Available commands for this exact state\n\n'
  render_taxonomy_commands_markdown
  if [ "$taxonomy_proposal" != accepted ] && [ "$taxonomy_proposal" != rejected ]; then
    printf '\nSimulation-only concurrent change: `mdplace prototype taxonomy-drift`\n'
  fi
  printf '\n## Accepted history and review records\n\n'
  render_semantic_ledger_markdown
  printf '\nLast command feedback: `%s`\n' "$last_feedback"
}

write_prototype_vault() {
  local state=$1
  local vault_dir=$2
  local review_dir="$vault_dir/_mdplace/Reviews"
  local inbox_dir="$vault_dir/Inbox"

  load_review_workflow_state "$state"
  mkdir -p "$review_dir" "$inbox_dir"

  if [ ! -e "$inbox_dir/Graph orchestration.md" ]; then
    {
      printf '# Graph orchestration\n\n'
      printf 'Prototype Captured Tab Note used to check the Inbox review workflow.\n'
    } > "$inbox_dir/Graph orchestration.md"
  fi

  render_placement_review_sheet > "$review_dir/placement-review-42.md"
  render_taxonomy_review_sheet > "$review_dir/taxonomy-reparent-17.md"
}
