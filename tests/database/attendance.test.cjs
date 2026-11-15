const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),net=require('node:net'),cp=require('node:child_process');
const OWNER='11111111-1111-4111-8111-111111111111',ORG='22222222-2222-4222-8222-222222222222',OTHER='33333333-3333-4333-8333-333333333333';
test('isolated PostgreSQL general attendance proposal',async t=>{
 const bin=process.env.IRONCREST_PG_BIN||(process.platform==='win32'?'C:/Program Files/PostgreSQL/17/bin':'/usr/lib/postgresql/17/bin'),root=path.join(process.env.TEMP||process.env.TMPDIR||require('node:os').tmpdir(),'ironcrest-db-tests');fs.mkdirSync(root,{recursive:true});const dir=fs.mkdtempSync(path.join(root,'attendance-')),data=path.join(dir,'data');
 const env={...process.env,TEMP:dir,TMP:dir};for(const key of Object.keys(env))if(key.startsWith('PG'))delete env[key];
 const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p));});});
 const args=['-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',String(port),'-U','ironcrest_test','-d','postgres'];
 function command(name,args){const fd=fs.openSync(path.join(dir,name+'.log'),'a');try{const r=cp.spawnSync(path.join(bin,name+(process.platform==='win32'?'.exe':'')),args,{env,windowsHide:true,encoding:'utf8',timeout:60000,stdio:['ignore',fd,fd]});if(r.error||r.status!==0)throw Error(r.error?.message||fs.readFileSync(path.join(dir,name+'.log'),'utf8'));return r.stdout;}finally{fs.closeSync(fd);}}
 function sql(text,role='service_role',success=true){const r=cp.spawnSync(path.join(bin,'psql'+(process.platform==='win32'?'.exe':'')),args,{input:(role?"SET ROLE "+role+";SET request.jwt.claim.role='"+role+"';\n":'')+text,env,windowsHide:true,encoding:'utf8',timeout:30000});if(r.error||success&&r.status!==0)throw Error(r.error?.message||r.stderr);return r;}
 const rpc=(revision,name='Example',actor=OWNER,zone='America/Phoenix',day=1)=>`SELECT public.ironcrest_save_company_settings('${actor}','${ORG}','${name}','${zone}',${day},${revision});`;
 const call=(...params)=>JSON.parse(sql(rpc(...params)).stdout.trim());
 function independent(text){return new Promise((resolve,reject)=>{const child=cp.spawn(path.join(bin,'psql'+(process.platform==='win32'?'.exe':'')),args,{env,windowsHide:true});let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('error',reject);child.on('close',code=>code?reject(Error(err)):resolve(JSON.parse(out.trim())));child.stdin.end("SET ROLE service_role;SET request.jwt.claim.role='service_role';\n"+text);});}
 let started=false;
 try{
  command('initdb',['-D',data,'-U','ironcrest_test','-A','trust','--no-locale','-E','UTF8']);
  command('pg_ctl',['-D',data,'-l',path.join(dir,'server.log'),'-o','-h 127.0.0.1 -p '+port,'-w','start']);started=true;

  const EMP='44444444-4444-4444-8444-444444444444',MEM='66666666-6666-4666-8666-666666666666',SITE='77777777-7777-4777-8777-777777777777',FOREIGN='55555555-5555-4555-8555-555555555555';
  sql(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;
   CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid primary key);
   CREATE TABLE public.ironcrest_organizations(id uuid primary key,created_by uuid);
   CREATE TABLE public.ironcrest_memberships(id uuid primary key,organization_id uuid,user_id uuid,role text,active boolean);
   CREATE TABLE public.ironcrest_worksites(id uuid primary key,organization_id uuid,latitude double precision,longitude double precision,radius_m double precision,active boolean);
   CREATE TABLE public.ironcrest_employee_worksite_assignments(id uuid primary key,membership_id uuid,organization_id uuid,worksite_id uuid,active boolean);
   CREATE TABLE public.test_entitlement(active boolean);INSERT INTO public.test_entitlement VALUES(true);
   CREATE FUNCTION public.ironcrest_business_entitlement(uuid) RETURNS TABLE(business_active boolean) LANGUAGE SQL STABLE AS 'SELECT active FROM public.test_entitlement';
   CREATE TABLE public.ironcrest_attendance_entries(id uuid primary key default gen_random_uuid(),organization_id uuid,employee_user_id uuid,worksite_id uuid,clock_in_at timestamptz,clock_out_at timestamptz,clock_in_method text,clock_out_method text,updated_at timestamptz default now());
   CREATE UNIQUE INDEX one_open_shift ON public.ironcrest_attendance_entries(employee_user_id) WHERE clock_out_at IS NULL;
   CREATE TABLE public.ironcrest_attendance_audit(id uuid primary key default gen_random_uuid(),organization_id uuid,attendance_entry_id uuid,actor_user_id uuid,action text,details jsonb);
   GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO service_role;
   INSERT INTO auth.users VALUES('${EMP}'),('${OWNER}'),('${FOREIGN}');
   INSERT INTO public.ironcrest_organizations VALUES('${ORG}','${OWNER}');
   INSERT INTO public.ironcrest_memberships VALUES('${OWNER}','${ORG}','${OWNER}','owner',true),('${MEM}','${ORG}','${EMP}','employee',true);
   INSERT INTO public.ironcrest_worksites VALUES('${SITE}','${ORG}',33,-112,100,true);
   INSERT INTO public.ironcrest_employee_worksite_assignments VALUES('${SITE}','${MEM}','${ORG}','${SITE}',true);`,null);
  sql(fs.readFileSync(path.join(__dirname,'../../docs/attendance-workflows-proposal.sql'),'utf8'),null);
  const uuid=()=>require('node:crypto').randomUUID();
  const action=(op=uuid(),verb='clock_in',entry=null,actor=EMP,lat='33',lon='-112',accuracy='5',sample='clock_timestamp()')=>`SELECT public.ironcrest_attendance_workflow('${actor}','${op}','${SITE}','${verb}',${entry?"'"+entry+"'":'NULL'},${lat},${lon},${accuracy},${sample});`;
  const count=table=>Number(sql('SELECT count(*) FROM public.'+table+';').stdout.trim());
  const reset=()=>sql('TRUNCATE public.ironcrest_attendance_operations,public.ironcrest_attendance_entries,public.ironcrest_attendance_audit;',null);
  await t.test('ordinary roles cannot call the function or read request journal',()=>{
   for(const role of ['anon','authenticated']){assert.notEqual(sql(action(),role,false).status,0);assert.notEqual(sql('SELECT * FROM public.ironcrest_attendance_operations;',role,false).status,0);}
   for(const user of [OWNER,FOREIGN])assert.notEqual(sql(action(uuid(),'clock_in',null,user),'service_role',false).status,0);
   assert.equal(count('ironcrest_attendance_entries'),0);
  });
  await t.test('revoked company, employee, assignment, worksite and Business access deny writes',()=>{
   for(const [table,filter] of [['ironcrest_memberships',`user_id='${EMP}'`],['ironcrest_memberships',`user_id='${OWNER}'`],['ironcrest_worksites','true'],['ironcrest_employee_worksite_assignments','true'],['test_entitlement','true']]){
    sql(`UPDATE public.${table} SET active=false WHERE ${filter};`,null);assert.notEqual(sql(action(),'service_role',false).status,0);sql(`UPDATE public.${table} SET active=true WHERE ${filter};`,null);
   }assert.equal(count('ironcrest_attendance_operations'),0);
  });
  await t.test('stale, future, inaccurate, out of bounds and boundary-uncertain locations deny writes',()=>{
   const cases=[['33','-112','5',"clock_timestamp()-interval '31 seconds'"],['33','-112','5',"clock_timestamp()+interval '6 seconds'"],['33','-112','101','clock_timestamp()'],['33.0008','-112','20','clock_timestamp()'],['34','-112','1','clock_timestamp()'],["'NaN'",'-112','1','clock_timestamp()'],['33',"'Infinity'",'1','clock_timestamp()'],['33','-112',"'NaN'",'clock_timestamp()'],['NULL','-112','1','clock_timestamp()']];
   for(const [lat,lon,acc,sample] of cases)assert.notEqual(sql(action(uuid(),'clock_in',null,EMP,lat,lon,acc,sample),'service_role',false).status,0);
   assert.equal(count('ironcrest_attendance_entries'),0);
  });
  await t.test('same operation concurrently replays one result with one shift and audit event',async()=>{
   const op=uuid(),results=await Promise.all([independent(action(op)),independent(action(op))]);
   assert.equal(results[0].entryId,results[1].entryId);assert.deepEqual(results.map(x=>x.replayed).sort(),[false,true]);
   assert.equal(count('ironcrest_attendance_entries'),1);assert.equal(count('ironcrest_attendance_audit'),1);assert.equal(count('ironcrest_attendance_operations'),1);
   assert.notEqual(sql(action(op,'clock_out',results[0].entryId),'service_role',false).status,0);reset();
  });
  await t.test('different simultaneous clock-in operations cannot open two shifts',async()=>{
   const results=await Promise.allSettled([independent(action()),independent(action())]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(count('ironcrest_attendance_entries'),1);reset();
  });
  await t.test('clock-out replays stay on the old shift and cannot close a later shift',()=>{
   const start=JSON.parse(sql(action()).stdout),op=uuid(),end=JSON.parse(sql(action(op,'clock_out',start.entryId)).stdout);
   const newer=JSON.parse(sql(action()).stdout);assert.notEqual(start.entryId,newer.entryId);
   const replay=JSON.parse(sql(action(op,'clock_out',start.entryId)).stdout);assert.equal(replay.entryId,end.entryId);assert.equal(replay.replayed,true);
   assert.notEqual(sql(action(uuid(),'clock_out',start.entryId),'service_role',false).status,0);
   assert.equal(sql(`SELECT id FROM public.ironcrest_attendance_entries WHERE clock_out_at IS NULL;`).stdout.trim(),newer.entryId);
   assert.equal(count('ironcrest_attendance_audit'),3);reset();
  });
  await t.test('competing clock-outs create one mutation and cannot target another employee',async()=>{
   const start=JSON.parse(sql(action()).stdout);const results=await Promise.allSettled([independent(action(uuid(),'clock_out',start.entryId)),independent(action(uuid(),'clock_out',start.entryId))]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
   assert.equal(count('ironcrest_attendance_audit'),2);assert.notEqual(sql(action(uuid(),'clock_out',start.entryId,FOREIGN),'service_role',false).status,0);reset();
  });
  await t.test('journal failure rolls back the shift and its audit event',()=>{
   sql(`CREATE FUNCTION public.test_journal_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Test journal unavailable';END;$$;CREATE TRIGGER test_journal_failure BEFORE INSERT ON public.ironcrest_attendance_operations FOR EACH ROW EXECUTE FUNCTION public.test_journal_failure();`,null);
   assert.notEqual(sql(action(),'service_role',false).status,0);assert.equal(count('ironcrest_attendance_entries'),0);assert.equal(count('ironcrest_attendance_audit'),0);
   sql('DROP TRIGGER test_journal_failure ON public.ironcrest_attendance_operations;',null);
   const start=JSON.parse(sql(action()).stdout);
   sql('CREATE TRIGGER test_journal_failure BEFORE INSERT ON public.ironcrest_attendance_operations FOR EACH ROW EXECUTE FUNCTION public.test_journal_failure();',null);
   assert.notEqual(sql(action(uuid(),'clock_out',start.entryId),'service_role',false).status,0);
   assert.equal(sql(`SELECT id FROM public.ironcrest_attendance_entries WHERE clock_out_at IS NULL;`).stdout.trim(),start.entryId);assert.equal(count('ironcrest_attendance_audit'),1);
   sql('DROP TRIGGER test_journal_failure ON public.ironcrest_attendance_operations;',null);reset();
  });
  await t.test('replay does not disclose a prior result after membership revocation',()=>{
   const op=uuid();sql(action(op));sql(`UPDATE public.ironcrest_memberships SET active=false WHERE user_id='${EMP}';`,null);
   assert.notEqual(sql(action(op),'service_role',false).status,0);sql(`UPDATE public.ironcrest_memberships SET active=true WHERE user_id='${EMP}';`,null);reset();
  });
  await t.test('multiple active memberships and invalid expected shift deny changes',()=>{
   assert.notEqual(sql(action(uuid(),'clock_out'),'service_role',false).status,0);
   assert.notEqual(sql(action(uuid(),'clock_in',uuid()),'service_role',false).status,0);
   sql(`INSERT INTO public.ironcrest_memberships VALUES('${FOREIGN}','${OTHER}','${EMP}','employee',true);`,null);assert.notEqual(sql(action(),'service_role',false).status,0);
  });
 }finally{if(started)command('pg_ctl',['-D',data,'-m','fast','-w','stop']);}
});
