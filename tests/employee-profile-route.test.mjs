import {test} from 'node:test';import assert from 'node:assert/strict';import {createEmployeeProfilesRoute,validateEmployeeProfile} from '../worker/employee-profiles.mjs';
const USER='11111111-1111-4111-8111-111111111111',ORG='22222222-2222-4222-8222-222222222222',MEMBER='33333333-3333-4333-8333-333333333333';
const env={ENABLE_EMPLOYEE_PROFILES:'true',SUPABASE_URL:'https://nhiqbcevcdxfzvrprgck.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_fixture',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture',INVITATION_RATE_LIMITER:{limit:async()=>({success:true})}};
const contact={revision:1,phoneNumber:'+1 (555) 010-1234',email:'contact@example.invalid'};
const owner={...contact,membershipId:MEMBER,firstName:'Jordan',lastName:'Example',jobTitle:'Crew lead',employmentStatus:'active'};
const profile={firstName:'Jordan',lastName:'Example',jobTitle:'Crew lead',employmentStatus:'active',phoneNumber:contact.phoneNumber,email:contact.email,revision:2};
const request=(self=true,body)=>new Request('https://worker.invalid/api/'+(self?'employee':'employees')+'/profile',{method:body?'PATCH':'GET',headers:{Origin:'https://ironcrest.profitharborai.com',Authorization:'Bearer caller-fixture',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
function fixture(overrides={}){
 const data={user:{id:USER,email_confirmed_at:'confirmed'},memberships:[{id:MEMBER,organization_id:ORG}],organizations:[{id:ORG}],entitlement:[{business_active:true}],profiles:[{first_name:'Jordan',last_name:'Example',job_title:'Crew lead',employment_status:'active',phone_number:contact.phoneNumber,email:contact.email,revision:1,private_note:'omit'}],result:{ok:true,revision:2,profile},...overrides},calls=[];
 const route=createEmployeeProfilesRoute({fetcher:async(url,options)=>{calls.push({url,options});assert.equal(options.redirect,'manual');const path=new URL(url).pathname;
  const key=path.endsWith('/user')?'user':path.endsWith('ironcrest_memberships')?'memberships':path.endsWith('ironcrest_organizations')?'organizations':path.endsWith('ironcrest_business_entitlement')?'entitlement':path.endsWith('ironcrest_employee_profiles')?'profiles':path.endsWith('ironcrest_update_employee_profile')?'result':null;if(!key)throw Error('Unexpected provider');return new Response(JSON.stringify(data[key]));
 }});return {route,calls};
}
test('employee contact input cannot edit names, title, employment, membership or organization',()=>{
 assert.deepEqual(validateEmployeeProfile(contact,true).changes,{phoneNumber:contact.phoneNumber,email:contact.email});
 for(const field of ['firstName','jobTitle','employmentStatus','membershipId','organizationId','active'])assert.throws(()=>validateEmployeeProfile({...contact,[field]:'foreign'},true));
 for(const value of [{...contact,revision:-1},{...contact,phoneNumber:'abc123'},{...contact,email:'not-an-email'},{...contact,email:'a@b.invalid\nsecret'}])assert.throws(()=>validateEmployeeProfile(value,true));
 assert.equal(validateEmployeeProfile(owner,false).membershipId,MEMBER);
});
test('new employee endpoint is closed until release; owner legacy route is not intercepted before release',async()=>{
 const s=fixture();assert.equal((await s.route(request(),{...env,ENABLE_EMPLOYEE_PROFILES:'false'})).status,503);assert.equal(await s.route(request(false,owner),{...env,ENABLE_EMPLOYEE_PROFILES:'false'}),null);assert.equal(s.calls.length,0);
});
test('self read derives membership from verified identity and projects only permitted profile fields',async()=>{
 const s=fixture(),response=await s.route(request(),env),data=await response.json();assert.equal(response.status,200);assert.equal(data.selfScoped,true);assert.equal(data.contactEditsOnly,true);assert.equal(data.profile.firstName,'Jordan');assert.doesNotMatch(JSON.stringify(data),/private_note|caller-fixture|secret_fixture/);
 const query=new URL(s.calls.find(c=>c.url.includes('/ironcrest_employee_profiles')).url).searchParams;assert.equal(query.get('membership_id'),'eq.'+MEMBER);assert.equal(query.get('organization_id'),'eq.'+ORG);
 assert.equal(new URL(s.calls.find(c=>c.url.includes('ironcrest_memberships')).url).searchParams.get('user_id'),'eq.'+USER);
});
test('self update uses server-derived actor and target and does not send employment or auth changes',async()=>{
 const s=fixture(),response=await s.route(request(true,contact),env);assert.equal(response.status,200);const action=s.calls.find(c=>c.url.endsWith('ironcrest_update_employee_profile')),payload=JSON.parse(action.options.body);
 assert.deepEqual(payload,{p_actor:USER,p_organization_id:ORG,p_membership_id:MEMBER,p_expected_revision:1,p_changes:{phoneNumber:contact.phoneNumber,email:contact.email},p_self:true});
 assert.ok(s.calls.every(c=>!c.url.includes('attendance')&&!c.url.includes('admin')&&!c.url.includes('scheduled_shifts')));assert.equal(s.calls.filter(c=>c.url.includes('/auth/')).length,1);
});
test('owner update accepts contact email, uses revision and preserves existing response contract',async()=>{
 const s=fixture(),response=await s.route(request(false,owner),env),data=await response.json();assert.equal(response.status,200);assert.equal(data.updated,true);assert.equal(data.revision,2);assert.equal(data.attendanceWritesEnabled,false);
 const payload=JSON.parse(s.calls.find(c=>c.url.endsWith('ironcrest_update_employee_profile')).options.body);assert.equal(payload.p_self,false);assert.equal(payload.p_changes.email,contact.email);assert.equal(payload.p_changes.jobTitle,'Crew lead');
 const old={...owner};delete old.revision;const legacy=fixture();assert.equal((await legacy.route(request(false,old),env)).status,409);assert.equal(legacy.calls.length,0);
});
test('unconfirmed, revoked, ambiguous and non-Business users cannot access profiles',async()=>{
 for(const changes of [{user:null},{user:{id:USER}},{memberships:[]},{memberships:[{id:MEMBER,organization_id:ORG},{id:ORG,organization_id:ORG}]},{organizations:[]},{entitlement:[{business_active:false}]}]){
  const s=fixture(changes);assert.notEqual((await s.route(request(true,contact),env)).status,200);assert.equal(s.calls.some(c=>c.url.endsWith('ironcrest_update_employee_profile')),false);
 }
});
test('conflicts, missing profiles and provider redirects fail closed without exposing provider details',async()=>{
 const conflict=fixture({result:{ok:false,error:'profile_conflict'}});assert.equal((await conflict.route(request(true,contact),env)).status,409);
 const missing=fixture({profiles:[]});assert.equal((await (await missing.route(request(),env)).json()).profile,null);
 let count=0;const redirect=createEmployeeProfilesRoute({fetcher:async()=>{count++;return new Response(null,{status:302,headers:{Location:'https://foreign.invalid'}});}});assert.equal((await redirect(request(),env)).status,503);assert.equal(count,1);
});
test('foreign origin, scope parameters, rate limit and untrusted project never make privileged requests',async()=>{
 const s=fixture(),req=request();assert.equal((await s.route(new Request(req.url,{headers:{Origin:'https://foreign.invalid'}}),env)).status,403);assert.equal((await s.route(new Request(req.url+'?membershipId='+ORG,{headers:req.headers}),env)).status,400);assert.equal((await s.route(req,{...env,SUPABASE_URL:'https://foreign.invalid'})).status,503);assert.equal(s.calls.length,0);
 const limited=fixture();assert.equal((await limited.route(request(),{...env,INVITATION_RATE_LIMITER:{limit:async()=>({success:false})}})).status,429);assert.equal(limited.calls.length,1);
});
