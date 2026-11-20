const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),net=require('node:net'),cp=require('node:child_process');
const OWNER='11111111-1111-4111-8111-111111111111',ORG='22222222-2222-4222-8222-222222222222',OTHER='33333333-3333-4333-8333-333333333333';
test('isolated PostgreSQL Business entitlement compatibility',async t=>{
 const bin=process.env.IRONCREST_PG_BIN||(process.platform==='win32'?'C:/Program Files/PostgreSQL/17/bin':'/usr/lib/postgresql/17/bin'),root=path.join(process.env.TEMP||process.env.TMPDIR||require('node:os').tmpdir(),'ironcrest-db-tests');fs.mkdirSync(root,{recursive:true});const dir=fs.mkdtempSync(path.join(root,'business-')),data=path.join(dir,'data');
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
  command('pg_ctl',['-D',data,'-l',path.join(dir,'server.log'),'-o','-h 127.0.0.1 -p '+port+" -c unix_socket_directories=",'-w','start']);started=true;

  sql(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE TABLE public.ironcrest_organizations(id uuid,created_by uuid);
  CREATE TABLE public.ironcrest_memberships(organization_id uuid,user_id uuid,role text,active boolean);
  CREATE TABLE public.owner_entitlements(user_id uuid,role text,lifetime_business boolean);
  CREATE TABLE public.ph_business_subscriptions_live(user_id uuid,stripe_subscription_id text,stripe_price_id text,subscription_type text,billing_interval text,status text,current_period_end timestamptz);
  CREATE TABLE public.ph_subscriptions_live(user_id uuid,stripe_subscription_id text,stripe_price_id text,status text,current_period_end timestamptz);
  CREATE TABLE public.ironcrest_addon_subscriptions(organization_id uuid,stripe_price_id text,status text,current_period_end timestamptz);
  INSERT INTO public.ironcrest_organizations VALUES('${ORG}','${OWNER}');
  INSERT INTO public.ironcrest_memberships VALUES('${ORG}','${OWNER}','owner',true);
  GRANT SELECT ON ALL TABLES IN SCHEMA public TO service_role;`,null);
  sql(fs.readFileSync(path.join(__dirname,'../../docs/business-entitlement-proposal.sql'),'utf8'),null);
  const read=()=>JSON.parse(sql(`SELECT row_to_json(x) FROM public.ironcrest_business_entitlement_v2('${ORG}') x;`).stdout);
  const reset=()=>sql('TRUNCATE public.ph_business_subscriptions_live,public.ph_subscriptions_live,public.ironcrest_addon_subscriptions,public.owner_entitlements;',null);
  const base=(price='price_1UXk8pAQCOww3CbZm6PjdBil',interval='month',status='active')=>sql(`INSERT INTO public.ph_business_subscriptions_live VALUES('${OWNER}','sub_fixture','${price}','business','${interval}','${status}',now()+interval '1 day');`,null);
  await t.test('service-only access and no Business grant without subscription',()=>{assert.equal(read().business_active,false);for(const role of ['anon','authenticated'])assert.notEqual(sql(`SELECT * FROM public.ironcrest_business_entitlement_v2('${ORG}');`,role,false).status,0);});
  await t.test('both verified monthly and annual Business prices grant 20 employees',()=>{for(const [price,interval] of [['price_1UXk8pAQCOww3CbZm6PjdBil','month'],['price_1UYO1JAQCOww3CbZAMWwOC7N','year']]){base(price,interval);assert.equal(read().employee_limit,20);reset();}});
  await t.test('Pro prices, wrong cadence, expired and failed subscriptions cannot grant Business',()=>{for(const [price,interval,status] of [['price_pro','month','active'],['price_1UYO1JAQCOww3CbZAMWwOC7N','month','active'],['price_1UXk8pAQCOww3CbZm6PjdBil','month','past_due']]){base(price,interval,status);assert.equal(read().business_active,false);reset();}base();sql(`UPDATE public.ph_business_subscriptions_live SET current_period_end=now()-interval '1 second';`,null);assert.equal(read().business_active,false);reset();});
  await t.test('canceled current Business blocks stale active legacy fallback',()=>{sql(`INSERT INTO public.ph_subscriptions_live VALUES('${OWNER}','sub_legacy','price_1UXk8pAQCOww3CbZm6PjdBil','active',now()+interval '1 day');`,null);assert.equal(read().business_active,true);base(undefined,undefined,'canceled');assert.equal(read().business_active,false);reset();});
  await t.test('duplicate active Business rows fail closed',()=>{base();base();assert.equal(read().business_active,false);reset();});
  await t.test('lifetime owners remain entitled; unlimited requires active Business and matching approved add-on',()=>{sql(`INSERT INTO public.owner_entitlements VALUES('${OWNER}','owner',true);INSERT INTO public.ironcrest_addon_subscriptions VALUES('${ORG}','price_1UXkBDAQCOww3CbZpXEDYoHB','active',now()+interval '1 day');`,null);assert.equal(read().entitlement_status,'LIFETIME_BUSINESS');assert.equal(read().unlimited_employees,true);assert.equal(read().employee_limit,null);sql('TRUNCATE public.owner_entitlements;',null);assert.equal(read().unlimited_employees,false);reset();});
  await t.test('canceled current add-on blocks stale legacy unlimited; revoked owner loses access',()=>{base();sql(`INSERT INTO public.ironcrest_addon_subscriptions VALUES('${ORG}','price_1UXkBDAQCOww3CbZpXEDYoHB','active',now()+interval '1 day');INSERT INTO public.ph_business_subscriptions_live VALUES('${OWNER}','sub_addon','price_1UXkBDAQCOww3CbZpXEDYoHB','unlimited_employees','month','canceled',now()+interval '1 day');`,null);assert.equal(read().employee_limit,20);sql('UPDATE public.ironcrest_memberships SET active=false;',null);assert.equal(read().business_active,false);reset();});
 }finally{if(started)command('pg_ctl',['-D',data,'-m','fast','-w','stop']);}
});
