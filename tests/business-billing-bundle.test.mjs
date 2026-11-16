import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,unlinkSync,rmdirSync,existsSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';import {pathToFileURL,fileURLToPath} from 'node:url';
test('actual single-file Worker builds reproducibly, parses, and preserves the production source gate',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'ironcrest-bundle-'));try{
 const build=fileURLToPath(new URL('../tools/build-business-worker.cjs',import.meta.url)),target=path.join(dir,'worker.mjs');
 const first=JSON.parse(execFileSync(process.execPath,[build,target],{encoding:'utf8',windowsHide:true}));
 const second=JSON.parse(execFileSync(process.execPath,[build,target],{encoding:'utf8',windowsHide:true}));assert.equal(first.sha256,second.sha256);
 execFileSync(process.execPath,['--check',target],{windowsHide:true});
 const {default:worker}=await import(pathToFileURL(target).href);
 const env={BUSINESS_STRIPE_MODE:'live',ENABLE_BUSINESS_BILLING:'true'};
 assert.equal((await worker.fetch(new Request('https://worker.example/api/business/billing/webhook',{method:'POST',body:'{}'}),env)).status,503);
 assert.equal((await (await worker.fetch(new Request('https://worker.example/health'),env)).json()).productionApproved,false);
 assert.ok(!readFileSync(target,'utf8').includes('require('));
 }finally{const target=path.join(dir,'worker.mjs');if(existsSync(target))unlinkSync(target);rmdirSync(dir);}
});
test('staging bundle preserves its inspected baseline and keeps the sandbox bridge closed by default',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'ironcrest-stage-bundle-')),baseline=path.join(dir,'baseline.mjs'),target=path.join(dir,'candidate.mjs');try{
 const source="export default {fetch:async()=>Response.json({legacy:true,webhookProcessingEnabled:false})};\n";writeFileSync(baseline,source);
 const build=fileURLToPath(new URL('../tools/build-staging-business-worker.cjs',import.meta.url));
 assert.throws(()=>execFileSync(process.execPath,[build,baseline,'0'.repeat(64),target],{stdio:'pipe',windowsHide:true}));assert.equal(existsSync(target),false);
 execFileSync(process.execPath,[build,baseline,createHash('sha256').update(source).digest('hex'),target],{windowsHide:true});execFileSync(process.execPath,['--check',target],{windowsHide:true});
 const {default:worker}=await import(pathToFileURL(target).href);
 const response=await worker.fetch(new Request('https://worker.example/api/stripe-webhook'),{ENABLE_BUSINESS_WEBHOOK_BRIDGE:'true',ENABLE_BUSINESS_BILLING:'true'});
 assert.deepEqual(await response.json(),{legacy:true,webhookProcessingEnabled:false});
 }finally{for(const p of [baseline,target])if(existsSync(p))unlinkSync(p);rmdirSync(dir);}
});
