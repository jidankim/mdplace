import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

import {requiredCandidateFoundationSlots, requiredReleaseSlots} from './package-checks.mjs';
import {validateAgainstSchemaPath} from './json-schema.mjs';
import {inspectAbsentPackageEntry, inspectPackageEntry, listPackageFiles, readPackageFile} from './safe-path.mjs';

function equalSets(left, right) {
  return left.length === right.length && left.every((value) => right.includes(value));
}

async function readJson(packageRoot, path) {
  const read = await readPackageFile(packageRoot, path);
  if (read.status !== 'present') return null;
  try {
    return JSON.parse(read.content.toString('utf8'));
  } catch {
    return null;
  }
}

function observedPath(root, path) {
  return root === '.' ? path : `${root}/${path}`;
}

async function observedPackage(packageRoot, observationRoot, manifestReference, requiredSlots, requiredArtifacts) {
  const manifestPath = observedPath(observationRoot, manifestReference);
  const manifest = await readJson(packageRoot, manifestPath);
  if (manifest === null) return null;
  const schemaErrors = await validateAgainstSchemaPath(
    packageRoot,
    'contracts/schemas/package-manifest.schema.json',
    manifest,
  );
  if (schemaErrors.length > 0) return null;
  const directory = manifestPath.split('/').slice(0, -1).join('/');
  const inspectedRoot = await inspectPackageEntry(packageRoot, directory, 'directory');
  if (inspectedRoot.status !== 'present') return null;
  const listing = await listPackageFiles(inspectedRoot.target);
  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  const artifactPaths = artifacts.map(({path}) => path);
  const listedPaths = listing.paths.filter((path) => path !== 'package-manifest.yaml');
  if (listing.status !== 'present' || !equalSets(artifactPaths, listedPaths) ||
      new Set(artifactPaths).size !== artifactPaths.length ||
      requiredArtifacts.some((path) => !artifactPaths.includes(path))) return null;
  const slotsMatch = (await Promise.all(requiredSlots.map((path) =>
    inspectPackageEntry(inspectedRoot.target, path, path.endsWith('/') ? 'directory' : 'file'))))
    .every(({status}) => status === 'present');
  if (!slotsMatch) return null;
  const bindingsMatch = (await Promise.all(artifacts.map(async (artifact) => {
    if (artifact === null || typeof artifact !== 'object' || typeof artifact.path !== 'string' ||
        typeof artifact.sha256 !== 'string' || !['normative', 'informative'].includes(artifact.authority)) return false;
    const read = await readPackageFile(inspectedRoot.target, artifact.path);
    return read.status === 'present' && createHash('sha256').update(read.content).digest('hex') === artifact.sha256;
  }))).every(Boolean);
  const digest = createHash('sha256').update(artifacts
    .filter(({authority}) => authority === 'normative')
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(({path, sha256}) => `${path}\0${sha256}\n`).join('')).digest('hex');
  return bindingsMatch && digest === manifest.normative_digest
    ? {manifest, root: inspectedRoot.target, artifacts}
    : null;
}

async function requirementSection(root, entry) {
  if (typeof entry?.normative_anchor !== 'string') return null;
  const [path] = entry.normative_anchor.split('#', 1);
  const read = await readPackageFile(root, path);
  if (read.status !== 'present') return null;
  const lines = read.content.toString('utf8').split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`## ${entry.id}:`));
  if (start === -1) return null;
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start, next === -1 ? undefined : next).join('\n').trim();
}

function isGreaterSemver(target, source) {
  const semver = /^[1-9][0-9]*\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
  if (!semver.test(target) || !semver.test(source)) return false;
  const targetParts = target.split('.').map(Number);
  const sourceParts = source.split('.').map(Number);
  return targetParts.some((part, index) => part > sourceParts[index] &&
    targetParts.slice(0, index).every((earlier, earlierIndex) => earlier === sourceParts[earlierIndex]));
}

