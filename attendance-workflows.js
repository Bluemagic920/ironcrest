(function(root){'use strict';
 const API='https://ironcrest-invitations-api.bluemagic920.workers.dev',UUID=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
 function mount({document,client,getContext,fetcher=root.fetch.bind(root),storage=root.sessionStorage,randomUUID=()=>root.crypto.randomUUID(),confirmAction=message=>root.confirm(message),getPosition=()=>new Promise((resolve,reject)=>root.navigator.geolocation.getCurrentPosition(resolve,reject,{enableHighAccuracy:true,maximumAge:0,timeout:12000}))}){
  const $=id=>document.getElementById(id),panel=$('attendance-workflow-panel');if(!panel)return null;
  const output=$('attendance-workflow-result'),site=$('attendance-workflow-site'),inButton=$('attendance-workflow-in'),outButton=$('attendance-workflow-out'),recoverButton=$('attendance-workflow-recover'),reload=$('attendance-workflow-refresh');
  let generation=0,busy=false,ready=false,identity=null,openShift=null,pending=null,storageBroken=false,assignedSiteIds=new Set();
  const key=id=>'ironcrest-attendance-pending-v1:'+id;
  const say=message=>{output.textContent=message;};
  function controls(){inButton.disabled=!ready||busy||!!pending||storageBroken||!!openShift||!assignedSiteIds.has(site.value);outButton.disabled=!ready||busy||!!pending||storageBroken||!openShift||!assignedSiteIds.has(openShift.worksiteId);recoverButton.hidden=!pending;recoverButton.disabled=!ready||busy||!pending||storageBroken;reload.disabled=busy;site.disabled=busy||!!pending||!!openShift;}
  function clear(){generation++;busy=false;ready=false;identity=null;openShift=null;pending=null;storageBroken=false;assignedSiteIds=new Set();panel.hidden=true;site.replaceChildren();say('Sign in and refresh attendance to check your current shift.');controls();}
  const same=(g,id)=>g===generation&&getContext()?.organizationId===id.org&&identity?.userId===id.userId;
  async function verified(g){
   const org=getContext()?.organizationId;if(!UUID.test(org||''))throw Error('Sign in to your employee company first.');
   const {data,error}=await client.auth.getUser();if(error||!UUID.test(data?.user?.id||'')||!data.user.email_confirmed_at)throw Error('Verified sign-in required.');
   const {data:sessionData,error:sessionError}=await client.auth.getSession();const session=sessionData?.session;
   if(sessionError||!session?.access_token||session.user?.id!==data.user.id)throw Error('Sign in again before recording attendance.');
   if(g!==generation||org!==getContext()?.organizationId)throw Error('Account changed. Reload attendance.');
   return {org,userId:data.user.id,token:session.access_token};
  }
  async function request(path,id,body){
   const response=await fetcher(API+'/api/attendance/workflows/'+path,{method:body?'POST':'GET',cache:'no-store',referrerPolicy:'no-referrer',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+id.token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
   const data=await response.json();return {response,data};
  }
  function readPending(id){
   const raw=storage.getItem(key(id.userId));if(raw===null)return null;
   const value=JSON.parse(raw);
   if(!value||Object.keys(value).sort().join(',')!=='action,expectedEntryId,operationId,organizationId,worksiteId'||value.organizationId!==id.org||!UUID.test(value.operationId)||!UUID.test(value.worksiteId)||!['clock_in','clock_out'].includes(value.action)||(value.action==='clock_in'?value.expectedEntryId!==null:!UUID.test(value.expectedEntryId)))throw Error();
   return value;
  }
  async function refresh(){
   if(busy)return;const g=++generation;ready=false;openShift=null;controls();
   try{
    const id=await verified(g);if(g!==generation)return;identity=id;
    const {response,data}=await request('status',id);if(!same(g,id))return;
    if(!response.ok||data?.ok!==true||data.readOnly!==true||!Array.isArray(data.worksites))throw Error('Attendance is not available for this account yet.');
    if(data.worksites.some(w=>!UUID.test(w?.id||'')||typeof w.name!=='string')||data.worksites.length>100)throw Error('Worksites could not be verified.');
    if(data.openShift!==null&&(!UUID.test(data.openShift?.entryId||'')||!UUID.test(data.openShift?.worksiteId||'')||!Number.isFinite(Date.parse(data.openShift?.clockInAt))))throw Error('Current shift could not be verified.');
    assignedSiteIds=new Set(data.worksites.map(w=>w.id));const oldSite=site.value;site.replaceChildren();for(const worksite of data.worksites){const option=document.createElement('option');option.value=worksite.id;option.textContent=worksite.name;site.appendChild(option);}
    if(data.worksites.some(w=>w.id===oldSite))site.value=oldSite;
    openShift=data.openShift;
    if(openShift&&data.worksites.some(w=>w.id===openShift.worksiteId))site.value=openShift.worksiteId;
    try{pending=readPending(id);}catch{storageBroken=true;throw Error('The saved attendance action needs review. Do not submit another action; contact your company owner.');}
    ready=true;panel.hidden=false;
    say(pending?'A previous action has not been confirmed. Recover that same action; do not submit a new one.':openShift?!assignedSiteIds.has(openShift.worksiteId)?'Your open shift is at a worksite that is no longer assigned. Contact your company owner for review.':'Clocked in since '+new Date(openShift.clockInAt).toLocaleString()+'.':'You are clocked out. Choose an assigned worksite to begin.');
   }catch(error){if(g===generation){panel.hidden=false;say(String(error?.message||'Unable to check attendance.'));}}
   finally{if(g===generation)controls();}
  }
  async function submit(action,recover=false){
   if(busy||!ready||storageBroken||!identity||(!recover&&pending)||recover&&!pending)return;
   if(!recover&&((action==='clock_in'&&(openShift||!assignedSiteIds.has(site.value)))||(action==='clock_out'&&(!openShift||!assignedSiteIds.has(openShift.worksiteId)))))return;
   const g=generation,id={...identity};
   const operation=recover?{...pending}:{organizationId:id.org,operationId:randomUUID(),worksiteId:action==='clock_out'?openShift.worksiteId:site.value,action,expectedEntryId:action==='clock_out'?openShift.entryId:null};
   if(!UUID.test(operation.operationId)||!UUID.test(operation.worksiteId))return;
   if(!confirmAction(recover?'Recover the same attendance action? This cannot create a second copy of that action.':action==='clock_in'?'Clock in now at the selected worksite? Your location will be checked once.':'Clock out of your current shift now? Your location will be checked once.'))return;
   busy=true;controls();say('Checking a fresh device location…');let submitted=false;
   try{
    const fresh=await verified(g);if(!same(g,id)||fresh.userId!==id.userId)throw Error('Account changed. Reload attendance.');
    const position=await getPosition();if(!same(g,id))return;
    const {latitude,longitude,accuracy}=position?.coords||{},timestamp=position?.timestamp;
    if(!Number.isFinite(latitude)||Math.abs(latitude)>90||!Number.isFinite(longitude)||Math.abs(longitude)>180||!Number.isFinite(accuracy)||accuracy<0||accuracy>100||!Number.isFinite(timestamp)||timestamp>Date.now()+5000||timestamp<Date.now()-30000)throw Error('A fresh location accurate to 100 metres or better is required. Nothing submitted.');
    const latest=await verified(g);if(!same(g,id)||latest.userId!==id.userId)throw Error('Account changed. Reload attendance.');
    // Persist only operation identity, never coordinates or credentials. If this
    // cannot be saved, do not risk a write whose recovery identity could be lost.
    storage.setItem(key(id.userId),JSON.stringify(operation));pending=operation;submitted=true;say('Submitting attendance…');
    const {response,data}=await request(operation.action==='clock_in'?'clock-in':'clock-out',latest,{operationId:operation.operationId,worksiteId:operation.worksiteId,expectedEntryId:operation.expectedEntryId,latitude,longitude,accuracyMeters:accuracy,sampleTimestamp:timestamp});
    if(!same(g,id))return;
    if(response.ok&&data?.ok===true&&data.attendanceRecorded===true&&data.result?.operationId===operation.operationId&&UUID.test(data.result.entryId||'')&&data.result.action===operation.action&&(operation.action!=='clock_out'||data.result.entryId===operation.expectedEntryId)){
     storage.removeItem(key(id.userId));pending=null;busy=false;await refresh();if(same(generation,id))say('Attendance confirmed. '+(openShift?'You are clocked in.':'You are clocked out.'));return;
    }
    if(data?.attendanceRecorded===false){storage.removeItem(key(id.userId));pending=null;throw Error(String(data.error||'Attendance was not submitted.'));}
    throw Error('Outcome not confirmed. Recover the same saved action before doing anything else.');
   }catch(error){if(same(g,id))say(submitted&&pending?'Outcome not confirmed. Recover the same saved action. Do not create a replacement action.':String(error?.message||'Location unavailable. Nothing submitted.'));}
   finally{if(same(g,id)){busy=false;controls();}}
  }
  inButton.addEventListener('click',()=>submit('clock_in'));outButton.addEventListener('click',()=>submit('clock_out'));recoverButton.addEventListener('click',()=>submit(pending?.action,true));reload.addEventListener('click',refresh);site.addEventListener('change',controls);
  client.auth.onAuthStateChange(clear);clear();return {refresh,clear};
 }
 const api={mount};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.IroncrestAttendanceWorkflows=api;
})(typeof window!=='undefined'?window:globalThis);
