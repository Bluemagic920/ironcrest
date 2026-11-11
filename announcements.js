(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.IroncrestAnnouncements=api;})(typeof globalThis==='object'?globalThis:this,function(){
 'use strict';
 const errors={announcement_conflict:'This notice changed in another window. Reload announcements before trying again.',published_announcement_read_only:'Published notices cannot be edited. Archive it and publish a replacement.',announcement_not_found:'This notice is no longer available.',invalid_announcement_request:'Enter a title and message within the allowed lengths.'};
 function mount({document,client,verifyMembership,apiBase,owner=false,fetcher=fetch}){
  const $=id=>document.getElementById(id),panel=$('announcements-panel'),open=$('announcements-open');if(!panel||!open)return;
  const list=$('announcements-list'),status=$('announcements-status'),form=$('announcements-form'),previous=$('announcements-previous'),next=$('announcements-next');
  let generation=0,busy=false,identity=null,controller=null,ready=false,needsReload=false,editing=null,cursors=[null],nextCursor=null;
  function editorReset(){editing=null;form?.reset();if(owner){$('announcements-editor-heading').textContent='New draft announcement';$('announcements-save').textContent='Save draft';}}
  function controls(){for(const el of panel.querySelectorAll('button,input,textarea,select'))el.disabled=busy;previous.disabled=busy||cursors.length<2;next.disabled=busy||!nextCursor;
   if(owner)for(const el of form.querySelectorAll('button,input,textarea'))el.disabled=busy||needsReload||!ready;
   if(needsReload)for(const el of list.querySelectorAll('button'))el.disabled=true;
  }
  function clear(){++generation;controller?.abort();identity=null;busy=false;ready=false;needsReload=false;editing=null;cursors=[null];nextCursor=null;list.replaceChildren();editorReset();if(owner)$('announcements-filter').value='all';panel.hidden=true;open.setAttribute('aria-expanded','false');status.textContent='Load company announcements to begin.';controls();}
  const base=apiBase+(owner?'/api/announcements':'/api/employee/announcements');
  async function execute(task){
   if(busy)return;busy=true;const version=++generation;controller=new AbortController();controls();
   try{
    const org=await verifyMembership();if(version!==generation)return;const session=await client.auth.getSession();if(version!==generation)return;
    if(session.error||!session.data?.session?.access_token||!session.data.session.user?.id)throw Error('Please sign in again.');const user=session.data.session.user.id;identity=user;
    const call=async(query='',payload)=>{
     if(version!==generation)throw Error('Account changed.');const response=await fetcher(base+query,{method:payload?'POST':'GET',headers:{Authorization:'Bearer '+session.data.session.access_token,...(payload?{'Content-Type':'application/json'}:{})},...(payload?{body:JSON.stringify(payload)}:{}),cache:'no-store',referrerPolicy:'no-referrer',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000)])});
     const result=await response.json();if(version!==generation)throw Error('Account changed.');if(!response.ok)throw Error(errors[result.error]||(response.status===401?'Your session expired. Please sign in again.':response.status===403?'Verified company Business access is required.':response.status===429?'Please wait before trying again.':response.status===503?'Company announcements are temporarily unavailable.':'Unable to complete this request. Reload before retrying.'));
     const latestOrg=await verifyMembership(),latest=await client.auth.getSession();if(version!==generation||latest.error||latestOrg!==org||latest.data?.session?.user?.id!==user)throw Error('Account changed. Reload announcements.');
     if(result?.ok!==true||result.organizationScoped!==true||!owner&&result.employeeFeed!==true)throw Error('Announcement response could not be verified.');return result;
    };
    await task(call,()=>version===generation);
   }catch(error){if(version===generation)status.textContent=(error.message||'Unable to load announcements.')+(needsReload?' Reload announcements before making another change.':'');}
   finally{if(version===generation){busy=false;controls();}}
  }
  function render(rows,timeZone){
   list.replaceChildren();for(const notice of rows){const card=document.createElement('article');card.className='announcement-card';const heading=document.createElement('h3');heading.textContent=notice.title;const text=document.createElement('div');text.className='announcement-body';text.textContent=notice.body;const meta=document.createElement('p');meta.className='announcement-meta';
    const time=notice.published_at||notice.created_at;const formatted=new Intl.DateTimeFormat('en',{timeZone,dateStyle:'medium',timeStyle:'short'}).format(new Date(time));meta.textContent=(owner?notice.status+' · ':'Published ')+formatted+' · '+timeZone;card.append(heading,meta,text);
    if(owner&&notice.status!=='archived'){const actions=document.createElement('div');actions.className='announcement-actions';
     if(notice.status==='draft'){
      const edit=document.createElement('button');edit.type='button';edit.textContent='Edit draft';edit.addEventListener('click',()=>{if(busy||needsReload)return;editing={id:notice.id,revision:notice.revision};$('announcements-title').value=notice.title;$('announcements-body').value=notice.body;$('announcements-editor-heading').textContent='Editing draft announcement';$('announcements-save').textContent='Save draft changes';$('announcements-title').focus();});actions.append(edit);
      const publish=document.createElement('button');publish.type='button';publish.textContent='Publish to employees';publish.addEventListener('click',()=>perform({action:'publish',id:notice.id,revision:notice.revision}));actions.append(publish);
     }
     const archive=document.createElement('button');archive.type='button';archive.textContent='Archive notice';archive.addEventListener('click',()=>perform({action:'archive',id:notice.id,revision:notice.revision}));actions.append(archive);card.append(actions);
    }list.append(card);
   }
   if(!rows.length){const empty=document.createElement('p');empty.textContent=owner?'No announcements match this view.':'No published company announcements yet.';list.append(empty);}
  }
  async function load(reset=true){if(busy)return;if(reset)cursors=[null];return execute(async(call,current)=>{
   ready=false;list.replaceChildren();nextCursor=null;editorReset();status.textContent='Loading company announcements…';const params=new URLSearchParams();if(owner)params.set('status',$('announcements-filter').value);if(cursors.at(-1))params.set('cursor',cursors.at(-1));
   const result=await call(params.size?'?'+params:'');if(!current())return;
   if(!Array.isArray(result.announcements)||result.announcements.length>25||typeof result.timeZone!=='string'||result.nextCursor!==null&&typeof result.nextCursor!=='string'||!owner&&result.announcements.some(n=>n.status!=='published'))throw Error('Announcement response could not be verified.');
   render(result.announcements,result.timeZone);nextCursor=result.nextCursor;ready=true;needsReload=false;status.textContent='Page '+cursors.length+' · '+result.announcements.length+' announcement(s).'+(nextCursor?' More notices are available on the next page.':'');
  });}
  async function perform(payload){if(!owner||busy)return;if(needsReload||!ready){status.textContent='Reload announcements before making changes.';return;}return execute(async(call,current)=>{
   needsReload=true;status.textContent=payload.action==='save_draft'?'Saving private draft…':payload.action==='publish'?'Publishing company announcement…':'Archiving notice…';await call('',payload);if(!current())return;
   editorReset();list.replaceChildren();nextCursor=null;ready=false;status.textContent=payload.action==='save_draft'?'Draft saved. It is not visible to employees. Reload to review or publish it.':payload.action==='publish'?'Notice published to employees with active company access. Reload to view it.':'Notice archived. It is hidden from the employee feed. Reload to view your history.';
  });}
  open.disabled=false;open.addEventListener('click',()=>{panel.hidden=false;open.setAttribute('aria-expanded','true');panel.scrollIntoView({behavior:'smooth',block:'start'});load();});$('announcements-close').addEventListener('click',clear);$('announcements-reload').addEventListener('click',()=>load());
  next.addEventListener('click',()=>{if(!busy&&nextCursor){cursors.push(nextCursor);load(false);}});previous.addEventListener('click',()=>{if(!busy&&cursors.length>1){cursors.pop();load(false);}});
  if(owner){$('announcements-filter').addEventListener('change',()=>load());$('announcements-new').addEventListener('click',()=>{if(!busy&&!needsReload)editorReset();});form.addEventListener('submit',event=>{event.preventDefault();if(!form.reportValidity())return;perform({action:'save_draft',id:editing?.id??null,revision:editing?.revision??0,title:$('announcements-title').value.trim(),body:$('announcements-body').value.trim()});});}
  client.auth.onAuthStateChange((event,session)=>{if(event==='SIGNED_OUT'||event==='USER_DELETED'||identity&&session?.user?.id!==identity)clear();});controls();
  return {load,perform,clear};
 }
 return {mount};
});
