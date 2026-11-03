# Dependency-ordered push planning

Read actual module names, include paths and serialized template/base-template references. Run [plan-batches.mjs](../../scripts/serialization/README.md) with explicit item/module roots and review its exact namespace batches, missing references and cycles before transfer.

Use this ordering heuristic only when dependency evidence leaves a tie: Templates,
Renderings, Branches, Layouts, then content/resolvers/other. Within
template/rendering/branch groups, create depth-one roots first, then Foundation,
Feature, Project, System and other paths by depth. Container modules using the
`._containers` suffix precede their siblings.

Actual dependency edges override name heuristics. Media or datasource dependencies can require earlier batches; detect cycles and missing templates rather than assigning an arbitrary order. Record phase, exact namespaces, item counts, prerequisites and unresolved dependencies.

Preview and execute one batch at a time through [native execution](native-execution.md).
A single namespace may still depend on an absent template. Do not parallelize
transfers sharing CLI authentication/config or target scope. A completed batch
is preserved on resume only after its manifest and target read-back remain
current.

A filter matching no module is a failure: compare exact names/case, regenerate the plan from current files and review it. Never report it as zero changes or silently skip it.
