(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.IroncrestCompanySettings=api;})(typeof globalThis==='object'?globalThis:this,function(){
 'use strict';
 function mount({document,client,verifyOwner,apiBase,fetcher=fetch}){
  const $=id=>document.getElementById(id),panel=$('company-settings'),open=$('company-settings-open');if(!panel||!open)return;
  const form=$('company-settings-form'),status=$('company-settings-status'),save=$('company-settings-save'),reload=$('company-settings-reload');
  let revision=null,generation=0,busy=false,controller=null,identity=null;
  const clear=()=>{++generation;controller?.abort();controller=null;revision=null;busy=false;identity=null;form.reset();panel.hidden=true;open.setAttribute('aria-expanded','false');save.disabled=true;reload.disabled=false;status.textContent='Load company settings to begin.';};
  function display(settings){
   if(!settings||typeof settings.name!=='string'||typeof settings.timeZone!=='string'||!Number.isInteger(settings.weekStartsOn)||settings.weekStartsOn<0||settings.weekStartsOn>6||!Number.isSafeInteger(settings.revision)||settings.revision<0)throw Error('Company settings could not be verified.');
   $('company-name').value=settings.name;$('company-time-zone').value=settings.timeZone;$('company-week-start').value=String(settings.weekStartsOn);revision=settings.revision;
   $('owner-org').textContent=settings.name;
  }
  async function run(write){
   if(busy)return;busy=true;const version=++generation;controller=new AbortController();save.disabled=true;reload.disabled=true;
   let payload;if(write)payload={name:$('company-name').value.trim(),timeZone:$('company-time-zone').value.trim(),weekStartsOn:Number($('company-week-start').value),revision};
   status.textContent=write?'Saving company settings…':'Loading company settings…';
   try{
    if(write&&revision===null)throw Error('Load the latest settings before saving.');
    const org=await verifyOwner();if(version!==generation)return;
    const {data,error}=await client.auth.getSession();if(version!==generation)return;
    if(error||!data?.session?.access_token||!data.session.user?.id)throw Error('Please sign in again.');
    const user=data.session.user.id;identity=user;
    const response=await fetcher(apiBase+'/api/company/settings',{method:write?'PUT':'GET',headers:{Authorization:'Bearer '+data.session.access_token,...(write?{'Content-Type':'application/json'}:{})},...(write?{body:JSON.stringify(payload)}:{}),cache:'no-store',referrerPolicy:'no-referrer',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000)])});
    const result=await response.json();if(version!==generation)return;
    if(!response.ok){if(response.status===409)revision=null;throw Error(response.status===409?'These settings changed in another window. Reload before saving again.':response.status===401?'Your session expired. Please sign in again.':response.status===403?'Verified Business owner access is required.':response.status===400?'Check the company name, time zone, and workweek.':response.status===429?'Please wait before trying again.':'Company settings are temporarily unavailable.');}
    const latestOrg=await verifyOwner();const latest=await client.auth.getSession();if(version!==generation)return;
    if(latestOrg!==org||latest.error||latest.data?.session?.user?.id!==user)throw Error('Account changed. Reload company settings.');
    if(result?.ok!==true||result.organizationScoped!==true)throw Error('Company settings could not be verified.');
    display(result.settings);status.textContent=write?'Company settings saved.':'Company settings loaded. Changes are saved only when you select Save.';
   }catch(error){if(version===generation)status.textContent=error?.name==='AbortError'?'Request cancelled.':error.message||'Unable to load company settings.';}
   finally{if(version===generation){busy=false;save.disabled=revision===null;reload.disabled=false;}}
  }
  const zones=[...new Set(['UTC','America/Phoenix','America/New_York','America/Chicago','America/Denver','America/Los_Angeles',...(typeof Intl.supportedValuesOf==='function'?Intl.supportedValuesOf('timeZone'):[])])];
  for(const zone of zones){const option=document.createElement('option');option.value=zone;$('company-time-zones').append(option);}
  open.disabled=false;open.addEventListener('click',()=>{panel.hidden=false;open.setAttribute('aria-expanded','true');run(false);});
  $('company-settings-close').addEventListener('click',clear);reload.addEventListener('click',()=>run(false));
  form.addEventListener('submit',event=>{event.preventDefault();if(form.reportValidity())run(true);});
  client.auth.onAuthStateChange((event,session)=>{if(event==='SIGNED_OUT'||event==='USER_DELETED'||(identity&&session?.user?.id!==identity))clear();});
  return {clear,load:()=>run(false),save:()=>run(true)};
 }
 return {mount};
});
