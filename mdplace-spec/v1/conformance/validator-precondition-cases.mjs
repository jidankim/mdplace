import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {requiredCandidateFoundationSlots, requiredReleaseSlots} from './package-checks.mjs';
import {observeTransition} from './transition-observer.mjs';
import {completeTransition} from './validator-test-support.mjs';

const digestReference = 'package-manifest.yaml#/normative_digest';

async function transitionRoot({artifactContent = 'changed\n', table}) {
  const root = await mkdtemp(join(tmpdir(), 'mdplace-transition-precondition-'));
  await mkdir(join(root, 'normative'), {recursive: true});
  await mkdir(join(root, 'contracts/schemas'), {recursive: true});
  await mkdir(join(root, 'contracts/transitions'), {recursive: true});
  await writeFile(
    join(root, 'contracts/schemas/package-manifest.schema.json'),
    await readFile(new URL('../contracts/schemas/package-manifest.schema.json', import.meta.url)),
  );
  const declaredContent = 'declared\n';
  const artifactDigest = createHash('sha256').update(declaredContent).digest('hex');
  const normativeDigest = createHash('sha256').update(`normative/contract.md\0${artifactDigest}\n`).digest('hex');
  await writeFile(join(root, 'normative/contract.md'), artifactContent);
  await writeFile(join(root, 'package-manifest.yaml'), JSON.stringify({
    $schema: 'contracts/schemas/package-manifest.schema.json', schema_id: 'mdplace.package-manifest/v1',
    package_series: 'mdplace-spec/v1', release_version: '1.0.0', lifecycle_state: 'candidate',
    validator_version: '1.0.0', normative_vocabulary: '../../CONTEXT.md',
    authority: {normative_rule: 'binding', informative_rule: 'nonbinding', conflict_result: 'informative_ignored_for_conformance'},
    layout: {required_release_slots: requiredReleaseSlots, candidate_foundation_slots: requiredCandidateFoundationSlots},
    artifacts: [{path: 'normative/contract.md', authority: 'normative', media_type: 'text/markdown', sha256: artifactDigest}],
    normative_digest: normativeDigest,
    conformance_digest: createHash('sha256').update('').digest('hex'),
    amendment_policy: {immutable_after_release: true, in_place_mutation: 'forbidden', new_version_required: true, previous_release: null},
    conformance: {manifest: 'conformance/manifest.yaml', validator: 'conformance/validator.mjs', report: 'conformance/evidence/validation-report.json'},
  }));
  await writeFile(join(root, 'contracts/transitions/package-lifecycle.json'), JSON.stringify(table));
  return root;
}

function fixture(command, fromState, actors) {
  return {subject: {
    kind: 'transition', table: 'contracts/transitions/package-lifecycle.json', from_state: fromState, command,
    actors, base_references: {package_series: 'mdplace-spec/v1', release_version: '1.0.0', normative_digest_ref: digestReference},
    preconditions: {
      manifest_ref: 'package-manifest.yaml',
      state_manifest_ref: 'package-manifest.yaml',
      artifact_ledger_ref: 'package-manifest.yaml#/artifacts',
      normative_digest_ref: digestReference,
    },
    release_evidence: null,
    idempotency_key: `fixture-${command}`, idempotency_status: 'new',
  }};
}

function actor(id, roles) {
  return {principal_id: id, identity_assurance: 'canonical_authenticated_human', roles, delegated: false};
}

test('submit rejects a caller assertion when manifest-bound bytes have drifted', async () => {
  // Given an allowed submit whose caller claims success after an artifact changed.
  const table = {transitions: [completeTransition()]};
  const root = await transitionRoot({table});

  // When the transition oracle evaluates public package state.
  const observed = await observeTransition(fixture('submit', 'draft', [actor('person:author-001', ['package_author'])]), root);

  // Then the caller Boolean cannot override the observable digest mismatch.
  assert.equal(observed.verdict, 'fail');
  assert.deepEqual(observed.codes, ['transition.precondition_failed']);
});

test('approve rejects a caller assertion when candidate bytes have drifted', async () => {
  // Given an allowed approval with valid distinct authorities but invalid artifact bindings.
  const table = {transitions: [completeTransition({
    command_or_event: 'approve', from_state: 'candidate', terminal_state: 'release_ready',
    actor_authority: {roles: ['vault_owner', 'independent_technical_reviewer'], quorum: 2, distinct_actors: true, delegation: 'forbidden'},
  })]};
  const root = await transitionRoot({table});
  const actors = [actor('person:owner-001', ['vault_owner']), actor('person:reviewer-001', ['independent_technical_reviewer'])];

  // When the transition oracle evaluates public candidate state.
  const observed = await observeTransition(fixture('approve', 'candidate', actors), root);

  // Then valid authority cannot compensate for unmet candidate preconditions.
  assert.equal(observed.verdict, 'fail');
});

test('amend rejects a caller assertion without observable amendment evidence', async () => {
  // Given an allowed amendment carrying only the legacy trusted Boolean.
  const table = {transitions: [completeTransition({command_or_event: 'amend', from_state: 'released', terminal_state: 'released'})]};
  const root = await transitionRoot({artifactContent: 'declared\n', table});

  // When the transition oracle evaluates the amendment.
  const observed = await observeTransition(fixture('amend', 'released', [actor('person:author-001', ['package_author'])]), root);

  // Then missing observable version, path, and source-preservation evidence denies it.
  assert.equal(observed.verdict, 'fail');
  assert.deepEqual(observed.codes, ['transition.precondition_failed']);
});
