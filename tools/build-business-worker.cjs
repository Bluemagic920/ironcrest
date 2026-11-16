const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
function moduleSource(file,names){
 const source=fs.readFileSync(path.join(root,'worker',file),'utf8').replace(/\r/g,'').replace(/^export (?=(?:async )?function|const )/gm,'');
 if(/^import |^export /m.test(source))throw Error('Unsupported bundle import/export in '+file);
 return '(()=>{\n'+source+'\nreturn {'+names.join(',')+'};\n})();';
}
const core=moduleSource('business-billing.mjs',['createBusinessBillingWebhook']);
const adapters=moduleSource('business-billing-adapters.mjs',['createBusinessStripeAdapter','createBusinessBillingStore','createBusinessSupabaseRpc']);
const catalog=moduleSource('business-catalog.mjs',['LIVE_BUSINESS_PRICES']);
const entry=fs.readFileSync(path.join(root,'worker/business-billing-entry.mjs'),'utf8').replace(/\r/g,'').replace(/^import .*;\n/gm,'');
const output='// Generated with tools/build-business-worker.cjs; production approval defaults closed.\nconst {createBusinessBillingWebhook}='+core+'\nconst {createBusinessStripeAdapter,createBusinessBillingStore,createBusinessSupabaseRpc}='+adapters+'\nconst {LIVE_BUSINESS_PRICES}='+catalog+'\n'+entry;
// The live build is produced only on explicit request. Building it deploys nothing:
// the Worker still needs ENABLE_BUSINESS_BILLING, BUSINESS_STRIPE_MODE=live and live secrets.
const args=process.argv.slice(2),production=args.includes('--production-approved'),paths=args.filter(x=>!x.startsWith('--'));
if(args.some(x=>x.startsWith('--')&&x!=='--production-approved')||paths.length>1)throw Error('Usage: build-business-worker.cjs [target] [--production-approved]');
let result=output;
if(production){
 const closed='// Generated with tools/build-business-worker.cjs; production approval defaults closed.\n',gate='export default createBusinessBillingWorker();';
 if(!result.startsWith(closed)||result.split(gate).length!==2||!result.trimEnd().endsWith(gate))throw Error('Production gate not found exactly once');
 result='// Generated with tools/build-business-worker.cjs --production-approved; LIVE Business billing source gate OPEN.\n'+result.slice(closed.length).replace(gate,'export default createBusinessBillingWorker({productionApproved:true});');
}
const target=path.resolve(paths[0]||path.join(root,production?'work/business-webhook-production/worker.mjs':'work/business-webhook/worker.mjs'));
fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,result);
console.log(JSON.stringify({path:target,productionApproved:production,sha256:crypto.createHash('sha256').update(result).digest('hex')}));
