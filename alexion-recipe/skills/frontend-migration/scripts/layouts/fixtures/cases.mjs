const file = (path, content) => ({ path: `/project/${path}`, content, size: Buffer.byteLength(content) });
export const cases = {
  jss: { framework: 'jss', files: [
    file('src/LayoutFactory.js', `import * as layouts from './layouts/MainLayout'; const LayoutFactory = new Map(); LayoutFactory.set('main-id', layouts.MainLayout); LayoutFactory.set('default', layouts.DefaultLayout);`),
    file('src/layouts/MainLayout.jsx', `import { Placeholder, VisitorIdentification } from '@sitecore-jss/sitecore-jss-react'; export function MainLayout({route, context}) { const title = route.fields.Title; const subtitle = route.fields['Sub Title']; const id = route.itemId; const language = context.language; return <div id="main" className="shell"><Header/><VisitorIdentification/><Placeholder name="main" rendering={route} editor={false}/><Footer/></div>; }`),
    file('src/layouts/DefaultLayout.jsx', `import { Placeholder } from '@sitecore-jss/sitecore-jss-react'; export function DefaultLayout({route}) { return <div className="default"><Placeholder name="fallback" rendering={route}/></div>; }`),
    file('src/layouts/UnusedLayout.jsx', `import { Placeholder } from '@sitecore-jss/sitecore-jss-react'; export const UnusedLayout = () => <Placeholder name="unused"/>;`),
    file('src/index.jsx', `import { SitecoreContext } from '@sitecore-jss/sitecore-jss-react'; createRoot(root);`),
    file('src/AppRoot.jsx', `import { SitecoreContext } from '@sitecore-jss/sitecore-jss-react'; export const AppRoot = () => <SitecoreContext/>;`),
    file('src/RouteHandler.jsx', `import { SitecoreContext } from '@sitecore-jss/sitecore-jss-react'; dataApi.fetchRouteData();`),
    file('src/seo.js', `// react-helmet canonical og:title application/ld+json noindex`),
  ] },
  contentSdk: { framework: 'content-sdk', files: [
    file('.sitecore/component-map.ts', `export const map = {};`),
    file('.sitecore/component-map.client.ts', `export const map = {};`),
    file('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } })),
    file('package.json', JSON.stringify({ dependencies: { '@sitecore-content-sdk/nextjs': '^1.0.0' } })),
    file('src/Layout.tsx', `import { AppPlaceholder, Text, withDatasourceCheck } from '@sitecore-content-sdk/nextjs'; import { ComponentProps } from 'lib/component-props'; export function Layout({route}) { const title = route.fields.Title; return <div className="shell"><AppPlaceholder name="main"/><Header/></div>; }`),
    file('src/app/layout.tsx', `export default function Root(){ return <html><body/></html>; }`),
    file('src/app/[site]/layout.tsx', `export default function Site(){ return <div id="site"/>; }`),
    file('src/app/[site]/[locale]/[[...path]]/page.tsx', `import type { Metadata } from 'next'; import Head from 'next/head'; export async function generateMetadata(page) { return page.layout.sitecore.route.fields.Title; } export default function Page(){ return <main/>; } // canonical og:title schema.org robots`),
    file('src/Bootstrap.tsx', `export function Bootstrap(){ return <div/>; }`),
    file('src/Custom.tsx', `import { Placeholder, RichText as Rich } from '@sitecore-content-sdk/nextjs'; export function Custom(){ return <Placeholder name="custom"/>; }`),
    file('src/components/Container.tsx', `import { AppPlaceholder } from '@sitecore-content-sdk/nextjs'; export const Container = () => <AppPlaceholder name="excluded"/>;`),
  ] },
  emptyJss: { framework: 'jss', files: [] },
  emptyContentSdk: { framework: 'content-sdk', files: [] },
};
