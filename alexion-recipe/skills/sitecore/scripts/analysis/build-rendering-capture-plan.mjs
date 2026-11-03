// Portable discovery logic. Native Node only; source evidence is never modified.
import { createHash } from 'node:crypto';

export const RENDERING_CAPTURE_PLAN_FILE = 'mock-layouts/rendering-capture-plan.json';
export const RENDERING_MAPPING_INVENTORY_FILE = 'mock-layouts/rendering-mapping-inventory.json';
const canonical = (s) => s.replace(/[{}-]/g, '').toLowerCase();
export const renderingVariantKey = (r) => `${canonical(r.renderingId)}:variant:${r.variantId ? canonical(r.variantId) : 'default'}`;
/** Parameters stay in original discovery; capture identity is rendering + variant only. */
export function renderingVariantRoutes(entries) {
    return entries.map((entry) => {
        const collapse = (requirements) => {
            const merged = new Map();
            for (const r of requirements) {
                const key = renderingVariantKey(r);
                const previous = merged.get(key);
                merged.set(key, {
                    ...r,
                    key,
                    renderingId: canonical(r.renderingId),
                    variantId: r.variantId ? canonical(r.variantId) : null,
                    configurationKey: `variant:${r.variantId ? canonical(r.variantId) : 'default'}`,
                    parameters: {},
                    instanceIds: [...new Set([...(previous?.instanceIds ?? []), ...(r.instanceIds ?? [])])],
                    sourceOccurrences: [
                        ...new Map([...(previous?.sourceOccurrences ?? []), ...(r.sourceOccurrences ?? [])].map((o) => [
                            JSON.stringify(o),
                            o,
                        ])).values(),
                    ],
                });
            }
            return [...merged.values()];
        };
        return {
            ...entry,
            requirements: collapse(entry.requirements ?? []),
            unplacedRequirements: collapse(entry.unplacedRequirements ?? []),
        };
    });
}
/** Exact set cover with an explicit work budget; never label a heuristic result a proven minimum. */
export function buildRenderingCapturePlan(entries, options = {}) {
    const collapsed = renderingVariantRoutes(entries);
    const included = options.includedRenderingIds && new Set([...options.includedRenderingIds].map(canonical));
    const requirementMap = new Map();
    const pages = collapsed
        .flatMap((entry) => {
        const requirements = (entry.requirements ?? []).filter((r) => !r.definitionOnly && (!included || included.has(r.renderingId)));
        for (const r of requirements)
            requirementMap.set(r.key, r);
        return requirements.length
            ? [
                {
                    route: entry.route,
                    itemId: entry.itemId,
                    itemPath: entry.itemPath,
                    language: entry.language,
                    requirementKeys: requirements.map((r) => r.key).sort(),
                },
            ]
            : [];
    })
        .sort((a, b) => a.route === b.route
        ? 0
        : a.route === '/'
            ? -1
            : b.route === '/'
                ? 1
                : a.route.localeCompare(b.route));
    for (const entry of collapsed)
        for (const r of entry.unplacedRequirements ?? []) {
            if (!r.definitionOnly &&
                r.sourceOccurrences?.length &&
                (!included || included.has(r.renderingId)))
                requirementMap.set(r.key, r);
        }
    const keys = [...requirementMap.keys()].sort();
    const bit = new Map(keys.map((key, i) => [key, 1n << BigInt(i)]));
    let full = 0n;
    const count = (input) => {
        let n = 0;
        for (let v = input; v; v &= v - 1n)
            n++;
        return n;
    };
    const unique = new Map();
    for (const page of pages) {
        const mask = page.requirementKeys.reduce((m, key) => m | bit.get(key), 0n);
        full |= mask;
        if (!unique.has(mask))
            unique.set(mask, { ...page, mask });
    }
    const all = [...unique.values()];
    // Retain all page identities as alternatives; dominance reduction affects optimization only.
    const candidates = all.length > 2_000
        ? all
        : all.filter((a) => !all.some((b) => a !== b && (a.mask & b.mask) === a.mask));
    let best = [];
    for (let left = full; left;) {
        const page = candidates.reduce((a, b) => (count(b.mask & left) > count(a.mask & left) ? b : a));
        best.push(page);
        left &= ~page.mask;
    }
    const searchLimit = options.searchLimit ??
        Math.min(100_000, Math.max(1, Math.floor(2_000_000 / Math.max(1, candidates.length))));
    if (!Number.isInteger(searchLimit) || searchLimit < 0)
        throw new Error('Invalid capture-plan search limit');
    let searchStates = 0, exhausted = false;
    const memo = new Map();
    const owners = keys.map((key) => candidates.filter((page) => !!(page.mask & bit.get(key))));
    function search(left, chosen) {
        if (searchStates >= searchLimit) {
            exhausted = true;
            return;
        }
        searchStates++;
        if (!left) {
            if (chosen.length < best.length)
                best = [...chosen];
            return;
        }
        if (chosen.length >= best.length || (memo.get(left) ?? Infinity) <= chosen.length)
            return;
        memo.set(left, chosen.length);
        const maxGain = candidates.reduce((gain, p) => Math.max(gain, count(p.mask & left)), 0);
        if (chosen.length + Math.ceil(count(left) / maxGain) >= best.length)
            return;
        let choices;
        for (let i = 0; i < keys.length; i++)
            if (left & (1n << BigInt(i))) {
                if (!choices || owners[i].length < choices.length)
                    choices = owners[i];
            }
        for (const page of [...(choices ?? [])].sort((a, b) => count(b.mask & left) - count(a.mask & left) || a.route.localeCompare(b.route))) {
            search(left & ~page.mask, [...chosen, page]);
            if (exhausted)
                break;
        }
    }
    if (full)
        search(full, []);
    const selectedPages = best
        .map(({ mask: _mask, ...page }) => page)
        .sort((a, b) => a.route === b.route
        ? 0
        : a.route === '/'
            ? -1
            : b.route === '/'
                ? 1
                : a.route.localeCompare(b.route));
    const requirements = keys.map((key) => {
        const r = requirementMap.get(key);
        return {
            key,
            renderingId: r.renderingId,
            renderingName: r.renderingName,
            variantId: r.variantId,
            alternatives: pages
                .filter((p) => p.requirementKeys.includes(key))
                .map(({ requirementKeys: _keys, ...page }) => page),
        };
    });
    const warnings = [...new Set([...entries.flatMap((e) => e.evidenceWarnings ?? []), ...(options.evidenceWarnings ?? [])])];
    if (!included)
        warnings.push('Discovery-only draft: included rendering scope has not been approved; do not execute captures from this plan.');
    const uncoveredRequirementKeys = requirements
        .filter((r) => !r.alternatives.length)
        .map((r) => r.key);
    if (uncoveredRequirementKeys.length)
        warnings.push(`${uncoveredRequirementKeys.length} used rendering/variant targets have no resolvable capture page.`);
    if (exhausted)
        warnings.push('Optimization search limit reached; full coverage retained but minimum page count is not proven.');
    const body = {
        identity: 'rendering-variant',
        scope: included ? 'approved' : 'discovery-only',
        draft: !included,
        sourceDiscoveryFingerprint: createHash('sha256')
            .update(entries
            .map((entry) => createHash('sha256').update(JSON.stringify(entry)).digest('hex'))
            .sort()
            .join(':'))
            .digest('hex'),
        totalSourcePages: pages.length,
        totalRenderings: new Set(keys.map((key) => requirementMap.get(key).renderingId)).size,
        totalRequirements: keys.length,
        selectedPages,
        requirements,
        optimization: {
            minimumProven: !exhausted && uncoveredRequirementKeys.length === 0,
            searchStates,
            searchLimit,
        },
        warnings,
        uncoveredRequirementKeys,
    };
    return {
        schemaVersion: 1,
        fingerprint: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
        ...body,
    };
}
