import {test} from 'node:test';import assert from 'node:assert/strict';import {createAnnouncementsRoute,validateAnnouncement,announcementCursor} from '../worker/announcements.mjs';
const USER='11111111-1111-4111-8111-111111111111',ORG='22222222-2222-4222-8222-222222222222',ID='33333333-3333-4333-8333-333333333333';
const env={ENABLE_COMPANY_ANNOUNCEMENTS:'true',SUPABASE_URL:'https://nhiqbcevcdxfzvrprgck.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_fixture',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture',INVITATION_RATE_LIMITER:{limit:async()=>({success:true})}};
const draft={action:'save_draft',id:null,revision:0,title:'Company notice',body:'First line\nSecond line'};
const request=(self=false,body,query='')=>new Request('https://worker.invalid/api/'+(self?'employee/':'')+'announcements'+query,{method:body?'POST':'GET',headers:{Origin:'https://ironcrest.profitharborai.com',Authorization:'Bearer caller-fixture',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
const notice={id:ID,organization_id:ORG,title:'Fixture',body:'Sample notice',status:'published',revision:2,created_at:'2030-01-01T10:00:00.000123+00:00',published_at:'2030-01-02T10:00:00.000123+00:00',created_by:USER};
function fixture(overrides={}){
 const data={user:{id:USER,email_confirmed_at:'confirmed'},memberships:[{organization_id:ORG}],organizations:[{id:ORG}],entitlement:[{business_active:true}],rows:[notice],preferences:[{time_zone:'America/Phoenix'}],result:{ok:true,announcement:notice},...overrides},calls=[];
 const route=createAnnouncementsRoute({fetcher:async(url,options)=>{calls.push({url,options});assert.equal(options.redirect,'manual');const p=new URL(url).pathname,key=p.endsWith('/user')?'user':p.endsWith('ironcrest_memberships')?'memberships':p.endsWith('ironcrest_organizations')?'organizations':p.endsWith('ironcrest_business_entitlement')?'entitlement':p.endsWith('ironcrest_announcements')?'rows':p.endsWith('ironcrest_company_settings')?'preferences':p.endsWith('ironcrest_announcement_action')?'result':null;if(!key)throw Error('Unexpected provider');return new Response(JSON.stringify(data[key]));}});return {route,calls};
}
test('notice body allows plain multiline text while scope overrides and invalid controls are rejected',()=>{
 assert.equal(validateAnnouncement(draft).body,draft.body);assert.equal(validateAnnouncement({...draft,body:'<img src=x onerror=alert(1)>'}).action,'save_draft');
 for(const value of [{...draft,organization_id:ORG},{...draft,title:'x\ny'},{...draft,body:'x\u0001y'},{...draft,body:'x'.repeat(5001)},{...draft,revision:1},{action:'publish',id:ID,revision:0},{action:'archive',id:null,revision:0}])assert.throws(()=>validateAnnouncement(value));
});
test('closed release gate and employee POST produce no provider calls',async()=>{
 const s=fixture();assert.equal((await s.route(request(),{...env,ENABLE_COMPANY_ANNOUNCEMENTS:'false'})).status,503);assert.equal((await s.route(request(true,draft),env)).status,405);assert.equal(s.calls.length,0);
});
test('employee feed reads only published notices from its verified company',async()=>{
 const s=fixture(),response=await s.route(request(true),env),data=await response.json();assert.equal(response.status,200);assert.equal(data.employeeFeed,true);assert.equal(data.announcements.length,1);assert.doesNotMatch(JSON.stringify(data),/organization_id|created_by|caller-fixture|secret_fixture/);
 const read=new URL(s.calls.find(c=>c.url.includes('/ironcrest_announcements?')).url).searchParams;assert.equal(read.get('organization_id'),'eq.'+ORG);assert.equal(read.get('status'),'eq.published');assert.equal(read.get('order'),'published_at.desc,id.desc');
 const member=new URL(s.calls.find(c=>c.url.includes('/ironcrest_memberships?')).url).searchParams;assert.equal(member.get('role'),'eq.employee');assert.equal(member.get('user_id'),'eq.'+USER);
});
test('employee cannot request drafts, archived notices or another company and foreign provider rows fail closed',async()=>{
 for(const query of ['?status=draft','?organization_id='+ORG]){const s=fixture();assert.equal((await s.route(request(true,undefined,query),env)).status,400);assert.equal(s.calls.length,0);}
 for(const row of [{...notice,status:'draft'},{...notice,status:'archived'},{...notice,published_at:null},{...notice,organization_id:USER}]){const s=fixture({rows:[row]});assert.equal((await s.route(request(true),env)).status,503);}
});
test('pagination uses an exact timestamp and UUID cursor without exposing other organizations',async()=>{
 const s=fixture({rows:Array.from({length:26},()=>notice)}),data=await (await s.route(request(true),env)).json();assert.equal(data.announcements.length,25);assert.ok(data.nextCursor);assert.deepEqual(announcementCursor(data.nextCursor),{time:notice.published_at,id:ID});
 const next=fixture();assert.equal((await next.route(request(true,undefined,'?cursor='+data.nextCursor),env)).status,200);const read=new URL(next.calls.find(c=>c.url.includes('/ironcrest_announcements?')).url).searchParams;assert.equal(read.get('organization_id'),'eq.'+ORG);assert.match(read.get('or'),/\.000123\+00:00/);
 for(const value of ['invalid,scope','e30',btoa(JSON.stringify({time:'2030-02-30T00:00:00Z',id:ID})).replaceAll('=','')])assert.throws(()=>announcementCursor(value));
});
test('owner publication uses only the atomic notice RPC with server-derived actor and organization',async()=>{
 const s=fixture(),response=await s.route(request(false,draft),env);assert.equal(response.status,200);const action=s.calls.find(c=>c.url.endsWith('/ironcrest_announcement_action'));assert.deepEqual(JSON.parse(action.options.body),{p_actor:USER,p_organization_id:ORG,p_action:'save_draft',p_id:null,p_expected_revision:0,p_title:draft.title,p_body:draft.body});
 for(const c of s.calls){assert.equal(new URL(c.url).origin,env.SUPABASE_URL);if(!c.url.endsWith('/user'))assert.equal(c.options.headers.Authorization,undefined);}assert.ok(s.calls.every(c=>!c.url.includes('attendance')&&!c.url.includes('employee_profiles')&&!c.url.includes('resend')));
});
test('unverified, revoked, ambiguous and unpaid members cannot read or publish notices',async()=>{
 for(const change of [{user:null},{user:{id:USER}},{memberships:[]},{memberships:[{organization_id:ORG},{organization_id:ORG}]},{organizations:[]},{entitlement:[{business_active:false}]}]){const s=fixture(change);assert.notEqual((await s.route(request(false,draft),env)).status,200);assert.equal(s.calls.some(c=>c.url.endsWith('ironcrest_announcement_action')),false);}
});
test('foreign origin, wrong project, rate limiting, redirects and revision conflicts fail closed',async()=>{
 const s=fixture(),req=request();assert.equal((await s.route(new Request(req.url,{headers:{Origin:'https://foreign.invalid'}}),env)).status,403);assert.equal((await s.route(req,{...env,SUPABASE_URL:'https://foreign.invalid'})).status,503);assert.equal(s.calls.length,0);
 const limited=fixture();assert.equal((await limited.route(req,{...env,INVITATION_RATE_LIMITER:{limit:async()=>({success:false})}})).status,429);assert.equal(limited.calls.length,1);
 let count=0;const redirect=createAnnouncementsRoute({fetcher:async()=>{count++;return new Response(null,{status:302,headers:{Location:'https://foreign.invalid'}});}});assert.equal((await redirect(req,env)).status,503);assert.equal(count,1);
 const conflict=fixture({result:{ok:false,error:'announcement_conflict'}});assert.equal((await conflict.route(request(false,{action:'publish',id:ID,revision:1}),env)).status,409);
});
