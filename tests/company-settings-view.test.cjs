const {test}=require('node:test'),assert=require('node:assert/strict'),{mount}=require('../company-settings.js');
const settings={name:'Fixture company',timeZone:'America/Phoenix',weekStartsOn:1,revision:1};
function setup(){
 const elements=new Map(),$=id=>{if(!elements.has(id))elements.set(id,{value:'',disabled:false,hidden:true,textContent:'',addEventListener(){},setAttribute(){},append(){},reset(){for(const [key,el] of elements)if(key.startsWith('company-'))el.value='';}});return elements.get(id);};
 let listener,handler=async()=>({ok:true,json:async()=>({ok:true,organizationScoped:true,settings})}),user='owner';const requests=[];
 const client={auth:{getSession:async()=>({data:{session:{access_token:'fixture',user:{id:user}}}}),onAuthStateChange:callback=>listener=callback}};
 const api=mount({document:{getElementById:$,createElement:()=>({})},client,verifyOwner:async()=> 'organization',apiBase:'https://worker.invalid',fetcher:async(url,options)=>{requests.push({url,options});return handler();}});
 return {$,api,requests,setHandler:value=>handler=value,signOut:()=>{user=null;listener('SIGNED_OUT',null);},switchUser:()=>{user='other';listener('SIGNED_IN',{user:{id:user}});}};
}
test('company preferences load without saving and save uses loaded revision',async()=>{
 const s=setup();await s.api.load();assert.equal(s.requests[0].options.method,'GET');assert.equal(s.$('company-name').value,'Fixture company');assert.equal(s.$('company-settings-save').disabled,false);
 s.$('company-name').value='Renamed';await s.api.save();assert.equal(s.requests[1].options.method,'PUT');assert.equal(JSON.parse(s.requests[1].options.body).revision,1);assert.equal(JSON.parse(s.requests[1].options.body).name,'Renamed');
});
test('conflict requires reload rather than silently overwriting another edit',async()=>{
 const s=setup();await s.api.load();s.setHandler(async()=>({ok:false,status:409,json:async()=>({error:'settings_conflict'})}));await s.api.save();assert.match(s.$('company-settings-status').textContent,/another window/);assert.equal(s.$('company-settings-save').disabled,true);
 const before=s.requests.length;await s.api.save();assert.equal(s.requests.length,before);
});
test('account change clears loaded company values and blocks a late response',async()=>{
 const s=setup();await s.api.load();let release;s.setHandler(()=>new Promise(resolve=>release=resolve));const pending=s.api.load();await new Promise(resolve=>setImmediate(resolve));s.switchUser();release({ok:true,json:async()=>({ok:true,organizationScoped:true,settings})});await pending;
 assert.equal(s.$('company-name').value,'');assert.equal(s.$('company-settings-save').disabled,true);assert.equal(s.$('company-settings').hidden,true);
});