export async function amendmentEvidenceMatches(subject, packageRoot) {
  const evidence = subject.amendment_evidence;
  if (evidence === null || evidence === undefined) return false;
  const rootIsSafe = /^conformance\/release-targets\/[a-z][a-z0-9-]{2,63}$/.test(evidence.observation_root ?? '');
  if (!rootIsSafe || typeof evidence.source_manifest !== 'string' ||
      typeof evidence.target_manifest !== 'string' || !Array.isArray(evidence.changed_requirement_ids) ||
      !Array.isArray(evidence.new_requirement_ids) ||
      evidence.changed_requirement_ids.length + evidence.new_requirement_ids.length === 0) return false;
  const [sourcePackage, targetPackage] = await Promise.all([
    observedPackage(packageRoot, evidence.observation_root, evidence.source_manifest, requiredReleaseSlots, [
      'normative/package-contract.md',
      'normative/requirements.json',
      'conformance/manifest.yaml',
      'conformance/evidence/validation-report.json',
      'conformance/evidence/traceability-report.json',
      'traceability.yaml',
    ]),
    observedPackage(packageRoot, evidence.observation_root, evidence.target_manifest, requiredCandidateFoundationSlots, [
      'normative/package-contract.md',
      'normative/requirements.json',
      'conformance/manifest.yaml',
      'traceability.yaml',
    ]),
  ]);
  if (sourcePackage === null || targetPackage === null) return false;
  const sourceManifest = sourcePackage.manifest;
  const targetManifest = targetPackage.manifest;
  const sourceArtifacts = sourcePackage.artifacts;
  const targetArtifacts = targetPackage.artifacts;
  const sourceRequirementsPath = sourceArtifacts.find(({path}) => path === 'normative/requirements.json')?.path;
  const targetRequirementsPath = targetArtifacts.find(({path}) => path === 'normative/requirements.json')?.path;
  const sourceRequirements = sourceRequirementsPath === undefined ? null : await readJson(sourcePackage.root, sourceRequirementsPath);
  const targetRequirements = targetRequirementsPath === undefined ? null : await readJson(targetPackage.root, targetRequirementsPath);
  const [sourceSchemaErrors, targetSchemaErrors] = sourceRequirements === null || targetRequirements === null
    ? [[{keyword: 'invalidSchema'}], [{keyword: 'invalidSchema'}]]
    : await Promise.all([
      validateAgainstSchemaPath(packageRoot, 'contracts/schemas/requirements.schema.json', sourceRequirements),
      validateAgainstSchemaPath(packageRoot, 'contracts/schemas/requirements.schema.json', targetRequirements),
    ]);
  const sourceEntries = Array.isArray(sourceRequirements?.requirements) ? sourceRequirements.requirements : [];
  const targetEntries = Array.isArray(targetRequirements?.requirements) ? targetRequirements.requirements : [];
  const sourceIds = sourceEntries.map(({id}) => id);
  const targetIds = targetEntries.map(({id}) => id);
  const targetById = new Map(targetEntries.map((entry) => [entry.id, entry]));
  const sourceSections = await Promise.all(sourceEntries.map((entry) => requirementSection(sourcePackage.root, entry)));
  const targetSections = await Promise.all(targetEntries.map((entry) => requirementSection(targetPackage.root, entry)));
  const targetSectionsById = new Map(targetEntries.map((entry, index) => [entry.id, targetSections[index]]));
  const changedIds = sourceEntries.filter((entry, index) => targetById.has(entry.id) &&
    (!isDeepStrictEqual(entry, targetById.get(entry.id)) || sourceSections[index] !== targetSectionsById.get(entry.id)))
    .map(({id}) => id);
  const newIds = targetIds.filter((id) => !sourceIds.includes(id));
  const requirementIdsMatch = sourceSchemaErrors.length === 0 && targetSchemaErrors.length === 0 &&
    sourceEntries.length > 0 && targetEntries.length > 0 &&
    sourceSections.every((section) => section !== null) && targetSections.every((section) => section !== null) &&
    new Set(sourceIds).size === sourceIds.length && new Set(targetIds).size === targetIds.length &&
    sourceIds.every((id) => targetById.has(id)) && equalSets(changedIds, evidence.changed_requirement_ids ?? []) &&
    equalSets(newIds, evidence.new_requirement_ids ?? []);
  if (sourceManifest === null || sourceManifest.lifecycle_state !== 'released' ||
      sourceManifest.package_series !== subject.base_references.package_series ||
      sourceManifest.release_version !== subject.base_references.release_version ||
      sourceManifest.normative_digest !== evidence.source_digest ||
      targetManifest.package_series !== sourceManifest.package_series || targetManifest.lifecycle_state !== 'draft' ||
      targetManifest.release_version !== evidence.target_version || targetManifest.normative_digest !== evidence.target_digest ||
      targetManifest.amendment_policy?.previous_release !== sourceManifest.release_version || !requirementIdsMatch ||
      !/^[a-f0-9]{64}$/.test(evidence.source_digest) ||
      !/^[a-f0-9]{64}$/.test(evidence.target_digest) ||
      !isGreaterSemver(evidence.target_version, sourceManifest.release_version) ||
      evidence.target_path !== `releases/${evidence.target_version}`) return false;
  const target = await inspectAbsentPackageEntry(
    packageRoot,
    observedPath(evidence.observation_root, evidence.target_path),
  );
  return target.status === 'absent';
}
