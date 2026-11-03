#!/usr/bin/env node
import { createTargetRenderingInventory } from './component-mapping.mjs';
import { isMain, parseArgs, readBound, writeFreshOutput } from './cli-files.mjs';

export function createTargetInventory(args) {
  const options = parseArgs(args, ['input', 'input-sha256', 'output-dir']);
  const input = readBound(options, 'input');
  return writeFreshOutput(options['output-dir'], 'target-rendering-inventory.json', createTargetRenderingInventory(input.value));
}
if (isMain(import.meta.url)) {
  try { console.log(createTargetInventory(process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
