const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),net=require('node:net'),cp=require('node:child_process');
const OWNER='11111111-1111-4111-8111-111111111111',ORG='22222222-2222-4222-8222-222222222222',OTHER='33333333-3333-4333-8333-333333333333';
test('durable Business webhook processing',async t=>{
 const bin=process.env.IRONCREST_PG_BIN||(process.platform==='win32'?'C:/Program Files/PostgreSQL/17/bin':'/usr/lib/postgresql/17/bin'),root=path.join(process.env.TEMP||process.env.TMPDIR||require('node:os').tmpdir(),'ironcrest-db-tests');fs.mkdirSync(root,{recursive:true});const dir=fs.mkdtempSync(path.join(root,'webhook-')),data=path.join(dir,'data');
 const env={...process.env,TEMP:dir,TMP:dir};for(const key of Object.keys(env))if(key.startsWith('PG'))delete env[key];
 const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p));});});
 const args=['-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',String(port),'-U','ironcrest_test','-d','postgres'];
 function command(name,args){const fd=fs.openSync(path.join(dir,name+'.log'),'a');try{const r=cp.spawnSync(path.join(bin,name+(process.platform==='win32'?'.exe':'')),args,{env,windowsHide:true,encoding:'utf8',timeout:60000,stdio:['ignore',fd,fd]});if(r.error||r.status!==0)throw Error(r.error?.message||fs.readFileSync(path.join(dir,name+'.log'),'utf8')+(fs.existsSync(path.join(dir,'server.log'))?'\n'+fs.readFileSync(path.join(dir,'server.log'),'utf8'):''));return r.stdout;}finally{fs.closeSync(fd);}}
 function sql(text,role='service_role',success=true){const r=cp.spawnSync(path.join(bin,'psql'+(process.platform==='win32'?'.exe':'')),args,{input:(role?"SET ROLE "+role+";SET request.jwt.claim.role='"+role+"';\n":'')+text,env,windowsHide:true,encoding:'utf8',timeout:30000});if(r.error||success&&r.status!==0)throw Error(r.error?.message||r.stderr);return r;}
 const rpc=(revision,name='Example',actor=OWNER,zone='America/Phoenix',day=1)=>`SELECT public.ironcrest_save_company_settings('${actor}','${ORG}','${name}','${zone}',${day},${revision});`;
 const call=(...params)=>JSON.parse(sql(rpc(...params)).stdout.trim());
 function independent(text){return new Promise((resolve,reject)=>{const child=cp.spawn(path.join(bin,'psql'+(process.platform==='win32'?'.exe':'')),args,{env,windowsHide:true});let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('error',reject);child.on('close',code=>code?reject(Error(err)):resolve(JSON.parse(out.trim())));child.stdin.end("SET ROLE service_role;SET request.jwt.claim.role='service_role';\n"+text);});}
 let started=false;
 try{
  command('initdb',['-D',data,'-U','ironcrest_test','-A','trust','--no-locale','-E','UTF8']);
  command('pg_ctl',['-D',data,'-l',path.join(dir,'server.log'),'-o','-h 127.0.0.1 -p '+port+(process.platform==='win32'?'':' -k '+dir),'-w','start']);started=true;

  sql(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;
   CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid primary key);
   CREATE TABLE public.ironcrest_organizations(id uuid primary key,created_by uuid);
   CREATE TABLE public.ironcrest_memberships(organization_id uuid,user_id uuid,role text,active boolean);
   INSERT INTO auth.users VALUES('${OWNER}');
   INSERT INTO public.ironcrest_organizations VALUES('${ORG}','${OWNER}');
   INSERT INTO public.ironcrest_memberships VALUES('${ORG}','${OWNER}','owner',true);GRANT SELECT ON ALL TABLES IN SCHEMA public TO service_role;`,null);
  sql(fs.readFileSync(path.join(__dirname,'../../docs/business-webhook-storage-proposal.sql'),'utf8'),null);
  const customer='cus_fixture';
  sql(`INSERT INTO public.ironcrest_billing_customers(mode,customer_id,owner_user_id,organization_id) VALUES('test','${customer}','${OWNER}','${ORG}');`,null);
  const quote=value=>"'"+String(value).replaceAll("'","''")+"'";
  const call=(operation,token=null,data={},mode='test',who=customer)=>JSON.parse(sql(`SELECT public.ironcrest_billing_event_operation(${quote(mode)},${quote(who)},${quote(operation)},${token?quote(token):'NULL'},${quote(JSON.stringify(data))}::jsonb);`).stdout);
  const acquire=()=>call('acquire').token;
  const snapshot=()=>({stripe_customer_id:customer,stripe_subscription_id:'sub_fixture',status:'active',business_active:true,unlimited_employees:false,employee_limit:20,current_period_end:new Date(Date.now()+86400000).toISOString(),cancel_at_period_end:false});
  const event=(id='evt_fixture')=>({eventId:id,eventType:'invoice.paid',snapshot:snapshot()});
  const count=()=>Number(sql('SELECT count(*) FROM public.ironcrest_billing_events;').stdout);
  const entitlement=(mode='test')=>JSON.parse(sql(`SELECT row_to_json(x) FROM public.ironcrest_webhook_business_entitlement('${ORG}',${quote(mode)}) x;`).stdout);
  const reset=()=>sql('TRUNCATE public.ironcrest_billing_events,public.ironcrest_billing_snapshots;UPDATE public.ironcrest_billing_customers SET lease_token=NULL,lease_until=NULL,review_required=false,subscription_id=NULL,unlimited_subscription_id=NULL;',null);
  await t.test('ordinary clients cannot call billing RPCs or read mapped customers',()=>{
   for(const role of ['anon','authenticated']){assert.notEqual(sql("SELECT * FROM public.ironcrest_billing_customers;",role,false).status,0);assert.notEqual(sql("SELECT public.ironcrest_billing_event_operation('test','cus_fixture','acquire');",role,false).status,0);}assert.throws(()=>call('acquire',null,{},'live'));assert.throws(()=>call('acquire',null,{},'test','cus_unknown'));
  });
  await t.test('durable lease permits one holder; stale holder cannot commit or release a successor',()=>{
   const first=acquire();assert.throws(()=>acquire());sql("UPDATE public.ironcrest_billing_customers SET lease_until=clock_timestamp()-interval '1 second';",null);const second=acquire();assert.notEqual(first,second);assert.throws(()=>call('commit',first,event()));call('release',first);assert.equal(sql('SELECT lease_token FROM public.ironcrest_billing_customers;').stdout.trim(),second);call('release',second);reset();
  });
  await t.test('customer ownership cannot be reassigned through direct service updates',()=>{
   const result=sql("UPDATE public.ironcrest_billing_customers SET customer_id='cus_reassigned';",'service_role',false);
   assert.notEqual(result.status,0);assert.match(result.stderr,/mapping is immutable/);assert.equal(sql('SELECT customer_id FROM public.ironcrest_billing_customers;').stdout.trim(),customer);
  });
  await t.test('commit and event journal are atomic; duplicate does not overwrite a newer snapshot',()=>{
   const token=acquire();assert.equal(call('commit',token,event()).ok,true);assert.equal(count(),1);const newer=event('evt_newer');newer.snapshot.status='canceled';newer.snapshot.business_active=false;newer.snapshot.employee_limit=0;call('commit',token,newer);assert.equal(call('commit',token,event()).duplicate,true);assert.equal(entitlement().business_active,false);assert.equal(entitlement('live').business_active,false);call('release',token);reset();
  });
  await t.test('journal failure rolls back entitlement and subscription pin',()=>{
   sql("CREATE FUNCTION public.fail_event() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture failure';END;$$;CREATE TRIGGER fail_event BEFORE INSERT ON public.ironcrest_billing_events FOR EACH ROW EXECUTE FUNCTION public.fail_event();",null);
   const token=acquire();assert.throws(()=>call('commit',token,event()));assert.equal(count(),0);assert.equal(entitlement().business_active,false);assert.equal(sql('SELECT count(*) FROM public.ironcrest_billing_snapshots;').stdout.trim(),'0');assert.equal(sql('SELECT subscription_id IS NULL FROM public.ironcrest_billing_customers;').stdout.trim(),'t');sql('DROP TRIGGER fail_event ON public.ironcrest_billing_events;',null);call('release',token);reset();
  });
  await t.test('risk hold survives subsequent paid events and handles a refund on an older subscription',()=>{
   const token=acquire();call('commit',token,event());call('review',token,{eventId:'evt_refund',eventType:'charge.refunded',subscriptionId:'sub_older'});assert.equal(entitlement().business_active,false);call('commit',token,event('evt_after'));assert.equal(entitlement().review_required,true);assert.equal(entitlement().business_active,false);call('release',token);reset();
  });
  await t.test('separate unlimited subscriptions compose with Business without replacing or granting the base',()=>{
   const token=acquire(),addon={...snapshot(),stripe_subscription_id:'sub_addon',subscription_type:'unlimited_employees',business_active:false,unlimited_employees:true,employee_limit:0};
   call('commit',token,{eventId:'evt_addon',eventType:'invoice.paid',snapshot:addon});assert.equal(entitlement().business_active,false);assert.equal(entitlement().unlimited_employees,false);
   call('commit',token,event());assert.equal(entitlement().business_active,true);assert.equal(entitlement().unlimited_employees,true);
   call('commit',token,{eventId:'evt_addoncancel',eventType:'customer.subscription.deleted',snapshot:{...addon,status:'canceled',unlimited_employees:false}});assert.equal(entitlement().business_active,true);assert.equal(entitlement().unlimited_employees,false);assert.equal(entitlement().employee_limit,20);call('release',token);reset();
  });
  await t.test('independent concurrent lease requests have one winner',async()=>{
   const request="SELECT public.ironcrest_billing_event_operation('test','cus_fixture','acquire');";
   const results=await Promise.allSettled([independent(request),independent(request)]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);const token=results.find(x=>x.status==='fulfilled').value.token;call('release',token);reset();
  });
  await t.test('replacement, malformed snapshots and revoked owner cannot commit',()=>{
   const token=acquire();call('commit',token,event());const wrong=event('evt_replacement');wrong.snapshot.stripe_subscription_id='sub_replacement';assert.throws(()=>call('commit',token,wrong));for(const value of [null,'true']){const bad=event('evt_bad');bad.snapshot.business_active=value;assert.throws(()=>call('commit',token,bad));}sql('UPDATE public.ironcrest_memberships SET active=false;',null);assert.throws(()=>call('commit',token,event('evt_revoked')));assert.equal(entitlement().business_active,false);call('release',token);sql('UPDATE public.ironcrest_memberships SET active=true;',null);reset();
  });
  await t.test('complete signed Worker-to-Stripe-to-database flow commits once and handles cancellation',async()=>{
   const {createBusinessBillingWorker,SANDBOX_BUSINESS_PRICES}=await import('../../worker/business-billing-entry.mjs');
   const {createHmac}=require('node:crypto');let state='active',stripeReads=0,paid=true;
   const price=SANDBOX_BUSINESS_PRICES[0];const sub=()=>({id:'sub_fixture',customer,livemode:false,status:state,latest_invoice:'in_fixture',items:{has_more:false,data:[{price:{id:price.priceId,product:price.productId,currency:'usd',unit_amount:12999,livemode:false,recurring:{interval:'month',interval_count:1,usage_type:'licensed'}},quantity:1,current_period_end:Math.floor(Date.now()/1000)+86400}]},cancel_at_period_end:false});
   const invoice=()=>({id:'in_fixture',customer,livemode:false,status:paid?'paid':'open',amount_remaining:paid?0:12999,currency:'usd',parent:{subscription_details:{subscription:'sub_fixture'}}});
   const fetcher=async(url,options)=>{
    const u=new URL(url);assert.equal(options.redirect,'manual');
    if(u.hostname==='api.stripe.com'){stripeReads++;assert.equal(options.headers['Stripe-Version'],'2026-10-28.endive');return new Response(JSON.stringify(u.pathname.includes('/subscriptions/')?sub():invoice()));}
    assert.equal(u.origin,'https://nhiqbcevcdxfzvrprgck.supabase.co');assert.equal(u.pathname,'/rest/v1/rpc/ironcrest_billing_event_operation');const b=JSON.parse(options.body);return new Response(JSON.stringify(call(b.p_operation,b.p_token,b.p_data,b.p_mode,b.p_customer_id)));
   };
   const worker=createBusinessBillingWorker({fetcher});const env={BUSINESS_STRIPE_MODE:'test',ENABLE_BUSINESS_BILLING:'true',BUSINESS_STRIPE_KEY:'rk_test_fixture',BUSINESS_DATABASE_KEY:'sb_secret_fixture',SUPABASE_URL:'https://nhiqbcevcdxfzvrprgck.supabase.co',BUSINESS_STRIPE_WEBHOOK_SECRET:'whsec_fixture'};
   const request=id=>{const raw=JSON.stringify({id,type:'customer.subscription.updated',livemode:false,data:{object:{id:'sub_fixture',customer}}}),time=Math.floor(Date.now()/1000),signature=createHmac('sha256','whsec_fixture').update(time+'.'+raw).digest('hex');return new Request('https://worker.example/api/business/billing/webhook',{method:'POST',headers:{'Stripe-Signature':`t=${time},v1=${signature}`},body:raw});};
   assert.equal((await worker.fetch(request('evt_integrated'),env)).status,200);assert.equal(entitlement().business_active,true);const reads=stripeReads;assert.equal((await worker.fetch(request('evt_integrated'),env)).status,200);assert.equal(stripeReads,reads);assert.equal(count(),1);
   state='canceled';assert.equal((await worker.fetch(request('evt_canceled'),env)).status,200);assert.equal(entitlement().business_active,false);
   assert.equal((await worker.fetch(request('evt_live'),{...env,BUSINESS_STRIPE_MODE:'live',BUSINESS_STRIPE_KEY:'rk_live_fixture'})).status,503);
   assert.equal(count(),2);state='active';paid=false;assert.equal((await worker.fetch(request('evt_unpaid'),env)).status,200);assert.equal(entitlement().business_active,false);assert.equal(entitlement().review_required,false);paid=true;assert.equal((await worker.fetch(request('evt_paidagain'),env)).status,200);assert.equal(entitlement().business_active,true);reset();
  });
 }finally{if(started)command('pg_ctl',['-D',data,'-m','fast','-w','stop']);}
});

