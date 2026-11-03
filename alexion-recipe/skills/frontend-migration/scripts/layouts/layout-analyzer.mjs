// Pure methods extracted from packages/kajoo-code-analysis/src/analyzers/layout-analyzer.ts at 03e00d4c9.
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
const babelTraverse = traverseModule.default || traverseModule;
const traverse = (ast, visitors) => babelTraverse(ast, { noScope: true, ...visitors });
export class LayoutAnalyzer {
    parseLayoutFile(filePath, content) {
        try {
            const ast = this.parseToAST(content, filePath);
            const layoutInfo = {
                path: filePath,
                name: this.extractComponentName(filePath),
                placeholders: [],
                structuralElements: [],
                dataFields: [],
                jsxStructure: null,
            };
            traverse(ast, {
                JSXElement: (path) => {
                    const element = path.node;
                    const openingElement = element.openingElement;
                    const elementName = this.getJSXElementName(openingElement.name);
                    if (this.isPlaceholderComponent(elementName, element)) {
                        const placeholder = this.extractPlaceholderInfo(element);
                        if (placeholder) {
                            layoutInfo.placeholders.push(placeholder);
                        }
                    }
                    if (elementName === 'div') {
                        const structural = this.extractStructuralElement(element);
                        if (structural) {
                            layoutInfo.structuralElements.push(structural);
                        }
                    }
                    if (this.isStructuralComponent(elementName)) {
                        layoutInfo.structuralElements.push({
                            type: 'component',
                            name: elementName,
                            props: this.extractProps(element),
                        });
                    }
                },
                MemberExpression: (path) => {
                    const dataField = this.extractDataFieldAccess(path.node);
                    if (dataField &&
                        !layoutInfo.dataFields.some((f) => f.fieldPath === dataField.fieldPath)) {
                        layoutInfo.dataFields.push(dataField);
                    }
                },
            });
            layoutInfo.jsxStructure = this.buildJSXStructure(ast);
            return layoutInfo;
        }
        catch (error) {
            return null;
        }
    }
    parseToAST(content) {
        return parse(content, {
            sourceType: 'module',
            plugins: [
                'jsx',
                'typescript',
                'classProperties',
                'objectRestSpread',
                'optionalChaining',
                'nullishCoalescingOperator',
            ],
        });
    }
    extractComponentName(filePath) {
        const fileName = filePath.split('/').pop() || '';
        return fileName.replace(/\.(js|jsx|ts|tsx)$/, '');
    }
    getJSXElementName(name) {
        if (name.type === 'JSXIdentifier') {
            return name.name;
        }
        if (name.type === 'JSXMemberExpression') {
            const parts = [];
            let current = name;
            while (current) {
                if (current.type === 'JSXMemberExpression') {
                    if (current.property.type === 'JSXIdentifier') {
                        parts.unshift(current.property.name);
                    }
                    current = current.object;
                }
                else if (current.type === 'JSXIdentifier') {
                    parts.unshift(current.name);
                    break;
                }
                else {
                    break;
                }
            }
            return parts.join('.');
        }
        return '';
    }
    isPlaceholderComponent(elementName, element) {
        return false;
    }
    extractPlaceholderInfo(element) {
        const props = this.extractProps(element);
        const name = props.name;
        if (!name) {
            return null;
        }
        return {
            name,
            props,
            path: undefined,
        };
    }
    extractStructuralElement(element) {
        const props = this.extractProps(element);
        if (!props.className && !props.id) {
            return null;
        }
        return {
            type: 'div',
            className: props.className,
            id: props.id,
            props,
        };
    }
    extractProps(element) {
        const props = {};
        for (const attr of element.openingElement.attributes) {
            if (attr.type === 'JSXAttribute' && attr.name.type === 'JSXIdentifier') {
                const propName = attr.name.name;
                const propValue = this.extractJSXAttributeValue(attr);
                props[propName] = propValue;
            }
        }
        return props;
    }
    extractJSXAttributeValue(attr) {
        if (!attr.value) {
            return true;
        }
        if (attr.value.type === 'StringLiteral') {
            return attr.value.value;
        }
        if (attr.value.type === 'JSXExpressionContainer') {
            const expr = attr.value.expression;
            if (expr.type === 'StringLiteral') {
                return expr.value;
            }
            if (expr.type === 'NumericLiteral') {
                return expr.value;
            }
            if (expr.type === 'BooleanLiteral') {
                return expr.value;
            }
            if (expr.type === 'Identifier') {
                return `{${expr.name}}`;
            }
            return '{...}';
        }
        return null;
    }
    isStructuralComponent(name) {
        const structuralComponents = [
            'Navigation',
            'Header',
            'Footer',
            'Sidebar',
            'Nav',
            'Main',
            'Aside',
        ];
        return structuralComponents.includes(name);
    }
    extractDataFieldAccess(node) {
        return null;
    }
    buildJSXStructure(ast) {
        let jsxRoot = null;
        traverse(ast, {
            ReturnStatement: (path) => {
                if (path.node.argument?.type === 'JSXElement' ||
                    path.node.argument?.type === 'JSXFragment') {
                    jsxRoot = this.buildJSXNode(path.node.argument);
                }
            },
        });
        return jsxRoot;
    }
    buildJSXNode(node) {
        if (!node)
            return null;
        if (node.type === 'JSXElement') {
            const elementName = this.getJSXElementName(node.openingElement.name);
            const props = {};
            for (const attr of node.openingElement.attributes) {
                if (attr.type === 'JSXAttribute' && attr.name.type === 'JSXIdentifier') {
                    const propName = attr.name.name;
                    if (propName === 'className' || propName === 'id' || propName === 'name') {
                        props[propName] = this.extractJSXAttributeValue(attr);
                    }
                }
            }
            const children = node.children
                .map((child) => this.buildJSXNode(child))
                .filter((child) => child !== null);
            return {
                type: elementName,
                props,
                children: children.length > 0 ? children : undefined,
            };
        }
        if (node.type === 'JSXFragment') {
            const children = node.children
                .map((child) => this.buildJSXNode(child))
                .filter((child) => child !== null);
            return {
                type: 'Fragment',
                children: children.length > 0 ? children : undefined,
            };
        }
        return null;
    }
    normalizePaths(analysis, root) {
        return {
            ...analysis,
            entryPoints: analysis.entryPoints.map((ep) => ({
                ...ep,
                path: this.normalizePath(ep.path, root),
            })),
            layouts: analysis.layouts.map((layout) => ({
                ...layout,
                path: this.normalizePath(layout.path, root),
            })),
        };
    }
    normalizePath(fullPath, root) {
        if (fullPath.startsWith(root)) {
            const relativePath = fullPath.substring(root.length);
            return relativePath.startsWith('/') ? `.${relativePath}` : `./${relativePath}`;
        }
        return fullPath;
    }
}
