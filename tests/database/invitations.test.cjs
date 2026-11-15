const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),net=require('node:net'),cp=require('node:child_process');
const OWNER='11111111-1111-4111-8111-111111111111',ORG='22222222-2222-4222-8222-222222222222',OTHER='33333333-3333-4333-8333-333333333333';
test('isolated PostgreSQL invitation security, capacity and delivery',async t=>{
 const bin=process.env.IRONCREST_PG_BIN||(process.platform==='win32'?'C:/Program Files/PostgreSQL/17/bin':'/usr/lib/postgresql/17/bin'),root=path.join(process.env.TEMP||process.env.TMPDIR||require('node:os').tmpdir(),'ironcrest-db-tests');fs.mkdirSync(root,{recursive:true});const dir=fs.mkdtempSync(path.join(root,'invitations-')),data=path.join(dir,'data');
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
   CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
   CREATE FUNCTION auth.role() RETURNS text LANGUAGE SQL STABLE AS $$ SELECT current_setting('request.jwt.claim.role',true) $$;
   GRANT USAGE ON SCHEMA auth TO service_role;
   CREATE TABLE public.ironcrest_organizations(id uuid primary key,name text,created_by uuid);
   CREATE TABLE public.ironcrest_memberships(id uuid primary key default gen_random_uuid(),organization_id uuid,user_id uuid unique,role text,active boolean);
   CREATE TABLE public.test_entitlement(active boolean,employee_limit integer);INSERT INTO public.test_entitlement VALUES(true,20);
   CREATE FUNCTION public.ironcrest_business_entitlement(uuid) RETURNS TABLE(business_active boolean,unlimited_employees boolean,employee_limit integer,entitlement_status text) LANGUAGE SQL STABLE AS $$ SELECT active,false,employee_limit,'active'::text FROM public.test_entitlement $$;
   CREATE TABLE public.ironcrest_invitations(id uuid primary key default gen_random_uuid(),organization_id uuid,email text,role text default 'employee',status text default 'pending',invited_by uuid,created_at timestamptz default now(),expires_at timestamptz default now()+interval '7 days',accepted_at timestamptz,revoked_at timestamptz,token_hash text unique not null);
   CREATE UNIQUE INDEX invitation_pending_unique ON public.ironcrest_invitations(organization_id,lower(email)) WHERE status='pending';
   CREATE TABLE public.ironcrest_invitation_delivery_audit(id uuid primary key default gen_random_uuid(),invitation_id uuid,organization_id uuid,recipient_email text,provider text default 'resend',provider_message_id text,delivery_status text default 'pending',attempt_count integer default 0,last_error_code text,created_at timestamptz default now(),updated_at timestamptz default now(),CONSTRAINT ironcrest_delivery_status_check CHECK(delivery_status in ('pending','sending','accepted','delivered','bounced','failed','cancelled')));
   CREATE UNIQUE INDEX delivery_active_unique ON public.ironcrest_invitation_delivery_audit(invitation_id) WHERE delivery_status in ('pending','sending','accepted','delivered');
   GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO service_role;
   INSERT INTO auth.users VALUES('${OWNER}','owner@example.com',now()),('${OTHER}','employee@example.com',now());
   INSERT INTO public.ironcrest_organizations VALUES('${ORG}','Fixture','${OWNER}');
   INSERT INTO public.ironcrest_memberships(organization_id,user_id,role,active) VALUES('${ORG}','${OWNER}','owner',true);`,null);
  sql(fs.readFileSync(path.join(__dirname,'invitation-existing-functions.sql'),'utf8'),null);
  sql(fs.readFileSync(path.join(__dirname,'../../docs/owner-invitations-schema.sql'),'utf8'),null);
  const hash=n=>n.toString(16).padStart(64,'0');
  const create=(email,n=1,actor=OWNER)=>`SELECT public.ironcrest_owner_create_invitation('${actor}','${ORG}','${email}','${hash(n)}');`;
  const accept=(n=1,user=OTHER)=>`SELECT row_to_json(a) FROM public.ironcrest_accept_invitation('${hash(n)}','${user}') a;`;
  const make=(email,n)=>sql(create(email,n)).stdout.trim();
  let invite,audit;
  await t.test('ordinary clients cannot execute new invitation or revoke functions',()=>{
   for(const role of ['anon','authenticated'])assert.notEqual(sql(create('employee@example.com'),role,false).status,0);
   assert.notEqual(sql(create('employee@example.com',1,OTHER),'service_role',false).status,0);
   assert.equal(sql('SELECT count(*) FROM public.ironcrest_invitations;').stdout.trim(),'0');
  });
  await t.test('normal creation reserves one employee slot and rejects duplicate recipients',()=>{
   invite=make('employee@example.com',1);assert.match(invite,/^[a-f0-9-]{36}$/);
   assert.equal(sql(`SELECT role FROM public.ironcrest_invitations WHERE id='${invite}';`).stdout.trim(),'employee');
   assert.notEqual(sql(create('EMPLOYEE@example.com',2),'service_role',false).status,0);
   assert.equal(sql(`SELECT occupied_slots FROM public.ironcrest_employee_capacity('${ORG}');`).stdout.trim(),'1');
  });
  await t.test('only one independent email delivery claim succeeds and unknown outcomes cannot be reserved again',async()=>{
   const reserve=()=>JSON.parse(sql(`SELECT row_to_json(r) FROM public.ironcrest_reserve_invitation_delivery('${invite}','${ORG}','employee@example.com') r;`).stdout.trim());
   audit=reserve().audit_id;const claim=`SELECT public.ironcrest_claim_invitation_delivery('${audit}','${invite}','${ORG}');`;
   // JSON boolean output permits independent concurrent connections.
   const results=await Promise.all([independent(claim.replace('SELECT public.','SELECT to_json(public.').replace("');","'));")),independent(claim.replace('SELECT public.','SELECT to_json(public.').replace("');","'));"))]);
   assert.equal(results.filter(x=>x===true).length,1);
   assert.equal(sql(`SELECT public.ironcrest_finish_invitation_delivery('${audit}','${invite}','${ORG}','unknown',null,'PROVIDER_OUTCOME_UNKNOWN');`).stdout.trim(),'t');
   const again=reserve();assert.equal(again.reservation_created,false);assert.equal(again.audit_id,audit);
   assert.equal(sql(claim).stdout.trim(),'f');
  });
  await t.test('wrong email and unverified account cannot accept the reserved invitation',()=>{
   assert.notEqual(sql(accept(1,OWNER),'service_role',false).status,0);
   sql(`UPDATE auth.users SET email_confirmed_at=null WHERE id='${OTHER}';`,null);assert.notEqual(sql(accept(),'service_role',false).status,0);
   sql(`UPDATE auth.users SET email_confirmed_at=now() WHERE id='${OTHER}';`,null);
  });
  await t.test('concurrent acceptance has one winner and never creates a duplicate membership',async()=>{
   const results=await Promise.allSettled([independent(accept()),independent(accept())]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
   assert.equal(sql(`SELECT count(*) FROM public.ironcrest_memberships WHERE user_id='${OTHER}';`).stdout.trim(),'1');
   assert.equal(sql(`SELECT status FROM public.ironcrest_invitations WHERE id='${invite}';`).stdout.trim(),'accepted');
   assert.notEqual(sql(accept(),'service_role',false).status,0);
  });
  await t.test('revocation preserves accepted memberships and revoked invitations cannot be accepted',()=>{
   const revoke=id=>JSON.parse(sql(`SELECT public.ironcrest_owner_revoke_invitation('${OWNER}','${ORG}','${id}');`).stdout.trim());
   assert.equal(revoke(invite).error,'invitation_not_pending');assert.equal(sql('SELECT count(*) FROM public.ironcrest_memberships;').stdout.trim(),'2');
   const id=make('second@example.com',2);assert.equal(revoke(id).ok,true);assert.equal(revoke(id).ok,true);assert.notEqual(sql(accept(2),'service_role',false).status,0);
  });
  await t.test('independent invitation creations cannot exceed the last team place',async()=>{
   sql('UPDATE public.test_entitlement SET employee_limit=2;',null);
   const results=await Promise.allSettled([independent(create('third@example.com',3).replace('SELECT public.','SELECT to_json(public.').replace("');","'));")),independent(create('fourth@example.com',4).replace('SELECT public.','SELECT to_json(public.').replace("');","'));"))]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
   assert.equal(sql(`SELECT occupied_slots FROM public.ironcrest_employee_capacity('${ORG}');`).stdout.trim(),'2');
   sql('UPDATE public.test_entitlement SET employee_limit=20;',null);
  });
  await t.test('expired and existing-member invitations do not create extra memberships',()=>{
   const id=make('fifth@example.com',5);sql(`UPDATE public.ironcrest_invitations SET expires_at=now()-interval '1 second' WHERE id='${id}';`,null);
   assert.notEqual(sql(accept(5),'service_role',false).status,0);
   assert.notEqual(sql(create('employee@example.com',6),'service_role',false).status,0);
   assert.equal(sql('SELECT count(*) FROM public.ironcrest_memberships;').stdout.trim(),'2');
  });
  await t.test('recipient hourly limit is enforced across revoked invitations',()=>{
   for(let n=10;n<13;n++){const id=make('rate@example.com',n);sql(`SELECT public.ironcrest_owner_revoke_invitation('${OWNER}','${ORG}','${id}');`);}
   const rejected=sql(create('rate@example.com',13),'service_role',false);assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/Recipient invitation rate limit/);
  });
 }finally{if(started)command('pg_ctl',['-D',data,'-m','fast','-w','stop']);}
});
