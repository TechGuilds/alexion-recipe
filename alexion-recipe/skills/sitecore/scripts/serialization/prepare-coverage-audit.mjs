import {createHash} from 'node:crypto';
import {args,cmp,readBytes,required,run,writeReport} from './core.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const pathKey = value => typeof value === 'string' ? value.toLowerCase() : '';
const validPath = value => typeof value === 'string' && /^\/sitecore(?:\/|$)/i.test(value) && !value.split('/').some(part => part === '.' || part === '..');

function readJson(file, label) {
  try { return JSON.parse(readBytes(file)); }
  catch (error) { throw Error(`Invalid ${label} JSON: ${error.message}`); }
}

function readPathMappings(file) {
  if (!file) return [];
  const input=readJson(file,'target path map');
  if (input?.version !== 1 || !Array.isArray(input.mappings)) throw Error('target path map requires version: 1 and mappings');
  const mappings=input.mappings.map((mapping,index) => {
    if (!validPath(mapping?.sourcePrefix) || !validPath(mapping?.targetPrefix)) throw Error(`Invalid target path map entry ${index}`);
    return {sourcePrefix:mapping.sourcePrefix.replace(/\/$/,''),targetPrefix:mapping.targetPrefix.replace(/\/$/,'')};
  });
  const seen=new Set();
  for (const mapping of mappings) {
    const key=pathKey(mapping.sourcePrefix);
    if (seen.has(key)) throw Error(`Duplicate target path map sourcePrefix: ${mapping.sourcePrefix}`);
    seen.add(key);
  }
  return mappings.sort((a,b) => b.sourcePrefix.length-a.sourcePrefix.length || cmp(a.sourcePrefix,b.sourcePrefix));
}

function targetPath(sourcePath, mappings) {
  const sourceKey=pathKey(sourcePath);
  const match=mappings.find(mapping => sourceKey === pathKey(mapping.sourcePrefix) || sourceKey.startsWith(pathKey(mapping.sourcePrefix)+'/'));
  return match ? match.targetPrefix + sourcePath.slice(match.sourcePrefix.length) : sourcePath;
}

function included(itemPath, include) {
  const itemKey=pathKey(itemPath), includeKey=pathKey(include.path);
  return (include.scope !== 'DescendantsOnly' && itemKey === includeKey) || (include.scope !== 'SingleItem' && itemKey.startsWith(includeKey+'/'));
}

function coverageRows(inspection, mappings) {
  const rows=[];
  for (const module of inspection.modules) {
    for (const include of module.includes) {
      if (!validPath(include.path)) throw Error(`Invalid include path for ${module.namespace}`);
      const expectedItemCount=inspection.items.filter(item => item.namespace === module.namespace && included(item.path,include)).length;
      // A zero-item captured include says nothing about a pre-existing target root.
      if (!expectedItemCount) continue;
      rows.push({
        namespace:module.namespace,
        sourcePath:include.path,
        targetPath:targetPath(include.path,mappings),
        scope:include.scope ?? 'ItemAndDescendants',
        expectedItemCount,
      });
    }
  }
  return rows.sort((a,b) => cmp(a.namespace,b.namespace) || cmp(a.sourcePath,b.sourcePath));
}

run(() => {
  const a=args(['inspection-report','output-root','target-path-map']);
  required(a,'inspection-report','output-root');
  const inspectionBytes=readBytes(a['inspection-report']);
  const inspection=readJson(a['inspection-report'],'inspection report');
  if (inspection?.version !== 1 || inspection?.valid !== true || !Array.isArray(inspection.items) || !Array.isArray(inspection.modules)) {
    throw Error('Inspection report must be a valid version 1 inspection result');
  }
  const invalid=inspection.items.find(item => !item?.id || !validPath(item.path) || !item?.namespace);
  if (invalid) throw Error('Inspection report contains an invalid item record');
  const mappings=readPathMappings(a['target-path-map']);
  const expectedNamespaces=inspection.modules.map(module => ({
    namespace:module.namespace,
    expectedItemCount:inspection.items.filter(item => item.namespace === module.namespace).length,
  })).filter(row => row.expectedItemCount > 0).sort((a,b) => cmp(a.namespace,b.namespace));
  const report={
    version:1,
    kind:'content-coverage-audit-plan',
    inspectionSha256:hash(inspectionBytes),
    expectedItemCount:inspection.items.length,
    expectedNamespaces,
    targetIncludes:coverageRows(inspection,mappings),
    targetPathMappings:mappings,
  };
  writeReport(a['output-root'],'content-coverage-audit-plan.json',report,[a['inspection-report'],...(a['target-path-map']?[a['target-path-map']]:[])]);
});
