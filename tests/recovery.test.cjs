const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../accept-invitation.html'),'utf8');const source=html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
async function flush(){for(let i=0;i<25;i++)await Promise.resolve();}
function setup({token=false}={}){
 const nodes=new Map();function $(id){if(!nodes.has(id)){const hidden=new Set(['hidden']);nodes.set(id,{value:'',disabled:false,textContent:'',classList:{add:c=>hidden.add(c),remove:c=>hidden.delete(c),contains:c=>hidden.has(c)},addEventListener:(e,fn)=>{nodes.get(id)[e]=fn;}});}return nodes.get(id);}
 let callback;let user={id:'fixture-user',email_confirmed_at:'confirmed'};let updater=async()=>({error:null});const updates=[];
 const auth={getUser:async()=>({data:{user}}),updateUser:async data=>{updates.push(data);return updater(data);},onAuthStateChange:fn=>callback=fn};
 const storage=new Map(token?[['ironcrest-pending-invitation-v1','a'.repeat(64)]]:[]);
 const ctx={window:{supabase:{createClient:()=>({auth})},location:{assign(){}}},location:{search:'',hash:'',origin:'https://ironcrest.profitharborai.com',pathname:'/accept-invitation.html'},history:{replaceState(){}},sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},document:{getElementById:$},URLSearchParams,setTimeout:fn=>Promise.resolve().then(fn),fetch:()=>{throw Error('No worker call should occur');}};
 vm.runInNewContext(source,ctx);
 return {$,updates,setUser:u=>user=u,setUpdater:fn=>updater=fn,event:async event=>{callback(event);await flush();}};
}
test('recovery without a pending invitation verifies the user and shows reset form',async()=>{
 const s=setup();await s.event('PASSWORD_RECOVERY');assert.equal(s.$('recovery-ui').classList.contains('hidden'),false);assert.equal(s.$('save-password').disabled,false);
});
test('ordinary signed-in user cannot submit a password change without recovery',async()=>{
 const s=setup({token:true});await s.event('SIGNED_IN');s.$('new-password').value=s.$('confirm-password').value='fixture-password';s.$('recovery-form').submit({preventDefault(){}});await flush();assert.equal(s.updates.length,0);
});
test('valid matching password is updated once and sensitive fields are cleared',async()=>{
 const s=setup();await s.event('PASSWORD_RECOVERY');s.$('new-password').value=s.$('confirm-password').value='fixture-password';s.$('recovery-form').submit({preventDefault(){}});await flush();
 assert.equal(s.updates.length,1);assert.equal(s.$('new-password').value,'');assert.equal(s.$('confirm-password').value,'');assert.match(s.$('notice').textContent,/Password updated/);assert.equal(s.$('recovery-done').classList.contains('hidden'),false);
});
test('mismatch, expired session and switched account do not update passwords',async()=>{
 for(const mode of ['mismatch','expired','changed']){
  const s=setup();if(mode==='expired')s.setUser(null);await s.event('PASSWORD_RECOVERY');
  s.$('new-password').value='fixture-password';s.$('confirm-password').value=mode==='mismatch'?'different-password':'fixture-password';
  if(mode==='changed')s.setUser({id:'another-user'});
  s.$('recovery-form').submit({preventDefault(){}});await flush();assert.equal(s.updates.length,0);
 }
});
test('provider rejection clears entered passwords and allows correction',async()=>{
 const s=setup();s.setUpdater(async()=>({error:{message:'private provider details'}}));await s.event('PASSWORD_RECOVERY');s.$('new-password').value=s.$('confirm-password').value='fixture-password';s.$('recovery-form').submit({preventDefault(){}});await flush();
 assert.equal(s.$('new-password').value,'');assert.equal(s.$('save-password').disabled,false);assert.doesNotMatch(s.$('notice').textContent,/private provider/);
});
test('sign-out invalidates an active recovery form',async()=>{
 const s=setup();await s.event('PASSWORD_RECOVERY');await s.event('SIGNED_OUT');s.$('new-password').value=s.$('confirm-password').value='fixture-password';s.$('recovery-form').submit({preventDefault(){}});await flush();assert.equal(s.updates.length,0);assert.equal(s.$('recovery-ui').classList.contains('hidden'),true);
});
