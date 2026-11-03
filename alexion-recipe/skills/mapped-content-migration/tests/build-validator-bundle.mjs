// Authoring-only build helper. Runtime scripts use the emitted bundle and Node built-ins; this is
// not a migration operation and client agents never run it.
// Rebuilds the bundled Ajv 8.17.1 validator and its third-party notices in
// ../../cms-migration/scripts/lib/vendor/. Requires Ajv 8.17.1 and esbuild in a development
// environment. After rebuilding, run the full test suites (independent schema comparison and
// isolated-runtime checks).
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const ajvPackage = require.resolve('ajv/package.json');
if (JSON.parse(await readFile(ajvPackage, 'utf8')).version !== '8.17.1') throw new Error('Build requires Ajv 8.17.1');
const directory = fileURLToPath(new URL('../../cms-migration/scripts/lib/vendor/', import.meta.url));
await mkdir(directory, { recursive: true });
await build({
  entryPoints: [require.resolve('ajv/dist/2020.js')],
  outfile: join(directory, 'ajv.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  legalComments: 'inline',
  banner: { js: '// Bundled Ajv 8.17.1 for recipe execution without npm installation. See LICENSES.txt.' },
});
const dependencyRequire = createRequire(ajvPackage);
const notices = [];
for (const name of ['ajv', 'fast-deep-equal', 'fast-uri', 'json-schema-traverse', 'require-from-string']) {
  const packageFile = name === 'ajv' ? ajvPackage : dependencyRequire.resolve(name + '/package.json');
  const metadata = JSON.parse(await readFile(packageFile, 'utf8'));
  let license;
  for (const filename of ['LICENSE', 'LICENSE.md', 'license']) {
    try { license = await readFile(join(dirname(packageFile), filename), 'utf8'); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!license) throw new Error('Missing license: ' + name);
  notices.push(name + ' ' + metadata.version + '\n\n' + license);
}
await writeFile(join(directory, 'LICENSES.txt'), notices.join('\n\n---\n\n'));
