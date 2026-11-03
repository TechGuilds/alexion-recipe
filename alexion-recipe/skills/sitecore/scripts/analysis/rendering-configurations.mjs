// Portable discovery logic. Native Node only; source evidence is never modified.
import { createHash } from 'node:crypto';
import { canonicalRenderingId, parseRenderingInstances, parseRenderingVariants, normalizeEvidenceRoute } from './rendering-evidence.mjs';
/** Data and editing-instance identifiers describe examples, not visual configurations. */
const incidental = new Set([
    'datasource',
    'data source',
    'dynamicplaceholderid',
    'renderingidentifier',
    'cacheable',
    'caching',
    'varybydata',
    'varybydevice',
    'varybylogin',
    'varybyparm',
    'varybyquerystring',
    'varybyuser',
]);
export function normalizeRenderingParameters(raw) {
    const entries = [];
    for (const [key, value] of new URLSearchParams(raw ?? '')) {
        const normalized = key.toLowerCase();
        if (!incidental.has(normalized))
            entries.push([
                normalized,
                ['fieldnames', 'renderingvariant', 'variantid'].includes(normalized) &&
                    /^\{?[0-9a-f-]{32,36}\}?$/i.test(value)
                    ? canonicalRenderingId(value)
                    : value,
            ]);
    }
    entries.sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv));
    const result = {};
    for (const [key, value] of entries) {
        // Preserve repeated parameter values instead of silently discarding them.
        result[key] = key in result ? `${result[key]}\u001f${value}` : value;
    }
    return result;
}
export function requirementFromInstance(instance) {
    const renderingId = canonicalRenderingId(instance.renderingId);
    const parameters = normalizeRenderingParameters(instance.parameters);
    const variantId = instance.variantId ? canonicalRenderingId(instance.variantId) : null;
    const configurationKey = createHash('sha256')
        .update(JSON.stringify({ variantId, parameters }))
        .digest('hex')
        .slice(0, 24);
    return {
        key: `${renderingId}:${configurationKey}`,
        renderingId,
        renderingName: instance.renderingName,
        configurationKey,
        variantId,
        parameters,
        sourceOccurrences: [
            {
                itemId: canonicalRenderingId(instance.pageId),
                itemPath: instance.itemPath,
                language: instance.language,
                instanceId: instance.instanceId ? canonicalRenderingId(instance.instanceId) : null,
                deviceId: instance.deviceId ? canonicalRenderingId(instance.deviceId) : null,
                placeholder: instance.placeholder,
                datasource: instance.datasource,
                route: null,
            },
        ],
        instanceIds: instance.instanceId ? [canonicalRenderingId(instance.instanceId)] : [],
    };
}
/** Keep every occurrence of a configuration across items and repeated placements. */
export function mergeCoverageRequirements(a, b) {
    const occurrences = new Map();
    for (const occurrence of [...(a.sourceOccurrences ?? []), ...(b.sourceOccurrences ?? [])])
        occurrences.set(JSON.stringify(occurrence), occurrence);
    return {
        ...a,
        instanceIds: [...new Set([...(a.instanceIds ?? []), ...(b.instanceIds ?? [])])].sort(),
        sourceOccurrences: [...occurrences.values()].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))),
    };
}
/** Linear accumulation for large sites; never copy the complete occurrence list per page. */
export class CoverageRequirementCollector {
    requirements = new Map();
    occurrences = new Map();
    instances = new Map();
    add(requirement) {
        let target = this.requirements.get(requirement.key);
        if (!target) {
            target = { ...requirement, sourceOccurrences: [], instanceIds: [] };
            this.requirements.set(requirement.key, target);
            this.occurrences.set(requirement.key, new Set());
            this.instances.set(requirement.key, new Set());
        }
        const occurrences = this.occurrences.get(requirement.key);
        for (const occurrence of requirement.sourceOccurrences ?? []) {
            const key = JSON.stringify(occurrence);
            if (!occurrences.has(key)) {
                occurrences.add(key);
                target.sourceOccurrences.push(occurrence);
            }
        }
        const instances = this.instances.get(requirement.key);
        for (const id of requirement.instanceIds ?? [])
            if (!instances.has(id)) {
                instances.add(id);
                target.instanceIds.push(id);
            }
    }
}
/** Extend candidate routes without deleting legacy rendering-level fields. */
export function buildConfigurationRoutes(renderings, artifacts, legacy = []) {
    const instances = parseRenderingInstances(artifacts['rendering-instances']);
    if (instances === null)
        return legacy;
    const raw = artifacts['rendering-page-mapping'];
    const mapping = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const pages = mapping && typeof mapping === 'object' && 'pages' in mapping && Array.isArray(mapping.pages)
        ? mapping.pages
        : [];
    const pageRoutes = new Map();
    const routeOwners = new Map();
    const conflictingRoutes = new Set();
    for (const page of pages) {
        if (!page || typeof page !== 'object' || typeof page.itemPath !== 'string')
            continue;
        const route = normalizeEvidenceRoute(page.route);
        if (!route)
            continue;
        pageRoutes.set(page.itemPath, route);
        const owners = routeOwners.get(route) ?? new Set();
        owners.add(page.itemPath.toLowerCase());
        routeOwners.set(route, owners);
        if (owners.size > 1)
            conflictingRoutes.add(route);
    }
    const routeItemIds = new Map();
    for (const instance of instances) {
        const route = pageRoutes.get(instance.itemPath);
        if (!route || !instance.pageId)
            continue;
        const ids = routeItemIds.get(route) ?? new Set();
        ids.add(canonicalRenderingId(instance.pageId));
        routeItemIds.set(route, ids);
        if (ids.size > 1)
            conflictingRoutes.add(route);
    }
    const routes = new Map();
    const collector = new CoverageRequirementCollector();
    const all = collector.requirements;
    const placed = new Set();
    const observedVariants = new Set(instances
        .filter((i) => i.variantId)
        .map((i) => `${canonicalRenderingId(i.renderingId)}:${canonicalRenderingId(i.variantId)}`));
    const definitions = new Map(renderings.map((r) => [canonicalRenderingId(r.id), r]));
    const configuredRenderings = new Set();
    for (const instance of instances) {
        const requirement = requirementFromInstance(instance);
        configuredRenderings.add(requirement.renderingId);
        const route = pageRoutes.get(instance.itemPath) ?? null;
        const routeIssue = /\/Presentation\/(Partial Designs|Page Designs)(?:\/|$)/i.test(instance.itemPath)
            ? 'shared-design-requires-page'
            : route && conflictingRoutes.has(route)
                ? 'route-conflict'
                : !route
                    ? 'route-unresolved'
                    : undefined;
        requirement.sourceOccurrences = requirement.sourceOccurrences.map((o) => ({
            ...o,
            route: routeIssue ? null : route,
            ...(routeIssue ? { routeIssue } : {}),
        }));
        collector.add(requirement);
        if (!route || routeIssue)
            continue;
        const entry = routes.get(route) ?? {
            route,
            itemPath: instance.itemPath,
            itemId: canonicalRenderingId(instance.pageId),
            language: instance.language,
            renderings: [],
            requirements: [],
        };
        if (!entry.renderings.includes(instance.renderingName))
            entry.renderings.push(instance.renderingName);
        const existingIndex = entry.requirements.findIndex((r) => r.key === requirement.key);
        if (existingIndex >= 0)
            entry.requirements[existingIndex] = mergeCoverageRequirements(entry.requirements[existingIndex], requirement);
        else
            entry.requirements.push(requirement);
        routes.set(route, entry);
        placed.add(requirement.key);
    }
    for (const variant of parseRenderingVariants(artifacts['rendering-variants'])) {
        for (const id of variant.renderingIds) {
            const renderingId = canonicalRenderingId(id);
            if (observedVariants.has(`${renderingId}:${canonicalRenderingId(variant.id)}`))
                continue;
            const definition = definitions.get(renderingId);
            if (!definition)
                continue;
            const key = `${renderingId}:variant:${canonicalRenderingId(variant.id)}`;
            all.set(key, {
                key,
                renderingId,
                renderingName: definition.name,
                configurationKey: `variant:${canonicalRenderingId(variant.id)}`,
                variantId: canonicalRenderingId(variant.id),
                parameters: {},
                definitionOnly: true,
            });
            configuredRenderings.add(renderingId);
        }
    }
    for (const definition of renderings) {
        const renderingId = canonicalRenderingId(definition.id);
        if (configuredRenderings.has(renderingId))
            continue;
        const key = `${renderingId}:definition`;
        all.set(key, {
            key,
            renderingId,
            renderingName: definition.name,
            configurationKey: 'definition',
            variantId: null,
            parameters: {},
            definitionOnly: true,
        });
    }
    const entries = [...routes.values()].sort((a, b) => a.route.localeCompare(b.route));
    if (!entries.length)
        entries.push({ route: '/', renderings: [], requirements: [] });
    entries[0].unplacedRequirements = [...all.values()]
        .filter((r) => !placed.has(r.key) || r.sourceOccurrences?.some((o) => o.routeIssue))
        .map((r) => placed.has(r.key)
        ? {
            ...r,
            instanceIds: [],
            sourceOccurrences: r.sourceOccurrences?.filter((o) => o.routeIssue),
        }
        : r);
    entries[0].evidenceFingerprint = createHash('sha256')
        .update(JSON.stringify({ instances, variants: artifacts['rendering-variants'], mapping }))
        .digest('hex');
    entries[0].evidenceWarnings = [];
    if (mapping &&
        typeof mapping === 'object' &&
        'usage_scan_complete' in mapping &&
        mapping.usage_scan_complete === false)
        entries[0].evidenceWarnings.push('Source usage scan was incomplete; absence is not proof of non-use.');
    for (const variant of parseRenderingVariants(artifacts['rendering-variants']))
        if (!variant.renderingIds.length)
            entries[0].evidenceWarnings.push(`Variant association unresolved: ${variant.path}`);
    const variantsRaw = typeof artifacts['rendering-variants'] === 'string'
        ? JSON.parse(artifacts['rendering-variants'])
        : artifacts['rendering-variants'];
    if (variantsRaw &&
        typeof variantsRaw === 'object' &&
        'unresolvedReferences' in variantsRaw &&
        Array.isArray(variantsRaw.unresolvedReferences)) {
        for (const reference of variantsRaw.unresolvedReferences)
            if (typeof reference === 'string')
                entries[0].evidenceWarnings.push(`Variant reference could not be resolved: ${reference}`);
    }
    return entries;
}
export function buildRenderingMappingInventory(entries) {
    const requirements = new Map();
    const seen = new Map();
    for (const entry of entries)
        for (const r of [...(entry.requirements ?? []), ...(entry.unplacedRequirements ?? [])]) {
            let target = requirements.get(r.key);
            if (!target) {
                target = { ...r, sourceOccurrences: [], instanceIds: [] };
                requirements.set(r.key, target);
                seen.set(r.key, new Set());
            }
            target.instanceIds = [...new Set([...(target.instanceIds ?? []), ...(r.instanceIds ?? [])])];
            for (const occurrence of r.sourceOccurrences ?? []) {
                const key = JSON.stringify(occurrence);
                if (!seen.get(r.key).has(key)) {
                    seen.get(r.key).add(key);
                    target.sourceOccurrences.push(occurrence);
                }
            }
        }
    const body = {
        schemaVersion: 1,
        requirements: [...requirements.values()].sort((a, b) => a.key.localeCompare(b.key)),
        warnings: [...new Set(entries.flatMap((entry) => entry.evidenceWarnings ?? []))],
    };
    return { ...body, fingerprint: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
}
