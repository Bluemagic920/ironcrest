const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../accept-invitation.html'),'utf8').match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const ORG='22222222-2222-4222-8222-222222222222';
const flush=async()=>{for(let i=0;i<35;i++)await Promise.resolve();};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function setup(){
 const nodes=new Map();const $=id=>{if(!nodes.has(id)){const hidden=new Set(['hidden']);nodes.set(id,{value:'',disabled:false,textContent:'',classList:{add:x=>hidden.add(x),remove:x=>hidden.delete(x),contains:x=>hidden.has(x)},addEventListener:(event,callback)=>nodes.get(id)[event]=callback});}return nodes.get(id);};
 let user={id:'first-user',email:'first@example.com',email_confirmed_at:'confirmed'},callback;
 let session=async()=>({data:{session:{access_token:'first-token',user}}});
 let response=async()=>({ok:true,status:200,json:async()=>({ok:true,invitationAccepted:true,organizationId:ORG,assignedRole:'employee'})});
 const calls=[],navigations=[],storage=new Map([['ironcrest-pending-invitation-v1','a'.repeat(64)]]);
 const auth={getUser:async()=>({data:{user}}),getSession:()=>session(),onAuthStateChange:fn=>callback=fn};
 vm.runInNewContext(source,{window:{supabase:{createClient:()=>({auth})},location:{assign:url=>navigations.push(url)}},location:{search:'',hash:'',origin:'https://ironcrest.profitharborai.com',pathname:'/accept-invitation.html'},history:{replaceState(){}},URLSearchParams,document:{getElementById:$},sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},setTimeout:fn=>Promise.resolve().then(fn),fetch:async(url,options)=>{calls.push({url,options});return response(url,options);}});
 return {$,calls,navigations,storage,setResponse:fn=>response=fn,setSession:fn=>session=fn,setUser:u=>user=u,switch:async()=>{user={id:'second-user',email:'second@example.com',email_confirmed_at:'confirmed'};callback('SIGNED_IN',{user});await flush();}};
}
test('acceptance requires the displayed verified account and clears its token only after verified success',async()=>{
 const s=setup();await flush();await s.$('accept').onclick();assert.equal(s.calls.length,1);assert.ok(s.calls[0].url.endsWith('/api/accept-invitation'));assert.equal(s.calls[0].options.headers.Authorization,'Bearer first-token');assert.equal(s.navigations.length,1);assert.equal(s.storage.size,0);
});
test('lost response retains invitation and explicit status check recovers without a second acceptance write',async()=>{
 const s=setup();await flush();s.setResponse(async()=>{throw Error('lost receipt');});await s.$('accept').onclick();assert.match(s.$('notice').textContent,/result is unclear/);assert.equal(s.storage.size,1);assert.equal(s.calls.length,1);assert.equal(s.navigations.length,0);
 s.setResponse(async()=>({ok:true,status:200,json:async()=>({ok:true,readOnly:true,invitationAccepted:true,organizationId:ORG,assignedRole:'employee'})}));await s.$('check-membership').onclick();assert.equal(s.calls.length,2);assert.ok(s.calls[1].url.endsWith('/status'));assert.equal(s.navigations.length,1);assert.equal(s.storage.size,0);
});
test('account switch discards a late acceptance receipt and preserves the invitation for review',async()=>{
 const s=setup();await flush();const pending=deferred();s.setResponse(()=>pending.promise);const action=s.$('accept').onclick();await flush();assert.equal(s.calls.length,1);await s.switch();pending.resolve({ok:true,status:200,json:async()=>({ok:true,invitationAccepted:true,organizationId:ORG,assignedRole:'employee'})});await action;assert.equal(s.navigations.length,0);assert.equal(s.storage.size,1);assert.match(s.$('account').textContent,/second@example.com/);
});
test('switch during session acquisition cannot post with the replacement account session',async()=>{
 const s=setup();await flush();const pending=deferred();s.setSession(()=>pending.promise);const action=s.$('accept').onclick();await flush();await s.switch();pending.resolve({data:{session:{access_token:'second-token',user:{id:'second-user'}}}});await action;assert.equal(s.calls.length,0);assert.equal(s.navigations.length,0);
});
test('duplicate clicks send one request and malformed success cannot clear invitation or navigate',async()=>{
 const s=setup();await flush();const pending=deferred();s.setResponse(()=>pending.promise);const action=s.$('accept').onclick();await flush();await s.$('accept').onclick();assert.equal(s.calls.length,1);pending.resolve({ok:true,status:200,json:async()=>({invitationAccepted:true})});await action;assert.equal(s.storage.size,1);assert.equal(s.navigations.length,0);
});
test('status response must be verified as read-only; unverified users never post acceptance',async()=>{
 const s=setup();await flush();await s.$('check-membership').onclick();assert.equal(s.navigations.length,0);assert.equal(s.storage.size,1);
 s.setUser({id:'first-user',email:'first@example.com',email_confirmed_at:null});await s.$('accept').onclick();assert.equal(s.calls.length,1);assert.match(s.$('notice').textContent,/verify your account/);
});
