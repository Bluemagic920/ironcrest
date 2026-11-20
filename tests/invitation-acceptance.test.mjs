import {test} from 'node:test';import assert from 'node:assert/strict';import {webcrypto,createHash} from 'node:crypto';
import {createInvitationAcceptanceRoute} from '../worker/invitation-acceptance.mjs';
const USER='11111111-1111-4111-8111-111111111111',ORG='22222222-2222-4222-8222-222222222222',INVITE='33333333-3333-4333-8333-333333333333',MEMBER='44444444-4444-4444-8444-444444444444',OWNER='55555555-5555-4555-8555-555555555555';
const token='a'.repeat(64),hash=createHash('sha256').update(token).digest('hex');
const env={SUPABASE_URL:'https://nhiqbcevcdxfzvrprgck.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_fixture',SUPABASE_PUBLISHABLE_KEY:'public-fixture',STAGE9B_ACCEPTANCE_ENABLED:'true',INVITATION_RATE_LIMITER:{limit:async()=>({success:true})}};
const req=(status=false,body={token},options={})=>new Request('https://worker.example/api/accept-invitation'+(status?'/status':''),{method:'POST',headers:{Origin:'https://ironcrest.profitharborai.com',Authorization:'Bearer fixture-session','Content-Type':'application/json'},body:JSON.stringify(body),...options});
function fixture(change={},approved=true){
 const data={user:{id:USER,email:'employee@example.com',email_confirmed_at:'confirmed'},accept:[{invitation_id:INVITE,membership_id:MEMBER,organization_id:ORG,assigned_role:'employee',private:'hidden'}],invites:[{id:INVITE,organization_id:ORG,email:'employee@example.com',role:'employee',status:'accepted',accepted_at:'2026-11-15T12:00:00Z',revoked_at:null,token_hash:hash}],members:[{id:MEMBER,organization_id:ORG,user_id:USER,role:'employee',active:true}],companies:[{id:ORG,created_by:OWNER}],owners:[{id:OWNER}],entitlement:[{business_active:true}],...change};
 const calls=[];const route=createInvitationAcceptanceRoute({releaseApproved:approved,cryptoApi:webcrypto,fetcher:async(url,options)=>{
  calls.push({url,options});assert.equal(options.redirect,'manual');assert.equal(new URL(url).origin,env.SUPABASE_URL);
  const u=new URL(url),p=u.pathname;const key=p.endsWith('/user')?'user':p.endsWith('/ironcrest_accept_invitation')?'accept':p.endsWith('/ironcrest_invitations')?'invites':p.endsWith('/ironcrest_memberships')?(u.searchParams.has('role')?'owners':'members'):p.endsWith('/ironcrest_organizations')?'companies':p.endsWith('/ironcrest_business_entitlement')?'entitlement':null;
  if(!key)throw Error('Unexpected provider call');if(change.failure===key)throw Error('private provider error');return Response.json(data[key]);
 }});return {route,calls,data};
}
test('both acceptance gates, foreign origins and unsafe requests fail before providers',async()=>{
 const closed=fixture({},false);assert.equal((await closed.route(req(),env)).status,503);assert.equal(closed.calls.length,0);
 const off=fixture();assert.equal((await off.route(req(),{...env,STAGE9B_ACCEPTANCE_ENABLED:'false'})).status,503);assert.equal(off.calls.length,0);
 for(const request of [req(false,{token,user_id:OWNER}),req(false,{token:'bad'}),req(false,{token},{headers:{Origin:'https://evil.example'}}),req(false,{token:'x'.repeat(2000)})]){const f=fixture();assert.ok((await f.route(request,env)).status>=400);assert.equal(f.calls.length,0);}
});
test('acceptance sends only the verified actor and token hash to one atomic RPC and projects public fields',async()=>{
 const f=fixture(),r=await f.route(req(),env),answer=await r.json();assert.equal(r.status,200);assert.deepEqual(answer,{ok:true,invitationAccepted:true,organizationId:ORG,assignedRole:'employee'});
 const c=f.calls.find(x=>x.url.endsWith('/ironcrest_accept_invitation'));assert.deepEqual(JSON.parse(c.options.body),{p_token_hash:hash,p_user_id:USER});assert.equal(c.options.headers.Authorization,undefined);assert.equal(c.options.headers.apikey,'sb_secret_fixture');assert.equal(f.calls.filter(x=>x.options.method==='POST').length,1);assert.ok(!JSON.stringify(f.calls).includes(token));
});
test('unverified and rate-limited sessions never reach acceptance or membership reads',async()=>{
 for(const change of [{user:null},{user:{id:USER,email:'employee@example.com'}}]){const f=fixture(change);assert.equal((await f.route(req(),env)).status,401);assert.equal(f.calls.length,1);}
 const f=fixture();assert.equal((await f.route(req(),{...env,INVITATION_RATE_LIMITER:{limit:async()=>({success:false})}})).status,429);assert.equal(f.calls.length,1);
});
test('lost acceptance receipt remains uncertain and never auto-retries the write',async()=>{
 for(const change of [{failure:'accept'},{accept:[]},{accept:[{membership_id:MEMBER}]}]){const f=fixture(change),r=await f.route(req(),env),a=await r.json();assert.equal(r.status,409);assert.equal(a.invitationAccepted,null);assert.equal(f.calls.filter(x=>x.url.endsWith('/ironcrest_accept_invitation')).length,1);assert.ok(!JSON.stringify(a).includes('private'));}
});
test('status resolves only accepted invitation, verified recipient and current active own membership without acceptance write',async()=>{
 const f=fixture(),r=await f.route(req(true),env),a=await r.json();assert.equal(r.status,200);assert.equal(a.readOnly,true);assert.equal(a.invitationAccepted,true);assert.ok(!f.calls.some(x=>x.url.endsWith('/ironcrest_accept_invitation')));assert.ok(!JSON.stringify(a).includes(hash));
 const u=new URL(f.calls.find(x=>x.url.includes('ironcrest_invitations?')).url);assert.equal(u.searchParams.get('token_hash'),'eq.'+hash);assert.equal(u.searchParams.get('status'),'eq.accepted');
});
test('wrong recipient, token hash, revoked membership, foreign rows, multiple memberships and unpaid Business deny status',async()=>{
 const initial=fixture().data;
 for(const change of [{invites:[{...initial.invites[0],email:'other@example.com'}]},{invites:[{...initial.invites[0],token_hash:'b'.repeat(64)}]},{invites:[{...initial.invites[0],revoked_at:'2026-11-15T12:00:00Z'}]},{members:[]},{members:[{...initial.members[0],user_id:OWNER}]},{members:[{...initial.members[0],active:false}]},{members:[...initial.members,...initial.members]},{owners:[]},{entitlement:[{business_active:false}]}]){const f=fixture(change);assert.equal((await f.route(req(true),env)).status,409);assert.ok(!f.calls.some(x=>x.url.endsWith('/ironcrest_accept_invitation')));}
});
test('integration wrapper preserves the existing Worker until source approval and delegates unrelated routes',async()=>{
 const {withInvitationAcceptance}=await import('../worker/invitation-acceptance.mjs');let calls=0;const legacy={fetch:async()=>{calls++;return new Response('legacy');}};
 const closed=withInvitationAcceptance(legacy);assert.equal(await (await closed.fetch(req(),env)).text(),'legacy');
 const approved=withInvitationAcceptance(legacy,{releaseApproved:true,cryptoApi:webcrypto});assert.equal(await (await approved.fetch(new Request('https://worker.example/health'),env)).text(),'legacy');assert.equal(calls,2);
 assert.equal((await approved.fetch(req(),{...env,STAGE9B_ACCEPTANCE_ENABLED:'false'})).status,503);assert.equal(calls,2);
});
