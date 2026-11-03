// Pure methods extracted from packages/kajoo-sitecore/src/code/analysis/content-sdk-layout-analyzer.ts at 03e00d4c9.
import { LayoutAnalyzer } from './layout-analyzer.mjs';
import { parse } from '@babel/parser';
import * as t from '@babel/types';
import traverseModule from '@babel/traverse';
const babelTraverse = traverseModule.default || traverseModule;
const traverse = (ast, visitors) => babelTraverse(ast, { noScope: true, ...visitors });
export class ContentSdkLayoutAnalyzer extends LayoutAnalyzer {
    async analyze(files, rootPath) {
        const componentMaps = this.detectComponentMaps(files);
        const entryPoints = this.detectEntryPoints(files);
        const entryPointPaths = new Set(entryPoints.map((ep) => ep.path));
        const entryPointFiles = files.filter((f) => entryPointPaths.has(f.path));
        const layoutFiles = this.detectLayoutFiles(files, entryPointPaths);
        const componentPropsPath = this.detectComponentPropsPath(files);
        const pathAliases = this.detectPathAliases(files);
        const contentSdkPatterns = this.detectContentSdkPatterns(files);
        const allLayoutFiles = [...entryPointFiles, ...layoutFiles];
        const layouts = allLayoutFiles
            .map((file) => this.parseLayoutFile(file.path, file.content))
            .filter((layout) => layout !== null);
        const allPlaceholders = [];
        for (const layout of layouts) {
            allPlaceholders.push(...layout.placeholders.map((p) => p.name));
        }
        const seoPatterns = this.detectContentSdkSEOPatterns(files);
        return {
            framework: 'content-sdk',
            entryPoints,
            layouts,
            componentMaps,
            componentPropsPath,
            pathAliases,
            contentSdkPatterns,
            allPlaceholders: Array.from(new Set(allPlaceholders)).sort(),
            allDataFields: [],
            seoPatterns,
        };
    }
    detectComponentMaps(files) {
        const serverMap = files.find((f) => f.path.includes('component-map.ts') && !f.path.includes('.client.'))
            ?.path || null;
        const clientMap = files.find((f) => f.path.includes('component-map.client.ts'))?.path || null;
        const registrationPattern = 'auto';
        return {
            serverMap,
            clientMap,
            registrationPattern,
        };
    }
    detectLayoutFiles(files, entryPointPaths) {
        return files.filter((file) => {
            if (entryPointPaths.has(file.path))
                return false;
            if (file.path.includes('.sitecore/') ||
                file.path.includes('import-map') ||
                file.path.includes('component-map')) {
                return false;
            }
            if (file.path.includes('/components/')) {
                return false;
            }
            try {
                const imports = this.extractContentSdkImports(file.content, file.path);
                return imports.has('AppPlaceholder') || imports.has('Placeholder');
            }
            catch {
                return false;
            }
        });
    }
    detectEntryPoints(files) {
        const entryPoints = [];
        for (const file of files) {
            if (file.path.match(/\/src\/Layout\.tsx$/)) {
                entryPoints.push({
                    type: 'root-component',
                    path: file.path,
                    description: 'Sitecore layout wrapper component',
                });
            }
            else if (file.path.match(/\/src\/app\/layout\.tsx$/)) {
                entryPoints.push({
                    type: 'app-entry',
                    path: file.path,
                    description: 'Next.js root layout',
                });
            }
            else if (file.path.match(/\/src\/app\/\[site\]\/layout\.tsx$/)) {
                entryPoints.push({
                    type: 'app-entry',
                    path: file.path,
                    description: 'Site-specific layout',
                });
            }
            else if (file.path.match(/\/src\/app\/.*\/\[\[\.\.\.path\]\]\/page\.tsx$/)) {
                entryPoints.push({
                    type: 'route-handler',
                    path: file.path,
                    description: 'Dynamic page renderer',
                });
            }
            else if (file.path.match(/\/src\/Bootstrap\.tsx$/)) {
                entryPoints.push({
                    type: 'root-component',
                    path: file.path,
                    description: 'Bootstrap/initialization component',
                });
            }
        }
        return entryPoints;
    }
    detectComponentPropsPath(files) {
        for (const file of files) {
            try {
                const ast = this.parseToAST(file.content, file.path);
                let componentPropsPath = null;
                traverse(ast, {
                    ImportDeclaration: (path) => {
                        const importPath = path.node.source.value;
                        const specifiers = path.node.specifiers;
                        if (specifiers.some((s) => t.isImportSpecifier(s) &&
                            t.isIdentifier(s.imported) &&
                            s.imported.name === 'ComponentProps')) {
                            componentPropsPath = importPath;
                        }
                    },
                });
                if (componentPropsPath) {
                    return componentPropsPath;
                }
            }
            catch {
                continue;
            }
        }
        return null;
    }
    detectPathAliases(files) {
        const tsconfigFile = files.find((f) => f.path.endsWith('tsconfig.json'));
        if (!tsconfigFile) {
            return {};
        }
        try {
            const tsconfig = JSON.parse(tsconfigFile.content);
            return tsconfig.compilerOptions?.paths || {};
        }
        catch {
            return {};
        }
    }
    detectContentSdkPatterns(files) {
        const fieldHelpersUsed = new Set();
        let usesWithDatasourceCheck = false;
        let contentSdkVersion = null;
        const packageJson = files.find((f) => f.path.endsWith('package.json'));
        if (packageJson) {
            try {
                const pkg = JSON.parse(packageJson.content);
                contentSdkVersion = pkg.dependencies?.['@sitecore-content-sdk/nextjs'] || null;
            }
            catch {
            }
        }
        for (const file of files) {
            try {
                const imports = this.extractContentSdkImports(file.content, file.path);
                const fieldHelpers = [
                    'Text',
                    'RichText',
                    'Link',
                    'NextImage',
                    'Image',
                    'DateField',
                    'File',
                    'AppPlaceholder',
                    'Placeholder',
                ];
                for (const helper of fieldHelpers) {
                    if (imports.has(helper)) {
                        fieldHelpersUsed.add(helper);
                    }
                }
                if (imports.has('withDatasourceCheck')) {
                    usesWithDatasourceCheck = true;
                }
            }
            catch {
                continue;
            }
        }
        return {
            fieldHelpersUsed: Array.from(fieldHelpersUsed).sort(),
            usesWithDatasourceCheck,
            contentSdkVersion,
        };
    }
    extractContentSdkImports(content, filePath) {
        const imports = new Set();
        try {
            const ast = this.parseToAST(content, filePath);
            traverse(ast, {
                ImportDeclaration: (path) => {
                    const source = path.node.source.value;
                    if (source === '@sitecore-content-sdk/nextjs') {
                        path.node.specifiers.forEach((spec) => {
                            if (t.isImportSpecifier(spec) && t.isIdentifier(spec.imported)) {
                                imports.add(spec.imported.name);
                            }
                        });
                    }
                },
            });
        }
        catch {
        }
        return imports;
    }
    isPlaceholderComponent(elementName) {
        return elementName === 'AppPlaceholder' || elementName === 'Placeholder';
    }
    extractDataFieldAccess(node) {
        if (this.matchesNestedPath(node, ['page', 'layout', 'sitecore', 'route', 'fields'])) {
            const fieldName = node.property?.name;
            if (fieldName) {
                return {
                    fieldPath: `page.layout.sitecore.route.fields.${fieldName}`,
                    fieldName,
                    usage: 'read',
                };
            }
        }
        if (this.matchesNestedPath(node, ['layout', 'sitecore', 'route', 'fields'])) {
            const fieldName = node.property?.name;
            if (fieldName) {
                return {
                    fieldPath: `layout.sitecore.route.fields.${fieldName}`,
                    fieldName,
                    usage: 'read',
                };
            }
        }
        if (node.object?.type === 'MemberExpression' &&
            node.object.object?.name === 'route' &&
            node.object.property?.name === 'fields') {
            const fieldName = node.property?.name;
            if (fieldName) {
                return {
                    fieldPath: `route.fields.${fieldName}`,
                    fieldName,
                    usage: 'read',
                };
            }
        }
        return null;
    }
    matchesNestedPath(node, path) {
        let current = node;
        let depth = path.length;
        for (let i = depth - 1; i >= 0; i--) {
            if (current.type !== 'MemberExpression')
                return false;
            if (current.property?.name !== path[i])
                return false;
            if (i > 0) {
                current = current.object;
            }
            else {
                return current.object?.type === 'Identifier' && current.object?.name === path[0];
            }
        }
        return true;
    }
    detectContentSdkSEOPatterns(files) {
        let usesGenerateMetadata = false;
        let usesMetadataApi = false;
        let usesNextHead = false;
        for (const file of files) {
            const content = file.content;
            if (/export\s+(const|async\s+function)\s+generateMetadata/.test(content)) {
                usesGenerateMetadata = true;
            }
            if (/import.*Metadata.*from ['"]next['"]/i.test(content)) {
                usesMetadataApi = true;
            }
            if (/import.*Head.*from ['"]next\/head['"]/i.test(content)) {
                usesNextHead = true;
            }
        }
        return {
            contentSdk: {
                usesGenerateMetadata,
                usesMetadataApi,
                usesNextHead,
            },
        };
    }
    parseToAST(content) {
        return parse(content, {
            sourceType: 'module',
            plugins: ['jsx', 'typescript'],
            errorRecovery: true,
        });
    }
    normalizePaths(analysis, root) {
        const normalized = super.normalizePaths(analysis, root);
        return {
            ...normalized,
            framework: 'content-sdk',
            componentMaps: {
                serverMap: analysis.componentMaps.serverMap
                    ? this.normalizePath(analysis.componentMaps.serverMap, root)
                    : null,
                clientMap: analysis.componentMaps.clientMap
                    ? this.normalizePath(analysis.componentMaps.clientMap, root)
                    : null,
                registrationPattern: analysis.componentMaps.registrationPattern,
            },
            contentSdkPatterns: analysis.contentSdkPatterns,
        };
    }
}
