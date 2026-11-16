const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const resourceId=value=>typeof value==='string'?value:value?.id;
const valid=(value,prefix)=>typeof value==='string'&&new RegExp('^'+prefix+'_[A-Za-z0-9]+$').test(value);
async function boundedJson(response){
 if(!response.ok)throw Error('Provider unavailable');
 const reader=response.body?.getReader();if(!reader)throw Error('Missing provider body');
 let size=0,text='';const decoder=new TextDecoder('utf-8',{fatal:true});
 for(;;){const r=await reader.read();if(r.done)break;size+=r.value.byteLength;if(size>1000000){await reader.cancel();throw Error('Provider response too large');}text+=decoder.decode(r.value,{stream:true});}
 return JSON.parse(text+decoder.decode());
}
export function createBusinessStripeAdapter({key,mode,fetcher=fetch,version='2026-10-28.endive',productIds=[]}={}){
 if(!['test','live'].includes(mode)||typeof key!=='string'||!new RegExp('^[sr]k_'+mode+'_[A-Za-z0-9]+$').test(key))throw Error('Stripe mode/key mismatch');
 const get=async(path,params)=>{
  const url=new URL('https://api.stripe.com/v1/'+path);if(params)url.search=new URLSearchParams(params).toString();
  return boundedJson(await fetcher(url.href,{headers:{Authorization:'Bearer '+key,'Stripe-Version':version},redirect:'manual',signal:AbortSignal.timeout(15000)}));
 };
 const retrieve=async(path,id,prefix)=>{if(!valid(id,prefix))throw Error('Invalid Stripe resource');const result=await get(path+'/'+encodeURIComponent(id));if(result?.id!==id||result.livemode!==(mode==='live'))throw Error('Stripe resource mismatch');return result;};
 const stripe={retrieveSubscription:id=>retrieve('subscriptions',id,'sub'),retrieveInvoice:id=>retrieve('invoices',id,'in')};
 stripe.isRelevantSubscription=async(subscriptionId,customerId)=>{
  const s=await stripe.retrieveSubscription(subscriptionId);
  if(resourceId(s.customer)!==customerId||!Array.isArray(s.items?.data)||s.items.has_more!==false||!s.items.data.length)throw Error('Incomplete relevance check');
  if(!s.items.data.every(item=>valid(resourceId(item.price?.product),'prod')))throw Error('Unknown product linkage');
  return s.items.data.some(item=>productIds.includes(resourceId(item.price.product)));
 };
 stripe.resolveRisk=async event=>{
  const object=event.data?.object;
  let paymentIntent=resourceId(object?.payment_intent),charge;
  // Fresh charge retrieval prevents relying on a stale refund object or metadata.
  const chargeId=event.type==='charge.refunded'?object?.id:resourceId(object?.charge);
  if(chargeId){charge=await retrieve('charges',chargeId,'ch');paymentIntent=resourceId(charge.payment_intent)||paymentIntent;}
  if(!valid(paymentIntent,'pi'))throw Error('Risk payment linkage requires review');
  const found=new Map();let cursor;
  // A payment can pay multiple invoices. Bound the work; never acknowledge an incomplete traversal.
  for(let page=0;page<10;page++){
   const list=await get('invoice_payments',{'payment[type]':'payment_intent','payment[payment_intent]':paymentIntent,status:'paid',limit:'100',...(cursor?{starting_after:cursor}:{})});
   if(!Array.isArray(list?.data)||typeof list.has_more!=='boolean')throw Error('Invalid invoice-payment list');
   for(const payment of list.data){
    if(payment.payment?.type!=='payment_intent'||resourceId(payment.payment.payment_intent)!==paymentIntent)throw Error('Foreign invoice payment');
    const invoice=await stripe.retrieveInvoice(resourceId(payment.invoice));
    const subId=resourceId(invoice.parent?.subscription_details?.subscription??invoice.subscription);
    if(!subId)continue;
    const customerId=resourceId(invoice.customer);if(!valid(customerId,'cus')||!valid(subId,'sub')||(charge&&resourceId(charge.customer)!==customerId))throw Error('Risk customer mismatch');
    found.set(customerId+':'+subId,{customerId,subscriptionId:subId});
   }
   if(!list.has_more)return [...found.values()];
   cursor=list.data.at(-1)?.id;if(!valid(cursor,'inpay'))throw Error('Incomplete invoice-payment page');
  }
  throw Error('Risk pagination requires reconciliation');
 };
 return stripe;
}

export function createBusinessBillingStore({rpc,mode}={}){
 if(typeof rpc!=='function'||!['test','live'].includes(mode))throw Error('Billing store configuration required');
 const call=(customer,operation,token=null,data={})=>rpc('ironcrest_billing_event_operation',{p_mode:mode,p_customer_id:customer,p_operation:operation,p_token:token,p_data:data});
 const store={async isMapped(customer){const result=await call(customer,'mapped');if(typeof result?.mapped!=='boolean')throw Error('Mapping lookup unavailable');return result.mapped;},async withCustomerLock(customer,callback){
  const lock=await call(customer,'acquire');if(!uuid.test(lock?.token||''))throw Error('Billing lock unavailable');
  try{
   return await callback({
    hasEvent:async(eventId,eventType)=>{const result=await call(customer,'has_event',lock.token,{eventId,eventType});if(typeof result?.exists!=='boolean')throw Error('Invalid event receipt');return result.exists;},
    commitEvent:async data=>{const result=await call(customer,'commit',lock.token,data);if(result?.ok!==true)throw Error('Event commit not verified');return result;},
    markReview:async data=>{const result=await call(customer,'review',lock.token,data);if(result?.ok!==true)throw Error('Review commit not verified');return result;}
   });
  }finally{try{await call(customer,'release',lock.token);}catch{/* Expiry fences late holders; release cannot undo a committed event. */}}
 }};
 store.reconcileRisk=async(event,stripe)=>{
  const links=await stripe.resolveRisk(event);
  if(!Array.isArray(links))throw Error('Risk linkage requires reconciliation');
  let held=0;
  // Each hold is durable; a later failure returns 500 so retries finish remaining links.
  // A risk hold covers the mapped customer's Business access, including replacement subscriptions.
  for(const link of links){
   if(!await store.isMapped(link.customerId)){
    if(await stripe.isRelevantSubscription(link.subscriptionId,link.customerId))throw Error('Business customer mapping pending');
    continue;
   }
   await store.withCustomerLock(link.customerId,async transaction=>{
    const eventId=event.id;
    if(!await transaction.hasEvent(eventId,event.type))await transaction.markReview({eventId,eventType:event.type,subscriptionId:link.subscriptionId});
   });
   held++;
  }
  return {reviewRequired:held>0,ignored:held===0};
 };
 return store;
}

export function createBusinessSupabaseRpc({url,key,expectedProject,fetcher=fetch}={}){
 if(typeof url!=='string'||url.replace(/\/$/,'')!==expectedProject||!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(expectedProject||'')||!key)throw Error('Untrusted billing database');
 return async(name,body)=>{
  if(name!=='ironcrest_billing_event_operation')throw Error('Unsupported billing RPC');
  return boundedJson(await fetcher(expectedProject+'/rest/v1/rpc/'+name,{method:'POST',headers:{apikey:key,...(key.startsWith('sb_secret_')?{}:{Authorization:'Bearer '+key}),'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(15000)}));
 };
}
