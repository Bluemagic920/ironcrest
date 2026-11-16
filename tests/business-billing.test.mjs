import {readFileSync} from 'node:fs';
const requireFixture=()=>readFileSync(new URL('./fixtures/business-sandbox.json',import.meta.url),'utf8');
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,webcrypto} from 'node:crypto';
import {businessCatalog,businessSnapshot,verifyBusinessSignature,createBusinessBillingWebhook} from '../worker/business-billing.mjs';
import {LIVE_BUSINESS_PRICES} from '../worker/business-catalog.mjs';
const now=Date.parse('2026-11-15T12:00:00Z'),end=now/1000+86400;
// Invented catalog: these values do not specify real prices or launch limits.
const entries=['month','year'].flatMap(interval=>[
 {priceId:'price_base'+interval,productId:'prod_business',kind:'business',interval,currency:'usd',unitAmount:1000,employees:20},
 {priceId:'price_add'+interval,productId:'prod_add',kind:'employee_addon',interval,currency:'usd',unitAmount:1000,employees:5},
 {priceId:'price_unlimited'+interval,productId:'prod_unlimited',kind:'unlimited',interval,currency:'usd',unitAmount:1000,employees:0}]);
const catalog=businessCatalog(entries);
test('verified live catalog preserves ProfitHarbor Business monthly, annual and unlimited prices',()=>{
 const live=businessCatalog(LIVE_BUSINESS_PRICES);
 assert.deepEqual([...live.values()].filter(x=>x.kind==='business').map(x=>[x.interval,x.unitAmount,x.employees]),[['month',12999,20],['year',132590,20]]);
 assert.equal(live.get('price_1UXkBDAQCOww3CbZpXEDYoHB').unitAmount,4999);
 assert.throws(()=>businessCatalog([{...LIVE_BUSINESS_PRICES[0],unitAmount:undefined}]));
});
function item(kind='base',interval='month',quantity=1){const e=entries.find(x=>x.priceId==='price_'+kind+interval);return {price:{id:e.priceId,product:e.productId,unit_amount:e.unitAmount,livemode:false,currency:'usd',recurring:{interval,interval_count:1,usage_type:'licensed'}},quantity,current_period_end:end};}
const sub=()=>({id:'sub_fixture',customer:'cus_fixture',livemode:false,status:'active',latest_invoice:'in_fixture',items:{has_more:false,data:[item()]},cancel_at_period_end:false});
const invoice=()=>({id:'in_fixture',customer:'cus_fixture',livemode:false,status:'paid',paid:true,amount_remaining:0,currency:'usd',parent:{subscription_details:{subscription:'sub_fixture'}}});
const options={customerId:'cus_fixture',livemode:false,now};
test('monthly and annual Business base, capacity add-ons and unlimited are explicitly cataloged',()=>{
 for(const interval of ['month','year']){
  const s=sub();s.items.data=[item('base',interval),item('add',interval,3)];assert.equal(businessSnapshot(s,invoice(),catalog,options).employee_limit,35);
  s.items.data=[item('base',interval),item('unlimited',interval)];assert.equal(businessSnapshot(s,invoice(),catalog,options).unlimited_employees,true);
 }
});
test('a standalone paid unlimited subscription never grants Business without the base subscription',()=>{
 const s=sub();s.items.data=[item('unlimited')];const r=businessSnapshot(s,invoice(),catalog,options);
 assert.equal(r.subscription_type,'unlimited_employees');assert.equal(r.business_active,false);assert.equal(r.unlimited_employees,true);assert.equal(r.employee_limit,0);
});
test('unknown Pro price, duplicate bases, add-on alone, mixed intervals and invalid quantities cannot grant Business',()=>{
 for(const items of [[item(),item()],[item('add')],[item(),item('add','year')],[item(),item('add'),item('unlimited')],[{...item(),quantity:2}],[{...item(),quantity:NaN}],[{...item(),price:{...item().price,id:'price_pro'}}]]){
  const s=sub();s.items.data=items;assert.throws(()=>businessSnapshot(s,invoice(),catalog,options));
 }
});
test('customer, mode, product, currency, recurrence and truncated lists fail closed',()=>{
 for(const change of [s=>s.customer='cus_other',s=>s.livemode=true,s=>s.items.has_more=true,s=>s.items.data[0].price.unit_amount=1,s=>s.items.data[0].price.livemode=true,s=>s.items.data[0].price.product='prod_other',s=>s.items.data[0].price.currency='eur',s=>s.items.data[0].price.recurring.interval_count=2]){const s=sub();change(s);assert.throws(()=>businessSnapshot(s,invoice(),catalog,options));}
});
test('only paid invoices belonging to the current subscription and customer activate access',()=>{
 for(const change of [i=>i.status='open',i=>i.paid=false,i=>i.amount_remaining=100,i=>i.customer='cus_other',i=>i.parent.subscription_details.subscription='sub_other',i=>i.id='in_other',i=>i.livemode=true]){const i=invoice();change(i);assert.throws(()=>businessSnapshot(sub(),i,catalog,options));}
});
test('trial, expired, paused, failed and canceled access is inactive; period-end cancellation preserves paid access',()=>{
 for(const status of ['trialing','past_due','unpaid','canceled','incomplete','incomplete_expired','paused']){const s=sub();s.status=status;const r=businessSnapshot(s,null,catalog,options);assert.equal(r.business_active,false);assert.equal(r.employee_limit,0);}
 const s=sub();s.cancel_at_period_end=true;assert.equal(businessSnapshot(s,invoice(),catalog,options).business_active,true);
 s.items.data[0].current_period_end=now/1000;assert.equal(businessSnapshot(s,null,catalog,options).business_active,false);
 s.items.data[0].current_period_end=end;s.pause_collection={behavior:'void'};assert.equal(businessSnapshot(s,null,catalog,options).business_active,false);
});
const secret='whsec_fixture';
const signed=(raw,time=now/1000)=>`t=${time},v1=${createHmac('sha256',secret).update(time+'.'+raw).digest('hex')}`;
test('signature checks raw body, timestamp tolerance, duplicate timestamps and rotation signatures',async()=>{
 const raw='{"test":true}',opts={now,cryptoApi:webcrypto};
 assert.equal(await verifyBusinessSignature(raw,signed(raw),secret,opts),true);
 for(const header of [signed(raw,now/1000-301),signed(raw)+',t='+now/1000,'t=1,v1=bad'])assert.equal(await verifyBusinessSignature(raw,header,secret,opts),false);
 assert.equal(await verifyBusinessSignature(raw+' ',signed(raw),secret,opts),false);
 assert.equal(await verifyBusinessSignature(raw,signed(raw)+',v1='+'0'.repeat(64),secret,opts),true);
});
const env={ENABLE_BUSINESS_BILLING:'true',BUSINESS_STRIPE_MODE:'test',BUSINESS_STRIPE_WEBHOOK_SECRET:secret};
const event=()=>({id:'evt_fixture',type:'invoice.paid',livemode:false,data:{object:invoice()}});
function request(e=event(),header){const raw=typeof e==='string'?e:JSON.stringify(e);return new Request('https://worker.example/api/business/billing/webhook',{method:'POST',headers:{'Stripe-Signature':header??signed(raw)},body:raw});}
function fixture({approved=true,failCommit=false,subscriptionStatus='active'}={}){
 const calls=[],events=new Set();
 const stripe={retrieveSubscription:async()=>{calls.push('subscription');const s=sub();s.status=subscriptionStatus;return s;},retrieveInvoice:async()=>{calls.push('invoice');return invoice();}};
 const store={withCustomerLock:async(customer,fn)=>{calls.push('lock:'+customer);await fn({hasEvent:async id=>events.has(id),commitEvent:async data=>{calls.push(data);if(failCommit)throw Error('private database error');events.add(data.eventId);}});},reconcileRisk:async()=>{calls.push('risk');}};
 return {calls,route:createBusinessBillingWebhook({releaseApproved:approved,catalog:entries,stripe,store,cryptoApi:webcrypto,now:()=>now})};
}
test('source and environment approval gates independently prevent all adapter calls',async()=>{
 for(const [approved,flags] of [[false,env],[true,{...env,ENABLE_BUSINESS_BILLING:'false'}]]){const f=fixture({approved});assert.equal((await f.route(request(),flags)).status,503);assert.deepEqual(f.calls,[]);}
});
test('signed events fetch current state under lock, commit once, and duplicate events skip Stripe reads',async()=>{
 const f=fixture();assert.equal((await f.route(request(),env)).status,200);assert.equal(f.calls[0],'lock:cus_fixture');assert.equal(f.calls[1],'subscription');assert.equal(f.calls[2],'invoice');assert.equal(f.calls[3].snapshot.business_active,true);
 await f.route(request(),env);assert.equal(f.calls.filter(x=>x==='subscription').length,1);
});
test('invalid signature, wrong mode and oversized body never call adapters',async()=>{
 const f=fixture();const wrong=event();wrong.livemode=true;
 assert.equal((await f.route(request(event(),'bad'),env)).status,400);assert.equal((await f.route(request(wrong),env)).status,400);
 assert.equal((await f.route(request('x'.repeat(1000001)),env)).status,413);assert.deepEqual(f.calls,[]);
});
test('failed atomic commit returns retryable failure without exposing provider details',async()=>{
 const f=fixture({failCommit:true}),r=await f.route(request(),env);assert.equal(r.status,500);assert.ok(!(await r.text()).includes('private'));
});
test('asynchronous unpaid checkout does not grant access; risk events require the reconciliation adapter',async()=>{
 const f=fixture(),e=event();e.type='checkout.session.completed';e.data.object={mode:'subscription',payment_status:'unpaid'};
 assert.equal((await f.route(request(e),env)).status,200);assert.deepEqual(f.calls,[]);
 e.type='charge.refunded';await f.route(request(e),env);assert.deepEqual(f.calls,['risk']);
});
test('actual Stripe sandbox monthly and annual paid responses satisfy the snapshot contract',()=>{
 const fixture=JSON.parse(requireFixture());
 const approved=businessCatalog(fixture.catalog);
 for(const row of fixture.fixtures){
  assert.equal(row.invoice.status,'paid');
  assert.equal(Object.hasOwn(row.invoice,'paid'),false);
  const result=businessSnapshot(row.subscription,row.invoice,approved,{customerId:row.subscription.customer,livemode:false,now:Date.parse('2026-11-15T15:00:00Z')});
  assert.equal(result.business_active,true);assert.equal(result.employee_limit,20);
 }
 for(const row of fixture.cancellations){
  const result=businessSnapshot(row.subscription,null,approved,{customerId:row.subscription.customer,livemode:false,now:Date.parse('2026-11-15T15:00:00Z')});
  assert.equal(result.business_active,false);assert.equal(result.employee_limit,0);
 }
});
test('subscription paused and resumed events reconcile current access rather than being ignored',async()=>{
 for(const [type,status,active] of [['customer.subscription.paused','paused',false],['customer.subscription.resumed','active',true]]){
  const f=fixture({subscriptionStatus:status}),e=event();e.type=type;e.data.object={id:'sub_fixture',customer:'cus_fixture'};
  assert.equal((await f.route(request(e),env)).status,200);const commit=f.calls.find(x=>typeof x==='object'&&x.eventId===e.id);assert.equal(commit.snapshot.business_active,active);
 }
});
