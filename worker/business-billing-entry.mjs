import {createBusinessBillingWebhook} from './business-billing.mjs';
import {createBusinessStripeAdapter,createBusinessBillingStore,createBusinessSupabaseRpc} from './business-billing-adapters.mjs';
import {LIVE_BUSINESS_PRICES} from './business-catalog.mjs';
const PROJECT='https://nhiqbcevcdxfzvrprgck.supabase.co';
export const SANDBOX_BUSINESS_PRICES=Object.freeze([
 {priceId:'price_1Uc5Z1AJcPWZlA8sEhP4K4Mb',productId:'prod_VdMHQOCOBLAiwX',kind:'business',interval:'month',currency:'usd',unitAmount:12999,employees:20},
 {priceId:'price_1Uc5Z2AJcPWZlA8s96n61KyL',productId:'prod_VdMHQOCOBLAiwX',kind:'business',interval:'year',currency:'usd',unitAmount:132590,employees:20}
]);
export function createBusinessBillingWorker({productionApproved=false,fetcher=fetch}={}){
 return {async fetch(request,env){
  const path=new URL(request.url).pathname,mode=env.BUSINESS_STRIPE_MODE;
  const approved=mode==='test'||(mode==='live'&&productionApproved===true);
  const enabled=approved&&env.ENABLE_BUSINESS_BILLING==='true';
  const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  if(path==='/health')return json({ok:true,service:'ironcrest-business-webhook',mode:mode==='test'?'test':mode==='live'?'live':'unconfigured',releaseGateOpen:enabled,productionApproved:productionApproved===true});
  if(path!=='/api/business/billing/webhook')return json({error:'not_found'},404);
  if(!enabled)return json({error:'business_billing_not_released'},503);
  try{
   const entries=mode==='live'?LIVE_BUSINESS_PRICES:SANDBOX_BUSINESS_PRICES;
   const stripe=createBusinessStripeAdapter({key:env.BUSINESS_STRIPE_KEY,mode,fetcher,productIds:entries.map(x=>x.productId),expectedAccount:mode==='test'?'acct_1UWd69AJcPWZlA8s':'acct_1UWd63AQCOww3CbZ'});
   const rpc=createBusinessSupabaseRpc({url:env.SUPABASE_URL,key:env.BUSINESS_DATABASE_KEY,expectedProject:PROJECT,fetcher});
   const store=createBusinessBillingStore({rpc,mode});
   const route=createBusinessBillingWebhook({releaseApproved:approved,catalog:entries,stripe,store});
   return await route(request,env);
  }catch{return json({error:'billing_configuration_unavailable'},503);}
 }};
}
// No production path can be activated by changing environment settings alone.
export default createBusinessBillingWorker();
