# Setup procedure selection

Load the active migration profile from `context.json` and follow its Setup procedure. The profile owns platform-specific probes, setup modes and acceptance evidence. This shared entry defines no vendor-specific operation. Use the workflow and executable contracts for shared state and validation rules.

## Collect Setup choices efficiently

Before dispatching work that depends on user choices, collect the currently knowable Setup decisions in one concise request: migration mode/surfaces, connector roles, source acquisition/repository, target repository/branch, and initialization choice as applicable. Do not ask for values already verified from workspace or artifact state. If a candidate list must first be obtained from a read-only probe, run only that bounded enumeration, then present its results together with any still-open choices in one follow-up. Do not start a worker that needs a user-selected source/target value and let it fail or pause merely to discover those inputs. Once the user answers, run the dependent checks once with the confirmed values; ask another question only when a terminal result reveals a genuinely new decision.
