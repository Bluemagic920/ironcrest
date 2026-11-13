const {test}=require('node:test'),assert=require('node:assert/strict'),{mount}=require('../attendance-workflows.js');
const USER='11111111-1111-4111-8111-111111111111',ORG='22222222-2222-4222-8222-222222222222',SITE='44444444-4444-4444-8444-444444444444',OP='55555555-5555-4555-8555-555555555555',ENTRY='66666666-6666-4666-8666-666666666666';
function setup(saved=new Map()){
 const elements=new Map(),$=id=>{if(!elements.has(id))elements.set(id,{value:'',textContent:'',disabled:false,hidden:false,children:[],listeners:{},addEventListener(k,fn){this.listeners[k]=fn;},replaceChildren(){this.children=[];this.value='';},appendChild(node){this.children.push(node);if(!this.value)this.value=node.value;}});return elements.get(id);};
 let user=USER,org=ORG,listener,gpsCount=0,clockedIn=false,confirm=true,location={coords:{latitude:33,longitude:-112,accuracy:5},timestamp:Date.now()},handler=null;
 const requests=[],client={auth:{getUser:async()=>({data:{user:{id:user,email_confirmed_at:'confirmed'}}}),getSession:async()=>({data:{session:{access_token:'fixture-session',user:{id:user}}}}),onAuthStateChange:fn=>listener=fn}};
 const storage={getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,value),removeItem:key=>saved.delete(key)};
 const api=mount({document:{getElementById:$,createElement:()=>({})},client,getContext:()=>({organizationId:org}),storage,randomUUID:()=>OP,confirmAction:()=>confirm,getPosition:async()=>{gpsCount++;return location;},fetcher:async(url,options)=>{
  requests.push({url,options});if(handler)return handler(url,options);
  if(options.method==='GET')return {ok:true,status:200,json:async()=>({ok:true,readOnly:true,worksites:[{id:SITE,name:'Assigned <site>'}],openShift:clockedIn?{entryId:ENTRY,worksiteId:SITE,clockInAt:'2026-11-12T14:00:00Z'}:null})};
  const body=JSON.parse(options.body);clockedIn=url.endsWith('clock-in');return {ok:true,json:async()=>({ok:true,attendanceRecorded:true,result:{operationId:body.operationId,entryId:ENTRY,action:clockedIn?'clock_in':'clock_out'}})};
 }});
 return {$,api,requests,saved,storage,get gpsCount(){return gpsCount;},setHandler:fn=>handler=fn,setClockedIn:value=>clockedIn=value,setLocation:value=>location=value,setConfirm:value=>confirm=value,switchUser:(id='77777777-7777-4777-8777-777777777777')=>{user=id;listener('SIGNED_IN',{user:{id}});},setOrg:value=>org=value,click:id=>$(id).listeners.click()};
}
test('read-only refresh never requests GPS; normal action saves no coordinates or token',async()=>{
 const s=setup();await s.api.refresh();assert.equal(s.gpsCount,0);assert.equal(s.$('attendance-workflow-in').disabled,false);assert.equal(s.$('attendance-workflow-out').disabled,true);assert.equal(s.$('attendance-workflow-site').children[0].textContent,'Assigned <site>');
 await s.click('attendance-workflow-in');assert.equal(s.gpsCount,1);assert.equal(s.requests.filter(x=>x.options.method==='POST').length,1);assert.equal(s.saved.size,0);assert.match(s.$('attendance-workflow-result').textContent,/confirmed/);assert.equal(s.$('attendance-workflow-out').disabled,false);
});
test('clock out sends only the exact open entry and worksite',async()=>{
 const s=setup();s.setClockedIn(true);await s.api.refresh();await s.click('attendance-workflow-out');const sent=JSON.parse(s.requests.find(x=>x.options.method==='POST').options.body);assert.equal(sent.expectedEntryId,ENTRY);assert.equal(sent.worksiteId,SITE);assert.equal(sent.operationId,OP);assert.equal(s.$('attendance-workflow-in').disabled,false);
});
test('declined confirmation and stale/inaccurate GPS never submit',async()=>{
 const s=setup();await s.api.refresh();s.setConfirm(false);await s.click('attendance-workflow-in');assert.equal(s.gpsCount,0);
 s.setConfirm(true);for(const location of [{coords:{latitude:33,longitude:-112,accuracy:101},timestamp:Date.now()},{coords:{latitude:33,longitude:-112,accuracy:5},timestamp:Date.now()-31000}]){s.setLocation(location);await s.click('attendance-workflow-in');}
 assert.equal(s.requests.filter(x=>x.options.method==='POST').length,0);assert.equal(s.saved.size,0);
});
test('ambiguous network failure survives reload and recovery reuses the operation identity',async()=>{
 const s=setup();await s.api.refresh();s.setHandler(async()=>{throw Error('Connection lost');});await s.click('attendance-workflow-in');assert.equal(s.$('attendance-workflow-in').disabled,true);assert.equal(s.$('attendance-workflow-recover').hidden,false);assert.equal(s.requests.filter(x=>x.options.method==='POST').length,1);
 const saved=JSON.parse([...s.saved.values()][0]);assert.deepEqual(Object.keys(saved).sort(),['action','expectedEntryId','operationId','organizationId','worksiteId']);assert.ok(!JSON.stringify(saved).includes('fixture-session'));
 const again=setup(s.saved);await again.api.refresh();assert.equal(again.$('attendance-workflow-in').disabled,true);assert.equal(again.$('attendance-workflow-recover').hidden,false);await again.click('attendance-workflow-recover');
 const sent=JSON.parse(again.requests.find(x=>x.options.method==='POST').options.body);assert.equal(sent.operationId,OP);assert.equal(sent.expectedEntryId,null);assert.equal(s.saved.size,0);
});
test('a second click during submission cannot create a second request',async()=>{
 const s=setup();await s.api.refresh();let finish;s.setHandler(()=>new Promise(resolve=>finish=resolve));const running=s.click('attendance-workflow-in');await new Promise(r=>setImmediate(r));await s.click('attendance-workflow-in');assert.equal(s.requests.filter(x=>x.options.method==='POST').length,1);
 finish({ok:false,json:async()=>({attendanceRecorded:null})});await running;assert.equal(s.$('attendance-workflow-in').disabled,true);
});
test('account switch discards late replies and preserves recovery identity for original account',async()=>{
 const s=setup();await s.api.refresh();let finish;s.setHandler(()=>new Promise(resolve=>finish=resolve));const running=s.click('attendance-workflow-in');await new Promise(r=>setImmediate(r));s.switchUser();finish({ok:true,json:async()=>({ok:true,attendanceRecorded:true,result:{operationId:OP,entryId:ENTRY,action:'clock_in'}})});await running;
 assert.equal(s.$('attendance-workflow-panel').hidden,true);assert.equal(s.$('attendance-workflow-in').disabled,true);assert.equal(s.saved.size,1);s.setHandler(null);await s.api.refresh();assert.equal(s.$('attendance-workflow-recover').hidden,true);
});
test('storage failure or corrupted pending state blocks mutation rather than losing recovery',async()=>{
 const s=setup();await s.api.refresh();s.storage.setItem=()=>{throw Error('Storage unavailable');};await s.click('attendance-workflow-in');assert.equal(s.requests.filter(x=>x.options.method==='POST').length,0);
 const other=setup(new Map([['ironcrest-attendance-pending-v1:'+USER,'broken']]));await other.api.refresh();assert.equal(other.$('attendance-workflow-in').disabled,true);assert.match(other.$('attendance-workflow-result').textContent,/needs review/);
});
test('definite pre-write denial clears saved operation and rejected response cannot claim success',async()=>{
 const s=setup();await s.api.refresh();s.setHandler(async()=>({ok:false,json:async()=>({attendanceRecorded:false,error:'Location rejected before recording.'})}));await s.click('attendance-workflow-in');assert.equal(s.saved.size,0);assert.match(s.$('attendance-workflow-result').textContent,/rejected/);
 s.setHandler(async()=>({ok:true,json:async()=>({ok:true,attendanceRecorded:true,result:{operationId:USER,entryId:ENTRY,action:'clock_in'}})}));await s.click('attendance-workflow-in');assert.equal(s.saved.size,1);assert.match(s.$('attendance-workflow-result').textContent,/not confirmed/);
});
test('an open shift at a removed assignment directs the employee to the owner without submitting',async()=>{
 const s=setup();s.setHandler(async()=>({ok:true,json:async()=>({ok:true,readOnly:true,worksites:[],openShift:{entryId:ENTRY,worksiteId:SITE,clockInAt:'2026-11-12T14:00:00Z'}})}));await s.api.refresh();assert.equal(s.$('attendance-workflow-out').disabled,true);assert.match(s.$('attendance-workflow-result').textContent,/company owner/);await s.click('attendance-workflow-out');assert.equal(s.gpsCount,0);assert.equal(s.requests.filter(x=>x.options.method==='POST').length,0);
});
