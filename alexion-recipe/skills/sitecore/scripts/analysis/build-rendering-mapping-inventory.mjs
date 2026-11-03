// Portable discovery logic. Native Node only; source evidence is never modified.
import { createHash } from 'node:crypto';
import { buildRenderingMappingInventory } from './rendering-configurations.mjs';
import { canonicalRenderingId, parseRenderingInstances, parseRenderingVariants, } from './rendering-evidence.mjs';
const object = (v) => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const list = (v) => (Array.isArray(v) ? v : []);
const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const strings = (v) => [
    ...new Set(list(v)
        .map(text)
        .filter((s) => s !== null)),
].sort();
const id = (v) => (text(v) ? canonicalRenderingId(text(v)) : null);
const boolean = (v) => v === true || v === '1' ? true : v === false || v === '0' ? false : null;
const sort = (rows) => rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
/** Mapping facts only. Existing requirements remain available to legacy backend consumers. */
export function buildSourceMappingInventory(input) {
    const legacy = buildRenderingMappingInventory(input.entries);
    const warnings = new Set(legacy.warnings);
    const read = (name) => {
        const raw = input.artifacts[name];
        if (raw == null) {
            warnings.add(`Missing ${name}; related mapping evidence is unknown.`);
            return {};
        }
        try {
            return object(typeof raw === 'string' ? JSON.parse(raw.replace(/^\uFEFF/, '')) : raw);
        }
        catch {
            warnings.add(`Invalid ${name}; related mapping evidence is unknown.`);
            return {};
        }
    };
    const details = read('rendering-details');
    const metadata = object(read('metadata-stats').audit_metadata);
    const templateData = read('template-definitions');
    const placeholderData = read('placeholder-settings');
    const sxa = read('sxa-conversion-inputs');
    const variantData = read('rendering-variants');
    const code = input.artifacts['code-discovery-report'];
    const codeInventory = object(object(code).componentInventory ?? object(code).components);
    const mvcInventory = object(object(input.artifacts['mvc-rendering-source-mapping']).renderings);
    const definitionRows = list(details.rendering_details ?? details.renderings).map(object);
    const byId = new Map(definitionRows.map((r) => [id(r.id), r]));
    const templates = sort(list(templateData.templates).map((value) => {
        const t = object(value);
        return {
            templateId: id(t.id),
            name: text(t.name),
            path: text(t.path),
            baseTemplateIds: list(t.base_templates)
                .map((b) => id(typeof b === 'string' ? b : object(b).id))
                .filter(Boolean)
                .sort(),
            fields: sort(list(t.fields).map((value) => {
                const f = object(value);
                return {
                    fieldId: id(f.id),
                    name: text(f.name),
                    type: text(f.type),
                    path: text(f.path),
                    section: text(f.section),
                    standardValue: typeof f.standard_value === 'string' ? f.standard_value : null,
                    source: text(f.source),
                    shared: boolean(f.shared),
                    unversioned: boolean(f.unversioned),
                };
            })),
        };
    }));
    if (templates.some((t) => !t.templateId || t.fields.some((f) => !f.fieldId)))
        warnings.add('Some template/field IDs are missing; rerun source discovery with the updated field exporter for ID-based mapping.');
    const templateById = new Map(templates.filter((t) => t.templateId).map((t) => [t.templateId, t]));
    const templateByPath = new Map(templates.filter((t) => t.path).map((t) => [t.path.toLowerCase(), t]));
    const missingBaseTemplates = templates.flatMap((t) => t.baseTemplateIds.filter((base) => base && !templateById.has(base)));
    if (missingBaseTemplates.length)
        warnings.add(`${new Set(missingBaseTemplates).size} base template definitions are missing; inherited fields are incomplete.`);
    const missingTemplateReferences = new Set();
    const resolveTemplate = (reference, renderingName) => {
        const value = text(reference);
        if (!value)
            return null;
        const resolved = templateById.get(id(value)) ?? templateByPath.get(value.toLowerCase());
        if (!resolved) {
            missingTemplateReferences.add(value);
            warnings.add(`Template reference unresolved for ${renderingName}: ${value}`);
        }
        return resolved?.templateId ?? null;
    };
    let instances = null;
    try {
        instances = parseRenderingInstances(input.artifacts['rendering-instances']);
    }
    catch {
        warnings.add('Invalid rendering-instances; occurrence counts and unobserved usage are unknown.');
    }
    if (input.artifacts['rendering-instances'] == null)
        warnings.add('Missing rendering-instances; occurrence counts and unobserved usage are unknown.');
    let variantRows = [];
    try {
        variantRows = parseRenderingVariants(input.artifacts['rendering-variants']);
    }
    catch {
        warnings.add('Invalid rendering-variants; variant definitions are unknown.');
    }
    if (input.artifacts['rendering-variants'] == null)
        warnings.add('Missing rendering-variants; variant definitions are unknown.');
    const variants = sort(variantRows.map((v) => ({
        variantId: id(v.id),
        name: v.name,
        path: v.path,
        renderingIds: v.renderingIds.map((r) => id(r)).sort(),
        fields: v.fields,
        nodes: sort(v.nodes),
        observed: v.observed,
    })));
    const unresolvedVariants = list(variantData.unresolvedReferences);
    if (unresolvedVariants.length)
        warnings.add(`${unresolvedVariants.length} unresolved variant references; review discovery evidence.`);
    if (variants.some((v) => !v.renderingIds.length))
        warnings.add('Some variants have no resolved rendering association; do not infer associations from names.');
    const settings = sort(list(placeholderData.placeholder_settings).map((value) => {
        const p = object(value);
        return {
            settingsId: id(p.id),
            key: text(p.placeholder_key ?? p.key),
            name: text(p.name),
            path: text(p.path),
            allowedRenderings: sort(list(p.allowed_renderings).map((v) => {
                const r = object(v);
                return {
                    renderingId: id(typeof v === 'string' ? v : r.id),
                    name: text(r.name),
                    path: text(r.path),
                };
            })),
            editable: boolean(p.editable),
        };
    }));
    const missingPlaceholderReferences = new Set();
    const dynamic = sort(list(object(sxa.dynamicPlaceholders).placeholders).map((value) => {
        const p = object(value);
        return {
            key: text(p.baseName),
            isDynamic: p.isDynamic === true,
            settingsId: id(p.placeholderSettingsId),
            settingsPath: text(p.placeholderSettingsPath),
            segmentPattern: text(p.segmentPattern),
            usedInTemplateIds: strings(p.usedInTemplates).map(canonicalRenderingId),
            parentRenderings: sort(list(p.parentRenderings).map((v) => {
                const r = object(v);
                return {
                    renderingId: id(r.renderingId),
                    name: text(r.renderingName),
                    path: text(r.renderingPath),
                };
            })),
        };
    }));
    const usageComplete = details.usage_scan_complete === true &&
        instances !== null &&
        !list(details.excluded_content_paths).length;
    const inventoryComplete = details.inventory_scan_complete === true;
    if (!usageComplete)
        warnings.add('Usage scan is incomplete or not certified; unobserved renderings/variants have unknown usage.');
    if (!inventoryComplete)
        warnings.add('Rendering inventory scan is incomplete or not certified.');
    const unresolved = list(details.unresolved_rendering_references);
    if (unresolved.length)
        warnings.add(`${unresolved.length} unresolved rendering/dependency references; inspect metadata.unresolvedReferences.`);
    const requirementsByRendering = new Map();
    for (const r of legacy.requirements) {
        const key = canonicalRenderingId(r.renderingId);
        const group = requirementsByRendering.get(key) ?? [];
        group.push(r);
        requirementsByRendering.set(key, group);
    }
    const missingVariantDefinitions = new Set();
    const renderings = sort(input.renderings.map((rendering) => {
        const renderingId = canonicalRenderingId(rendering.id), raw = byId.get(renderingId) ?? {};
        const requirements = requirementsByRendering.get(renderingId) ?? [];
        const occurrences = [
            ...new Map(requirements.flatMap((r) => r.sourceOccurrences ?? []).map((o) => [JSON.stringify(o), o])).values(),
        ];
        const pages = new Map(occurrences.map((o) => [`${id(o.itemId)}:${o.language}`, o]));
        const observed = occurrences.length > 0 || raw.usageStatus === 'used' || raw.is_used === true;
        const countsComplete = usageComplete && !(observed && occurrences.length === 0);
        if (observed && occurrences.length === 0)
            warnings.add(`Usage is reported for ${rendering.name} without instance evidence; counts are unknown.`);
        const usageStatus = observed ? 'used' : usageComplete ? 'unused' : 'unknown';
        const match = object(codeInventory[rendering.id] ??
            codeInventory[renderingId] ??
            codeInventory[rendering.name] ??
            codeInventory[rendering.name.toLowerCase()] ??
            Object.entries(codeInventory).find(([key]) => canonicalRenderingId(key) === renderingId)?.[1]);
        const mvc = object(Object.values(mvcInventory).find((v) => id(object(v).renderingId) === renderingId));
        const filePath = text(match.sourcePath ??
            match.path ??
            object(mvc.view).filePath ??
            object(mvc.controller).filePath);
        const componentName = text(raw.component_name ?? raw.componentName);
        const settingsReferences = (text(raw.placeholders) ?? '').split('|').map(id);
        for (const reference of settingsReferences.filter((r) => r !== null)) {
            if (!settings.some((s) => s.settingsId === reference || canonicalRenderingId(s.key ?? '') === reference))
                missingPlaceholderReferences.add(reference);
        }
        const placeholderKeys = [
            ...new Set([
                ...occurrences.flatMap((o) => (o.placeholder ? [o.placeholder] : [])),
                ...settings
                    .filter((s) => s.settingsId && settingsReferences.includes(s.settingsId))
                    .flatMap((s) => (s.key ? [s.key] : [])),
                ...dynamic
                    .filter((p) => p.parentRenderings.some((r) => r.renderingId === renderingId))
                    .flatMap((p) => (p.key ? [p.key] : [])),
            ]),
        ].sort();
        const datasourceTemplateIds = [
            ...new Set((text(raw.datasource_template) ?? '')
                .split('|')
                .filter((reference) => reference.trim())
                .map((reference) => resolveTemplate(reference, rendering.name))
                .filter((value) => value !== null)),
        ].sort();
        const datasourceTemplateId = datasourceTemplateIds.length === 1 ? datasourceTemplateIds[0] : null;
        const parametersTemplateId = resolveTemplate(raw.parameters_template, rendering.name);
        const relatedVariants = variants.filter((v) => v.renderingIds.includes(renderingId));
        const configuredVariantIds = [...new Set(requirements.map((r) => id(r.variantId)))];
        const variantIds = [
            ...new Set([...configuredVariantIds, ...relatedVariants.map((v) => v.variantId)]),
        ];
        const renderingVariants = sort(variantIds.map((variantId) => {
            const definition = relatedVariants.find((v) => v.variantId === variantId);
            const variantOccurrences = requirements
                .filter((r) => id(r.variantId) === variantId)
                .flatMap((r) => r.sourceOccurrences ?? []);
            return {
                variantId,
                name: definition?.name ?? (variantId === null ? 'Default' : null),
                path: definition?.path ?? null,
                observed: variantOccurrences.length > 0,
                usageStatus: variantOccurrences.length ? 'used' : usageComplete ? 'unused' : 'unknown',
                pageCount: new Set(variantOccurrences.map((o) => `${id(o.itemId)}:${o.language}`)).size,
            };
        }));
        for (const variantId of configuredVariantIds)
            if (variantId && !relatedVariants.some((v) => v.variantId === variantId)) {
                missingVariantDefinitions.add(variantId);
                warnings.add(`Variant ${variantId} for ${rendering.name} has no definition.`);
            }
        return {
            renderingId,
            name: rendering.name,
            path: text(raw.path ?? rendering.path),
            componentName,
            discoverySources: strings(raw.discovery_sources),
            usage: {
                status: usageStatus,
                pageCount: observed && !occurrences.length ? null : pages.size,
                instanceCount: observed && !occurrences.length ? null : occurrences.length,
                countsComplete,
                examples: sort([...pages.values()].map((o) => ({
                    itemId: o.itemId,
                    itemPath: o.itemPath,
                    route: o.route,
                    language: o.language,
                    placeholder: o.placeholder,
                }))).slice(0, 3),
            },
            implementation: {
                status: filePath ? 'found' : 'unknown',
                filePath,
                registeredName: text(match.componentName ?? match.name),
                evidence: filePath ? 'source-analysis' : null,
            },
            dependencies: {
                datasourceTemplateId,
                datasourceTemplateIds,
                parametersTemplateId,
                placeholderKeys,
                datasourceTemplateReference: text(raw.datasource_template),
                parametersTemplateReference: text(raw.parameters_template),
                datasourceLocation: text(raw.datasource_location),
                resolverReference: text(raw.rendering_contents_resolver),
                placeholderSettingsReferences: text(raw.placeholders),
                layoutServicePlaceholders: text(raw.layout_service_placeholders),
                controller: text(raw.controller_class),
                controllerAction: text(raw.controller_action),
                viewPath: text(raw.view_path),
                componentQuery: text(raw.component_query),
            },
            variants: renderingVariants,
            configurations: sort(requirements.map((r) => ({
                configurationKey: r.configurationKey,
                variantId: id(r.variantId),
                parameters: r.parameters,
                pageCount: new Set((r.sourceOccurrences ?? []).map((o) => `${id(o.itemId)}:${o.language}`)).size,
            }))),
            evidence: {
                occurrencesFile: 'rendering-instances.jsonl',
                definitionsFile: 'rendering-details.json',
                variantsFile: 'rendering-variants.json',
            },
        };
    }));
    const instance = text(details.source_instance ?? metadata.source_instance);
    if (missingPlaceholderReferences.size)
        warnings.add(`${missingPlaceholderReferences.size} rendering placeholder-settings references have no exported definition.`);
    if (!instance)
        warnings.add('Source instance identity is not supplied by discovery; bind this inventory to the source connector in the mapping experience.');
    const body = {
        schemaVersion: 2,
        requirementsFingerprint: legacy.fingerprint,
        metadata: {
            source: {
                instance,
                sitePath: text(details.site_root ?? metadata.site_root_path),
                database: text(metadata.database),
                language: text(details.language ?? metadata.language),
            },
            discoveryCompletedAt: text(metadata.completed_at),
            completeness: {
                renderingInventory: inventoryComplete,
                pageUsage: usageComplete,
                templateDefinitions: Array.isArray(templateData.templates) &&
                    !missingBaseTemplates.length &&
                    !missingTemplateReferences.size &&
                    templates.every((t) => !!t.templateId && t.fields.every((f) => !!f.fieldId)),
                placeholderSettings: Array.isArray(placeholderData.placeholder_settings) && !missingPlaceholderReferences.size,
                dynamicPlaceholders: Array.isArray(object(sxa.dynamicPlaceholders).placeholders),
                variantDefinitions: !missingVariantDefinitions.size && input.artifacts['rendering-variants'] != null &&
                    !unresolvedVariants.length &&
                    ![...warnings].some((w) => w.startsWith('Invalid rendering-variants')),
                variantAssociations: !missingVariantDefinitions.size && !unresolvedVariants.length && Array.isArray(variantData.variants) &&
                    ![...warnings].some((w) => w.startsWith('Invalid rendering-variants')) &&
                    variants.every((v) => v.renderingIds.length > 0),
            },
            configuredRenderingRoots: strings(details.configured_roots),
            effectiveRenderingRoots: strings(details.effective_roots),
            excludedContentPaths: strings(details.excluded_content_paths),
            unresolvedReferences: unresolved,
            evidenceFiles: [
                'rendering-details.json',
                'rendering-instances.jsonl',
                'rendering-variants.json',
                'template-definitions.json',
                'placeholder-settings.json',
                'sxa-conversion-inputs.json',
                'metadata-stats.json',
            ],
        },
        renderings,
        templates,
        placeholders: { settings, dynamic },
        variants,
        // Compatibility: mapping backend still consumes exhaustive configurations from this section.
        requirements: legacy.requirements,
        warnings: [...warnings].sort(),
    };
    return {
        ...body,
        generatedAt: input.generatedAt,
        fingerprint: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    };
}
