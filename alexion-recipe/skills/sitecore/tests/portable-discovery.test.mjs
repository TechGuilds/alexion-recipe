import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
test('copied discovery builders and fixtures run without workspace packages', async () => {
  const root=await mkdtemp(join(tmpdir(),'kajoo-portable-discovery-'));
  const base=new URL('../',import.meta.url);
  try {
    await mkdir(join(root,'scripts/analysis'),{recursive:true});
    await mkdir(join(root,'tests'));
    for(const name of ['rendering-evidence','rendering-configurations','build-rendering-capture-plan','build-rendering-mapping-inventory'])
      await copyFile(fileURLToPath(new URL('scripts/analysis/'+name+'.mjs',base)),join(root,'scripts/analysis',name+'.mjs'));
    const tests=['rendering-evidence.test.mjs','rendering-capture-plan.test.mjs','rendering-mapping-inventory.test.mjs'];
    for(const name of tests) await copyFile(fileURLToPath(new URL('tests/'+name,base)),join(root,'tests',name));
    const env={...process.env};
    delete env.NODE_TEST_CONTEXT;
    const result=await exec(process.execPath,['--test','--test-reporter=tap',...tests.map(name=>join(root,'tests',name))],{cwd:root,env,timeout:30000});
    assert.match(result.stdout,/tests [1-9][0-9]*/);
    assert.match(result.stdout,/fail 0/);
  } finally { await rm(root,{recursive:true,force:true}); }
});
