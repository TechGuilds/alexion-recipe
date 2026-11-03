/** A Sitecore item ID in braces, e.g. "{3F2A9C54-81D7-4B6E-A0C3-5E7D2B91F4A8}". */
export type Guid = string;

export interface SitecoreMapping {
  templates: TemplateMapping[];
  renderings: RenderingMapping[];
  placeholders: PlaceholderMapping[];
}

/* ---------- templates ---------- */

/** A base template, referenced by ID and name. */
export interface BaseTemplateRef {
  baseTemplateId: Guid;
  baseTemplateName: string;
}

export interface TemplateRef {
  templateName: string;
  baseTemplates: BaseTemplateRef[];
  templateId: Guid;
  path: string;
}

export interface TemplateMapping {
  /** One source for a one-to-one or split mapping, several when they all become the same target(s). */
  source: TemplateRef[];
  /** Several targets when a source template is split. */
  target: TemplateRef[];
  fields: FieldMapping[];
  warnings: MappingWarning[];
}

/**
 * Where a target field lives. Set on every row that writes to a target field.
 *
 * The template that declares the target field: one of the `target[]` templates,
 * or one of their base templates (matching `baseTemplateId` / `baseTemplateName`).
 *
 * Rules to validate:
 *  - `targetTemplateId` is the `templateId` of a `target[]` entry or the `baseTemplateId` of one of its base templates,
 *    and `targetTemplate` is that template's name.
 *  - A given `tfid` always has the same `targetTemplateId`.
 *  - When `target[]` has several entries, the template must belong to exactly one of them,
 *    otherwise the row is ambiguous (for example a base template shared by two targets).
 */
export interface TargetTemplateRef {
  targetTemplate: string;
  targetTemplateId: Guid;
}

/** A field row is mapped to a target field, set to a constant, or removed. */
export type FieldMapping = MappedField | SetField | RemovedField;

export interface MappedField extends TargetTemplateRef {
  action: "map";
  sfid: Guid;               // source field ID
  from: string;             // source field name
  tfid: Guid;               // target field ID
  to: string;               // target field name
}

/** No source field: writes a constant to a target field. */
export interface SetField extends TargetTemplateRef {
  action: "set";
  tfid: Guid;
  to: string;
  value: string;
}

/** Dropped field: nothing is written, so there is no target template. */
export interface RemovedField {
  action: "remove";
  sfid: Guid;
  from: string;
}

/* ---------- renderings ---------- */

export interface RenderingRef {
  renderingName: string;
  renderingId: Guid;
  path: string;
}

export interface RenderingMapping {
  source: RenderingRef[];   // several sources can map to one target (many-to-one)
  target: RenderingRef[];
  warnings: MappingWarning[];
}

/* ---------- placeholders ---------- */

export interface PlaceholderRef {
  key: string;
  id: Guid;
}

export interface PlaceholderMapping {
  source: PlaceholderRef;
  target: PlaceholderRef;
}

/* ---------- shared ---------- */

export interface MappingWarning {
  field?: string;           // field name the warning is about, when it applies to one field
  message: string;
}
