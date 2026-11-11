import {test} from 'node:test';import assert from 'node:assert/strict';
import {createCompanySettingsRoute,validateCompanySettings} from '../worker/company-settings.mjs';
const USER='11111111-1111-4111-8111-111111111111',ORG='22222222-2222-4222-8222-222222222222';
const env={SUPABASE_URL:'https://nhiqbcevcdxfzvrprgck.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_fixture',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture',INVITATION_RATE_LIMITER:{limit:async()=>({success:true})}};
const input={name:' Example Company ',timeZone:'America/Phoenix',weekStartsOn:1,revision:0};
const request=(method='GET',body=input)=>new Request('https://worker.invalid/api/company/settings',{method,headers:{Origin:'https://ironcrest.profitharborai.com',Authorization:'Bearer user-fixture',...(method==='PUT'?{'Content-Type':'application/json'}:{})},...(method==='PUT'?{body:JSON.stringify(body)}:{})});
function fixture(overrides={}){
 const data={user:{id:USER,email_confirmed_at:'confirmed'},memberships:[{organization_id:ORG}],organizations:[{id:ORG,name:'Example Company'}],entitlement:[{business_active:true}],settings:[],result:{ok:true,settings:{...input,name:'Example Company',revision:1,updatedAt:'2026-11-11T00:00:00Z'}},...overrides},calls=[];
 const route=createCompanySettingsRoute({fetcher:async(url,options)=>{
  calls.push({url,options});const path=new URL(url).pathname;
  const resource=path==='/auth/v1/user'?'user':path.endsWith('ironcrest_memberships')?'memberships':path.endsWith('ironcrest_organizations')?'organizations':path.endsWith('ironcrest_business_entitlement')?'entitlement':path.endsWith('ironcrest_save_company_settings')?'result':path.endsWith('ironcrest_company_settings')?'settings':null;
  if(!resource)throw Error('Unexpected provider call');assert.equal(options.redirect,'manual');return new Response(JSON.stringify(data[resource]));
 }});return {route,calls};
}
test('settings reject invalid names, time zones, revision, day and foreign identity fields',()=>{
 assert.equal(validateCompanySettings(input).name,'Example Company');
 for(const value of [{...input,name:' '},{...input,name:'x\nname'},{...input,timeZone:'Mars/Olympus'},{...input,weekStartsOn:7},{...input,revision:-1},{...input,revision:0.5},{...input,organization_id:ORG}])assert.throws(()=>validateCompanySettings(value));
});
test('settings defaults load without creating any row, scoped to the verified owner',async()=>{
 const s=fixture(),response=await s.route(request(),env),data=await response.json();assert.equal(response.status,200);assert.equal(data.settings.timeZone,'UTC');assert.equal(data.settings.weekStartsOn,1);assert.equal(data.settings.revision,0);
 const reads=s.calls.filter(c=>c.url.includes('ironcrest_company_settings'));assert.equal(reads.length,1);assert.equal(new URL(reads[0].url).searchParams.get('organization_id'),'eq.'+ORG);
 assert.deepEqual(s.calls.filter(c=>c.options.method==='POST').map(c=>new URL(c.url).pathname),['/rest/v1/rpc/ironcrest_business_entitlement']);
 assert.equal(response.headers.get('Cache-Control'),'no-store');assert.doesNotMatch(JSON.stringify(data),/secret_fixture|user-fixture/);
});
test('save uses only atomic settings RPC with server-derived actor and organization',async()=>{
 const s=fixture(),response=await s.route(request('PUT'),env);assert.equal(response.status,200);
 const call=s.calls.find(c=>c.url.endsWith('ironcrest_save_company_settings'));assert.deepEqual(JSON.parse(call.options.body),{p_actor:USER,p_organization_id:ORG,p_name:'Example Company',p_time_zone:'America/Phoenix',p_week_starts_on:1,p_expected_revision:0});
 for(const c of s.calls){assert.equal(new URL(c.url).origin,env.SUPABASE_URL);if(c.url.endsWith('/user'))assert.equal(c.options.headers.Authorization,'Bearer user-fixture');else{assert.equal(c.options.headers.apikey,'sb_secret_fixture');assert.equal(c.options.headers.Authorization,undefined);}}
 assert.ok(s.calls.every(c=>!c.url.includes('attendance')));
});
test('unverified users, employees, ambiguous owners and inactive Business cannot read or save settings',async()=>{
 for(const change of [{user:null},{user:{id:USER}},{memberships:[]},{memberships:[{organization_id:ORG},{organization_id:ORG}]},{organizations:[]},{entitlement:[{business_active:false}]}])for(const method of ['GET','PUT']){
  const s=fixture(change);assert.notEqual((await s.route(request(method),env)).status,200);assert.equal(s.calls.some(c=>/ironcrest_(company_settings|save_company_settings)/.test(c.url)),false);
 }
});
test('foreign origin, query identity override, invalid body and closed configuration make no provider calls',async()=>{
 const s=fixture();const req=request();assert.equal((await s.route(new Request(req.url,{headers:{Origin:'https://foreign.invalid'}}),env)).status,403);
 assert.equal((await s.route(new Request(req.url+'?organization_id='+ORG,{headers:req.headers}),env)).status,400);
 assert.equal((await s.route(request('PUT',{...input,revision:null}),env)).status,400);
 assert.equal((await s.route(req,{...env,SUPABASE_URL:'https://foreign.invalid'})).status,503);assert.equal(s.calls.length,0);
});
test('conflicting revisions return409 and restricted RPC failures are not reported as success',async()=>{
 for(const [error,status] of [['settings_conflict',409],['owner_required',403],['business_access_required',403],['invalid_settings',400],['unexpected',503]]){
  const s=fixture({result:{ok:false,error}});assert.equal((await s.route(request('PUT'),env)).status,status);
 }
});
test('settings fail closed on provider redirects, expired auth and rate limiting',async()=>{
 let count=0;const route=createCompanySettingsRoute({fetcher:async()=>{count++;return new Response(null,{status:302,headers:{Location:'https://foreign.invalid'}});}});
 assert.equal((await route(request(),env)).status,503);assert.equal(count,1);
 const expired=createCompanySettingsRoute({fetcher:async()=>new Response('{}',{status:401})});assert.equal((await expired(request(),env)).status,401);
 const s=fixture();assert.equal((await s.route(request('PUT'),{...env,INVITATION_RATE_LIMITER:{limit:async()=>({success:false})}})).status,429);assert.equal(s.calls.length,1);
});
