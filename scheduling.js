(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.IroncrestScheduling=api;})(typeof globalThis==='object'?globalThis:this,function(){
 'use strict';
 function localParts(time,zone){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(time));return Object.fromEntries(parts.filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));}
 function localValue(time,zone){const p=localParts(time,zone);return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;}
 function localToUtc(value,zone,{boundary=false}={}){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))throw Error('Enter a valid date and time.');
  const approximate=Date.parse(value+':00.000Z');if(!Number.isFinite(approximate)||new Date(approximate).toISOString().slice(0,16)!==value)throw Error('Enter a valid date and time.');
  const offsets=new Set();for(let hours=-36;hours<=36;hours+=6){const probe=approximate+hours*3600000,p=localParts(probe,zone);offsets.add(Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.000Z`)-probe);}
  const candidates=[...offsets].map(offset=>approximate-offset).filter(time=>localValue(time,zone)===value).sort((a,b)=>a-b);
  if(!candidates.length)throw Error('This local time does not exist because the clock changes. Choose another time.');
  if(candidates.length>1&&!boundary)throw Error('This local time occurs twice when the clock changes. Choose an unambiguous time.');
  return new Date(candidates[0]).toISOString();
 }
 function addDays(date,days){const time=Date.parse(date+'T00:00:00.000Z');if(!Number.isFinite(time)||new Date(time).toISOString().slice(0,10)!==date)throw Error('Choose valid dates.');return new Date(time+days*86400000).toISOString().slice(0,10);}
 function dateWindow(start,end,zone){const next=addDays(end,1),days=(Date.parse(next)-Date.parse(start))/86400000;if(!Number.isFinite(days)||days<1||days>31)throw Error('Choose up to 31 calendar days.');return {start:localToUtc(start+'T00:00',zone,{boundary:true}),end:localToUtc(next+'T00:00',zone,{boundary:true})};}
 function weekWindow(now,zone,weekStartsOn){const date=localValue(now,zone).slice(0,10),day=new Date(date+'T00:00:00Z').getUTCDay(),start=addDays(date,-((day-weekStartsOn+7)%7));return {start,end:addDays(start,6)};}
 const messages={schedule_conflict:'This shift changed in another window. Reload the schedule.',company_time_zone_changed:'The company time zone changed. Reload the schedule before saving.',employee_schedule_overlap:'This employee already has an overlapping published shift.',active_employee_required:'Choose an active employee in your company.',active_worksite_required:'Choose an active company worksite.',future_shift_required:'Only future shifts can be published.',invalid_schedule:'Check the shift title and times. Shifts must be in the future and no longer than 24 hours.',published_shift_read_only:'Published shifts cannot be edited. Cancel and create a replacement.',shift_not_found:'This shift is no longer available.'};
 function mount({document,client,verifyOwner,apiBase,selfOnly=false,fetcher=fetch}){
  const $=id=>document.getElementById(id),panel=$('schedule-panel'),open=$('schedule-open');if(!panel||!open)return;
  const status=$('schedule-status'),body=$('schedule-body'),form=$('schedule-form'),save=$('schedule-save');
  let generation=0,identity=null,busy=false,controller=null,context=null,rows=[],editing=null,needsReload=false;
  const base=apiBase+(selfOnly?'/api/my-schedule':'/api/scheduling');
  function editorReset(){editing=null;if(form)form.reset();if(save)save.textContent='Save draft shift';$('schedule-editing')&&( $('schedule-editing').textContent='New draft shift');}
  function clear(){++generation;controller?.abort();context=null;rows=[];identity=null;busy=false;needsReload=false;body.replaceChildren();editorReset();for(const id of ['schedule-employee','schedule-worksite'])$(id)?.replaceChildren();$('schedule-start').value='';$('schedule-end').value='';$('schedule-zone').textContent='Dates and times use your company time zone.';panel.hidden=true;open.setAttribute('aria-expanded','false');status.textContent='Load your schedule to begin.';}
  function buttons(){for(const el of panel.querySelectorAll('button,input,select'))el.disabled=busy;if(needsReload){for(const el of form?.querySelectorAll('button,input,select')||[])el.disabled=true;for(const el of body.querySelectorAll('button'))el.disabled=true;$('schedule-new')&&($('schedule-new').disabled=true);}if(save)save.disabled=busy||needsReload||!context?.employees?.length||!context?.worksites?.length;}
  function options(id,values,label){const select=$(id);select.replaceChildren();const empty=document.createElement('option');empty.value='';empty.textContent=label;select.append(empty);for(const value of values){const option=document.createElement('option');option.value=value.id;option.textContent=value.name;select.append(option);}}
  function render(){
   body.replaceChildren();const format=value=>new Intl.DateTimeFormat('en',{timeZone:context.timeZone,dateStyle:'medium',timeStyle:'short'}).format(new Date(value));
   for(const row of rows){const tr=document.createElement('tr');
    const employee=selfOnly?'You':context.employees.find(e=>e.id===row.employee_user_id)?.name||'Employee '+row.employee_user_id.slice(-8),site=(context.siteLabels||context.worksites).find(s=>s.id===row.worksite_id)?.name||'Worksite '+row.worksite_id.slice(-8);
    for(const value of [row.title,employee,site,format(row.starts_at),format(row.ends_at),row.status]){const td=document.createElement('td');td.textContent=value;tr.append(td);}
    if(!selfOnly){const td=document.createElement('td');
     if(row.status==='draft'){
      const edit=document.createElement('button');edit.type='button';edit.textContent='Edit draft';edit.addEventListener('click',()=>{if(busy)return;editing={id:row.id,revision:row.revision};$('schedule-title').value=row.title;$('schedule-employee').value=row.employee_user_id;$('schedule-worksite').value=row.worksite_id;$('schedule-shift-start').value=localValue(Date.parse(row.starts_at),context.timeZone);$('schedule-shift-end').value=localValue(Date.parse(row.ends_at),context.timeZone);$('schedule-editing').textContent='Editing draft: '+row.title;save.textContent='Save draft changes';$('schedule-title').focus();});td.append(edit);
      const publish=document.createElement('button');publish.type='button';publish.textContent='Publish shift';publish.addEventListener('click',()=>perform({action:'publish',id:row.id,revision:row.revision}));td.append(publish);
     }
     if(row.status!=='cancelled'){const cancel=document.createElement('button');cancel.type='button';cancel.textContent='Cancel shift';cancel.addEventListener('click',()=>perform({action:'cancel',id:row.id,revision:row.revision}));td.append(cancel);}tr.append(td);
    }body.append(tr);
   }
   if(!rows.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=selfOnly?6:7;td.textContent='No scheduled shifts in these dates.';tr.append(td);body.append(tr);}
  }
  async function execute(task){
   if(busy)return;busy=true;const version=++generation;controller=new AbortController();buttons();
   try{
    const org=await verifyOwner();if(version!==generation)return;const session=await client.auth.getSession();if(version!==generation)return;
    if(session.error||!session.data?.session?.access_token||!session.data.session.user?.id)throw Error('Please sign in again.');
    const token=session.data.session.access_token,user=session.data.session.user.id;identity=user;
    const call=async(path,payload)=>{
     if(version!==generation)throw Error('Account changed.');
     const response=await fetcher(base+path,{method:payload?'POST':'GET',headers:{Authorization:'Bearer '+token,...(payload?{'Content-Type':'application/json'}:{})},...(payload?{body:JSON.stringify(payload)}:{}),cache:'no-store',referrerPolicy:'no-referrer',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000)])});
     const result=await response.json();if(version!==generation)throw Error('Account changed.');
     if(!response.ok)throw Error(messages[result?.error]||(response.status===401?'Your session expired. Please sign in again.':response.status===403?'Verified Business membership is required.':response.status===429?'Please wait before loading again.':response.status===503?'Scheduling is not available yet.':'Unable to complete the schedule request. Reload before retrying.'));
     const latestOrg=await verifyOwner(),latest=await client.auth.getSession();if(version!==generation||latestOrg!==org||latest.data?.session?.user?.id!==user||latest.error)throw Error('Account changed. Reload your schedule.');
     if(result?.ok!==true||result.organizationScoped!==true||(selfOnly&&result.selfScoped!==true))throw Error('Schedule response could not be verified.');return result;
    };
    await task(call,()=>version===generation);
   }catch(error){if(version===generation)status.textContent=error?.name==='AbortError'?'Request cancelled.':error.message||'Unable to load your schedule.';}
   finally{if(version===generation){busy=false;buttons();}}
  }
  async function load(){return execute(async(call,current)=>{
   status.textContent='Loading schedule…';rows=[];body.replaceChildren();const next=await call('/context');if(!current())return;
   if(typeof next.timeZone!=='string'||!Number.isInteger(next.weekStartsOn)||next.weekStartsOn<0||next.weekStartsOn>6||!Array.isArray(next.employees)||!Array.isArray(next.worksites))throw Error('Schedule preferences could not be verified.');
   new Intl.DateTimeFormat('en',{timeZone:next.timeZone}).format();
   context=next;$('schedule-zone').textContent='All schedule dates and times use '+context.timeZone+'.';
   if(!$('schedule-start').value||!$('schedule-end').value){const week=weekWindow(Date.now(),context.timeZone,context.weekStartsOn);$('schedule-start').value=week.start;$('schedule-end').value=week.end;}
   if(!selfOnly){options('schedule-employee',context.employees,'Choose an employee');options('schedule-worksite',context.worksites,'Choose a worksite');editorReset();}
   const window=dateWindow($('schedule-start').value,$('schedule-end').value,context.timeZone);const result=await call('/shifts?'+new URLSearchParams(window));if(!current())return;
   if(!Array.isArray(result.shifts)||result.shifts.length>200||!Array.isArray(result.worksites))throw Error('Schedule response could not be verified.');
   rows=result.shifts;context.siteLabels=[...context.worksites,...result.worksites];needsReload=false;render();
   status.textContent=(result.truncated?'Showing the first 200 shifts. Select a smaller date range.':'Schedule loaded. '+rows.length+' shift(s).')+(context.choicesTruncated?' Employee/worksite choices show the first 200.':'')+(!selfOnly&&(!next.employees.length||!next.worksites.length)?' Add an active employee and worksite before creating shifts.':'');
  });}
  async function perform(payload){if(selfOnly)return;if(needsReload){status.textContent='Reload the schedule before making another change.';return;}return execute(async(call,current)=>{
   status.textContent=payload.action==='save_draft'?'Saving draft shift…':payload.action==='publish'?'Publishing shift…':'Cancelling shift…';
   needsReload=true;await call('/action',payload);if(!current())return;editorReset();rows=[];body.replaceChildren();status.textContent='Shift '+(payload.action==='save_draft'?'saved as a draft':payload.action==='publish'?'published':'cancelled')+'. Reload the schedule to see the latest shifts.';
  });}
  open.disabled=false;open.addEventListener('click',()=>{panel.hidden=false;open.setAttribute('aria-expanded','true');load();});
  $('schedule-close').addEventListener('click',clear);$('schedule-reload').addEventListener('click',load);
  if(!selfOnly){$('schedule-new').addEventListener('click',()=>{if(!busy)editorReset();});form.addEventListener('submit',event=>{event.preventDefault();if(busy||!context||!form.reportValidity())return;
   try{const start=localToUtc($('schedule-shift-start').value,context.timeZone),end=localToUtc($('schedule-shift-end').value,context.timeZone);if(Date.parse(end)<=Date.parse(start)||Date.parse(end)-Date.parse(start)>86400000)throw Error('A shift must end after it starts and last no longer than 24 hours.');
    perform({action:'save_draft',id:editing?.id??null,revision:editing?.revision??0,employeeId:$('schedule-employee').value,worksiteId:$('schedule-worksite').value,title:$('schedule-title').value.trim(),start,end,timeZone:context.timeZone});
   }catch(error){status.textContent=error.message;}
  });}
  client.auth.onAuthStateChange((event,session)=>{if(event==='SIGNED_OUT'||event==='USER_DELETED'||identity&&session?.user?.id!==identity)clear();});
  return {load,perform,clear};
 }
 return {mount,localValue,localToUtc,dateWindow,weekWindow};
});
