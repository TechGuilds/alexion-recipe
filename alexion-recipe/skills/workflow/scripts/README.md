# Workflow validator

`validate.mjs` is the existing tested recipe validator, now published in this shared bundle. Run `node <skill-dir>/scripts/validate.mjs <workflow.json>` after reading the skill to stage it. `validate.test.mjs` remains an authoring test and is excluded from publication.

Tests cover ordered phases, required/optional enrichment dependencies, waiting for a terminal enrichment result, synthesis after optional failure, cycles, duplicate IDs, missing/deleted agent hints, failure/resume and explicit skips. Output is valid/errors/currentPhase/runnable/counts/complete. Exit zero means structurally valid, not factual completion or approval.
