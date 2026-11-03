import { access, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readJSON } from './contracts.mjs';

// Profiles may register optional skills that supply canonical workflow operations
// (assets/profiles/<profile>/operation-providers.json). Shared scripts never name those
// skills: they read the registry and load a provider module only when a packet needs it.

const profiles = new URL('../assets/profiles/', import.meta.url);
let registry;
const loaded = new Map();

export async function providerRegistry() {
  if (!registry) {
    const providers = [], contentModes = new Set();
    for (const entry of await readdir(profiles, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      let file;
      try { file = await readJSON(new URL(`${entry.name}/operation-providers.json`, profiles)); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      providers.push(...file.providers);
      for (const mode of file.contentModes ?? []) contentModes.add(mode);
    }
    registry = { providers, contentModes: [...contentModes] };
  }
  return registry;
}

export async function loadProvider(entry, { root = new URL('../../', import.meta.url) } = {}) {
  if (!loaded.has(entry.id)) {
    const url = new URL(`${entry.skill}/${entry.module}`, root);
    try { await access(fileURLToPath(url)); }
    catch { throw new Error(`Operation provider skill "${entry.skill}" is not available next to cms-migration; stage it with the recipe skills`); }
    loaded.set(entry.id, { entry, module: await import(url.href) });
  }
  return loaded.get(entry.id);
}
