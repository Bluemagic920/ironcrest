import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,unlinkSync,rmdirSync,existsSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';import {pathToFileURL,fileURLToPath} from 'node:url';
test('invitation patch builder verifies baseline and preserves later initialization and legacy release gates',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'ironcrest-invitation-bundle-')),baseline=path.join(dir,'baseline.mjs'),target=path.join(dir,'candidate.mjs');
 try{
  const source="const LEGACY_RELEASE=false;\nexport default {fetch:async()=>Response.json({legacy:true,enabled:LEGACY_RELEASE,later})};\nconst later='initialized';\n";
  writeFileSync(baseline,source);const build=fileURLToPath(new URL('../tools/build-invitation-worker.cjs',import.meta.url));
  assert.throws(()=>execFileSync(process.execPath,[build,baseline,'0'.repeat(64),target],{windowsHide:true,stdio:'pipe'}));assert.equal(existsSync(target),false);
  const hash=createHash('sha256').update(source).digest('hex');execFileSync(process.execPath,[build,baseline,hash,target],{windowsHide:true});execFileSync(process.execPath,['--check',target],{windowsHide:true});
  const {default:worker}=await import(pathToFileURL(target).href);
  for(const route of ['/health','/api/accept-invitation','/api/accept-invitation/status','/api/attendance/workflows/status']){
   assert.deepEqual(await (await worker.fetch(new Request('https://worker.example'+route),{STAGE9B_ACCEPTANCE_ENABLED:'true'})).json(),{legacy:true,enabled:false,later:'initialized'});
  }
 }finally{for(const file of [baseline,target])if(existsSync(file))unlinkSync(file);rmdirSync(dir);}
});
