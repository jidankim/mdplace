import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {observeTransition} from './transition-observer.mjs';
import {authorityMatches, manifestFields, transitionFields} from './validator-rules.mjs';

function isGreaterSemver(target, source) {
  const semver = /^[1-9][0-9]*\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
  if (!semver.test(target) || !semver.test(source)) return false;
  const targetParts = target.split('.').map(Number);
  const sourceParts = source.split('.').map(Number);
  return targetParts.some((part, index) => part > sourceParts[index] &&
    targetParts.slice(0, index).every((earlier, earlierIndex) => earlier === sourceParts[earlierIndex]));
}

export async function observeFixture(fixture, packageRoot) {
  switch (fixture.subject.kind) {
    case 'artifact': {
      const schemaName = fixture.subject.schema.split('/').at(-1);
      const document = fixture.subject.document;
      let codes = [];
      const operations = ['parse boundary document'];
      let illegalTransition = false;
      let contractCode;
      try {
        const schemaErrors = await validateAgainstSchemaPath(packageRoot, fixture.subject.schema, document);
        contractCode = schemaErrorCode(schemaErrors);
      } catch {
        contractCode = 'fixture.schema_unresolved';
      }
      switch (schemaName) {
        case 'package-manifest.schema.json': {
          operations.push('validate closed package manifest');
          if (Object.keys(document).some((field) => !manifestFields.has(field))) {
            codes = ['schema.unknown_field'];
          } else if (document.artifacts?.some(({path}) => /^(?:production|runtime|src)\//.test(path))) {
            codes = ['package.production_code_forbidden'];
          } else if ([...manifestFields].some((field) => !(field in document))) {
            codes = ['schema.required_field'];
          } else if (!/^[a-f0-9]{64}$/.test(document.normative_digest)) {
            codes = ['schema.pattern'];
          }
          break;
        }
        case 'requirements.schema.json': {
          operations.push('validate stable requirement identifiers');
          const ids = document.requirements.map(({id}) => id);
          if (new Set(ids).size !== ids.length) {
            codes = ['requirements.duplicate_id'];
          } else {
            const glossary = await readFile(resolve(packageRoot, '../../CONTEXT.md'), 'utf8');
            const canonicalTerms = new Set([...glossary.matchAll(/^\*\*(.+)\*\*:/gm)].map((match) => match[1]));
            const requirementTerms = document.requirements.flatMap(({canonical_terms: terms}) => terms);
            if (requirementTerms.some((term) => !canonicalTerms.has(term))) codes = ['vocabulary.unknown_term'];
          }
          break;
        }
        case 'transition-table.schema.json': {
          operations.push('validate complete transition table');
          illegalTransition = true;
          if (document.transitions.some((row) => [...transitionFields].some((field) => !(field in row)))) {
            codes = ['schema.required_field'];
          } else if (document.transitions.some((row) => !authorityMatches(row.command_or_event, row.actor_authority))) {
            codes = ['transition.ambiguous_authority'];
          }
          break;
        }
        case 'traceability.schema.json': {
          operations.push('validate total traceability');
          const requirements = JSON.parse(await readFile(resolve(packageRoot, 'normative/requirements.json'), 'utf8'));
          const tracedIds = document.records.map(({requirement_id: requirementId}) => requirementId);
          if (requirements.requirements.some(({id}) => !tracedIds.includes(id)) || new Set(tracedIds).size !== tracedIds.length) {
            codes = ['traceability.untraced_requirement'];
          }
          break;
        }
        default:
          codes = ['fixture.unsupported_schema'];
      }
      if (codes.length === 0 && contractCode !== null) codes = [contractCode];
      const accepted = codes.length === 0;
      return {
        verdict: accepted ? 'pass' : 'fail',
        codes,
        outputs: [accepted ? 'artifact accepted' : 'artifact rejected'],
        operations,
        receipts: ['ValidationReceipt'],
        filesystem_effects: ['none'],
        terminal_state: accepted ? 'validated' : 'rejected',
        illegal_transition: accepted ? false : illegalTransition,
      };
    }
    case 'sha256_boundary': {
      const accepted = /^[a-f0-9]{64}$/.test(fixture.subject.value);
      return {
        verdict: accepted ? 'pass' : 'fail',
        codes: accepted ? [] : ['schema.pattern'],
        outputs: [accepted ? 'digest accepted' : 'digest rejected'],
        operations: ['validate sha256 boundary'],
        receipts: ['ValidationReceipt'],
        filesystem_effects: ['none'],
        terminal_state: accepted ? 'validated' : 'rejected',
        illegal_transition: false,
      };
    }
    case 'release_mutation': {
      const rejected = !isGreaterSemver(fixture.subject.target_version, fixture.subject.source_version) ||
        fixture.subject.source_path === fixture.subject.target_path ||
        fixture.subject.source_digest_after_attempt !== fixture.subject.source_digest;
      return {
        verdict: rejected ? 'fail' : 'pass',
        codes: rejected ? ['release.immutable'] : [],
        outputs: [rejected ? 'release mutation rejected' : 'package amendment opened'],
        operations: ['compare version and path bindings'],
        receipts: rejected
          ? ['PackageTransitionDenied', 'VersionAmendmentReport']
          : ['PackageAmendmentOpened', 'VersionAmendmentReport'],
        filesystem_effects: [rejected
          ? 'preserve released source byte-for-byte'
          : 'create a new draft version path'],
        terminal_state: 'released',
        illegal_transition: rejected,
      };
    }
    case 'recovery': {
      const discardPartialTarget = fixture.subject.partial_target_exists && !fixture.subject.target_published;
      return {
        verdict: 'pass',
        codes: [],
        outputs: discardPartialTarget
          ? ['source release preserved', 'partial target removed']
          : ['source release preserved'],
        operations: discardPartialTarget
          ? ['verify source digest', 'inspect staged target', 'discard unverified partial target']
          : ['verify source digest', 'inspect staged target'],
        receipts: ['PackageRecoveryReport'],
        filesystem_effects: discardPartialTarget
          ? ['preserve released source byte-for-byte', 'remove unverified partial target']
          : ['preserve released source byte-for-byte'],
        terminal_state: 'released',
        illegal_transition: false,
      };
    }
    case 'transition':
      return observeTransition(fixture, packageRoot);
    default:
      return {
        verdict: 'fail',
        codes: ['fixture.unsupported_subject'],
        outputs: [],
        operations: [],
        receipts: [],
        filesystem_effects: [],
        terminal_state: 'rejected',
        illegal_transition: false,
      };
  }
}
