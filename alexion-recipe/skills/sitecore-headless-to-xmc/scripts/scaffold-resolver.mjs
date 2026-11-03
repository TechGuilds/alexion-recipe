#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { options, scaffold, output } from '../assets/resolver-framework/scaffold-engine.mjs';
try {
 const o=options(process.argv.slice(2));
 if(o.help) console.log('scaffold-resolver.mjs --target APP [--source SOURCE] [--dry-run|--apply] [--overwrite PATH:SHA256] [--route RELATIVE_PATH] [--component Name=identifier]');
 else output(scaffold(o,[fileURLToPath(new URL('../assets/resolver-framework/',import.meta.url))]));
} catch(e) { console.log(JSON.stringify({error:e.message})); process.exitCode=1; }
