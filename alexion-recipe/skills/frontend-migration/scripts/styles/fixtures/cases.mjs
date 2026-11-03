const file = (path, content) => ({ path, content, size: content.length });
const pkg = (dependencies, devDependencies = {}, peerDependencies = {}) =>
  file('package.json', JSON.stringify({ dependencies, devDependencies, peerDependencies }));

export const cases = {
  empty: [],
  invalid: [
    file('package.json', '{'),
    file('broken.tsx', 'const = <'),
    file('plain.css', 'body { color: red }'),
  ],
  bootstrap: [
    pkg({ bootstrap: '5', 'react-bootstrap': '2', jquery: '3', 'popper.js': '1' }),
    file(
      'App.tsx',
      "import { Button, Card } from 'react-bootstrap';\nimport 'bootstrap/dist/css/bootstrap.css';\nexport const App = () => <div className=\"container row btn\" />;",
    ),
    file('main.scss', "@import '~bootstrap/scss/bootstrap';\n@use 'bootstrap' as bs;"),
  ],
  sass: [
    pkg({}, { sass: '1', 'sass-loader': '2' }),
    file(
      'src/Foundation/styles/main.scss',
      "$color: red;\n@import './reset';\n@use 'sass:math' as math;\n@forward './mixins';\n@mixin box { &:hover { color: $color; } }\n@include box;",
    ),
    file('src/Feature/card.sass', '$gap: 1px'),
  ],
  tailwind: [
    pkg({ tailwindcss: '3' }),
    file('tailwind.config.ts', "export default { mode: 'jit', theme: { extend: {} } }"),
    file('postcss.config.cjs', ''),
    file(
      'global.css',
      '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n.x { @apply flex; }',
    ),
    file(
      'App.tsx',
      'export const App = () => <div className="md:flex hover:bg-blue-500 gap-4 text-xl rounded-lg w-1/2" />;',
    ),
  ],
  modules: [
    file('Card.module.css', '.card {}'),
    file('Card.module.scss', '.card {}'),
    file('Card.module.sass', '.card'),
    file('Card.module.less', '.card {}'),
    file('webpack.config.js', "export default { loader: 'css-loader', modules: true };"),
    file(
      'Card.tsx',
      "import styles from './Card.module.css';\nexport const Card = () => <div className={styles.card} />;",
    ),
  ],
  cssInJs: [
    pkg({ 'styled-components': '6', '@emotion/react': '11', 'react-jss': '10' }),
    file(
      'App.tsx',
      "import styled from 'styled-components';\nimport { css } from '@emotion/react';\nconst Card = styled.div`color: red;`;\nconst rule = css({color: 'red'});\nconst useStyles = createUseStyles({});\nexport const App = () => <ThemeProvider><Card /></ThemeProvider>;",
    ),
  ],
  variables: [
    file(
      'src/tokens/theme.css',
      ':root { --color-primary: red; --space-sm: 1px; --font-size: 12px; }\n.x {color: var(--color-primary)}',
    ),
    file('App.tsx', 'export const App = () => <div style={{color: "var(--color-primary)"}} />;'),
  ],
  falsePositives: [
    pkg({ bootstrap: '5' }, { postcss: '8', autoprefixer: '10' }),
    file(
      'App.tsx',
      'const x = css`color: red`; const App = () => <div className="flex-col gap-4" />;',
    ),
    file('View.cshtml', 'css({}) styled.div`red`'),
  ],
  imports: [
    file(
      'App.tsx',
      "// import './fake.css';\nimport styles\n  from './Card.module.scss';\nimport { theme as renamed } from './theme.css';\nimport * as all from './all.less';\nimport './global.css';\nconst lazy = import('./lazy.css');\nconst old = require('./old.css');\nexport const App = (props: {name: string}) => <div>{props.name}</div>;",
    ),
    file('node_modules/ignored.ts', "import './ignored.css';"),
    file('broken.tsx', 'const = <'),
  ],
  sizes: Array.from({ length: 12 }, (_, i) =>
    file(`file${i}.${i % 2 ? 'less' : 'CSS'}`, 'x'.repeat(i + 1)),
  ),
};
cases.mixed = [
  ...cases.bootstrap,
  ...cases.sass.slice(1),
  ...cases.tailwind.slice(1),
  ...cases.modules,
  ...cases.cssInJs.slice(1),
  ...cases.variables,
];

export const mvcCases = {
  missing: undefined,
  empty: { bundleConfigs: [], razorStyleRefs: [] },
  full: {
    bundleConfigs: [
      {
        filePath: 'BundleConfig.cs',
        bundles: [
          {
            virtualPath: '~/bundles/site',
            includes: ['~/reset.css', '~/site.css'],
            bundleType: 'StyleBundle',
          },
          { virtualPath: '~/bundles/print', includes: ['~/print.css'] },
        ],
      },
    ],
    razorStyleRefs: [
      {
        filePath: 'Layout.cshtml',
        linkTags: [
          'https://kit.fontawesome.com/kit.css',
          '/site.css',
          '~/app.css',
          './relative.css',
          ' //cdn/site.css ',
        ],
        stylesRenders: ['~/bundles/site'],
        hasStylesSection: true,
      },
    ],
    razorBodyClasses: [
      {
        filePath: 'Layout.cshtml',
        staticClasses: ['page', 'second'],
        expression: '@Model.Class',
        conditionHint: 'loggedIn',
      },
      { filePath: 'Other.cshtml', staticClasses: [], expression: '@Model.BodyClass' },
    ],
    razorInlineStyleAttrs: [
      {
        filePath: 'Hero.cshtml',
        tag: 'div',
        expression: '@Model.BackgroundCss',
        lineNumber: 4,
        viewModelProperty: 'BackgroundCss',
      },
      { filePath: 'Fallback.cshtml', tag: 'section', expression: '@Build(Model)', lineNumber: 8 },
      { filePath: 'Ambiguous.cshtml', tag: 'span', expression: '@Build(Model)', lineNumber: 9 },
    ],
    cssStringViewModelProps: [
      { consumedByView: 'Fallback.cshtml', propertyName: 'Color' },
      { consumedByView: 'Ambiguous.cshtml', propertyName: 'Color' },
      { consumedByView: 'Ambiguous.cshtml', propertyName: 'Background' },
    ],
  },
};
export const headlessCases = {
  empty: [],
  full: [
    file(
      'app/layout.tsx',
      '<link rel="stylesheet" href="https://cdn.example.com/pro/lib.css" />\n<link rel="stylesheet" href="./site.css" />\n<link rel="stylesheet" href="../other.css" />\n<link rel="stylesheet" href="bare.css" />\n<link rel="icon" href="/favicon.ico" />\n<link rel="stylesheet" href={props.url} />\n<body className={`shell ${active ? "on" : "off"}`}>\n<div style={{color: props.theme.primary}} />\n<span style={{opacity: computed}} />\n<body className={getClass()} />',
    ),
  ],
};
