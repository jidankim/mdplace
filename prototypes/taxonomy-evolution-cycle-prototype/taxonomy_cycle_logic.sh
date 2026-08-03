#!/usr/bin/env bash

initial_taxonomy_cycle_state() {
  printf '%s\n' '0|0|none|disabled|disabled|0|0|none|none|no|no|5|3|clear|no|no|0|1|0|closed|0|Revision 0: stable non-placeable root only'
}

reduce_taxonomy_cycle_state() {
  state=$1
  action=$2

  IFS='|' read -r revision day bootstrap leaf_grant alias_grant cycle recurrence proposal \
    proposal_label auto_eligible human_gate unresolved_notes source_origins \
    parent_fit leaf_active alias_active leaf_observation_until negative_evidence corrections \
    circuit cooldown_until last_event <<< "$state"

  case "$proposal" in
    bootstrap_seed|leaf_ready|leaf_review|alias_ready|alias_review|merge|split|reparent|deprecate)
      proposal_pending=yes
      ;;
    *)
      proposal_pending=no
      ;;
  esac

  case "$action" in
    b)
      if [ "$bootstrap" = none ]; then
        bootstrap=draft
        proposal=bootstrap_seed
        proposal_label='Research + Projects + Reference'
        auto_eligible=no
        human_gate=yes
        last_event='BootstrapDrafted: frozen evidence produced a human-gated seed Change Set'
      else
        last_event='BootstrapIgnored: a seed draft or accepted seed already exists'
      fi
      ;;
    a)
      case "$proposal" in
        bootstrap_seed)
          revision=$((revision + 1))
          bootstrap=accepted
          proposal=none
          proposal_label=none
          human_gate=no
          auto_eligible=no
          last_event='TaxonomyChangeSetAccepted: seed tree is revision 1'
          ;;
        leaf_review)
          revision=$((revision + 1))
          proposal=none
          proposal_label=none
          auto_eligible=no
          human_gate=no
          leaf_active=yes
          leaf_observation_until=0
          last_event='NewLeafAcceptedByHuman: taxonomy changed; all supporting notes remain Unresolved'
          ;;
        alias_review)
          revision=$((revision + 1))
          proposal=none
          proposal_label=none
          auto_eligible=no
          human_gate=no
          alias_active=yes
          last_event='AliasAcceptedByHuman: lookup vocabulary changed without rename or placement effect'
          ;;
        merge|split|reparent|deprecate)
          accepted_operation=$proposal
          revision=$((revision + 1))
          proposal=none
          proposal_label=none
          human_gate=no
          auto_eligible=no
          last_event="StructuralChangeAcceptedByHuman: $accepted_operation produced a new revision"
          ;;
        *)
          last_event='ApprovalIgnored: no human-gated proposal is ready'
          ;;
      esac
      ;;
    g)
      if [ "$bootstrap" != accepted ]; then
        last_event='GrantBlocked: an Automation Grant requires an accepted parent scope'
      elif [ "$circuit" = suspended ]; then
        last_event='GrantBlocked: circuit breaker requires explicit reset outside this prototype'
      elif [ "$leaf_grant" = enabled ]; then
        leaf_grant=disabled
        if [ "$proposal" = leaf_ready ]; then
          proposal=leaf_review
          auto_eligible=no
          human_gate=yes
        fi
        last_event='AutomationGrantRevoked: pending leaf proposals become review-only'
      else
        leaf_grant=enabled
        last_event='AutomationGrantEnabled: new leaves under Research only'
      fi
      ;;
    k)
      if [ "$bootstrap" != accepted ]; then
        last_event='AliasGrantBlocked: an Automation Grant requires an accepted target scope'
      elif [ "$alias_grant" = enabled ]; then
        alias_grant=disabled
        if [ "$proposal" = alias_ready ]; then
          proposal=alias_review
          auto_eligible=no
          human_gate=yes
        fi
        last_event='AliasAutomationGrantRevoked: pending alias proposals become review-only'
      else
        alias_grant=enabled
        last_event='AliasAutomationGrantEnabled: aliases for Graph orchestration only'
      fi
      ;;
    c)
      if [ "$bootstrap" != accepted ]; then
        last_event='CycleBlocked: revision 0 has no human-approved seed taxonomy'
      elif [ "$proposal_pending" = yes ]; then
        last_event='CycleBlocked: the current proposal requires disposition before another cycle'
      elif [ "$leaf_active" = yes ]; then
        cycle=$((cycle + 1))
        day=$((day + 7))
        proposal=none
        proposal_label=none
        auto_eligible=no
        human_gate=no
        if [ "$day" -lt "$leaf_observation_until" ]; then
          last_event='CycleCompleted: the Active leaf was not rediscovered and remains under observation'
        elif [ "$leaf_observation_until" -gt 0 ]; then
          last_event='CycleCompleted: the Active leaf was not rediscovered and remains correctable after observation'
        else
          last_event='CycleCompleted: the Active leaf was not proposed again'
        fi
      else
        cycle=$((cycle + 1))
        day=$((day + 7))
        if [ "$day" -lt "$cooldown_until" ]; then
          proposal=none
          proposal_label=none
          auto_eligible=no
          human_gate=no
          last_event="CycleCompleted: rejected concept suppressed until day $cooldown_until"
        else
          recurrence=$((recurrence + 1))
          proposal_label='Graph orchestration'
          if [ "$recurrence" -lt 2 ]; then
            proposal=leaf_shadow
            auto_eligible=no
            human_gate=no
            last_event='ShadowConceptRecorded: first recurrence has no semantic effect'
          elif [ "$parent_fit" = ambiguous ]; then
            proposal=leaf_review
            auto_eligible=no
            human_gate=yes
            last_event='NewLeafReadyForReview: evidence recurs but the candidate parent is ambiguous'
          elif [ "$leaf_grant" = enabled ] && [ "$circuit" = closed ]; then
            proposal=leaf_ready
            auto_eligible=yes
            human_gate=no
            last_event='NewLeafEligible: recurrence, source diversity, collision, and grant gates pass'
          else
            proposal=leaf_review
            auto_eligible=no
            human_gate=yes
            last_event='NewLeafReadyForReview: evidence passes but no active scoped grant applies'
          fi
        fi
      fi
      ;;
    p)
      if [ "$proposal" = leaf_ready ] && [ "$auto_eligible" = yes ] && [ "$leaf_grant" = enabled ] && [ "$circuit" = closed ]; then
        revision=$((revision + 1))
        proposal=none
        proposal_label=none
        auto_eligible=no
        human_gate=no
        leaf_active=yes
        leaf_observation_until=$((day + 30))
        last_event='NewLeafAutomaticallyPromoted: taxonomy changed; all five notes remain Unresolved'
      elif [ "$proposal" = alias_ready ] && [ "$auto_eligible" = yes ] && [ "$alias_grant" = enabled ]; then
        revision=$((revision + 1))
        proposal=none
        proposal_label=none
        auto_eligible=no
        human_gate=no
        alias_active=yes
        last_event='AliasAutomaticallyPromoted: lookup vocabulary changed without rename or placement effect'
      else
        last_event='AutomaticPromotionBlocked: the proposal lacks its operation-type grant or eligibility gates'
      fi
      ;;
    l)
      if [ "$proposal_pending" = yes ]; then
        last_event='AliasBlocked: the current proposal requires disposition before another proposal'
      elif [ "$leaf_active" != yes ]; then
        last_event='AliasBlocked: Graph orchestration is not an accepted Active category'
      elif [ "$alias_active" = yes ]; then
        last_event='AliasBlocked: Graph ops is already an accepted alias'
      else
        proposal_label='Graph ops -> Graph orchestration'
        if [ "$alias_grant" = enabled ] && [ "$cycle" -ge 2 ]; then
          proposal=alias_ready
          auto_eligible=yes
          human_gate=no
          last_event='AliasEligible: recurring cross-source usage maps unambiguously without collision'
        else
          proposal=alias_review
          auto_eligible=no
          human_gate=yes
          last_event='AliasReadyForReview: evidence exists but automatic-promotion gates are incomplete'
        fi
      fi
      ;;
    y)
      if [ "$parent_fit" = clear ]; then
        parent_fit=ambiguous
        if [ "$proposal" = leaf_ready ]; then
          proposal=leaf_review
          auto_eligible=no
          human_gate=yes
        fi
        last_event='ParentEvidenceChanged: Research and Projects are now too close for automatic nesting'
      else
        parent_fit=clear
        if [ "$proposal" = leaf_review ] && [ "$recurrence" -ge 2 ] && [ "$leaf_grant" = enabled ] && [ "$circuit" = closed ]; then
          proposal=leaf_ready
          auto_eligible=yes
          human_gate=no
        fi
        last_event='ParentEvidenceChanged: Research now clears the configured parent-fit margin'
      fi
      ;;
    m)
      if [ "$bootstrap" != accepted ]; then
        last_event='MergeBlocked: no accepted categories exist at revision 0'
      elif [ "$proposal_pending" = yes ]; then
        last_event='MergeBlocked: the current proposal requires disposition before another proposal'
      else
        proposal=merge
        proposal_label='Knowledge systems + Graph systems'
        auto_eligible=no
        human_gate=yes
        last_event='MergeProposed: impact, affected placements, projection preview, and inverse required'
      fi
      ;;
    s)
      if [ "$bootstrap" != accepted ]; then
        last_event='SplitBlocked: no accepted categories exist at revision 0'
      elif [ "$proposal_pending" = yes ]; then
        last_event='SplitBlocked: the current proposal requires disposition before another proposal'
      else
        proposal='split'
        proposal_label='Split Research into Methods + Systems'
        auto_eligible=no
        human_gate=yes
        last_event='SplitProposed: successor identities and per-note review are required'
      fi
      ;;
    r)
      if [ "$bootstrap" != accepted ]; then
        last_event='ReparentBlocked: no accepted categories exist at revision 0'
      elif [ "$proposal_pending" = yes ]; then
        last_event='ReparentBlocked: the current proposal requires disposition before another proposal'
      else
        proposal=reparent
        proposal_label='Move Graph systems under Research'
        auto_eligible=no
        human_gate=yes
        last_event='ReparentProposed: accepted identity is stable; path effects require confirmation'
      fi
      ;;
    d)
      if [ "$bootstrap" != accepted ]; then
        last_event='DeprecationBlocked: no accepted categories exist at revision 0'
      elif [ "$proposal_pending" = yes ]; then
        last_event='DeprecationBlocked: the current proposal requires disposition before another proposal'
      else
        proposal=deprecate
        proposal_label='Deprecate Legacy tooling'
        auto_eligible=no
        human_gate=yes
        last_event='DeprecationProposed: identity and existing placements remain for review'
      fi
      ;;
    n)
      clear_proposal=no
      case "$proposal" in
        none)
          if [ "$leaf_observation_until" -gt 0 ]; then
            last_event='RejectionIgnored: accepted changes require correction or reversal'
          else
            last_event='RejectionIgnored: no proposal is selected'
          fi
          ;;
        bootstrap_seed)
          bootstrap=none
          clear_proposal=yes
          last_event='BootstrapRejected: draft discarded without changing taxonomy or evolution evidence'
          ;;
        leaf_shadow|leaf_ready|leaf_review)
          negative_evidence=$((negative_evidence + 1))
          recurrence=0
          cooldown_until=$((day + 30))
          clear_proposal=yes
          last_event="LeafProposalRejected: version-bound negative evidence and cooldown through day $cooldown_until"
          ;;
        alias_ready|alias_review)
          negative_evidence=$((negative_evidence + 1))
          clear_proposal=yes
          last_event='AliasProposalRejected: version-bound negative evidence recorded without changing leaf-discovery cooldown'
          ;;
        merge|split|reparent|deprecate)
          rejected_operation=$proposal
          negative_evidence=$((negative_evidence + 1))
          clear_proposal=yes
          last_event="StructuralProposalRejected: $rejected_operation recorded without changing leaf-discovery cooldown"
          ;;
        *)
          last_event='RejectionIgnored: selected state is not a pending proposal'
          ;;
      esac
      if [ "$clear_proposal" = yes ]; then
        proposal=none
        proposal_label=none
        auto_eligible=no
        human_gate=no
      fi
      ;;
    x)
      if [ "$proposal_pending" = yes ]; then
        last_event='CorrectionBlocked: the current proposal requires disposition; the accepted leaf remains correctable'
      elif [ "$leaf_observation_until" -gt 0 ] && [ "$leaf_active" = yes ]; then
        negative_evidence=$((negative_evidence + 1))
        correction_attributed=no
        if [ "$day" -lt "$leaf_observation_until" ]; then
          corrections=$((corrections + 1))
          correction_attributed=yes
        fi
        revision=$((revision + 1))
        proposal=none
        proposal_label=none
        recurrence=0
        leaf_active=no
        leaf_observation_until=0
        cooldown_until=$((day + 30))
        if [ "$correction_attributed" = yes ] && [ "$corrections" -ge 2 ]; then
          circuit=suspended
          leaf_grant=disabled
          if [ "$alias_active" = yes ]; then
            alias_active=no
            last_event='CompensatingTaxonomyChangeAppended: alias dependency retired; second correction suspended the scoped new-leaf grant'
          else
            last_event='TaxonomyReversalAppended: second correction suspended the scoped new-leaf grant'
          fi
        elif [ "$alias_active" = yes ]; then
          alias_active=no
          last_event="CompensatingTaxonomyChangeAppended: the accepted alias dependency was retired; rediscovery cools down through day $cooldown_until"
        elif [ "$correction_attributed" = no ]; then
          last_event="TaxonomyReversalAppended: correction fell outside grant attribution; rediscovery cools down through day $cooldown_until"
        else
          last_event="TaxonomyReversalAppended: correction recorded; rediscovery cools down through day $cooldown_until"
        fi
      else
        last_event='CorrectionIgnored: no current automatically promoted leaf is under observation'
      fi
      ;;
    t)
      day=$((day + 30))
      last_event='ClockAdvanced: 30-day observation or cooldown window elapsed'
      ;;
    *)
      last_event='IgnoredAction'
      ;;
  esac

  printf '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\n' \
    "$revision" "$day" "$bootstrap" "$leaf_grant" "$alias_grant" "$cycle" "$recurrence" \
    "$proposal" "$proposal_label" "$auto_eligible" "$human_gate" \
    "$unresolved_notes" "$source_origins" "$parent_fit" "$leaf_active" \
    "$alias_active" "$leaf_observation_until" "$negative_evidence" "$corrections" \
    "$circuit" "$cooldown_until" "$last_event"
}
