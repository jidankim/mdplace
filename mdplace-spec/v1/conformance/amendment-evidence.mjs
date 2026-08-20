import {isDeepStrictEqual} from 'node:util';

import {
  checkArtifactBindings,
  checkManifest,
  requiredCandidateFoundationSlots,
  requiredReleaseSlots,
} from './package-checks.mjs';
import {validateAgainstSchemaPath} from './json-schema.mjs';
import {inspectAbsentPackageEntry, inspectPackageEntry, readPackageFile} from './safe-path.mjs';

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

function markdownAnchor(heading) {
  return heading.trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
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
  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  const artifactPaths = artifacts.map(({path}) => path);
  if (requiredArtifacts.some((path) => !artifactPaths.includes(path))) return null;
  const slotsMatch = (await Promise.all(requiredSlots.map((path) =>
    inspectPackageEntry(inspectedRoot.target, path, path.endsWith('/') ? 'directory' : 'file'))))
    .every(({status}) => status === 'present');
  if (!slotsMatch) return null;
  const [manifestCheck, artifactCheck] = await Promise.all([
    checkManifest(inspectedRoot.target, manifest),
    checkArtifactBindings(inspectedRoot.target, manifest).then(({check}) => check),
  ]);
  return manifestCheck.verdict === 'pass' && artifactCheck.verdict === 'pass'
    ? {manifest, root: inspectedRoot.target, artifacts}
    : null;
}

async function requirementSection(root, entry) {
  if (typeof entry?.normative_anchor !== 'string') return null;
  const [path, fragment = ''] = entry.normative_anchor.split('#', 2);
  const read = await readPackageFile(root, path);
  if (read.status !== 'present') return null;
  const lines = read.content.toString('utf8').split(/\r?\n/);
  const expectedHeading = `## ${entry.id}: ${entry.title}`;
  const start = lines.indexOf(expectedHeading);
  if (start === -1 || fragment !== markdownAnchor(expectedHeading.replace(/^##\s+/, ''))) return null;
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start, next === -1 ? undefined : next).join('\n').trim();
}

async function unanchoredNormativeMaterial(root, entries) {
  const requirementIds = new Set(entries.map(({id}) => id));
  const paths = [...new Set(entries.map((entry) => entry?.normative_anchor?.split('#', 1)[0])
    .filter((path) => typeof path === 'string'))].sort();
  const documents = [];
  for (const path of paths) {
    const read = await readPackageFile(root, path);
    if (read.status !== 'present') return null;
    let insideRequirement = false;
    const unanchoredLines = [];
    for (const line of read.content.toString('utf8').split(/\r?\n/)) {
      const heading = /^## (REQ-[A-Z][A-Z0-9]{1,15}-[0-9]{3}):/.exec(line);
      if (heading !== null && requirementIds.has(heading[1])) {
        insideRequirement = true;
        continue;
      }
      if (line.startsWith('## ')) insideRequirement = false;
      if (!insideRequirement) unanchoredLines.push(line);
    }
    documents.push(`${path}\0${unanchoredLines.join('\n')}`);
  }
  return documents;
}

function unchangedUnanchoredNormativeArtifacts(sourcePackage, targetPackage, entries) {
  const anchoredPaths = new Set(entries.map((entry) => entry?.normative_anchor?.split('#', 1)[0])
    .filter((path) => typeof path === 'string'));
  anchoredPaths.add('normative/requirements.json');
  const bindings = ({artifacts}) => artifacts.filter(({authority, path}) =>
    authority === 'normative' && !anchoredPaths.has(path))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    .map(({path, sha256}) => `${path}\0${sha256}`);
  return isDeepStrictEqual(bindings(sourcePackage), bindings(targetPackage));
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
  const sourceManifestPath = observedPath(evidence.observation_root, evidence.source_manifest);
  if (subject.preconditions?.manifest_ref !== sourceManifestPath ||
      subject.preconditions?.artifact_ledger_ref !== `${sourceManifestPath}#/artifacts` ||
      subject.preconditions?.normative_digest_ref !== `${sourceManifestPath}#/normative_digest` ||
      subject.base_references?.normative_digest_ref !== `${sourceManifestPath}#/normative_digest`) return false;
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
  const [sourceUnanchored, targetUnanchored] = await Promise.all([
    unanchoredNormativeMaterial(sourcePackage.root, sourceEntries),
    unanchoredNormativeMaterial(targetPackage.root, targetEntries),
  ]);
  const targetSectionsById = new Map(targetEntries.map((entry, index) => [entry.id, targetSections[index]]));
  const changedIds = sourceEntries.filter((entry, index) => targetById.has(entry.id) &&
    (!isDeepStrictEqual(entry, targetById.get(entry.id)) || sourceSections[index] !== targetSectionsById.get(entry.id)))
    .map(({id}) => id);
  const newIds = targetIds.filter((id) => !sourceIds.includes(id));
  const requirementIdsMatch = sourceSchemaErrors.length === 0 && targetSchemaErrors.length === 0 &&
    sourceEntries.length > 0 && targetEntries.length > 0 &&
    sourceSections.every((section) => section !== null) && targetSections.every((section) => section !== null) &&
    sourceUnanchored !== null && targetUnanchored !== null && isDeepStrictEqual(sourceUnanchored, targetUnanchored) &&
    unchangedUnanchoredNormativeArtifacts(sourcePackage, targetPackage, [...sourceEntries, ...targetEntries]) &&
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
