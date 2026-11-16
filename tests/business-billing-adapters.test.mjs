import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBusinessStripeAdapter,createBusinessBillingStore,createBusinessSupabaseRpc} from '../worker/business-billing-adapters.mjs';
import worker from '../worker/business-billing-entry.mjs';
const token='11111111-1111-4111-8111-111111111111';
test('Stripe adapter pins host/version, separates modes and rejects redirect or oversized responses',async()=>{
 const calls=[];const stripe=createBusinessStripeAdapter({key:'rk_test_fixture',mode:'test',fetcher:async(url,options)=>{calls.push({url,options});return Response.json({id:'sub_fixture',livemode:false});}});
 assert.equal((await stripe.retrieveSubscription('sub_fixture')).id,'sub_fixture');assert.equal(new URL(calls[0].url).origin,'https://api.stripe.com');assert.equal(calls[0].options.redirect,'manual');assert.equal(calls[0].options.headers['Stripe-Version'],'2026-10-28.endive');
 assert.throws(()=>createBusinessStripeAdapter({key:'rk_live_fixture',mode:'test'}));
 await assert.rejects(()=>stripe.retrieveSubscription('../customers'));
 for(const response of [new Response('',{status:302}),new Response('x'.repeat(1000001)),Response.json({id:'sub_other',livemode:false}),Response.json({id:'sub_fixture',livemode:true})]){
  const s=createBusinessStripeAdapter({key:'rk_test_fixture',mode:'test',fetcher:async()=>response});await assert.rejects(()=>s.retrieveSubscription('sub_fixture'));
 }
});
test('risk resolver follows current charge and invoice-payment relationships across all pages',async()=>{
 const calls=[];const stripe=createBusinessStripeAdapter({key:'rk_test_fixture',mode:'test',fetcher:async(url)=>{
  const u=new URL(url);calls.push(u);
  if(u.pathname.includes('/charges/'))return Response.json({id:'ch_fixture',livemode:false,customer:'cus_fixture',payment_intent:'pi_fixture'});
  if(u.pathname.endsWith('/invoice_payments')){
   assert.equal(u.searchParams.get('payment[payment_intent]'),'pi_fixture');assert.equal(u.searchParams.get('payment[type]'),'payment_intent');assert.equal(u.searchParams.get('status'),'paid');
   const second=u.searchParams.has('starting_after');return Response.json({data:[{id:second?'inpay_second':'inpay_first',invoice:second?'in_second':'in_first',payment:{type:'payment_intent',payment_intent:'pi_fixture'}}],has_more:!second});
  }
  const id=u.pathname.split('/').at(-1);return Response.json({id,livemode:false,customer:'cus_fixture',parent:{subscription_details:{subscription:id==='in_first'?'sub_first':'sub_second'}}});
 }});
 assert.deepEqual(await stripe.resolveRisk({type:'charge.refunded',data:{object:{id:'ch_fixture',metadata:{owner:'untrusted'}}}}),[{customerId:'cus_fixture',subscriptionId:'sub_first'},{customerId:'cus_fixture',subscriptionId:'sub_second'}]);
 assert.equal(calls.filter(x=>x.pathname.endsWith('/invoice_payments')).length,2);
});
test('risk resolver rejects foreign payment linkage, partial pagination and unknown customer',async()=>{
 for(const change of ['foreign','pagination','customer']){
  const stripe=createBusinessStripeAdapter({key:'rk_test_fixture',mode:'test',fetcher:async(url)=>{
   const p=new URL(url).pathname;
   if(p.includes('/charges/'))return Response.json({id:'ch_fixture',livemode:false,customer:'cus_fixture',payment_intent:'pi_fixture'});
   if(p.endsWith('/invoice_payments'))return Response.json({data:change==='pagination'?[]:[{id:'inpay_fixture',invoice:'in_fixture',payment:{type:'payment_intent',payment_intent:change==='foreign'?'pi_other':'pi_fixture'}}],has_more:change==='pagination'});
   return Response.json({id:'in_fixture',livemode:false,customer:change==='customer'?'cus_other':'cus_fixture',parent:{subscription_details:{subscription:'sub_fixture'}}});
  }});await assert.rejects(()=>stripe.resolveRisk({type:'charge.dispute.created',data:{object:{charge:'ch_fixture'}}}));
 }
});
test('store awaits atomic commit, always releases its lease and never retries uncertain writes',async()=>{
 const calls=[];const store=createBusinessBillingStore({mode:'test',rpc:async(name,b)=>{calls.push(b);if(b.p_operation==='acquire')return {token};if(b.p_operation==='has_event')return {exists:false};if(b.p_operation==='commit')throw Error('uncertain commit');return {ok:true};}});
 await assert.rejects(()=>store.withCustomerLock('cus_fixture',async tx=>{assert.equal(await tx.hasEvent('evt_fixture','invoice.paid'),false);await tx.commitEvent({eventId:'evt_fixture',eventType:'invoice.paid'});}));
 assert.deepEqual(calls.map(x=>x.p_operation),['acquire','has_event','commit','release']);assert.equal(calls.filter(x=>x.p_operation==='commit').length,1);assert.ok(calls.every(x=>x.p_mode==='test'));assert.equal(calls.at(-1).p_token,token);
});
test('risk processing durably holds mapped customers and skips verified unrelated subscriptions',async()=>{
 const calls=[];const store=createBusinessBillingStore({mode:'test',rpc:async(name,b)=>{calls.push(b);if(b.p_operation==='mapped')return {mapped:b.p_customer_id==='cus_fixture'};if(b.p_operation==='acquire')return {token};if(b.p_operation==='has_event')return {exists:false};return {ok:true};}});
 const stripe={resolveRisk:async()=>[{customerId:'cus_fixture',subscriptionId:'sub_old'},{customerId:'cus_unrelated',subscriptionId:'sub_pro'}],isRelevantSubscription:async()=>false};
 assert.equal((await store.reconcileRisk({id:'evt_refund',type:'charge.refunded'},stripe)).reviewRequired,true);
 assert.equal(calls.filter(x=>x.p_operation==='review').length,1);assert.equal(calls.find(x=>x.p_operation==='review').p_data.subscriptionId,'sub_old');
 stripe.isRelevantSubscription=async()=>true;await assert.rejects(()=>store.reconcileRisk({id:'evt_other',type:'charge.refunded'},stripe));
});
test('Supabase adapter separates credentials, refuses foreign projects and propagates failed commit',async()=>{
 assert.throws(()=>createBusinessSupabaseRpc({url:'https://evil.example',expectedProject:'https://fixture.supabase.co',key:'private'}));
 const calls=[];const rpc=createBusinessSupabaseRpc({url:'https://fixture.supabase.co',expectedProject:'https://fixture.supabase.co',key:'sb_secret_fixture',fetcher:async(url,options)=>{calls.push({url,options});return Response.json({ok:true});}});
 await rpc('ironcrest_billing_event_operation',{p_mode:'test'});assert.equal(calls[0].options.headers.apikey,'sb_secret_fixture');assert.equal(calls[0].options.headers.Authorization,undefined);assert.equal(calls[0].options.redirect,'manual');
 await assert.rejects(()=>rpc('other_function',{}));
 const broken=createBusinessSupabaseRpc({url:'https://fixture.supabase.co',expectedProject:'https://fixture.supabase.co',key:'private',fetcher:async()=>new Response('',{status:500})});await assert.rejects(()=>broken('ironcrest_billing_event_operation',{}));
});
test('deployable entry point cannot enable production from environment flags',async()=>{
 const env={BUSINESS_STRIPE_MODE:'live',ENABLE_BUSINESS_BILLING:'true',BUSINESS_STRIPE_KEY:'rk_live_fixture'};
 const health=await (await worker.fetch(new Request('https://worker.example/health'),env)).json();assert.equal(health.releaseGateOpen,false);assert.equal(health.productionApproved,false);
 assert.equal((await worker.fetch(new Request('https://worker.example/api/business/billing/webhook',{method:'POST',body:'{}'}),env)).status,503);
 assert.equal((await worker.fetch(new Request('https://worker.example/api/stripe-webhook'),env)).status,404);
});
test('sandbox bridge preserves legacy routes and rejects live credentials even when environment requests live mode',async()=>{
 const {withSandboxBusinessWebhook}=await import('../worker/staging-business-bridge.mjs');let legacyCalls=0,providerCalls=0;
 const legacy={fetch:async()=>{legacyCalls++;return new Response('legacy');}};
 const options={releaseApproved:true,fetcher:async()=>{providerCalls++;throw Error('Provider should not be called');}};
 const wrapped=withSandboxBusinessWebhook(legacy,options);
 assert.equal(await (await wrapped.fetch(new Request('https://worker.example/health'),{})).text(),'legacy');
 assert.equal(await (await wrapped.fetch(new Request('https://worker.example/api/stripe-webhook'),{})).text(),'legacy');
 const flags={BUSINESS_STRIPE_MODE:'live',ENABLE_BUSINESS_BILLING:'true',ENABLE_BUSINESS_WEBHOOK_BRIDGE:'true',STRIPE_SECRET_KEY:'rk_live_fixture'};
 assert.equal((await wrapped.fetch(new Request('https://worker.example/api/stripe-webhook',{method:'POST',body:'{}'}),flags)).status,503);
 assert.equal(legacyCalls,2);assert.equal(providerCalls,0);
 const closed=withSandboxBusinessWebhook(legacy);assert.equal(await (await closed.fetch(new Request('https://worker.example/api/business/billing/webhook'),flags)).text(),'legacy');
});
test('staging health distinguishes configured Business processing from the legacy dry-run gate without exposing keys',async()=>{
 const {withSandboxBusinessWebhook}=await import('../worker/staging-business-bridge.mjs');
 const wrapped=withSandboxBusinessWebhook({fetch:async()=>Response.json({webhookProcessingEnabled:false,webhookDryRunEnabled:true,checkoutEnabled:false})},{releaseApproved:true});
 const flags={ENABLE_BUSINESS_BILLING:'true',ENABLE_BUSINESS_WEBHOOK_BRIDGE:'true',STRIPE_SECRET_KEY:'rk_test_fixture',STRIPE_WEBHOOK_SECRET_TEST:'whsec_fixture',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_fixture',SUPABASE_URL:'https://nhiqbcevcdxfzvrprgck.supabase.co'};
 const health=await (await wrapped.fetch(new Request('https://worker.example/health'),flags)).json();assert.equal(health.businessWebhookConfigured,true);assert.equal(health.webhookProcessingEnabled,true);assert.equal(health.webhookDryRunEnabled,false);assert.equal(health.checkoutEnabled,false);assert.ok(!JSON.stringify(health).includes('fixture'));
 const wrong=await (await wrapped.fetch(new Request('https://worker.example/health'),{...flags,STRIPE_SECRET_KEY:'rk_live_fixture'})).json();assert.equal(wrong.businessWebhookConfigured,false);assert.equal(wrong.webhookProcessingEnabled,false);
});
