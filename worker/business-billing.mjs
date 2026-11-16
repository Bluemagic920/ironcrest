// Review-only component. No production handler imports this module.
// Catalog and persistence adapters must be approved and integrated before release.
const id = (value, prefix) => typeof value === 'string' && new RegExp('^'+prefix+'_[A-Za-z0-9]+$').test(value);
const resourceId = value => typeof value === 'string' ? value : value?.id;
const statuses = new Set(['active','trialing','past_due','canceled','unpaid','incomplete','incomplete_expired','paused']);

export function businessCatalog(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 20) throw Error('Approved catalog required');
  const catalog = new Map();
  for (const entry of entries) {
    if (!entry || !id(entry.priceId,'price') || !id(entry.productId,'prod') || catalog.has(entry.priceId)
      || !['business','employee_addon','unlimited'].includes(entry.kind)
      || !['month','year'].includes(entry.interval) || !/^[a-z]{3}$/.test(entry.currency)
      || !Number.isSafeInteger(entry.unitAmount) || entry.unitAmount < 1
      || !Number.isSafeInteger(entry.employees) || entry.employees < 0 || entry.employees > 100000
      || (entry.kind === 'employee_addon' && entry.employees === 0)
      || (entry.kind === 'unlimited' && entry.employees !== 0)) throw Error('Invalid approved catalog');
    catalog.set(entry.priceId,Object.freeze({...entry}));
  }
  return catalog;
}

// Called only with a fresh Stripe snapshot, under the customer lock. Browser flags
// and subscription metadata cannot grant access or select the application owner.
export function businessSnapshot(subscription, invoice, catalog, {customerId,livemode,now=Date.now()}={}) {
  if (!id(subscription?.id,'sub') || !id(customerId,'cus') || typeof livemode !== 'boolean'
    || subscription.livemode !== livemode || resourceId(subscription.customer) !== customerId
    || !statuses.has(subscription.status) || !Array.isArray(subscription.items?.data)
    || subscription.items.has_more !== false || !subscription.items.data.length) throw Error('Invalid subscription snapshot');
  let base=null, addon=null, unlimited=null;
  const seen=new Set();
  for (const item of subscription.items.data) {
    const price=item?.price, approved=catalog.get(price?.id);
    if (!approved || seen.has(price.id) || resourceId(price.product)!==approved.productId
      || price.unit_amount!==approved.unitAmount || price.livemode!==livemode
      || price.currency!==approved.currency || price.recurring?.interval!==approved.interval
      || price.recurring.interval_count!==1 || price.recurring.usage_type!=='licensed'
      || !Number.isSafeInteger(item.quantity) || item.quantity<1 || item.quantity>100000
      || !Number.isSafeInteger(item.current_period_end) || item.current_period_end<1
      || item.current_period_end>8640000000000) throw Error('Unsupported subscription items');
    seen.add(price.id);
    const record={...approved,quantity:item.quantity,end:item.current_period_end};
    if (approved.kind==='business') { if(base || item.quantity!==1)throw Error('One Business base required');base=record; }
    if (approved.kind==='employee_addon') { if(addon)throw Error('One employee add-on required');addon=record; }
    if (approved.kind==='unlimited') { if(unlimited || item.quantity!==1)throw Error('One unlimited add-on required');unlimited=record; }
  }
  if ((!base&&(!unlimited||addon)) || (addon && unlimited) || (base&&[addon,unlimited].some(x=>x&&(x.interval!==base.interval||x.currency!==base.currency)))) throw Error('Invalid Business composition');
  const principal=base||unlimited;
  const end=Math.min(principal.end,...[addon,unlimited].filter(Boolean).map(x=>x.end));
  const active=subscription.status==='active' && !subscription.pause_collection && end*1000>now;
  if (active) {
    const linked=invoice?.parent?.subscription_details?.subscription ?? invoice?.subscription;
    if (!id(invoice?.id,'in') || resourceId(subscription.latest_invoice)!==invoice.id
      || invoice.livemode!==livemode || resourceId(invoice.customer)!==customerId
      || resourceId(linked)!==subscription.id || invoice.status!=='paid' || ('paid' in invoice && invoice.paid!==true)
      || invoice.amount_remaining!==0 || invoice.currency!==principal.currency) throw Error('Paid invoice required');
  }
  const employees=base?base.employees+(addon?addon.employees*addon.quantity:0):0;
  if (!Number.isSafeInteger(employees)||employees>100000)throw Error('Employee limit exceeded');
  return {stripe_subscription_id:subscription.id,stripe_customer_id:customerId,status:subscription.status,subscription_type:base?'business':'unlimited_employees',
    business_active:active&&Boolean(base),unlimited_employees:active&&Boolean(unlimited),employee_limit:active?employees:0,
    current_period_end:new Date(end*1000).toISOString(),cancel_at_period_end:subscription.cancel_at_period_end===true};
}

