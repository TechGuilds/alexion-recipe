#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
try {
 const args=process.argv.slice(2), i=args.indexOf('--resolver-assets');
 const assets=i>=0?args[i+1]:fileURLToPath(new URL('../assets/resolver-framework/',import.meta.url));
 if(!assets||assets.startsWith('--')) throw Error('--resolver-assets requires the supplied resolver-framework asset directory');
 const {options,scaffold,output}=await import(pathToFileURL(path.resolve(assets,'scaffold-engine.mjs')));
 const o=options(args);
 if(o.help) console.log('scaffold-mock-service.mjs --target APP [--resolver-assets DIRECTORY] [--source SOURCE] [--dry-run|--apply] [--overwrite PATH:SHA256] [--route RELATIVE_PATH] [--layout ROOT_LAYOUT] [--preview-stage DIRECTORY --preview-stage-sha256 SHA256]');
 else output(scaffold(o,[assets,fileURLToPath(new URL('../assets/mock-layout-service/',import.meta.url))],true));
} catch(e){ console.log(JSON.stringify({error:e.code==='ERR_MODULE_NOT_FOUND'?'Supply resolver assets with --resolver-assets DIRECTORY':e.message})); process.exitCode=1; }
