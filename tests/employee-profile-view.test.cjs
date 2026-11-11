const {test}=require('node:test'),assert=require('node:assert/strict'),{mount}=require('../employee-profile.js');
const profile={firstName:'Jordan',lastName:'Example',jobTitle:'Crew lead',employmentStatus:'active',phoneNumber:'555-010-1234',email:'contact@example.invalid',revision:1};
function setup(){
 const elements=new Map(),$=id=>{if(!elements.has(id))elements.set(id,{value:'',textContent:'',disabled:false,hidden:false,listeners:{},addEventListener(k,v){this.listeners[k]=v;},setAttribute(){},scrollIntoView(){},reset(){for(const [key,node] of elements)if(key==='employee-profile-phone'||key==='employee-profile-email')node.value='';}});return elements.get(id);};
 let listener,user='employee',handler=async()=>({ok:true,json:async()=>({ok:true,selfScoped:true,organizationScoped:true,contactEditsOnly:true,profile})});const requests=[];
 const client={auth:{getSession:async()=>({data:{session:{access_token:'fixture',user:{id:user}}}}),onAuthStateChange:fn=>listener=fn}};
 const api=mount({document:{getElementById:$},client,verifyEmployee:async()=>'organization',apiBase:'https://worker.invalid',fetcher:async(url,options)=>{requests.push({url,options});return handler();}});
 return {$,api,requests,setHandler:fn=>handler=fn,switchUser:()=>{user='other';listener('SIGNED_IN',{user:{id:user}});}};
}
test('employee profile displays owner-managed fields and saves only contact fields with the loaded revision',async()=>{
 const s=setup();await s.api.load();assert.equal(s.$('employee-profile-name').textContent,'Jordan Example');assert.equal(s.$('employee-profile-job').textContent,'Crew lead');
 s.$('employee-profile-email').value='new@example.invalid';s.setHandler(async()=>({ok:true,json:async()=>({ok:true,updated:true,selfScoped:true,organizationScoped:true,contactEditsOnly:true,profile:{...profile,email:'new@example.invalid',revision:2}})}));await s.api.save();
 assert.equal(s.requests[1].options.method,'PATCH');assert.deepEqual(JSON.parse(s.requests[1].options.body),{revision:1,phoneNumber:'555-010-1234',email:'new@example.invalid'});assert.match(s.$('employee-profile-status').textContent,/sign-in email is unchanged/);
});
test('conflict and uncertain save require reload, preventing a blind second mutation',async()=>{
 const s=setup();await s.api.load();s.setHandler(async()=>({ok:false,status:409,json:async()=>({error:'This profile changed in another window.'})}));await s.api.save();assert.equal(s.$('employee-profile-save').disabled,true);assert.match(s.$('employee-profile-status').textContent,/Reload/);
 const count=s.requests.length;await s.api.save();assert.equal(s.requests.length,count);
});
test('account switch clears contact fields and late replies cannot restore private details',async()=>{
 const s=setup();await s.api.load();let finish;s.setHandler(()=>new Promise(resolve=>finish=resolve));const pending=s.api.load();await new Promise(resolve=>setImmediate(resolve));s.switchUser();finish({ok:true,json:async()=>({ok:true,selfScoped:true,organizationScoped:true,contactEditsOnly:true,profile})});await pending;
 assert.equal(s.$('employee-profile-panel').hidden,true);assert.equal(s.$('employee-profile-email').value,'');assert.equal(s.$('employee-profile-name').textContent,'');assert.equal(s.$('employee-profile-save').disabled,true);
});
test('missing profile and non-self-scoped response never enable contact edits',async()=>{
 const s=setup();s.setHandler(async()=>({ok:true,json:async()=>({ok:true,selfScoped:true,organizationScoped:true,contactEditsOnly:true,profile:null})}));await s.api.load();assert.equal(s.$('employee-profile-save').disabled,true);assert.match(s.$('employee-profile-status').textContent,/owner needs to complete/);
 s.setHandler(async()=>({ok:true,json:async()=>({ok:true,organizationScoped:true,contactEditsOnly:true,profile})}));await s.api.load();assert.equal(s.$('employee-profile-save').disabled,true);
});
