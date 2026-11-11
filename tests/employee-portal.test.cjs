const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../employee-portal.html'),'utf8');
const source=html.match(/<script>\(\(\)=>\{[\s\S]*?<\/script>/)[0].slice(8,-9);
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const response=(data)=>({ok:true,json:async()=>data});
async function flush(){for(let i=0;i<30;i++)await Promise.resolve();}
function element(){return {textContent:'',disabled:false,value:'',children:[],style:{},classList:{add(){},remove(){}},addEventListener(){},replaceChildren(...children){this.children=children;this.textContent='';},appendChild(child){this.children.push(child);}};}
function setup(){
 const els=new Map();const $=id=>{if(!els.has(id))els.set(id,element());return els.get(id);};
 const requests=[];let fetcher=async()=>response({ok:true,employeeJobUpdatesEnabled:false});let session=async()=>({data:{session:{access_token:'fixture'}}});let worksite=async()=>({data:[]});
 const client={auth:{getUser:async()=>({data:{user:null}}),getSession:()=>session(),onAuthStateChange(){}},from(){const query={select(){return this;},eq(){return this;},order(){return this;},limit(){return worksite();}};return query;}};
 const window={supabase:{createClient:()=>client},confirm:()=>true,alert(){}};
 const exportCode='window.testPortal={clearWorksites,loadWorksites,clearJobs,loadAssignedJobs,transitionAssignedJob,refresh,setOrg:(id)=>{verifiedOrgId=id},setUpdates:(v)=>{employeeJobUpdatesEnabled=v}};';
 const instrumented=source.replace('refresh()})();',exportCode+'refresh()})();');
 vm.runInNewContext(instrumented,{window,document:{getElementById:$,createElement:element,createDocumentFragment:element},navigator:{},fetch:(url,options)=>{requests.push({url,options});return fetcher(url,options);},setTimeout,Date,Number,URL,console});
 return {api:window.testPortal,$,requests,setFetch:f=>fetcher=f,setSession:f=>session=f,setWorksite:f=>worksite=f};
}
const jobs=(title)=>({ok:true,assignedOnly:true,readOnly:true,jobs:[{id:'fixture-job',title,status:'pending',priority:'normal'}]});
test('refresh immediately clears the previous employee job cards and controls',async()=>{
 const s=setup();await flush();s.api.setOrg('org');s.$('assigned-jobs-list').children=[{textContent:'Private previous job'}];s.api.setUpdates(true);
 await s.api.refresh();assert.equal(s.$('assigned-jobs-list').children.length,0);assert.equal(s.$('refresh-jobs').disabled,true);
});
test('old account response cannot reappear after account switch in the same organization',async()=>{
 const s=setup();await flush();const old=deferred();s.api.setOrg('same-org');s.setFetch(async url=>url.endsWith('/health')?response({ok:true,employeeJobUpdatesEnabled:false}):old.promise);
 const loading=s.api.loadAssignedJobs();await flush();assert.ok(s.requests.some(r=>r.url.endsWith('/jobs')));
 s.api.clearWorksites();s.api.setOrg('same-org');old.resolve(response(jobs('OLD PRIVATE JOB')));await loading;
 assert.equal(s.$('assigned-jobs-list').children.length,0);
});
test('account switch can load new jobs while an obsolete health request is pending',async()=>{
 const s=setup();await flush();const old=deferred();let healthCalls=0;
 s.setFetch(async url=>url.endsWith('/health')?(++healthCalls===1?old.promise:response({ok:true,employeeJobUpdatesEnabled:false})):response(jobs('NEW JOB')));
 s.api.setOrg('org');const loading=s.api.loadAssignedJobs();await flush();s.api.clearWorksites();s.api.setOrg('org');await s.api.loadAssignedJobs();
 const cards=s.$('assigned-jobs-list').children;assert.equal(cards.length,1);
 old.resolve(response({ok:true,employeeJobUpdatesEnabled:true}));await loading;
 assert.equal(s.$('assigned-jobs-list').children,cards);
});
test('old-account action cannot post using a newly obtained session',async()=>{
 const s=setup();await flush();s.api.setOrg('org');s.api.setUpdates(true);const pending=deferred();s.setSession(()=>pending.promise);
 const transition=s.api.transitionAssignedJob({id:'old-job',title:'Old job'},'start');await flush();s.api.clearWorksites();s.api.setOrg('org');
 pending.resolve({data:{session:{access_token:'different-user'}}});await transition;
 assert.equal(s.requests.filter(r=>r.options?.method==='POST').length,0);
});
test('old worksite response cannot overwrite a new session in the same org',async()=>{
 const s=setup();await flush();s.api.setOrg('same-org');const pending=deferred();s.setWorksite(()=>pending.promise);const loading=s.api.loadWorksites();await flush();
 s.api.clearWorksites();s.api.setOrg('same-org');pending.resolve({data:[{id:'old',name:'Old worksite',radius_m:100}]});await loading;
 assert.equal(s.$('worksite-list').textContent,'No employer worksites loaded.');assert.equal(s.$('boundary-check').disabled,true);
});

test('manual refresh cannot invalidate an in-flight job transition',async()=>{
 const s=setup();await flush();s.api.setOrg('org');s.api.setUpdates(true);const pending=deferred();s.setSession(()=>pending.promise);
 s.setFetch(async url=>response(url.endsWith('/transition')?{ok:true,jobUpdated:true}:url.endsWith('/health')?{ok:true,employeeJobUpdatesEnabled:false}:jobs('Current job')));
 const transition=s.api.transitionAssignedJob({id:'fixture',title:'Current job'},'start');await flush();await s.api.loadAssignedJobs();assert.equal(s.requests.length,0);
 pending.resolve({data:{session:{access_token:'fixture'}}});await transition;
 assert.equal(s.requests.filter(r=>r.options?.method==='POST').length,1);assert.match(s.$('jobs-status').textContent,/assigned job/);
});
