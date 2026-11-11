import {test} from 'node:test';import assert from 'node:assert/strict';import {createAttendanceRecordsRoute,reportWindow} from '../worker/attendance-records.mjs';
const USER='11111111-1111-4111-8111-111111111111',ORG='22222222-2222-4222-8222-222222222222';
const env={INVITATION_RATE_LIMITER:{limit:async()=>({success:true})},ENABLE_ATTENDANCE_REPORTS_READONLY:'true',SUPABASE_URL:'https://nhiqbcevcdxfzvrprgck.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_fixture',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture'};
const request=(options={})=>new Request('https://example.invalid/api/attendance/records?start=2026-11-01&end=2026-11-07', {headers:{Origin:'https://ironcrest.profitharborai.com',Authorization:'Bearer user-token'},...options});
function fixture(changes={}){const calls=[];const data={user:{id:USER,email_confirmed_at:'confirmed'},memberships:[{organization_id:ORG}],organizations:[{id:ORG}],entitlement:[{business_active:true}],entries:[],exceptions:[],...changes};
 const fetcher=async(url,options)=>{calls.push({url,options});const u=new URL(url);let body;
  if(u.pathname==='/auth/v1/user')body=data.user;
  else if(u.pathname.endsWith('/ironcrest_memberships'))body=u.searchParams.get('select')==='organization_id'?data.memberships:[];
  else if(u.pathname.endsWith('/ironcrest_organizations'))body=data.organizations;
  else if(u.pathname.endsWith('/ironcrest_business_entitlement'))body=data.entitlement;
  else if(u.pathname.endsWith('/ironcrest_attendance_entries'))body=data.entries;
  else if(u.pathname.endsWith('/ironcrest_attendance_exceptions'))body=data.exceptions;
  else if(u.pathname.endsWith('/ironcrest_worksites'))body=[];
  else throw Error('Unexpected endpoint');
  return new Response(JSON.stringify(body),{status:200});};return {calls,route:createAttendanceRecordsRoute({fetcher})};}
test('date windows reject rollover, reverse, duplicate and excessive ranges',async()=>{
 assert.equal(reportWindow('2026-11-01','2026-11-01').end,'2026-11-02T00:00:00.000Z');
 for(const [a,b] of [['2026-02-30','2026-03-01'],['2026-11-02','2026-11-01'],['2026-10-01','2026-11-01']])assert.throws(()=>reportWindow(a,b));
 const s=fixture();const response=await s.route(new Request(request().url+'&organization_id=foreign',{headers:request().headers}),env);assert.equal(response.status,400);assert.equal(s.calls.length,0);
});
test('closed release flag, foreign origin and write method make no provider calls',async()=>{
 const s=fixture();assert.equal((await s.route(request(),{...env,ENABLE_ATTENDANCE_REPORTS_READONLY:'false'})).status,503);
 assert.equal((await s.route(request({method:'POST'}),env)).status,405);
 assert.equal((await s.route(request({headers:{Origin:'https://evil.invalid'}}),env)).status,403);assert.equal(s.calls.length,0);
});
test('unconfirmed, ambiguous membership and unpaid Business accounts cannot read attendance',async()=>{
 for(const changes of [{user:{id:USER}},{memberships:[]},{memberships:[{organization_id:ORG},{organization_id:ORG}]},{organizations:[]},{entitlement:[{business_active:false}]}]){
  const s=fixture(changes);assert.notEqual((await s.route(request(),env)).status,200);assert.equal(s.calls.filter(c=>c.url.includes('ironcrest_attendance_')).length,0);
 }
});
test('server resolves org and scopes every attendance read; credentials remain separated',async()=>{
 const s=fixture();const response=await s.route(request(),env);assert.equal(response.status,200);const payload=await response.json();assert.equal(payload.readOnly,true);
 for(const c of s.calls){if(c.url.includes('/auth/v1/user')){assert.equal(c.options.headers.Authorization,'Bearer user-token');assert.equal(c.options.headers.apikey,'sb_publishable_fixture');}else{assert.equal(c.options.headers.apikey,'sb_secret_fixture');assert.equal(c.options.headers.Authorization,undefined);}}
 const reads=s.calls.filter(c=>c.url.includes('ironcrest_attendance_'));assert.equal(reads.length,2);for(const c of reads){assert.equal(c.options.method,'GET');assert.equal(new URL(c.url).searchParams.get('organization_id'),'eq.'+ORG);}
 const posts=s.calls.filter(c=>c.options.method==='POST');assert.equal(posts.length,1);assert.ok(posts[0].url.endsWith('/rpc/ironcrest_business_entitlement'));
 assert.equal(response.headers.get('Cache-Control'),'no-store');assert.doesNotMatch(JSON.stringify(payload),/secret_fixture|user-token/);
});
test('limits are explicit and payload projection omits location, free text and audit data',async()=>{
 const rows=Array.from({length:201},()=>({id:'fixture',employee_user_id:USER,clock_in_at:'2026-11-01T08:00:00Z',details:{gps:'private'},reason:'private note',latitude:33}));
 const s=fixture({entries:rows});const body=await (await s.route(request(),env)).json();assert.equal(body.entries.length,200);assert.equal(body.entriesTruncated,true);assert.doesNotMatch(JSON.stringify(body),/private note|latitude|gps/);
});
test('unknown route is left to existing Worker; bad configuration never sends keys elsewhere',async()=>{
 const s=fixture();assert.equal(await s.route(new Request('https://example.invalid/api/other'),env),null);
 assert.equal((await s.route(request(),{...env,SUPABASE_URL:'https://evil.invalid'})).status,503);assert.equal(s.calls.length,0);
});

test('employee route derives identity and scopes entries, exceptions and names to self',async()=>{
 const s=fixture({entries:[{id:'entry',employee_user_id:USER,worksite_id:ORG,clock_in_at:'2026-11-01T08:00:00Z',clock_out_at:null}]});
 const req=new Request(request().url.replace('/records?','/my-records?'),{headers:request().headers});const response=await s.route(req,env);assert.equal(response.status,200);assert.equal((await response.json()).selfScoped,true);
 for(const c of s.calls.filter(c=>c.url.includes('ironcrest_attendance_'))){assert.equal(new URL(c.url).searchParams.get('employee_user_id'),'eq.'+USER);assert.equal(new URL(c.url).searchParams.get('organization_id'),'eq.'+ORG);}
 for(const c of s.calls.filter(c=>c.url.includes('ironcrest_memberships'))){const u=new URL(c.url);assert.equal(u.searchParams.get('role'),'eq.employee');assert.equal(u.searchParams.get('user_id'),'eq.'+USER);}
 const sites=s.calls.find(c=>c.url.includes('ironcrest_worksites'));assert.equal(new URL(sites.url).searchParams.get('id'),'in.('+ORG+')');
});
test('employee cannot override identity or receive a foreign provider row',async()=>{
 const req=new Request(request().url.replace('/records?','/my-records?'),{headers:request().headers});
 const s=fixture();assert.equal((await s.route(new Request(req.url+'&employee_user_id='+ORG,{headers:req.headers}),env)).status,400);assert.equal(s.calls.length,0);
 const foreign=fixture({entries:[{id:'foreign',employee_user_id:ORG}]});assert.equal((await foreign.route(req,env)).status,503);
});

test('expired provider authentication returns 401 and never reads company data',async()=>{
 const calls=[];const route=createAttendanceRecordsRoute({fetcher:async(url)=>{calls.push(url);return new Response('{}',{status:401});}});
 assert.equal((await route(request(),env)).status,401);assert.equal(calls.length,1);assert.ok(calls[0].endsWith('/auth/v1/user'));
});

test('existing rate limiter stops repeated reporting before privileged reads',async()=>{
 const s=fixture();const response=await s.route(request(),{...env,INVITATION_RATE_LIMITER:{limit:async()=>({success:false})}});assert.equal(response.status,429);assert.equal(s.calls.length,1);
});
