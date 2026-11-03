// Node 24 detects this ES module; .js also supports the workspace file editor.
import { pathToFileURL } from 'node:url';
import path from 'node:path';

try {
  const options = JSON.parse(process.argv[2] || '{}');
  if (!['mock', 'live', 'mock-debug', 'live-debug'].includes(options.mode)) throw new Error('Invalid mode');
  if (!options.envScript || !path.isAbsolute(options.envScript)) throw new Error('envScript must be the installed absolute path of dev-server/scripts/env-file.mjs');
  const port = options.port ?? 3000;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  const { updateEnv } = await import(pathToFileURL(options.envScript).href);
  const result = await updateEnv(options, current => {
    if (options.mode.startsWith('live')) {
      const missing = ['SITECORE_EDGE_CONTEXT_ID', 'SITECORE_EDITING_SECRET'].filter(key => !current[key]);
      if (missing.length) throw new Error('Missing required variables: ' + missing.join(', '));
    }
    return { USE_MOCK_LAYOUT_SERVICE: String(options.mode.startsWith('mock')), RESOLVER_DEBUG: String(options.mode.endsWith('-debug')),
      ...(options.mode.startsWith('live') && !current.SITECORE_INTERNAL_EDITING_HOST_URL ? { SITECORE_INTERNAL_EDITING_HOST_URL: `http://localhost:${port}` } : {}) };
  });
  console.log(JSON.stringify({ mode: options.mode, ...result }));
} catch (error) { console.log(JSON.stringify({ error: error.message })); process.exitCode = 1; }
