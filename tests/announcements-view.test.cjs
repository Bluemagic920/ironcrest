const {test}=require('node:test'),assert=require('node:assert/strict'),{mount}=require('../announcements.js');
const row={id:'fixture',title:'Company notice',body:'First line\n<img src=x onerror=alert(1)>',status:'published',revision:2,created_at:'2030-01-01T00:00:00Z',published_at:'2030-01-02T00:00:00Z'};
function setup(owner=false){
 const elements=new Map();function node(){const n={value:'',textContent:'',disabled:false,hidden:false,children:[],listeners:{},addEventListener(k,v){this.listeners[k]=v;},setAttribute(){},scrollIntoView(){},focus(){},reset(){},querySelectorAll(){return [];},append(...v){this.children.push(...v);},replaceChildren(...v){this.children=v;}};Object.defineProperty(n,'innerHTML',{set(){throw Error('User text must not be interpreted as HTML');}});return n;}
 const $=id=>{if(!elements.has(id))elements.set(id,node());return elements.get(id);};$('announcements-filter').value='all';let user='member',listener,handler=async()=>({ok:true,json:async()=>({ok:true,organizationScoped:true,employeeFeed:!owner,timeZone:'America/Phoenix',announcements:[row],nextCursor:null})});const requests=[];
 const client={auth:{getSession:async()=>({data:{session:{access_token:'fixture',user:{id:user}}}}),onAuthStateChange:fn=>listener=fn}};
 const api=mount({document:{getElementById:$,createElement:node},client,verifyMembership:async()=>'organization',apiBase:'https://worker.invalid',owner,fetcher:async(url,options)=>{requests.push({url,options});return handler(url,options);}});
 return {$,api,requests,setHandler:fn=>handler=fn,switchUser:()=>{user='other';listener('SIGNED_IN',{user:{id:user}});}};
}
test('employee feed renders multiline notices as plain text and cannot perform owner actions',async()=>{
 const s=setup();await s.api.load();assert.equal(s.requests[0].options.method,'GET');assert.match(s.requests[0].url,/employee\/announcements/);assert.equal(s.$('announcements-list').children[0].children[2].textContent,row.body);await s.api.perform({action:'publish'});assert.equal(s.requests.length,1);
});
test('private or unverified feed responses cannot render to employees',async()=>{
 const s=setup();s.setHandler(async()=>({ok:true,json:async()=>({ok:true,organizationScoped:true,employeeFeed:true,timeZone:'UTC',announcements:[{...row,status:'draft'}],nextCursor:null})}));await s.api.load();assert.equal(s.$('announcements-list').children.length,0);
});
test('account switch clears notices and late responses cannot restore another company feed',async()=>{
 const s=setup();await s.api.load();let finish;s.setHandler(()=>new Promise(resolve=>finish=resolve));const loading=s.api.load();await new Promise(resolve=>setImmediate(resolve));s.switchUser();finish({ok:true,json:async()=>({ok:true,organizationScoped:true,employeeFeed:true,timeZone:'UTC',announcements:[row],nextCursor:null})});await loading;assert.equal(s.$('announcements-list').children.length,0);assert.equal(s.$('announcements-panel').hidden,true);
});
test('owner uncertain publication cannot be retried blindly before reload',async()=>{
 const s=setup(true);await s.api.load();s.setHandler(async()=>{throw Error('Connection lost');});await s.api.perform({action:'publish',id:'fixture',revision:2});const count=s.requests.length;await s.api.perform({action:'publish',id:'fixture',revision:2});assert.equal(s.requests.length,count);assert.match(s.$('announcements-status').textContent,/Reload/);
});
test('next and previous pages use returned cursors, and filters reload at the first page',async()=>{
 const s=setup(true);s.setHandler(async()=>({ok:true,json:async()=>({ok:true,organizationScoped:true,timeZone:'UTC',announcements:[row],nextCursor:'next-fixture'})}));await s.api.load();assert.equal(s.$('announcements-next').disabled,false);
 s.$('announcements-next').listeners.click();await new Promise(resolve=>setImmediate(resolve));assert.match(s.requests[1].url,/cursor=next-fixture/);assert.equal(s.$('announcements-previous').disabled,false);
 s.$('announcements-filter').value='draft';s.$('announcements-filter').listeners.change();await new Promise(resolve=>setImmediate(resolve));assert.match(s.requests[2].url,/status=draft/);assert.doesNotMatch(s.requests[2].url,/cursor=/);
});
