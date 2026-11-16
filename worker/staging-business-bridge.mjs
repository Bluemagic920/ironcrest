import {createBusinessBillingWorker} from './business-billing-entry.mjs';
// Staging-only wrapper. The existing Pro handler and diagnostics stay delegated
// unless this source approval and the explicit bridge flag are both enabled.
export function withSandboxBusinessWebhook(legacy,{releaseApproved=false,fetcher=fetch}={}){
 if(typeof legacy?.fetch!=='function')throw Error('Existing staging Worker required');
 const business=createBusinessBillingWorker({fetcher});
 return {...legacy,async fetch(request,env,context){
  if(releaseApproved!==true)return legacy.fetch(request,env,context);
  const url=new URL(request.url);
  if(url.pathname==='/health'){
   const response=await legacy.fetch(request,env,context);
   if(response.status!==200||!response.headers.get('Content-Type')?.includes('application/json'))return response;
   const health=await response.clone().json();
   const configured=env.ENABLE_BUSINESS_BILLING==='true'&&/^[sr]k_test_[A-Za-z0-9]+$/.test(env.BUSINESS_STRIPE_KEY||env.STRIPE_SECRET_KEY||'')
    &&/^whsec_/.test(env.BUSINESS_STRIPE_WEBHOOK_SECRET||env.STRIPE_WEBHOOK_SECRET_TEST||'')
    &&Boolean(env.BUSINESS_DATABASE_KEY||env.SUPABASE_SERVICE_ROLE_KEY)&&env.SUPABASE_URL?.replace(/\/$/,'')==='https://nhiqbcevcdxfzvrprgck.supabase.co';
   const bridge=env.ENABLE_BUSINESS_WEBHOOK_BRIDGE==='true';
   return new Response(JSON.stringify({...health,businessWebhookVersion:'1',businessWebhookConfigured:configured,businessWebhookBridgeSelected:bridge,
    webhookProcessingEnabled:health.webhookProcessingEnabled===true||(configured&&bridge),webhookDryRunEnabled:configured&&bridge?false:health.webhookDryRunEnabled}),{status:response.status,headers:response.headers});
  }
  const dedicated=url.pathname==='/api/business/billing/webhook';
  const bridged=url.pathname==='/api/stripe-webhook'&&env.ENABLE_BUSINESS_WEBHOOK_BRIDGE==='true';
  if(!dedicated&&!bridged)return legacy.fetch(request,env,context);
  url.pathname='/api/business/billing/webhook';
  const normalized={...env,BUSINESS_STRIPE_MODE:'test',BUSINESS_STRIPE_KEY:env.BUSINESS_STRIPE_KEY||env.STRIPE_SECRET_KEY,
   BUSINESS_DATABASE_KEY:env.BUSINESS_DATABASE_KEY||env.SUPABASE_SERVICE_ROLE_KEY,
   BUSINESS_STRIPE_WEBHOOK_SECRET:env.BUSINESS_STRIPE_WEBHOOK_SECRET||env.STRIPE_WEBHOOK_SECRET_TEST};
  return business.fetch(new Request(url,request),normalized,context);
 }};
}
