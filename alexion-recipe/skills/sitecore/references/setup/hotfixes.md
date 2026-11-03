# Hotfix assessment

Use only for a reproduced issue on a recorded Sitecore build. Collect connector identity, version, failing operation, sanitized error and the vendor patch applicability statement. Do not infer compatibility from a similar product version.

Read [SPE-1322](spe-1322-patch.md) for its specific case. Use an available authenticated installation/management capability only after its schema and target are verified. A local shell cannot borrow connector credentials or assume remote Sitecore filesystem access.

Before applying a patch, document affected instance, package provenance, required restart, backup and rollback owner. Apply within the task's authorized maintenance scope; escalate when the required installation or outage is outside it. Retry the original failing probe afterward and save before/after evidence. An accepted background job is not proof of installation.

If the capability or compatible package is missing, record a prerequisite blocker. Golden scripts do not replace privileged installation orchestration, and none is promised by this draft.
