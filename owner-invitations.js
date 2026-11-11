(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.IroncrestOwnerInvitations=api;})(typeof globalThis==='object'?globalThis:this,function(){
 'use strict';
 const validLink=value=>typeof value==='string'&&/^https:\/\/ironcrest\.profitharborai\.com\/accept-invitation\.html#invite=[a-f0-9]{64}$/.test(value);
 const delivery={not_submitted:'Not submitted',pending:'Not submitted yet',sending:'Delivery not confirmed',accepted:'Email submission accepted',delivered:'Delivered',bounced:'Bounced',failed:'Email submission failed',unknown:'Outcome needs review',cancelled:'Cancelled',accepted_audit_pending:'Email accepted; delivery record needs review'};
 function mount({document,client,verifyOwner,apiBase,fetcher=fetch,copyText=text=>navigator.clipboard.writeText(text)}){
  const $=id=>document.getElementById(id),panel=$('owner-invitations-panel');if(!panel)return;
  const form=$('owner-invitation-form'),status=$('owner-invitation-status'),list=$('owner-invitation-list'),send=$('owner-invitation-send'),reload=$('owner-invitation-reload');
  let generation=0,busy=false,identity=null,loadedUser=null,loadedOrg=null,ready=false,needsReload=false,privateLink=null,canSend=false,controller=null;
  function forgetLink(){privateLink=null;$('owner-invitation-private-url').value='';$('owner-invitation-private-box').hidden=true;}
  function controls(){for(const node of panel.querySelectorAll('button,input,select'))node.disabled=busy;send.disabled=busy||!ready||needsReload||!canSend;if(needsReload)for(const node of list.querySelectorAll('button'))node.disabled=true;}
  function clear(){++generation;controller?.abort();busy=false;ready=false;needsReload=false;identity=null;loadedUser=null;loadedOrg=null;canSend=false;forgetLink();form.reset();list.replaceChildren();$('owner-invitation-capacity').textContent='';status.textContent='Load invitations to begin.';$('legacy-invite-controls').hidden=false;controls();}
  const base=apiBase+'/api/employees/invitations';
  async function execute(write,task){
   if(busy)return;busy=true;const version=++generation;controller=new AbortController();controls();
   try{
    const org=await verifyOwner();if(version!==generation)return;const auth=await client.auth.getSession();if(version!==generation)return;
    if(auth.error||!auth.data?.session?.access_token||!auth.data.session.user?.id)throw Error('Please sign in again.');const user=auth.data.session.user.id;
    if(write&&(!ready||needsReload||loadedUser!==user||loadedOrg!==org))throw Error('Your owner session changed. Reload invitations before making changes.');identity=user;
    const call=async(path='',payload)=>{
     if(version!==generation)throw Error('Account changed.');const response=await fetcher(base+path,{method:payload?'POST':'GET',headers:{Authorization:'Bearer '+auth.data.session.access_token,...(payload?{'Content-Type':'application/json'}:{})},...(payload?{body:JSON.stringify(payload)}:{}),cache:'no-store',referrerPolicy:'no-referrer',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(45000)])});
     const result=await response.json();if(version!==generation)throw Error('Account changed.');const latestOrg=await verifyOwner(),latest=await client.auth.getSession();if(version!==generation||latestOrg!==org||latest.error||latest.data?.session?.user?.id!==user)throw Error('Owner account changed. Reload invitations.');
     if(!response.ok&&result.invitationCreated!==true)throw Error(response.status===401?'Your session expired. Please sign in again.':response.status===403?'Verified Business owner access is required.':response.status===503&&result.error==='owner_invitations_not_released'?'Normal invitations are awaiting activation.':result.error||'Invitation request outcome is unclear. Reload before trying again.');
     if(result.organizationScoped!==true)throw Error('Invitation response could not be verified.');return result;
    };
    await task(call,()=>version===generation,user,org);
   }catch(error){if(version===generation)status.textContent=(error.message||'Invitation service unavailable.')+(needsReload?' Refresh invitations before another attempt.':'');}
   finally{if(version===generation){busy=false;controls();}}
  }
  function render(rows){
   list.replaceChildren();const format=value=>Number.isFinite(Date.parse(value))?new Intl.DateTimeFormat('en',{dateStyle:'medium',timeStyle:'short'}).format(new Date(value)):'Unavailable';
   for(const row of rows){const card=document.createElement('article');card.className='owner-invitation-card';const email=document.createElement('strong');email.textContent=row.email;const detail=document.createElement('p');detail.textContent=row.status+' · '+(delivery[row.deliveryStatus]||'Delivery not confirmed')+' · Expires '+format(row.expires_at);card.append(email,detail);
    if(row.status==='pending'){const revoke=document.createElement('button');revoke.type='button';revoke.textContent='Revoke pending invitation';revoke.addEventListener('click',()=>perform({id:row.id}));card.append(revoke);}list.append(card);
   }
   if(!rows.length){const empty=document.createElement('p');empty.textContent='No invitations match this view.';list.append(empty);}
  }
  async function load(){return execute(false,async(call,current,user,org)=>{
   ready=false;forgetLink();list.replaceChildren();status.textContent='Loading invitations…';const params=new URLSearchParams();params.set('status',$('owner-invitation-filter').value||'all');const search=$('owner-invitation-search').value.trim();if(search)params.set('email',search);
   const result=await call('?'+params);if(!current())return;if(!Array.isArray(result.invitations)||result.invitations.length>100||!result.capacity||!Number.isSafeInteger(result.capacity.occupiedSlots))throw Error('Invitation list could not be verified.');
   loadedUser=user;loadedOrg=org;ready=true;needsReload=false;canSend=result.emailConfigured===true&&result.acceptanceEnabled===true&&(result.capacity.unlimited===true||result.capacity.occupiedSlots<result.capacity.employeeLimit);
   $('owner-invitation-capacity').textContent=result.capacity.activeEmployees+' active employees · '+result.capacity.pendingInvitations+' pending invitations · '+(result.capacity.unlimited?'Unlimited team capacity':result.capacity.occupiedSlots+' of '+result.capacity.employeeLimit+' team places used');
   $('legacy-invite-controls').hidden=true;render(result.invitations);status.textContent=(result.truncated?'Showing the newest 100 invitations. Search by exact email or filter by status.':result.invitations.length+' invitation(s).')+(!result.acceptanceEnabled?' Invitation acceptance is not available yet.':!result.emailConfigured?' Email delivery is not configured.':!canSend?' Team capacity is full. Revoke an unused pending invitation or review your plan.':'');
  });}
  async function perform(revokePayload){return execute(true,async(call,current)=>{
   forgetLink();needsReload=true;status.textContent=revokePayload?'Revoking pending invitation…':'Creating invitation and submitting email…';const result=await call(revokePayload?'/revoke':'',revokePayload||{email:$('owner-invitation-email').value.trim()});if(!current())return;ready=false;list.replaceChildren();
   if(revokePayload){if(result.revoked!==true)throw Error('Revocation was not verified.');status.textContent='Invitation revoked. Existing employee memberships were not changed. Refresh invitations to continue.';return;}
   if(result.invitationCreated!==true)throw Error('Invitation creation was not verified.');
   if(validLink(result.privateInvitationUrl)){privateLink=result.privateInvitationUrl;$('owner-invitation-private-url').value=privateLink;$('owner-invitation-private-box').hidden=false;}
   status.textContent=result.deliveryStatus==='accepted'?'Invitation created and email submission accepted. Inbox delivery is not confirmed. Copy the private link now if needed, then refresh invitations.':result.deliveryStatus==='failed'?'Invitation created, but email submission failed. You can copy the private link for this recipient. Refresh invitations to review before another attempt.':'Invitation created, but email delivery needs review. Do not send it again automatically. Copy the private link if needed, then refresh invitations.';
  });}
  $('employee-open').addEventListener('click',()=>load());reload.addEventListener('click',load);$('owner-invitation-filter').addEventListener('change',load);$('owner-invitation-search-button').addEventListener('click',load);
  form.addEventListener('submit',event=>{event.preventDefault();if(!busy&&canSend&&form.reportValidity())perform();});
  $('owner-invitation-copy').addEventListener('click',async()=>{if(!privateLink)return;try{await copyText(privateLink);$('owner-invitation-copy').textContent='Private link copied';}catch{status.textContent='Copy was unavailable. Select the private link and copy it manually.';}});
  client.auth.onAuthStateChange((event,session)=>{if(event==='SIGNED_OUT'||event==='USER_DELETED'||identity&&session?.user?.id!==identity)clear();});controls();return {load,perform,clear};
 }
 return {mount,validLink};
});
