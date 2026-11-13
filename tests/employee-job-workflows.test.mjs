import {test} from 'node:test';import assert from 'node:assert/strict';import {createEmployeeJobWorkflowRoute,jobTransitionBody} from '../worker/employee-job-workflows.mjs';
const USER='11111111-1111-4111-8111-111111111111',ORG='22222222-2222-4222-8222-222222222222',MEM='33333333-3333-4333-8333-333333333333',JOB='44444444-4444-4444-8444-444444444444',OWNER='55555555-5555-4555-8555-555555555555';
const env={ENABLE_EMPLOYEE_JOB_WORKFLOWS:'true',IRONCREST_EMPLOYEE_JOB_UPDATES:'enabled',SUPABASE_URL:'https://nhiqbcevcdxfzvrprgck.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_fixture',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture',INVITATION_RATE_LIMITER:{limit:async()=>({success:true})}};
const body={jobId:JOB,action:'start',expectedUpdatedAt:'2026-11-12T12:00:00.000123+00:00'};
const req=(path='/api/employee/jobs',data,query='')=>new Request('https://worker.invalid'+path+query,{method:data?'POST':'GET',headers:{Origin:'https://ironcrest.profitharborai.com',Authorization:'Bearer fixture',...(data?{'Content-Type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})});
function fixture(change={}){
 const data={user:{id:USER,email_confirmed_at:'verified'},members:[{id:MEM,organization_id:ORG,role:'employee',active:true}],organizations:[{id:ORG,created_by:OWNER}],owners:[{id:OWNER}],entitlement:[{business_active:true}],jobs:[{id:JOB,organization_id:ORG,assigned_membership_id:MEM,title:'Fixture',status:'pending',updated_at:body.expectedUpdatedAt}],result:{jobId:JOB,status:'in_progress',eventId:MEM},...change};const calls=[];
 const route=createEmployeeJobWorkflowRoute({fetcher:async(url,options)=>{calls.push({url,options});assert.equal(options.redirect,'manual');assert.equal(new URL(url).origin,env.SUPABASE_URL);const u=new URL(url),p=u.pathname;const key=p.endsWith('/user')?'user':p.endsWith('/ironcrest_memberships')?(u.searchParams.has('role')?'owners':'members'):p.endsWith('/ironcrest_organizations')?'organizations':p.endsWith('/ironcrest_business_entitlement')?'entitlement':p.endsWith('/ironcrest_jobs')?'jobs':p.endsWith('/ironcrest_employee_job_workflow')?'result':null;if(!key)throw Error('Unexpected path');if(data.failure===key)throw Error('private backend details');return new Response(JSON.stringify(data[key]));}});return {route,calls};
}
test('closed release preserves the existing handler and never calls providers',async()=>{const s=fixture();assert.equal(await s.route(req(),{...env,ENABLE_EMPLOYEE_JOB_WORKFLOWS:'false'}),null);assert.equal(s.calls.length,0);});
test('employee reads only bounded assigned rows and omits company/member identifiers',async()=>{
 const s=fixture(),response=await s.route(req(),env),data=await response.json();assert.equal(response.status,200);assert.equal(data.assignedOnly,true);assert.equal(data.jobCount,1);assert.doesNotMatch(JSON.stringify(data),/organization_id|assigned_membership_id|secret_fixture/);
 const q=new URL(s.calls.find(c=>c.url.includes('/ironcrest_jobs?')).url).searchParams;assert.equal(q.get('organization_id'),'eq.'+ORG);assert.equal(q.get('assigned_membership_id'),'eq.'+MEM);assert.equal(q.get('limit'),'101');
});
test('inactive, ambiguous, unverified and unpaid memberships cannot reach jobs or mutations',async()=>{
 for(const change of [{user:null},{members:[]},{members:[{id:MEM,organization_id:ORG,role:'employee',active:false}]},{members:[{id:MEM,organization_id:ORG,role:'employee',active:true},{id:MEM,organization_id:ORG,role:'employee',active:true}]},{owners:[]},{entitlement:[{business_active:false}]}]){const s=fixture(change);assert.notEqual((await s.route(req('/api/employee/jobs/transition',body),env)).status,200);assert.ok(!s.calls.some(c=>c.url.endsWith('ironcrest_employee_job_workflow')));}
});
test('transition derives actor and uses only atomic workflow RPC with exact timestamp',async()=>{
 const s=fixture(),response=await s.route(req('/api/employee/jobs/transition',body),env);assert.equal(response.status,200);const mutation=s.calls.find(c=>c.url.endsWith('/ironcrest_employee_job_workflow'));assert.deepEqual(JSON.parse(mutation.options.body),{p_actor:USER,p_job_id:JOB,p_expected_updated_at:body.expectedUpdatedAt,p_action:'start'});assert.ok(s.calls.every(c=>!c.url.includes('attendance')&&!c.url.includes('resend')));
 for(const c of s.calls.filter(c=>!c.url.endsWith('/user')))assert.equal(c.options.headers.Authorization,undefined);
});
test('identity overrides and unsupported transitions cannot reach RPC',async()=>{
 for(const value of [{...body,organization_id:ORG},{...body,membershipId:MEM},{...body,action:'assign'},{...body,expectedUpdatedAt:'now'},{...body,jobId:'invalid'}]){
  assert.throws(()=>jobTransitionBody(value));const s=fixture();assert.equal((await s.route(req('/api/employee/jobs/transition',value),env)).status,400);assert.ok(!s.calls.some(c=>c.url.endsWith('ironcrest_employee_job_workflow')));
 }
});
test('uncertain RPC response never retries and cannot claim success',async()=>{
 for(const change of [{failure:'result'},{result:{jobId:JOB,status:'completed',eventId:MEM}},{result:{jobId:MEM,status:'in_progress',eventId:MEM}}]){const s=fixture(change),response=await s.route(req('/api/employee/jobs/transition',body),env),data=await response.json();assert.equal(response.status,409);assert.equal(data.jobUpdated,null);assert.equal(s.calls.filter(c=>c.url.endsWith('ironcrest_employee_job_workflow')).length,1);assert.doesNotMatch(JSON.stringify(data),/private backend/);}
});
test('Business gate covers existing owner job paths without enabling or replacing their writes',async()=>{
 const change={members:[{id:MEM,organization_id:ORG,role:'owner',active:true}],organizations:[{id:ORG,created_by:USER}]};
 const s=fixture(change);assert.equal(await s.route(req('/api/jobs'),env),null);assert.ok(!s.calls.some(c=>c.url.includes('/ironcrest_jobs?')));
 const unpaid=fixture({...change,entitlement:[{business_active:false}]});assert.equal((await unpaid.route(req('/api/jobs',{title:'Fixture'}),env)).status,403);
});
test('foreign origins, scope queries, missing auth, wrong project and rate limits fail closed',async()=>{
 const s=fixture();assert.equal((await s.route(new Request(req().url,{headers:{Origin:'https://foreign.invalid'}}),env)).status,403);assert.equal((await s.route(req('/api/employee/jobs',undefined,'?organization_id='+ORG),env)).status,400);assert.equal((await s.route(req(),{...env,SUPABASE_URL:'https://foreign.invalid'})).status,503);assert.equal(s.calls.length,0);
 const limited=fixture();assert.equal((await limited.route(req(),{...env,INVITATION_RATE_LIMITER:{limit:async()=>({success:false})}})).status,429);assert.equal(limited.calls.length,1);
});
test('foreign provider rows fail closed and oversized list exposes truncation',async()=>{
 const foreign=fixture({jobs:[{id:JOB,organization_id:USER,assigned_membership_id:MEM}]});assert.equal((await foreign.route(req(),env)).status,503);
 const rows=Array.from({length:101},()=>({id:JOB,organization_id:ORG,assigned_membership_id:MEM})),s=fixture({jobs:rows}),result=await (await s.route(req(),env)).json();assert.equal(result.jobs.length,100);assert.equal(result.truncated,true);
});
