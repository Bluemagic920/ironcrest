const {test}=require('node:test');const assert=require('node:assert/strict');
const {entrySummary,rowsCsv,mount}=require('../attendance-records.js');
const window={start:'2026-11-01T00:00:00.000Z',end:'2026-11-03T00:00:00.000Z'};const now=Date.parse('2026-11-10T12:00:00Z');
const entry=(fields={})=>({id:'fixture',employee_user_id:'employee-one',worksite_id:'site-one',clock_in_at:'2026-11-01T08:00:00Z',clock_out_at:'2026-11-01T16:30:00Z',...fields});
test('closed hours are clipped to the selected UTC window across midnight',()=>{
 assert.equal(entrySummary(entry(),window,now).seconds,8.5*3600);
 assert.equal(entrySummary(entry({clock_in_at:'2026-10-31T22:00:00Z',clock_out_at:'2026-11-01T02:00:00Z'}),window,now).seconds,7200);
 assert.equal(entrySummary(entry({clock_in_at:'2026-11-02T22:00:00Z',clock_out_at:'2026-11-03T02:00:00Z'}),window,now).seconds,7200);
});
test('open shifts contribute no unapproved hours; invalid chronology requires review',()=>{
 assert.deepEqual(entrySummary(entry({clock_out_at:null}),window,now),{state:'Open shift',seconds:0});
 for(const fields of [{clock_in_at:'bad'},{clock_out_at:'2026-10-01T00:00:00Z'},{clock_out_at:'2027-01-01T00:00:00Z'}])assert.equal(entrySummary(entry(fields),window,now).state,'Needs review');
 assert.match(entrySummary(entry({clock_in_exception_id:'fixture'}),window,now).state,/exception/);
});
test('CSV quotes embedded content and blocks spreadsheet formulas',()=>{
 const csv=rowsCsv([['Name','Notes'],['=HYPERLINK("bad")','line1\nline2'],[' +SUM(1)','@evil']]);
 assert.ok(csv.startsWith('\uFEFF'));assert.match(csv,/'=HYPERLINK\(""bad""\)/);assert.match(csv,/' \+SUM/);assert.match(csv,/'@evil/);assert.match(csv,/"line1\nline2"/);
});
function node(){return {value:'',textContent:'',disabled:false,hidden:false,children:[],listeners:{},setAttribute(){},scrollIntoView(){},addEventListener(type,fn){this.listeners[type]=fn;},replaceChildren(...children){this.children=children;},appendChild(child){this.children.push(child);}};}
function setup(mode={}){const nodes=new Map();const $=id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);};let authEvent;let handler;const requests=[],downloads=[];
 const client={auth:{getSession:async()=>({data:{session:{access_token:'fixture-token'}}}),onAuthStateChange:fn=>authEvent=fn}};
 const api=mount({document:{getElementById:$,createElement:node},client,verifyOwner:async()=>'fixture-org',apiBase:'https://example.invalid',...mode,fetcher:(url,options)=>{requests.push({url,options});return handler(url,options);},download:(...args)=>downloads.push(args)});
 return {$,api,requests,downloads,setHandler:fn=>handler=fn,authEvent:()=>authEvent()};}
const report=()=>({ok:true,readOnly:true,organizationScoped:true,window,entries:[entry()],exceptions:[],employeeNames:{'employee-one':'Fixture employee'},worksiteNames:{'site-one':'Office'}});
test('report loading is GET-only; export uses displayed verified records',async()=>{
 const s=setup();s.setHandler(async()=>({ok:true,json:async()=>report()}));await s.api.load();
 assert.equal(s.requests[0].options.method,'GET');assert.equal(s.$('attendance-records-export').disabled,false);
 s.$('attendance-records-export').listeners.click();assert.equal(s.downloads.length,1);assert.match(s.downloads[0][0],/Fixture employee/);
 s.$('attendance-employee').value='different';s.$('attendance-employee').listeners.change();assert.equal(s.$('attendance-records-export').disabled,true);
});
test('late report after account change cannot restore private rows or export',async()=>{
 const s=setup();let finish;s.setHandler(()=>new Promise(resolve=>finish=resolve));const loading=s.api.load();for(let i=0;i<10;i++)await Promise.resolve();
 s.authEvent();finish({ok:true,json:async()=>report()});await loading;
 assert.equal(s.$('attendance-records-body').children.length,0);assert.equal(s.$('attendance-records-export').disabled,true);assert.equal(s.$('attendance-employee').children.length,1);
});
test('truncated response is visibly disclosed and unverified data never export',async()=>{
 const s=setup();s.setHandler(async()=>({ok:true,json:async()=>({...report(),entriesTruncated:true})}));await s.api.load();assert.match(s.$('attendance-records-status').textContent,/first 200/);
 s.setHandler(async()=>({ok:true,json:async()=>({...report(),organizationScoped:false})}));await s.api.load();assert.equal(s.$('attendance-records-export').disabled,true);assert.equal(s.$('attendance-records-body').children.length,0);
});

test('overlapping employee shifts are excluded from hours, but adjacent/different-employee shifts are valid',()=>{
 const {analyzeEntries}=require('../attendance-records.js');
 const first=entry();const overlap=entry({id:'second',clock_in_at:'2026-11-01T12:00:00Z',clock_out_at:'2026-11-01T18:00:00Z'});
 const sums=analyzeEntries([first,overlap],window,now);assert.equal(sums.reduce((sum,row)=>sum+row.seconds,0),0);assert.ok(sums.every(row=>row.state.includes('overlapping')));
 assert.ok(analyzeEntries([first,{...overlap,employee_user_id:'another'}],window,now).every(row=>row.seconds>0));
 assert.ok(analyzeEntries([first,{...overlap,clock_in_at:first.clock_out_at}],window,now).every(row=>row.seconds>0));
});
test('timestamps require explicit timezone and a valid calendar date',()=>{
 for(const clock_in_at of ['2026-02-30T08:00:00Z','2026-11-01T08:00:00','2026-11-01T25:00:00Z'])assert.equal(entrySummary(entry({clock_in_at}),window,now).state,'Needs review');
 assert.equal(entrySummary(entry({clock_in_at:'2026-11-01T10:00:00+02:00'}),window,now).seconds,8.5*3600);
});

test('employee view uses its own endpoint and rejects an organization-wide response',async()=>{
 const s=setup({endpoint:'/api/attendance/my-records',selfOnly:true});s.setHandler(async()=>({ok:true,json:async()=>({...report(),selfScoped:true})}));await s.api.load();
 assert.ok(s.requests[0].url.includes('/api/attendance/my-records?'));assert.equal(s.$('attendance-records-export').disabled,false);
 s.setHandler(async()=>({ok:true,json:async()=>report()}));await s.api.load();assert.equal(s.$('attendance-records-export').disabled,true);
});
test('expired session is distinguished from unavailable reporting service',async()=>{
 const s=setup();s.setHandler(async()=>({ok:false,status:401,json:async()=>({error:'verified_owner_required'})}));await s.api.load();assert.match(s.$('attendance-records-status').textContent,/session expired/);assert.equal(s.$('attendance-records-export').disabled,true);
});
