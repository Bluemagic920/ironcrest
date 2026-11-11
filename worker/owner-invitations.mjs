const PROJECT='https://nhiqbcevcdxfzvrprgck.supabase.co',ORIGIN='https://ironcrest.profitharborai.com';
const UUID=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function invitationEmail(value){if(typeof value!=='string')throw Error();const email=value.trim().toLowerCase();if(email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||/[\x00-\x20\x7f<>\\]/.test(email))throw Error();return email;}
export async function invitationSecret(cryptoApi=crypto){const bytes=cryptoApi.getRandomValues(new Uint8Array(32));const token=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');const digest=await cryptoApi.subtle.digest('SHA-256',new TextEncoder().encode(token));return {token,hash:Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('')};}
export function createOwnerInvitationsRoute({fetcher=fetch,emailBuilder,cryptoApi=crypto}={}){
 return async function ownerInvitations(request,env){
  const url=new URL(request.url),revoke=url.pathname==='/api/employees/invitations/revoke';if(!revoke&&url.pathname!=='/api/employees/invitations')return null;
  const origin=request.headers.get('Origin');const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Vary':'Origin',...(origin===ORIGIN?{'Access-Control-Allow-Origin':ORIGIN}:{})}});
  if(origin!==ORIGIN)return reply({ok:false,error:'origin_not_allowed'},403);
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':ORIGIN,'Access-Control-Allow-Methods':revoke?'POST, OPTIONS':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type','Cache-Control':'no-store','Vary':'Origin'}});
  if(request.method!=='POST'&&!(request.method==='GET'&&!revoke))return reply({ok:false,error:'method_not_allowed'},405);
  if(env.ENABLE_OWNER_INVITATIONS!=='true')return reply({ok:false,error:'owner_invitations_not_released'},503);
  if(env.SUPABASE_URL?.replace(/\/$/,'')!==PROJECT||!env.SUPABASE_SERVICE_ROLE_KEY||!env.SUPABASE_PUBLISHABLE_KEY||typeof env.INVITATION_RATE_LIMITER?.limit!=='function')return reply({ok:false,error:'invitations_unavailable'},503);
  const auth=request.headers.get('Authorization')||'';if(!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(auth))return reply({ok:false,error:'owner_required'},401);
  let email=null,id=null,status='all',search=null;
  try{
   if(request.method==='POST'){
    if(url.search||request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw Error();
    const reader=request.body?.getReader();if(!reader)throw Error();let size=0,raw='';const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false});while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>1024){await reader.cancel();throw Error();}raw+=decoder.decode(value,{stream:true});}raw+=decoder.decode();const body=JSON.parse(raw);
    if(!body||Array.isArray(body)||Object.keys(body).join(',')!==(revoke?'id':'email'))throw Error();if(revoke){if(!UUID.test(body.id))throw Error();id=body.id;}else email=invitationEmail(body.email);
   }else{
    if([...url.searchParams.keys()].some(k=>!['status','email'].includes(k))||['status','email'].some(k=>url.searchParams.getAll(k).length>1))throw Error();status=url.searchParams.get('status')||'all';if(!['all','pending','accepted','revoked','expired'].includes(status))throw Error();if(url.searchParams.has('email'))search=invitationEmail(url.searchParams.get('email'));
   }
  }catch{return reply({ok:false,error:'Check the invitation email or request fields.'},400);}
  const key=env.SUPABASE_SERVICE_ROLE_KEY,server={apikey:key,...(key.startsWith('sb_secret_')?{}:{Authorization:'Bearer '+key})};
  const query=(table,params)=>'/rest/v1/'+table+'?'+new URLSearchParams(params);
  const call=async(path,headers=server,body)=>{
   const r=await fetcher(PROJECT+path,{method:body?'POST':'GET',headers:{...headers,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'manual',signal:AbortSignal.timeout(10000)});
   if(path==='/auth/v1/user'&&[401,403].includes(r.status))return null;
   if(!r.ok){let message='';try{message=(await r.json()).message||'';}catch{}const allowed=['Invitation already pending','User already belongs to this organization','Employee limit reached','Business membership required','Organization invitation rate limit reached','Recipient invitation rate limit reached'];const error=new Error(allowed.includes(message)?message:'Invitation service unavailable.');error.providerRejected=true;throw error;}
   const raw=await r.text();if(raw.length>1024*1024)throw Error('Invitation service unavailable.');return JSON.parse(raw);
  };
  const rpc=(name,body)=>call('/rest/v1/rpc/'+name,server,body);
  const validFrom=value=>typeof value==='string'&&(/^[^<>\r\n]+<[^<>\s@]+@[^<>\s@]+>$/.test(value.trim())||/^[^<>\s@]+@[^<>\s@]+$/.test(value.trim()));
  try{
   const user=await call('/auth/v1/user',{apikey:env.SUPABASE_PUBLISHABLE_KEY,Authorization:auth});if(!UUID.test(user?.id||'')||!user.email_confirmed_at||typeof user.email!=='string')return reply({ok:false,error:'owner_required'},401);
   if((await env.INVITATION_RATE_LIMITER.limit({key:'ironcrest-owner-invitations:'+user.id}))?.success!==true)return reply({ok:false,error:'Please wait before trying again.'},429);
   const members=await call(query('ironcrest_memberships',{select:'organization_id',user_id:'eq.'+user.id,role:'eq.owner',active:'eq.true',limit:'2'}));if(!Array.isArray(members)||members.length!==1||!UUID.test(members[0]?.organization_id||''))return reply({ok:false,error:'one_active_owner_organization_required'},403);const org=members[0].organization_id;
   const organizations=await call(query('ironcrest_organizations',{select:'id,name',id:'eq.'+org,created_by:'eq.'+user.id,limit:'1'}));if(!Array.isArray(organizations)||organizations.length!==1||organizations[0].id!==org)return reply({ok:false,error:'owner_required'},403);
   const ent=await rpc('ironcrest_business_entitlement',{p_organization_id:org});if(!Array.isArray(ent)||ent.length!==1||ent[0].business_active!==true)return reply({ok:false,error:'Business access is required.'},403);
   if(ent[0].unlimited_employees!==true&&(!Number.isSafeInteger(ent[0].employee_limit)||ent[0].employee_limit<0))throw Error();
   if(revoke){const result=await rpc('ironcrest_owner_revoke_invitation',{p_actor:user.id,p_organization_id:org,p_invitation_id:id});return result?.ok===true?reply({ok:true,revoked:true,organizationScoped:true}):reply({ok:false,error:result?.error==='invitation_not_pending'?'Only pending invitations can be revoked. Employee memberships are unchanged.':'Invitation could not be revoked.'},409);}
   const emailConfigured=Boolean(env.RESEND_API_KEY&&validFrom(env.RESEND_FROM_EMAIL)&&typeof emailBuilder==='function');
   if(request.method==='GET'){
    const capacity=await rpc('ironcrest_employee_capacity',{p_organization_id:org});if(!Array.isArray(capacity)||capacity.length!==1||['active_employees','pending_invitations','occupied_slots'].some(k=>!Number.isSafeInteger(capacity[0][k])||capacity[0][k]<0))throw Error();
    const rows=await call(query('ironcrest_invitations',{select:'id,email,role,status,created_at,expires_at,accepted_at,revoked_at',organization_id:'eq.'+org,...(status==='pending'?{status:'eq.pending',expires_at:'gt.'+new Date().toISOString()}:status==='expired'?{or:'(status.eq.expired,and(status.eq.pending,expires_at.lte.'+new Date().toISOString()+'))'}:status!=='all'?{status:'eq.'+status}:{}),...(search?{email:'eq.'+search}:{}),order:'created_at.desc,id.desc',limit:'101'}));if(!Array.isArray(rows)||rows.length>101)throw Error();
    const ids=rows.slice(0,100).map(r=>r.id);if(ids.some(v=>!UUID.test(v)))throw Error();let deliveries=[];
    if(ids.length)deliveries=await call(query('ironcrest_invitation_delivery_audit',{select:'invitation_id,delivery_status,updated_at',organization_id:'eq.'+org,invitation_id:'in.('+ids.join(',')+')',order:'created_at.desc',limit:'1001'}));if(!Array.isArray(deliveries)||deliveries.length>1000)throw Error();
    const invites=rows.slice(0,100).map(r=>({...Object.fromEntries(['id','email','role','created_at','expires_at','accepted_at','revoked_at'].map(k=>[k,r[k]??null])),status:r.status==='pending'&&Date.parse(r.expires_at)<=Date.now()?'expired':r.status,deliveryStatus:deliveries.find(d=>d.invitation_id===r.id)?.delivery_status||'not_submitted'}));
    return reply({ok:true,organizationScoped:true,role:'employee',emailConfigured,acceptanceEnabled:env.STAGE9B_ACCEPTANCE_ENABLED==='true',capacity:{activeEmployees:capacity[0].active_employees,pendingInvitations:capacity[0].pending_invitations,occupiedSlots:capacity[0].occupied_slots,employeeLimit:ent[0].employee_limit,unlimited:ent[0].unlimited_employees===true},invitations:invites,truncated:rows.length>100});
   }
   if(!emailConfigured)return reply({ok:false,error:'Invitation email is not configured.'},503);
   if(env.STAGE9B_ACCEPTANCE_ENABLED!=='true')return reply({ok:false,error:'Invitation acceptance is not available yet.'},503);
   if(typeof user.email==='string'&&email===user.email.trim().toLowerCase())return reply({ok:false,error:'Use an employee email that is not your owner account.'},409);
   const secret=await invitationSecret(cryptoApi);let inviteId;
   try{inviteId=await rpc('ironcrest_owner_create_invitation',{p_actor:user.id,p_organization_id:org,p_email:email,p_token_hash:secret.hash});}
   catch(error){return reply({ok:false,creationOutcome:error.providerRejected?'rejected':'unknown',needsReview:true,error:error.providerRejected?error.message:'Invitation creation outcome is unclear. Reload invitations before trying again.'},error.providerRejected?409:503);}
   if(!UUID.test(inviteId))return reply({ok:false,creationOutcome:'unknown',needsReview:true,error:'Reload invitations to check whether creation completed.'},503);
   const privateInvitationUrl=ORIGIN+'/accept-invitation.html#invite='+secret.token;
   let auditId=null,claimed=false;
   const finish=async(status,details={})=>rpc('ironcrest_finish_invitation_delivery',{p_audit_id:auditId,p_invitation_id:inviteId,p_organization_id:org,p_status:status,...details}).catch(()=>false);
   const outcome=(deliveryStatus,extra={})=>reply({ok:deliveryStatus==='accepted',organizationScoped:true,invitationCreated:true,invitationId:inviteId,privateInvitationUrl,deliveryStatus,needsReview:deliveryStatus!=='accepted',...extra},deliveryStatus==='accepted'?200:502);
   try{
    const reserved=await rpc('ironcrest_reserve_invitation_delivery',{p_invitation_id:inviteId,p_organization_id:org,p_recipient_email:email});if(!Array.isArray(reserved)||reserved.length!==1||reserved[0].reservation_created!==true||!UUID.test(reserved[0].audit_id))return outcome('not_submitted');auditId=reserved[0].audit_id;
    claimed=await rpc('ironcrest_claim_invitation_delivery',{p_audit_id:auditId,p_invitation_id:inviteId,p_organization_id:org});if(claimed!==true)return outcome('not_submitted');
    const name=String(organizations[0].name||'your company').replace(/[\x00-\x1f\x7f]/g,' ').slice(0,120);const message=emailBuilder({recipientEmail:email,invitationUrl:privateInvitationUrl,organizationName:name});message.from=env.RESEND_FROM_EMAIL.trim();
    let response;try{response=await fetcher('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+env.RESEND_API_KEY,'Content-Type':'application/json','Idempotency-Key':'ironcrest-'+auditId},body:JSON.stringify(message),redirect:'manual',signal:AbortSignal.timeout(15000)});}catch{const recorded=await finish('unknown',{p_error_code:'PROVIDER_OUTCOME_UNKNOWN'});return outcome('unknown',{auditRecorded:recorded===true});}
    if(!response.ok){const recorded=await finish('failed',{p_error_code:'RESEND_HTTP_'+response.status});return outcome('failed',{auditRecorded:recorded===true});}
    const result=await response.json().catch(()=>null);if(typeof result?.id!=='string'||!result.id||result.id.length>255){const recorded=await finish('unknown',{p_error_code:'PROVIDER_ID_MISSING'});return outcome('unknown',{auditRecorded:recorded===true});}
    const recorded=await finish('accepted',{p_provider_message_id:result.id});return outcome(recorded===true?'accepted':'accepted_audit_pending',{emailAcceptedByProvider:true,auditRecorded:recorded===true});
   }catch{if(claimed&&auditId)await finish('unknown',{p_error_code:'DELIVERY_FLOW_INTERRUPTED'});return outcome(claimed?'unknown':'not_submitted');}
  }catch{return reply({ok:false,error:'Invitation service is temporarily unavailable.'},503);}
 };
}
