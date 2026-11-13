import {test} from 'node:test';import assert from 'node:assert/strict';
import {createAttendanceWorkflowRoute,attendanceWorkflowBody} from '../worker/attendance-workflows.mjs';
const USER='11111111-1111-4111-8111-111111111111',ORG='22222222-2222-4222-8222-222222222222',MEM='33333333-3333-4333-8333-333333333333',SITE='44444444-4444-4444-8444-444444444444',OP='55555555-5555-4555-8555-555555555555',ENTRY='66666666-6666-4666-8666-666666666666',OWNER='77777777-7777-4777-8777-777777777777';
const env={SUPABASE_URL:'https://nhiqbcevcdxfzvrprgck.supabase.co',SUPABASE_PUBLISHABLE_KEY:'public-fixture',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_fixture',ENABLE_ATTENDANCE_WORKFLOWS:'true',INVITATION_RATE_LIMITER:{limit:async()=>({success:true})}};
const body=()=>({operationId:OP,worksiteId:SITE,expectedEntryId:null,latitude:33,longitude:-112,accuracyMeters:5,sampleTimestamp:Date.now()});
const req=(payload=body(),path='clock-in',options={})=>new Request('https://worker.example/api/attendance/workflows/'+path,{method:path==='status'?'GET':'POST',headers:{Origin:'https://ironcrest.profitharborai.com',Authorization:'Bearer fixture-session','Content-Type':'application/json'},...(path==='status'?{}:{body:JSON.stringify(payload)}),...options});
function fixture(overrides={},approved=true){
 const data={user:{id:USER,email_confirmed_at:'confirmed'},members:[{id:MEM,organization_id:ORG,role:'employee',active:true}],organizations:[{id:ORG,created_by:OWNER}],owners:[{id:OWNER}],entitlement:[{business_active:true}],assignments:[{worksite_id:SITE,organization_id:ORG,membership_id:MEM,active:true}],sites:[{id:SITE,name:'Assigned site',organization_id:ORG,active:true}],entries:[],result:{entryId:ENTRY,action:'clock_in',operationId:OP,replayed:false,clockInAt:'2026-11-12T14:00:00Z'},...overrides};const calls=[];
 const route=createAttendanceWorkflowRoute({releaseApproved:approved,fetcher:async(url,options)=>{calls.push({url,options});assert.equal(options.redirect,'manual');assert.equal(new URL(url).origin,env.SUPABASE_URL);const u=new URL(url),p=u.pathname,key=p.endsWith('/user')?'user':p.endsWith('/ironcrest_memberships')?(u.searchParams.has('role')?'owners':'members'):p.endsWith('/ironcrest_organizations')?'organizations':p.endsWith('/ironcrest_business_entitlement')?'entitlement':p.endsWith('/ironcrest_employee_worksite_assignments')?'assignments':p.endsWith('/ironcrest_worksites')?'sites':p.endsWith('/ironcrest_attendance_entries')?'entries':p.endsWith('/ironcrest_attendance_workflow')?'result':null;if(!key)throw Error('Unexpected path');if(data.failure===key)throw Error('Private provider details');return new Response(JSON.stringify(data[key]));}});return {route,calls};
}
test('default source gate and environment gate independently deny all provider calls',async()=>{
 const disabled=fixture();assert.equal((await disabled.route(req(),{...env,ENABLE_ATTENDANCE_WORKFLOWS:'false'})).status,403);assert.equal(disabled.calls.length,0);
 const s=fixture({},false);assert.equal((await s.route(req(),env)).status,403);assert.equal(s.calls.length,0);
 assert.equal(await createAttendanceWorkflowRoute()(new Request('https://worker.example/api/attendance/clock-in'),env),null);
});
test('origin, method, query, authentication and project overrides fail before provider calls',async()=>{
 for(const request of [req(body(),'clock-in',{headers:{Origin:'https://evil.example'}}),req(null,'status',{method:'DELETE'}),new Request('https://worker.example/api/attendance/workflows/status?user_id='+OWNER,{headers:{Origin:'https://ironcrest.profitharborai.com'}}),req(body(),'clock-in',{headers:{Origin:'https://ironcrest.profitharborai.com',Authorization:'Basic nope'}})]){const s=fixture();assert.ok((await s.route(request,env)).status>=400);assert.equal(s.calls.length,0);}
 const s=fixture();assert.equal((await s.route(req(),{...env,SUPABASE_URL:'https://other.example'})).status,503);assert.equal(s.calls.length,0);
});
test('verified employee, single membership, active owner and Business required',async()=>{
 for(const data of [{user:null},{user:{id:USER}},{members:[]},{members:[{id:MEM,organization_id:ORG,role:'owner',active:true}]},{members:[{id:MEM,organization_id:ORG,role:'employee',active:false}]},{members:[{id:MEM,organization_id:ORG,role:'employee',active:true},{id:MEM}]},{owners:[]},{entitlement:[{business_active:false}]}]){const s=fixture(data);assert.ok((await s.route(req(),env)).status>=400);assert.ok(!s.calls.some(x=>x.url.endsWith('/ironcrest_attendance_workflow')));}
});
test('rate denial blocks membership, location and mutation calls',async()=>{
 const s=fixture();assert.equal((await s.route(req(),{...env,INVITATION_RATE_LIMITER:{limit:async()=>({success:false})}})).status,429);assert.equal(s.calls.length,1);
});
test('identity overrides, inaccurate/stale input and wrong shift shape never reach mutation',async()=>{
 const invalid=[{user_id:OWNER},{organization_id:ORG},{accuracyMeters:101},{accuracyMeters:-1},{latitude:91},{longitude:181},{sampleTimestamp:Date.now()-31000},{sampleTimestamp:Date.now()+6000},{operationId:'bad'},{expectedEntryId:ENTRY}];
 for(const change of invalid){const s=fixture();assert.equal((await s.route(req({...body(),...change}),env)).status,400);assert.ok(!s.calls.some(x=>x.url.endsWith('/ironcrest_attendance_workflow')));}
 assert.throws(()=>attendanceWorkflowBody({...body(),latitude:NaN},'clock_in'));
 assert.throws(()=>attendanceWorkflowBody({...body(),accuracyMeters:Infinity},'clock_in'));
 assert.throws(()=>attendanceWorkflowBody(body(),'clock_out'));
});
test('wrong content type, malformed and oversized bodies deny before mutation',async()=>{
 for(const request of [req(body(),'clock-in',{headers:{Origin:'https://ironcrest.profitharborai.com',Authorization:'Bearer fixture','Content-Type':'text/plain'}}),req(body(),'clock-in',{body:'{broken'}),req(body(),'clock-in',{body:' '.repeat(2049)})]){const s=fixture();assert.ok((await s.route(request,env)).status>=400);assert.ok(!s.calls.some(x=>x.url.endsWith('/ironcrest_attendance_workflow')));}
});
test('server derives actor, sends one RPC, does not forward session or secret in output',async()=>{
 const s=fixture(),r=await s.route(req(),env),result=await r.json();assert.equal(r.status,200);assert.equal(result.attendanceRecorded,true);
 const mutations=s.calls.filter(x=>x.url.endsWith('/ironcrest_attendance_workflow'));assert.equal(mutations.length,1);const sent=JSON.parse(mutations[0].options.body);assert.equal(sent.p_actor,USER);assert.equal(sent.p_operation_id,OP);assert.equal(sent.p_expected_entry_id,null);assert.ok(!Object.hasOwn(sent,'p_organization_id'));
 assert.equal(mutations[0].options.headers.Authorization,undefined);assert.equal(s.calls[0].options.headers.Authorization,'Bearer fixture-session');assert.ok(!JSON.stringify(result).includes('sb_secret'));assert.equal(r.headers.get('Cache-Control'),'no-store');
});
test('clock-out requires and preserves the exact entry identity',async()=>{
 const s=fixture({result:{entryId:ENTRY,action:'clock_out',operationId:OP,replayed:false,clockOutAt:'2026-11-12T14:00:00Z'}});const r=await s.route(req({...body(),expectedEntryId:ENTRY},'clock-out'),env);assert.equal(r.status,200);assert.equal(JSON.parse(s.calls.at(-1).options.body).p_expected_entry_id,ENTRY);
});
test('uncertain provider response is not retried or reported as definitely unwritten',async()=>{
 for(const data of [{failure:'result'},{result:null},{result:{entryId:ENTRY,action:'clock_in',operationId:OWNER,replayed:false,clockInAt:'2026-11-12T14:00:00Z'}}]){const s=fixture(data),r=await s.route(req(),env),answer=await r.json();assert.equal(r.status,409);assert.equal(answer.attendanceRecorded,null);assert.equal(answer.operationId,OP);assert.equal(s.calls.filter(x=>x.url.endsWith('/ironcrest_attendance_workflow')).length,1);assert.ok(!JSON.stringify(answer).includes('Private provider'));}
});
test('read-only current shift scopes both employee and organization and strips extra fields',async()=>{
 const s=fixture({entries:[{id:ENTRY,organization_id:ORG,employee_user_id:USER,worksite_id:SITE,clock_in_at:'2026-11-12T14:00:00Z',private:'hidden'}]}),r=await s.route(req(null,'status'),env),answer=await r.json();assert.equal(r.status,200);assert.equal(answer.openShift.entryId,ENTRY);assert.equal(answer.openShift.private,undefined);
 const u=new URL(s.calls.find(x=>new URL(x.url).pathname.endsWith('/ironcrest_attendance_entries')).url);assert.equal(u.searchParams.get('organization_id'),'eq.'+ORG);assert.equal(u.searchParams.get('employee_user_id'),'eq.'+USER);assert.equal(u.searchParams.get('clock_out_at'),'is.null');assert.ok(!s.calls.some(x=>x.url.endsWith('/ironcrest_attendance_workflow')));
});
test('foreign, ambiguous and malformed open shifts fail closed',async()=>{
 for(const entries of [[{id:ENTRY,organization_id:ORG,employee_user_id:OWNER,worksite_id:SITE,clock_in_at:'2026-11-12'}],[{},{}],[{id:ENTRY,organization_id:ORG,employee_user_id:USER,worksite_id:null,clock_in_at:'invalid'}]]){const s=fixture({entries});assert.equal((await s.route(req(null,'status'),env)).status,503);}
});
test('only active assigned worksites are returned, with no coordinate or assignment leakage',async()=>{
 const s=fixture(),r=await s.route(req(null,'status'),env),data=await r.json();assert.deepEqual(data.worksites,[{id:SITE,name:'Assigned site'}]);
 for(const bad of [{assignments:[{worksite_id:SITE,organization_id:OWNER,membership_id:MEM,active:true}]},{assignments:Array(101).fill({worksite_id:SITE,organization_id:ORG,membership_id:MEM,active:true})},{sites:[{id:OWNER,name:'Foreign',organization_id:ORG,active:true}]},{sites:[{id:SITE,name:'Inactive',organization_id:ORG,active:false}]}]){const f=fixture(bad);assert.equal((await f.route(req(null,'status'),env)).status,503);}
 const none=fixture({assignments:[]});assert.deepEqual((await (await none.route(req(null,'status'),env)).json()).worksites,[]);assert.ok(!none.calls.some(c=>new URL(c.url).pathname.endsWith('/ironcrest_worksites')));
});
