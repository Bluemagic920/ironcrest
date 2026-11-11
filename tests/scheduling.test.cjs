const {test}=require('node:test'),assert=require('node:assert/strict');
const {localToUtc,localValue,dateWindow,weekWindow,mount}=require('../scheduling.js');
test('schedule input uses company timezone, including midnight and overnight shifts',()=>{
 assert.equal(localToUtc('2026-11-12T08:00','America/Phoenix'),'2026-11-12T15:00:00.000Z');
 assert.equal(localValue(Date.parse('2026-11-12T07:00:00Z'),'America/Phoenix'),'2026-11-12T00:00');
 assert.equal(localToUtc('2026-11-12T22:00','America/Phoenix'),'2026-11-13T05:00:00.000Z');
 assert.throws(()=>localToUtc('2026-02-30T08:00','UTC'));
});
test('clock-change gaps and ambiguous times cannot silently schedule the wrong hour',()=>{
 assert.throws(()=>localToUtc('2027-03-14T02:30','America/New_York'),/does not exist/);
 assert.throws(()=>localToUtc('2026-11-01T01:30','America/New_York'),/occurs twice/);
 assert.equal(localToUtc('2026-11-01T03:30','America/New_York'),'2026-11-01T08:30:00.000Z');
 const range=dateWindow('2026-11-01','2026-11-01','America/New_York');assert.equal((Date.parse(range.end)-Date.parse(range.start))/3600000,25);
});
test('schedule defaults respect company workweek and bounded local calendar dates',()=>{
 assert.deepEqual(weekWindow(Date.parse('2026-11-11T04:00:00Z'),'America/Phoenix',0),{start:'2026-11-08',end:'2026-11-14'});
 assert.throws(()=>dateWindow('2026-11-12','2026-11-11','UTC'));assert.throws(()=>dateWindow('2026-11-01','2026-12-02','UTC'));
});
function setup(selfOnly=false){
 const elements=new Map();function element(){return {value:'',textContent:'',children:[],disabled:false,hidden:false,listeners:{},reset(){},focus(){},querySelectorAll(){return [];},setAttribute(){},addEventListener(k,v){this.listeners[k]=v;},replaceChildren(...v){this.children=v;},append(...v){this.children.push(...v);}};}
 const $=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);};let listener,user='owner',handler;
 const requests=[],context={ok:true,organizationScoped:true,selfScoped:selfOnly,timeZone:'America/Phoenix',weekStartsOn:1,employees:selfOnly?[]:[{id:'employee',name:'Fixture employee'}],worksites:selfOnly?[]:[{id:'site',name:'Fixture site'}]},report={ok:true,organizationScoped:true,selfScoped:selfOnly,shifts:[],worksites:[]};
 handler=async(url)=>({ok:true,json:async()=>url.includes('/context')?context:report});
 const client={auth:{getSession:async()=>({data:{session:{access_token:'fixture',user:{id:user}}}}),onAuthStateChange:fn=>listener=fn}};
 const api=mount({document:{getElementById:$,createElement:element},client,verifyOwner:async()=>'organization',apiBase:'https://worker.invalid',selfOnly,fetcher:async(url,options)=>{requests.push({url,options});return handler(url,options);}});
 return {$,api,requests,context,report,setHandler:fn=>handler=fn,switchUser:()=>{user='other';listener('SIGNED_IN',{user:{id:user}});}};
}
test('schedule reads are GET-only and personal view cannot perform owner actions',async()=>{
 const s=setup(true);await s.api.load();assert.ok(s.requests.every(r=>r.options.method==='GET'&&r.url.includes('/my-schedule/')));await s.api.perform({action:'publish'});assert.equal(s.requests.length,2);
});
test('uncertain save cannot be blindly retried before reload',async()=>{
 const s=setup();await s.api.load();s.setHandler(async()=>{throw Error('Connection lost. Reload before retrying.');});await s.api.perform({action:'publish',id:'fixture',revision:1});const count=s.requests.length;
 await s.api.perform({action:'publish',id:'fixture',revision:1});assert.equal(s.requests.length,count);assert.match(s.$('schedule-status').textContent,/Reload/);
});
test('switching accounts clears names and prevents a late schedule response restoring data',async()=>{
 const s=setup();await s.api.load();let finish;s.setHandler(()=>new Promise(resolve=>finish=resolve));const loading=s.api.load();await new Promise(resolve=>setImmediate(resolve));s.switchUser();finish({ok:true,json:async()=>s.context});await loading;
 assert.equal(s.$('schedule-panel').hidden,true);assert.equal(s.$('schedule-body').children.length,0);assert.equal(s.$('schedule-employee').children.length,0);assert.equal(s.$('schedule-start').value,'');
});