export async function verifyBusinessSignature(raw, header, secret, {now=Date.now(),cryptoApi=crypto}={}) {
  if(typeof header!=='string'||header.length>4096||typeof secret!=='string'||!secret.startsWith('whsec_'))return false;
  const parts=header.split(',').map(x=>x.trim().split('='));
  const timestamps=parts.filter(x=>x[0]==='t');
  if(timestamps.length!==1||!/^\d{1,12}$/.test(timestamps[0][1]))return false;
  const timestamp=Number(timestamps[0][1]);if(Math.abs(now/1000-timestamp)>300)return false;
  const signatures=parts.filter(x=>x[0]==='v1'&&/^[a-f0-9]{64}$/.test(x[1]||''));
  const key=await cryptoApi.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  for(const [,hex] of signatures){const bytes=Uint8Array.from(hex.match(/../g),x=>parseInt(x,16));
    if(await cryptoApi.subtle.verify('HMAC',key,bytes,new TextEncoder().encode(timestamp+'.'+raw)))return true;
  }
  return false;
}

export function createBusinessBillingWebhook({releaseApproved=false,catalog:entries,stripe,store,cryptoApi=crypto,now=()=>Date.now()}={}) {
  const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  return async(request,env)=>{
    if(new URL(request.url).pathname!=='/api/business/billing/webhook')return null;
    if(request.method!=='POST')return reply({error:'method_not_allowed'},405);
    if(releaseApproved!==true||env.ENABLE_BUSINESS_BILLING!=='true')return reply({error:'business_billing_not_released'},503);
    if(!['live','test'].includes(env.BUSINESS_STRIPE_MODE)||!env.BUSINESS_STRIPE_WEBHOOK_SECRET||!stripe||!store)return reply({error:'billing_unavailable'},503);
    let catalog;try{catalog=businessCatalog(entries);}catch{return reply({error:'catalog_unavailable'},503);}
    let raw,event;
    try{
      const reader=request.body?.getReader();if(!reader)throw Error();let bytes=0;raw='';const decoder=new TextDecoder('utf-8',{fatal:true});
      for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>1000000){await reader.cancel();return reply({error:'event_too_large'},413);}raw+=decoder.decode(part.value,{stream:true});}raw+=decoder.decode();
      if(!await verifyBusinessSignature(raw,request.headers.get('Stripe-Signature'),env.BUSINESS_STRIPE_WEBHOOK_SECRET,{now:now(),cryptoApi}))throw Error();
      event=JSON.parse(raw);if(!id(event?.id,'evt')||event.livemode!==(env.BUSINESS_STRIPE_MODE==='live')||typeof event.type!=='string')throw Error();
    }catch{return reply({error:'invalid_event'},400);}
    const lifecycle=['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','customer.subscription.paused','customer.subscription.resumed','invoice.paid','invoice.payment_failed','checkout.session.completed','checkout.session.async_payment_succeeded'];
    const risk=['charge.dispute.created','charge.refunded','radar.early_fraud_warning.created'];
    if(!lifecycle.includes(event.type)&&!risk.includes(event.type))return reply({received:true,ignored:true});
    try{
      // The adapter must resolve risk events through Stripe charge/payment/invoice
      // relationships, then atomically journal and suspend access pending review.
      if(risk.includes(event.type)){const receipt=await store.reconcileRisk(event,stripe);return reply({received:true,reviewRequired:receipt?.reviewRequired!==false,...(receipt?.ignored?{ignored:true}:{})});}
      const object=event.data?.object;
      if(event.type.startsWith('checkout.')&&(object?.mode!=='subscription'||!['paid','no_payment_required'].includes(object.payment_status)))return reply({received:true,ignored:true});
      const customer=resourceId(object?.customer);
      const subId=event.type.startsWith('customer.subscription.')?object?.id:resourceId(object?.parent?.subscription_details?.subscription ?? object?.subscription);
      if(!id(customer,'cus')||!id(subId,'sub'))throw Error();
      if(typeof store.isMapped==='function'&&!await store.isMapped(customer)){
        if(await stripe.isRelevantSubscription(subId,customer))throw Error('Business customer mapping pending');
        return reply({received:true,ignored:true});
      }
      // Store contract: durable per-customer serialization, immutable customer to
      // owner mapping, event deduplication, subscription replacement rejection,
      // and atomic journal + entitlement update. No lifetime/legacy row updates.
      let reviewRequired=false,ignored=false;
      await store.withCustomerLock(customer,async transaction=>{
        if(await transaction.hasEvent(event.id,event.type))return;
        const subscription=await stripe.retrieveSubscription(subId);
        const items=subscription?.items;
        const products=[...catalog.values()].map(x=>x.productId);
        const unrelated=subscription?.id===subId&&resourceId(subscription.customer)===customer&&subscription.livemode===event.livemode
          &&Array.isArray(items?.data)&&items.has_more===false&&items.data.length>0
          &&items.data.every(x=>id(resourceId(x.price?.product),'prod'))&&!items.data.some(x=>products.includes(resourceId(x.price.product)));
        if(unrelated&&typeof transaction.isTrackedSubscription==='function'&&!await transaction.isTrackedSubscription(subId)){ignored=true;return;}
        const invoice=subscription.status==='active'?await stripe.retrieveInvoice(resourceId(subscription.latest_invoice)):null;
        let snapshot;
        try{snapshot=businessSnapshot(subscription,invoice,catalog,{customerId:customer,livemode:event.livemode,now:now()});}
        catch(error){
          if(subscription?.id!==subId||resourceId(subscription.customer)!==customer||subscription.livemode!==event.livemode||typeof transaction.markReview!=='function')throw error;
          const invoiceSubscription=resourceId(invoice?.parent?.subscription_details?.subscription??invoice?.subscription);
          const pendingPayment=error.message==='Paid invoice required'&&invoice?.status!=='paid'&&invoice?.id===resourceId(subscription.latest_invoice)
            &&resourceId(invoice.customer)===customer&&invoiceSubscription===subId&&invoice.livemode===event.livemode&&invoice.currency===subscription.items.data[0]?.price.currency
            &&Number.isSafeInteger(invoice.amount_remaining)&&invoice.amount_remaining>=0;
          if(pendingPayment){snapshot={...businessSnapshot({...subscription,status:'past_due'},null,catalog,{customerId:customer,livemode:event.livemode,now:now()}),status:subscription.status};}
          else{await transaction.markReview({eventId:event.id,eventType:event.type,subscriptionId:subId});reviewRequired=true;return;}
        }
        const receipt=await transaction.commitEvent({eventId:event.id,eventType:event.type,snapshot});
        reviewRequired=receipt?.reviewRequired===true;
      });
      return reply({received:true,...(reviewRequired?{reviewRequired:true}:{}),...(ignored?{ignored:true}:{})});
    }catch{return reply({error:'billing_retry_or_reconciliation_required'},500);}
  };
}
