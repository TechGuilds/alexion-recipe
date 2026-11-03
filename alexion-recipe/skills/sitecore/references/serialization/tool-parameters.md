# Serialization operation parameters

Use [native execution](native-execution.md) and the recipe-owned CLI wrapper.
The table defines the meaning and safety boundary of each operation input.

| Input | Meaning |
| --- | --- |
| include / exclude | Exact module namespace selection; item-path exclusions belong in reviewed module configuration |
| force | Overwrite intent requiring a concrete conflict/diff review; never an unconditional default |
| whatIf | Target change preview only if the actual installed transfer capability supports it |
| timeoutSeconds | Caller deadline, distinct from sandbox lifetime and remote job completion |
| cleanAll | Destructive full module/data replacement; do not reproduce implicitly |
| discoveryItems / exclusionPaths | Complete scoped module input and accumulated approved exclusions |

Preserve unchanged module configs and serialized data when adding exclusions. Compare before/after namespaces and item totals; a greater-than-50-percent namespace drop is a stop-and-review signal, not a reason to regenerate everything. Smaller unexpected drops also need explanation.

Inspect installed CLI version/help and authentication before selecting flags. Save
the actual command with secrets redacted and its result. Resolve selectors and
timeouts against the current exact module names and runtime limits.
