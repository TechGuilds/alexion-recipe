# Snapshot the data contract

For each rendering/adapter, retain a representative source response and identify fields, types, nullability, repeated values, language/version and route context. Record where each value originates: datasource, route, context, resolver/controller or external service.

Map each required value to a verified target field/query or mark it unresolved. Do not infer an empty array is always empty or one example proves all variants. Remove credentials and personal data from fixtures where possible.

Output source/target contract references and field-level differences. Use these for component and resolver tests; visual similarity alone cannot establish equivalent data.
