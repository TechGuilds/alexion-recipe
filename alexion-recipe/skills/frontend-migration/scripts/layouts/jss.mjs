// Pure methods extracted from packages/kajoo-sitecore/src/code/analysis/sitecore-layout-analyzer.ts at 03e00d4c9.
import { LayoutAnalyzer } from './layout-analyzer.mjs';
import * as path from 'node:path';
import traverseModule from '@babel/traverse';
const babelTraverse = traverseModule.default || traverseModule;
const traverse = (ast, visitors) => babelTraverse(ast, { noScope: true, ...visitors });
export class SitecoreLayoutAnalyzer extends LayoutAnalyzer {
    async analyze(files, rootPath) {
        const entryPointFiles = this.detectEntryPoints(files);
        const layoutFactoryFile = this.detectLayoutFactory(files);
        const candidateLayoutFiles = this.detectLayoutFiles(files);
        let layoutFactoryPath = null;
        let layoutFactoryMappings = [];
        let defaultLayoutName = null;
        if (layoutFactoryFile) {
            layoutFactoryPath = layoutFactoryFile.path;
            layoutFactoryMappings = this.parseLayoutFactory(layoutFactoryFile.content, layoutFactoryFile.path);
            defaultLayoutName = layoutFactoryMappings.find(mapping => mapping.layoutId === 'default')?.componentName ?? null;
        }
        const referencedLayoutNames = new Set(layoutFactoryMappings.map((m) => m.componentName));
        if (defaultLayoutName) {
            referencedLayoutNames.add(defaultLayoutName);
        }
        const layoutFiles = candidateLayoutFiles.filter((file) => {
            const fileName = file.path
                .split('/')
                .pop()
                ?.replace(/\.(js|jsx|ts|tsx)$/, '');
            return referencedLayoutNames.has(fileName || '');
        });
        const layouts = layoutFiles
            .map((file) => {
            const baseLayout = this.parseLayoutFile(file.path, file.content);
            if (!baseLayout)
                return null;
            const sitecoreLayout = {
                ...baseLayout,
                dataFields: [],
                routeFields: baseLayout.dataFields.map((df) => ({
                    ...df,
                    category: this.categorizeRouteField(df.fieldPath),
                })),
            };
            return sitecoreLayout;
        })
            .filter((layout) => layout !== null);
        const jssPatterns = this.detectJSSPatterns(files);
        const entryPoints = [];
        for (const file of entryPointFiles) {
            entryPoints.push({
                type: this.classifyEntryPointType(file.content),
                path: file.path,
                description: this.getEntryPointDescription(file.path, file.content),
            });
        }
        if (layoutFactoryFile) {
            entryPoints.push({
                type: 'layout-factory',
                path: layoutFactoryPath,
                description: 'Sitecore JSS Layout factory for routing',
            });
            this.matchLayoutsToFactory(layouts, layoutFactoryMappings);
        }
        const allPlaceholders = [];
        const allRouteFields = [];
        const allDataFields = [];
        for (const layout of layouts) {
            allPlaceholders.push(...layout.placeholders.map((p) => p.name));
            allRouteFields.push(...layout.routeFields.map((f) => f.fieldPath));
            allDataFields.push(...layout.dataFields.map((f) => f.fieldPath));
        }
        return {
            entryPoints,
            layoutFactory: {
                path: layoutFactoryPath,
                mappings: layoutFactoryMappings,
                defaultLayout: defaultLayoutName,
            },
            layouts,
            allPlaceholders: Array.from(new Set(allPlaceholders)).sort(),
            allDataFields: Array.from(new Set(allDataFields)).sort(),
            allRouteFields: Array.from(new Set(allRouteFields)).sort(),
            jssPatterns,
        };
    }
    detectEntryPoints(files) {
        return files.filter((file) => {
            try {
                const imports = this.extractJSSImports(file.content, file.path);
                return imports.has('SitecoreContext') && !this.isLayoutFactoryContent(file.content, file.path);
            }
            catch {
                return false;
            }
        });
    }
    detectLayoutFiles(files) {
        return files.filter((file) => {
            try {
                const imports = this.extractJSSImports(file.content, file.path);
                return imports.has('Placeholder');
            }
            catch {
                return false;
            }
        });
    }
    detectLayoutFactory(files) {
        return files.find((file) => this.isLayoutFactoryContent(file.content, file.path)) || null;
    }
    isLayoutFactoryContent(content, filePath) {
        try {
            const ast = this.parseToAST(content, filePath);
            let hasFactoryName = false;
            let layoutImports = 0;
            let hasMapping = false;
            traverse(ast, {
                Identifier: (path) => {
                    if (/LayoutFactory|layoutFactory/.test(path.node.name)) {
                        hasFactoryName = true;
                    }
                },
                ImportDeclaration: (path) => {
                    const importPath = path.node.source.value;
                    if (/\.\/.*[Ll]ayout|layouts\//.test(importPath)) {
                        layoutImports++;
                    }
                },
                CallExpression: (path) => {
                    if (path.node.callee.type === 'MemberExpression' &&
                        path.node.callee.property.type === 'Identifier' &&
                        path.node.callee.property.name === 'set') {
                        hasMapping = true;
                    }
                },
            });
            return hasFactoryName && layoutImports >= 1 && hasMapping;
        }
        catch {
            const hasFactoryName = /LayoutFactory|layoutFactory/.test(content);
            const hasLayoutImport = /import.*Layout.*from/.test(content);
            const hasMapping = /\.set\(|:\s*\w+Layout/.test(content);
            return hasFactoryName && hasLayoutImport && hasMapping;
        }
    }
    extractJSSImports(content, filePath) {
        const imports = new Set();
        try {
            const ast = this.parseToAST(content, filePath);
            traverse(ast, {
                ImportDeclaration: (path) => {
                    const source = path.node.source.value;
                    if (source === '@sitecore-jss/sitecore-jss-react' || source === '@sitecore-jss/sitecore-jss-nextjs') {
                        for (const specifier of path.node.specifiers) {
                            if (specifier.type === 'ImportSpecifier' &&
                                specifier.imported.type === 'Identifier') {
                                imports.add(specifier.imported.name);
                            }
                        }
                    }
                },
            });
        }
        catch {
        }
        return imports;
    }
    classifyEntryPointType(content) {
        if (/ReactDOM\.render|createRoot/.test(content)) {
            return 'app-entry';
        }
        if (/RouteHandler|dataApi\.fetchRouteData/.test(content)) {
            return 'route-handler';
        }
        return 'root-component';
    }
    getEntryPointDescription(filePath, content) {
        const fileName = path.basename(filePath);
        if (/index\./i.test(fileName)) {
            return 'Application entry point';
        }
        if (/AppRoot/i.test(fileName) || /AppRoot/i.test(content)) {
            return 'Root application component with providers';
        }
        if (/RouteHandler/i.test(fileName) || /RouteHandler/i.test(content)) {
            return 'Route handler component';
        }
        return 'Sitecore JSS entry component';
    }
    isPlaceholderComponent(elementName, element) {
        return elementName === 'Placeholder';
    }
    extractPlaceholderInfo(element) {
        const props = this.extractProps(element);
        const name = props.name;
        if (!name) {
            return null;
        }
        const path = props.rendering ? 'route' : undefined;
        return {
            name,
            props,
            path,
        };
    }
    isStructuralComponent(name) {
        const jssStructuralComponents = [
            'VisitorIdentification',
            'Placeholder',
        ];
        return super.isStructuralComponent(name) || jssStructuralComponents.includes(name);
    }
    categorizeRouteField(fieldPath) {
        if (fieldPath.startsWith('route.fields'))
            return 'route.fields';
        if (fieldPath.startsWith('route.'))
            return 'route';
        return 'context';
    }
    extractDataFieldAccess(node) {
        if (node.object?.type === 'MemberExpression' &&
            node.object.object?.type === 'Identifier' &&
            node.object.object.name === 'route' &&
            node.object.property?.type === 'Identifier' &&
            node.object.property.name === 'fields') {
            let fieldName = null;
            if (node.property?.type === 'Identifier') {
                fieldName = node.property.name;
            }
            else if (node.computed && node.property?.type === 'StringLiteral') {
                fieldName = node.property.value;
            }
            if (fieldName) {
                return {
                    fieldPath: `route.fields['${fieldName}']`,
                    fieldName,
                    usage: 'read',
                    category: 'route.fields',
                };
            }
        }
        if (node.object?.type === 'Identifier' &&
            node.object.name === 'route' &&
            node.property?.type === 'Identifier') {
            const fieldName = node.property.name;
            return {
                fieldPath: `route.${fieldName}`,
                fieldName,
                usage: 'read',
                category: 'route',
            };
        }
        if (node.object?.type === 'Identifier' &&
            node.object.name === 'context' &&
            node.property?.type === 'Identifier') {
            const fieldName = node.property.name;
            return {
                fieldPath: `context.${fieldName}`,
                fieldName,
                usage: 'read',
                category: 'context',
            };
        }
        return null;
    }
    detectJSSPatterns(files) {
        let usesLayoutService = false;
        let usesVisitorIdentification = false;
        let usesWithSitecoreContext = false;
        for (const file of files) {
            const content = file.content;
            if (/dataApi\.fetchRouteData|getRouteData|LayoutService/i.test(content)) {
                usesLayoutService = true;
            }
            if (/<VisitorIdentification|VisitorIdentification\s*\/>/i.test(content)) {
                usesVisitorIdentification = true;
            }
            if (/withSitecoreContext|SitecoreContext/i.test(content)) {
                usesWithSitecoreContext = true;
            }
        }
        return {
            usesLayoutService,
            usesVisitorIdentification,
            usesWithSitecoreContext,
        };
    }
    parseLayoutFactory(content, filePath) {
        const mappings = [];
        try {
            traverse(this.parseToAST(content, filePath), {
                CallExpression: ({ node }) => {
                    const [id, component] = node.arguments;
                    if (node.callee.type !== 'MemberExpression' || node.callee.computed ||
                        node.callee.property.name !== 'set' || component?.type !== 'MemberExpression' ||
                        component.computed || component.property.type !== 'Identifier') return;
                    const layoutId = id?.type === 'StringLiteral' ? id.value :
                        id?.type === 'TemplateLiteral' && id.expressions.length === 0 ? id.quasis[0].value.cooked : null;
                    if (layoutId !== null) mappings.push({ layoutId, componentName: component.property.name, filePath: undefined });
                },
            });
        } catch {
            // The caller retains parseWarnings; never manufacture mappings from comments or malformed code.
        }
        return mappings;
    }
    extractDefaultLayout(content) {
        const defaultMatch = content.match(/\.set\s*\(\s*['"`]default['"`]\s*,\s*[\w.]+\.(\w+)/);
        if (defaultMatch) {
            return defaultMatch[1];
        }
        return null;
    }
    matchLayoutsToFactory(layouts, mappings) {
        for (const layout of layouts) {
            const mapping = mappings.find((m) => m.componentName === layout.name);
            if (mapping) {
                mapping.filePath = layout.path;
                layout.layoutId = mapping.layoutId;
            }
        }
    }
    normalizePaths(analysis, root) {
        const baseNormalized = super.normalizePaths(analysis, root);
        const normalized = {
            ...baseNormalized,
            layouts: baseNormalized.layouts,
            allRouteFields: analysis.allRouteFields,
            jssPatterns: analysis.jssPatterns,
            layoutFactory: {
                ...analysis.layoutFactory,
                path: analysis.layoutFactory.path
                    ? this.normalizePath(analysis.layoutFactory.path, root)
                    : null,
                mappings: analysis.layoutFactory.mappings.map((m) => ({
                    ...m,
                    filePath: m.filePath ? this.normalizePath(m.filePath, root) : undefined,
                })),
            },
        };
        return normalized;
    }
}
