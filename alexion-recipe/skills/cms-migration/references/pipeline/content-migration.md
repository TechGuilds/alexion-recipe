# Content migration procedure selection

Load the active migration profile from `context.json` and follow its Content Migration procedure. The profile owns platform-specific serialization, transfer rules and acceptance evidence. This shared entry defines no vendor-specific operation. Use the workflow and executable contracts for shared state and validation rules.

For optional media transfer, the active profile supplies its supported adapter, task definitions and capability evidence. Record actual opt-in or skip before media work; skipping transfer never proves target reference dependencies exist.

## Task packet and bounded dispatch

Before a content-transfer worker is dispatched, the coordinator writes one
task-scoped packet under that task's current evidence attempt. It is an input
manifest, not a second workflow or status record. It must contain:

- the stable workflow task ID, phase, attempt, bounded stage range and terminal
  checkpoint;
- the approved execution-scope manifest/item list plus the decision IDs that
  authorize exclusions, external prerequisites or a later mutation;
- stable path-and-hash references to the applicable Discovery outputs,
  dependency/scope evidence, target-adoption evidence and prior attempt
  evidence;
- selected source and target connector roles/identities, without credentials;
- the expected result/checkpoint for the assigned stage.

The worker first validates that every required packet reference exists, has the
recorded hash and is current for the task scope. It must use current compatible
evidence rather than rediscovering it. A missing, stale, partial or conflicting
input produces a short `blocked` result naming that input and the Discovery planning refresh
needed. It is never permission to scan a source hierarchy,
infer a transfer scope from a task title, recreate workflow/task scope, or
issue speculative remote calls.

When the active profile defines a shared phase capture, the coordinator creates
one phase-scoped packet for that capture before dispatching any transfer task.
It records an immutable capture manifest and the validated global execution
plan. Later task packets reference that shared phase capture by stable
path-and-hash rather than repeating source collection, local validation or
planning. The shared capture is invalid only when an approved scope or source
input changes; a task-specific target result never invalidates it.

Keep user-visible tasks at the approved review boundary. Internally, a packet
may cover one contiguous, non-mutating preparation group defined by the active
profile; it ends at the next mutation, recovery-choice or verification
checkpoint. Return its evidence and let the coordinator assemble the next
packet. A worker may not advance from read-only preparation into a target
mutation without the recorded scoped approval. This gives resume behavior a
stable input boundary while allowing the profile to reuse artifacts and records
already stored in the sandbox or the application.
