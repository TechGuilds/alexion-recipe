# Sitecore v3 artifact contracts

These JSON Schema draft 2020-12 contracts describe the artifacts emitted by the
portable Sitecore skill. They are independent of the generic `cms-migration`
contracts. Known objects reject unknown fields; datasource field values are
arbitrary JSON, and parameter/transformation maps deliberately allow named keys.
Discovery can retain null identities, incomplete counts, unresolved reference
diagnostics and an empty target inventory without inventing missing evidence.

| Kind / schema filename prefix | Version | Producer |
| --- | --- | --- |
| `rendering-capture-plan` | 1 | `scripts/analysis/build-rendering-capture-plan.mjs` |
| `rendering-mapping-inventory` | 2 | `scripts/analysis/build-rendering-mapping-inventory.mjs` |
| `rendering-coverage-report` | 1 | `scripts/capture/rendering-coverage.mjs` |
| `target-rendering-inventory` | 1 | `scripts/mapping/component-mapping.mjs` |
| `component-mappings` | 1 | Explicit source-to-target mapping manifest |
| `component-migration-plan` | 1 | `scripts/mapping/component-migration-plan.mjs` |
| `component-examples` | 1 | `scripts/capture/build-component-examples.mjs` |
| `capture-result` | Unversioned common shape | Planned headless capture / MVC assembly |
| `mock-preview-routes` | Unversioned `{ "routes": [] }` | `scripts/preview/prepare-preview-navigation.mjs` |
| `mock-preview-deployment` | 1 | `scripts/preview/prepare-preview-navigation.mjs` |

Schemas use only local references to `common.schema.json`. Copy `scripts/` and
`assets/contracts/` together with the skill; Node built-ins are the only runtime
dependencies. No Ajv, Zod, workspace packages or installation step are needed.
The evaluator audits every schema node and refuses unsupported keywords,
unresolved references, remote references and unknown artifact kinds.

## Validate an explicit artifact

Run from the copied skill directory, supplying the exact file hash:

```sh
node scripts/validate-sitecore-artifact.mjs \
  --kind rendering-mapping-inventory \
  --file /absolute/evidence/rendering-mapping-inventory.json \
  --sha256 <64-character-lowercase-sha256>
```

Success returns a small JSON record and exit code 0. Invalid JSON, a stale file
hash, unsupported version, unknown field, missing identity or failed integrity
check returns exit code 1. File paths must be explicit absolute paths.
Alternatively, `--params /absolute/validation-params.json` accepts the same
`kind`, `file` and `sha256` keys plus the optional semantic contexts below.

```js
import {
  validateSitecoreArtifactSync,
  validateSitecoreArtifact,
  validateSitecoreArtifactFileSync,
  validateSitecoreArtifactFile,
} from './scripts/contracts/sitecore-artifacts.mjs';

// Returns the supplied value, or throws. Async variants return a Promise.
validateSitecoreArtifactSync('component-mappings', manifest, {
  sourceInventory,
  targetInventory,
});
await validateSitecoreArtifact('rendering-capture-plan', discoveryDraft);
validateSitecoreArtifactFileSync({ kind, file, sha256 });
```

Embedded fingerprints are checked using the native producer validators.
Mapping manifests can additionally bind `sourceInventory` and `targetInventory`;
coverage and capture-result artifacts can bind `capturePlan`.
Migration plans accept `currentInputs`, `currentDecisions`,
`currentApprovalEvidence` and `requireApproval` as supported by their native
validator. Without those contexts, validation checks local structure and
embedded integrity only; it does not certify that referenced files are current.
Deployment validation checks route/file relationships and declared hashes;
the preview deployment runtime separately reads and verifies the referenced files.

## Evidence boundaries

A structurally valid discovery capture plan remains a draft. Validation never
changes its scope, grants user approval, executes capture, or validates appearance.
The capture runtime still requires an approved non-draft plan. Embedded mapping
approval is local integrity evidence; mutating runtimes must also use
`verifyComponentMigrationPlanEvidence` to rebuild against current input bytes and
the current keyed user decision file.

Coverage retains `not-captured`, `capture-failed`, `target-absent`,
`target-unverified`, `mapping-only` and `captured` statuses. A captured example can
carry a placement consistency `warning`; that warning does not erase presence.
Synthetic examples remain `visualValidation: "pending"` at both manifest and
layout levels, including examples whose layout is ready for preview.

Run the portable contract tests with:

```sh
node --test tests/sitecore-contracts.test.mjs
```
