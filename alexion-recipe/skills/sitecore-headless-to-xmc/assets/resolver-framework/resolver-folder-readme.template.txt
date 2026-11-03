# Resolver Adapters

Drop `*.resolver.ts` adapters here — they auto-register at build time, no manual wiring.

Each adapter file exports a `ResolverAdapter` (see `../resolver-adapter.types.ts`).
The registry (`../resolver-registry.ts`) discovers every `*.resolver.ts` file in this
folder via a build-time glob and registers it automatically. You never edit the
registry and never call `registerAdapter()` by hand.
