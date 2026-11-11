import {test} from 'node:test';import assert from 'node:assert/strict';import {createSchedulingRoute,validateScheduleAction} from '../worker/scheduling.mjs';
const USER='11111111-1111-4111-8111-111111111111',ORG='22222222-2222-4222-8222-222222222222',SITE='33333333-3333-4333-8333-333333333333';
const env={ENABLE_SCHEDULING:'true',SUPABASE_URL:'https://nhiqbcevcdxfzvrprgck.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_fixture',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture',INVITATION_RATE_LIMITER:{limit:async()=>({success:true})}};
const draft={action:'save_draft',id:null,revision:0,employeeId:USER,worksiteId:SITE,title:'Fixture crew',start:'2035-01-01T15:00:00.000Z',end:'2035-01-01T23:00:00.000Z',timeZone:'America/Phoenix'};
const request=(path='scheduling/context',body)=>new Request('https://worker.invalid/api/'+path,{method:body?'POST':'GET',headers:{Origin:'https://ironcrest.profitharborai.com',Authorization:'Bearer caller-fixture',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
const range='?start=2035-01-01T00%3A00%3A00.000Z&end=2035-01-08T00%3A00%3A00.000Z';
function fixture(overrides={}){
 const data={user:{id:USER,email_confirmed_at:'confirmed'},memberships:[{organization_id:ORG}],organizations:[{id:ORG}],entitlement:[{business_active:true}],preferences:[{time_zone:'America/Phoenix',week_starts_on:0}],members:[{id:ORG,user_id:USER}],profiles:[{membership_id:ORG,first_name:'Fixture',last_name:'Employee'}],sites:[{id:SITE,name:'Fixture site',latitude:'private'}],shifts:[],result:{ok:true,shift:{id:ORG,employee_user_id:USER,worksite_id:SITE,title:'Fixture crew',status:'draft',revision:1,organization_id:ORG,updated_by:USER}},...overrides},calls=[];
 const route=createSchedulingRoute({fetcher:async(url,options)=>{
  calls.push({url,options});assert.equal(options.redirect,'manual');const u=new URL(url),path=u.pathname;
  const key=path.endsWith('/user')?'user':path.endsWith('ironcrest_memberships')?(u.searchParams.get('select')==='organization_id'?'memberships':'members'):path.endsWith('ironcrest_organizations')?'organizations':path.endsWith('ironcrest_business_entitlement')?'entitlement':path.endsWith('ironcrest_company_settings')?'preferences':path.endsWith('ironcrest_employee_profiles')?'profiles':path.endsWith('ironcrest_worksites')?'sites':path.endsWith('ironcrest_scheduled_shifts')?'shifts':path.endsWith('ironcrest_schedule_action')?'result':null;
  if(!key)throw Error('Unexpected provider');return new Response(JSON.stringify(data[key]));
 }});return {calls,route};
}
test('schedule body validation prevents identity overrides and malformed or excessive shifts',()=>{
 assert.equal(validateScheduleAction(draft).action,'save_draft');
 for(const value of [{...draft,organization_id:ORG},{...draft,revision:1},{...draft,start:'2035-02-30T15:00:00.000Z'},{...draft,end:'2035-01-03T23:00:00.000Z'},{...draft,title:'x\ny'},{action:'publish',id:ORG,revision:1,employeeId:USER},{action:'cancel',id:ORG,revision:0}])assert.throws(()=>validateScheduleAction(value));
});
test('closed gate and employee writes reject without contacting the provider',async()=>{
 const s=fixture();assert.equal((await s.route(request(),{...env,ENABLE_SCHEDULING:'false'})).status,503);
 assert.equal((await s.route(request('my-schedule/action',{action:'publish',id:ORG,revision:1}),env)).status,405);assert.equal(s.calls.length,0);
});
test('owner context exposes only bounded names and planning preferences',async()=>{
 const s=fixture(),response=await s.route(request(),env),body=await response.json();assert.equal(response.status,200);assert.equal(body.timeZone,'America/Phoenix');assert.equal(body.weekStartsOn,0);assert.equal(body.employees[0].name,'Fixture Employee');assert.doesNotMatch(JSON.stringify(body),/latitude|private|secret_fixture|caller-fixture/);
 for(const call of s.calls.filter(c=>/ironcrest_(memberships|worksites|employee_profiles)/.test(c.url))){const u=new URL(call.url);assert.equal(u.searchParams.get('organization_id')||'eq.'+ORG,'eq.'+ORG);}
});
test('employee context never retrieves colleagues or broad worksite lists',async()=>{
 const s=fixture(),body=await (await s.route(request('my-schedule/context'),env)).json();assert.equal(body.selfScoped,true);assert.deepEqual(body.employees,[]);assert.deepEqual(body.worksites,[]);
 assert.equal(s.calls.some(c=>c.url.includes('employee_profiles')||c.url.includes('worksites')),false);
 const membership=s.calls.find(c=>c.url.includes('ironcrest_memberships'));assert.equal(new URL(membership.url).searchParams.get('role'),'eq.employee');
});
test('employee shift query is self scoped, excludes drafts, and rejects foreign rows',async()=>{
 const row={id:ORG,employee_user_id:USER,worksite_id:SITE,title:'Fixture',status:'published',published_at:'2034-12-01T00:00:00Z',revision:2,latitude:'private'};
 const s=fixture({shifts:[row]}),response=await s.route(request('my-schedule/shifts'+range),env);assert.equal(response.status,200);assert.doesNotMatch(await response.text(),/private/);
 const q=new URL(s.calls.find(c=>c.url.includes('ironcrest_scheduled_shifts')).url).searchParams;assert.equal(q.get('organization_id'),'eq.'+ORG);assert.equal(q.get('employee_user_id'),'eq.'+USER);assert.equal(q.get('published_at'),'not.is.null');assert.equal(q.get('status'),'in.(published,cancelled)');
 for(const overrides of [{employee_user_id:ORG},{status:'draft'},{published_at:null}]){const bad=fixture({shifts:[{...row,...overrides}]});assert.equal((await bad.route(request('my-schedule/shifts'+range),env)).status,503);}
});
test('owner actions derive identity and organization and use only the schedule RPC',async()=>{
 const s=fixture(),response=await s.route(request('scheduling/action',draft),env);assert.equal(response.status,200);assert.doesNotMatch(await response.text(),/updated_by|organization_id|secret_fixture/);
 const action=s.calls.find(c=>c.url.endsWith('/ironcrest_schedule_action')),payload=JSON.parse(action.options.body);assert.equal(payload.p_actor,USER);assert.equal(payload.p_organization_id,ORG);assert.equal(payload.p_employee,USER);assert.equal(payload.p_expected_revision,0);
 for(const c of s.calls){assert.equal(new URL(c.url).origin,env.SUPABASE_URL);if(!c.url.endsWith('/user')){assert.equal(c.options.headers.apikey,'sb_secret_fixture');assert.equal(c.options.headers.Authorization,undefined);}}
 assert.ok(s.calls.every(c=>!c.url.includes('attendance')));
});
test('unconfirmed, ambiguous, foreign owner and unpaid memberships cannot read or write schedules',async()=>{
 for(const change of [{user:null},{user:{id:USER}},{memberships:[]},{memberships:[{organization_id:ORG},{organization_id:ORG}]},{organizations:[]},{entitlement:[{business_active:false}]}]){
  const s=fixture(change);assert.notEqual((await s.route(request('scheduling/action',draft),env)).status,200);assert.equal(s.calls.some(c=>c.url.endsWith('ironcrest_schedule_action')),false);
 }
});
test('shift list caps and discloses truncation; arbitrary scope and duplicate date parameters are rejected',async()=>{
 const s=fixture({shifts:Array.from({length:201},()=>({id:ORG,worksite_id:SITE}))});const body=await (await s.route(request('scheduling/shifts'+range),env)).json();assert.equal(body.shifts.length,200);assert.equal(body.truncated,true);
 for(const suffix of ['&organization_id='+ORG,'&start=2035-01-01T00%3A00%3A00.000Z']){const bad=fixture();assert.equal((await bad.route(request('scheduling/shifts'+range+suffix),env)).status,400);assert.equal(bad.calls.length,0);}
});
test('publication conflict, provider redirect, and rate limit fail closed',async()=>{
 const conflict=fixture({result:{ok:false,error:'employee_schedule_overlap'}});assert.equal((await conflict.route(request('scheduling/action',{action:'publish',id:ORG,revision:1}),env)).status,409);
 let count=0;const redirect=createSchedulingRoute({fetcher:async()=>{count++;return new Response(null,{status:302,headers:{Location:'https://foreign.invalid'}});}});assert.equal((await redirect(request(),env)).status,503);assert.equal(count,1);
 const limited=fixture();assert.equal((await limited.route(request(),{...env,INVITATION_RATE_LIMITER:{limit:async()=>({success:false})}})).status,429);assert.equal(limited.calls.length,1);
});
