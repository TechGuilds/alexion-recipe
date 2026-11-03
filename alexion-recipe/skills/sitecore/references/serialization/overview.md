# Serialization overview

Serialization transfers item definitions/content; it does not migrate C# assemblies, prove publishing, or preserve every runtime feature. Source capture and target transformation are separate copies with explicit endpoint identities.

Follow [native execution](native-execution.md) for all operations. The local
processors prepare evidence and the foreground CLI wrapper performs the
authenticated transfer.

1. Run [content health checks](health-check.md) and resolve duplicate identities with evidence.
2. Inspect target adoption, module scope and source items, preserving complete original configs and YAML.
3. Validate captured files and template dependencies before any target write.
4. Review [XP-to-XMC exclusions](xp-to-xmc-exclusions.md) only for XMC; evaluate remaps in a separate target copy.
5. Execute dependency-ordered, previewed batches sequentially and verify target items afterward through [target parity](target-parity.md).

Search serialized IDs and source templates before recommending exclusion. Exclusion can remove required content; record affected items and reason for hub approval. A namespace filter matching nothing is a configuration error, not success. Never skip local validation or assume force-overwrite is always appropriate.

For every batch, return requested, pulled/pushed, already-present, skipped,
failed and unresolved IDs separately, plus namespace/item counts, duration,
observed rate and actual evidence paths. Publishing and visual/editing checks
remain separate hub tasks.
