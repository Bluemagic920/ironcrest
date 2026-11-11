(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.IroncrestEmployeeProfile=api;})(typeof globalThis==='object'?globalThis:this,function(){
 'use strict';
 function mount({document,client,verifyEmployee,apiBase,fetcher=fetch}){
  const $=id=>document.getElementById(id),panel=$('employee-profile-panel'),open=$('employee-profile-open');if(!panel||!open)return;
  const form=$('employee-profile-form'),status=$('employee-profile-status'),save=$('employee-profile-save'),reload=$('employee-profile-reload');
  let generation=0,revision=null,busy=false,identity=null,controller=null,needsReload=false;
  function clear(){++generation;controller?.abort();revision=null;identity=null;busy=false;needsReload=false;form.reset();for(const id of ['employee-profile-name','employee-profile-job','employee-profile-employment'])$(id).textContent='';panel.hidden=true;open.setAttribute('aria-expanded','false');save.disabled=true;reload.disabled=false;status.textContent='Load your profile to begin.';}
  function display(profile){
   if(!profile){revision=null;$('employee-profile-name').textContent='Profile not set up';$('employee-profile-job').textContent='Contact your owner to complete your employee profile.';$('employee-profile-employment').textContent='';return false;}
   if(!Number.isSafeInteger(profile.revision)||profile.revision<1||!['active','inactive','on_leave'].includes(profile.employmentStatus))throw Error('Your profile could not be verified.');
   revision=profile.revision;$('employee-profile-name').textContent=[profile.firstName,profile.lastName].filter(x=>typeof x==='string').join(' ')||'Name not entered';$('employee-profile-job').textContent=profile.jobTitle||'Job title not entered';$('employee-profile-employment').textContent='Employment status: '+profile.employmentStatus.replace('_',' ');
   $('employee-profile-phone').value=profile.phoneNumber||'';$('employee-profile-email').value=profile.email||'';return true;
  }
  async function run(write){
   if(busy)return;if(write&&(needsReload||revision===null)){status.textContent='Reload your profile before saving.';return;}
   busy=true;const version=++generation;controller=new AbortController();save.disabled=true;reload.disabled=true;
   const payload=write?{revision,phoneNumber:$('employee-profile-phone').value.trim(),email:$('employee-profile-email').value.trim()}:null;
   if(!write){revision=null;form.reset();for(const id of ['employee-profile-name','employee-profile-job','employee-profile-employment'])$(id).textContent='';}
   status.textContent=write?'Saving your contact details…':'Loading your profile…';
   try{
    const org=await verifyEmployee();if(version!==generation)return;const session=await client.auth.getSession();if(version!==generation)return;
    if(session.error||!session.data?.session?.access_token||!session.data.session.user?.id)throw Error('Please sign in again.');
    const user=session.data.session.user.id;identity=user;if(write)needsReload=true;
    const response=await fetcher(apiBase+'/api/employee/profile',{method:write?'PATCH':'GET',headers:{Authorization:'Bearer '+session.data.session.access_token,...(write?{'Content-Type':'application/json'}:{})},...(write?{body:JSON.stringify(payload)}:{}),cache:'no-store',referrerPolicy:'no-referrer',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000)])});
    const result=await response.json();if(version!==generation)return;
    if(!response.ok)throw Error(response.status===401?'Your session expired. Please sign in again.':response.status===403?'Active employee Business membership is required.':response.status===503?'Employee profiles are not available yet.':result.error||'Unable to load your profile.');
    const latestOrg=await verifyEmployee(),latest=await client.auth.getSession();if(version!==generation)return;if(latestOrg!==org||latest.error||latest.data?.session?.user?.id!==user)throw Error('Account changed. Reload your profile.');
    if(result?.ok!==true||result.selfScoped!==true||result.organizationScoped!==true||result.contactEditsOnly!==true||write&&result.updated!==true)throw Error('Profile response could not be verified.');
    const ready=display(result.profile);needsReload=false;status.textContent=ready?(write?'Contact details saved. Your sign-in email is unchanged.':'Profile loaded. You can update your phone number and contact email below.'):'Your owner needs to complete your profile before you can edit contact details.';
   }catch(error){if(version===generation)status.textContent=(error.message||'Unable to load your profile.')+(needsReload?' Reload your profile before trying again.':'');}
   finally{if(version===generation){busy=false;save.disabled=revision===null||needsReload;reload.disabled=false;}}
  }
  open.disabled=false;open.addEventListener('click',()=>{panel.hidden=false;open.setAttribute('aria-expanded','true');panel.scrollIntoView({behavior:'smooth',block:'start'});run(false);});
  $('employee-profile-close').addEventListener('click',clear);reload.addEventListener('click',()=>run(false));form.addEventListener('submit',event=>{event.preventDefault();if(form.reportValidity())run(true);});
  client.auth.onAuthStateChange((event,session)=>{if(event==='SIGNED_OUT'||event==='USER_DELETED'||identity&&session?.user?.id!==identity)clear();});
  return {load:()=>run(false),save:()=>run(true),clear};
 }
 return {mount};
});
