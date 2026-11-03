# Serialization performance and timeout

Measure count and duration on the actual runtime. Until one completed batch
provides an observed rate, treat the planner's configured rate as a provisional
estimate rather than a performance guarantee.

Estimate timeout as itemCount / measuredRate with a safety factor, then keep the batch below verified runtime/job deadlines. The former 600-second sandbox observation is not a universal E2B limit. Increasing a caller timeout cannot extend sandbox lifetime or prove a remote job stopped.

Inspect exact namespace sizes natively and split large scopes in dependency order. Preserve stable batch boundaries, completed counts and failed IDs for resume. Start with a small representative batch if throughput is unknown.

One transfer at a time. On timeout, inspect terminal state and partial effects before retry; do not overlap a still-running job. If the measured duration approaches the verified runtime limit, reduce scope. Repeated sub-25-items/sec behavior can justify investigating network, server load or template complexity rather than simply increasing timeouts.

Report actual rate, elapsed time, count, expected remaining range and limits used. Authentication and command flags follow [native execution](native-execution.md).
