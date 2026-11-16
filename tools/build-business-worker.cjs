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
const target=path.resolve(process.argv[2]||path.join(root,'work/business-webhook/worker.mjs'));
fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,output);
console.log(JSON.stringify({path:target,sha256:crypto.createHash('sha256').update(output).digest('hex')}));
