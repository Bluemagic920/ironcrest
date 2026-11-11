const {test}=require('node:test'),assert=require('node:assert/strict'),{mount}=require('../owner-invitations.js');
const link='https://ironcrest.profitharborai.com/accept-invitation.html#invite='+'a'.repeat(64);
function setup(){
 const elements=new Map();function node(){const n={value:'',textContent:'',disabled:false,hidden:false,children:[],listeners:{},addEventListener(k,v){this.listeners[k]=v;},reset(){},reportValidity(){return true;},querySelectorAll(){return [];},append(...v){this.children.push(...v);},replaceChildren(...v){this.children=v;}};Object.defineProperty(n,'innerHTML',{set(){throw Error('No user HTML');}});return n;}
 const $=id=>{if(!elements.has(id))elements.set(id,node());return elements.get(id);};let user='owner',org='company',listener,handler=async()=>({ok:true,json:async()=>({ok:true,organizationScoped:true,emailConfigured:true,acceptanceEnabled:true,capacity:{activeEmployees:1,pendingInvitations:1,occupiedSlots:2,employeeLimit:20},invitations:[{id:'pending',email:'<fixture@example.com>',status:'pending',deliveryStatus:'unknown',expires_at:'2099-01-01'}]})});const requests=[],copies=[];
 const client={auth:{getSession:async()=>({data:{session:{access_token:'fixture',user:{id:user}}}}),onAuthStateChange:fn=>listener=fn}};
 const api=mount({document:{getElementById:$,createElement:node},client,verifyOwner:async()=>org,apiBase:'https://worker.invalid',copyText:async text=>copies.push(text),fetcher:async(url,options)=>{requests.push({url,options});return handler(url,options);}});
 return {$,api,requests,copies,setHandler:fn=>handler=fn,switchUser:()=>{user='other';listener('SIGNED_IN',{user:{id:user}});},switchOrg:()=>org='other-company'};
}
test('owner must load the company list before creating and invitation data stays plain text',async()=>{
 const s=setup();await s.api.perform();assert.equal(s.requests.length,0);await s.api.load();assert.equal(s.$('owner-invitation-list').children[0].children[0].textContent,'<fixture@example.com>');assert.equal(s.$('legacy-invite-controls').hidden,true);assert.equal(s.$('owner-invitation-send').disabled,false);
});
test('creation sends only the email and displays private link only on the explicit response',async()=>{
 const s=setup();await s.api.load();s.$('owner-invitation-email').value='employee@example.com';s.setHandler(async()=>({ok:true,json:async()=>({ok:true,organizationScoped:true,invitationCreated:true,deliveryStatus:'accepted',privateInvitationUrl:link})}));await s.api.perform();assert.deepEqual(JSON.parse(s.requests[1].options.body),{email:'employee@example.com'});assert.equal(s.$('owner-invitation-private-url').value,link);assert.equal(s.copies.length,0);await s.$('owner-invitation-copy').listeners.click();assert.deepEqual(s.copies,[link]);s.switchUser();assert.equal(s.$('owner-invitation-private-url').value,'');assert.equal(s.$('owner-invitation-private-box').hidden,true);
});
test('uncertain writes cannot be retried before reload and account changes cannot reuse loaded context',async()=>{
 const s=setup();await s.api.load();s.setHandler(async()=>{throw Error('Connection lost');});await s.api.perform();const count=s.requests.length;await s.api.perform();assert.equal(s.requests.length,count);assert.match(s.$('owner-invitation-status').textContent,/Refresh/);
 const other=setup();await other.api.load();other.switchOrg();await other.api.perform();assert.equal(other.requests.length,1);assert.match(other.$('owner-invitation-status').textContent,/session changed/);
});
test('late previous-account responses cannot restore invitation emails or private links',async()=>{
 const s=setup();await s.api.load();let finish;s.setHandler(()=>new Promise(resolve=>finish=resolve));const pending=s.api.perform();await new Promise(resolve=>setImmediate(resolve));s.switchUser();finish({ok:true,json:async()=>({ok:true,organizationScoped:true,invitationCreated:true,deliveryStatus:'accepted',privateInvitationUrl:link})});await pending;assert.equal(s.$('owner-invitation-list').children.length,0);assert.equal(s.$('owner-invitation-private-url').value,'');
});
test('failed email still preserves a copyable link without reporting inbox delivery',async()=>{
 const s=setup();await s.api.load();s.setHandler(async()=>({ok:false,json:async()=>({organizationScoped:true,invitationCreated:true,deliveryStatus:'failed',privateInvitationUrl:link})}));await s.api.perform();assert.equal(s.$('owner-invitation-private-url').value,link);assert.match(s.$('owner-invitation-status').textContent,/email submission failed/);assert.equal(s.$('owner-invitation-send').disabled,true);
});
