# Serialization error recovery

Retain the exact sanitized error, connector/CLI endpoint identity, phase, namespace, failed item IDs and partial counts before changing anything. Use [native execution](native-execution.md); removed wrappers are not recovery mechanisms.

| Failure | Inspect | Recovery |
| --- | --- | --- |
| Template not found | Search local YAML IDs/base templates and source template path; verify earlier target batches | Push missing dependency first; if incompatible, propose explicit remap or exclusion |
| Duplicate item/name | Compare sibling paths/IDs and [health checks](health-check.md) | Resolve exact duplicate with backup and approved scope; never delete by guessed name |
| YAML corruption | Parser error and original captured file | Re-capture affected source scope into a new copy; validate before reuse |
| Invalid field/reference | Item, field, target template and raw value | Correct the proven mapping; exclusion needs a scoped decision |
| Namespace filter mismatch | Existing module names and exact case | Re-plan; do not treat as empty success |
| Timeout/transport | Partial counts, operation terminal status, observed rate | Resolve running work before retry; split verified batches |
| Authentication/permission | Actual endpoint role and injected role environment availability | Return a prerequisite blocker; never copy connector secrets into a file or argument |

For remaps, save from/to template IDs and paths, affected files/items, changed template headers, additional field occurrences, preview diff and approval. Do not globally replace every occurrence of a GUID: a field reference may have another meaning. Apply only reviewed edits to a target copy, then validate inheritance and fields.

Accumulate approved exclusions against the complete original scope. Preserve module data, compare namespace counts and stop on unexplained reductions (especially greater than 50 percent). Do not weaken dependency checks to get a green result.

Retry one clearly transient, terminated operation once after reconciling partial
effects. A timeout is not transient until its remote state has been read back.
Persistent errors return failed/blocked with evidence. Remote restoration
requires the separate backup contract.
