# Headless field rendering

Use for both XP JSS source inspection and target field mapping. Record the installed SDK/version separately on each side; examples from one SDK are not proof of another API.

1. Read the rendering's captured Layout Service fields and template definitions. Record exact field name, ID/type, wrapper, nullability, language and whether the source renders editable markup.
2. Preserve the complete field object for editable Text, RichText, Image and Link components. Passing only value can discard editing metadata. Use raw values only where the source did so.
3. Distinguish absent fields, empty values and missing datasource. Do not manufacture sample values in production code to make a marker pass.
4. Preserve link attributes, image alt/dimensions and rich-text embedded markup. Treat raw HTML according to the existing content trust policy; never execute arbitrary embedded scripts during analysis.
5. Compare normal, preview and editing output. A delivery snapshot alone does not establish editability.

Output a field mapping table with source expression, source payload path, target type/component and evidence. Delegate JSS imports to the headless pair and Razor helpers to the MVC pair. See [field types](../common/field-types.md) and [Layout Service](layout-service.md).
