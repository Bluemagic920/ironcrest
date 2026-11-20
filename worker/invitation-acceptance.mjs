const PROJECT='https://nhiqbcevcdxfzvrprgck.supabase.co',ORIGIN='https://ironcrest.profitharborai.com';
const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function createInvitationAcceptanceRoute({fetcher=fetch,cryptoApi=crypto,releaseApproved=false}={}){
 return async(request,env)=>{
  const url=new URL(request.url),status=url.pathname==='/api/accept-invitation/status';
  if(!status&&url.pathname!=='/api/accept-invitation')return null;
  const origin=request.headers.get('Origin');
  const reply=(body,code=200)=>new Response(JSON.stringify(body),{status:code,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Vary':'Origin',...(origin===ORIGIN?{'Access-Control-Allow-Origin':ORIGIN}:{})}});
  if(origin!==ORIGIN)return reply({ok:false,error:'origin_not_allowed'},403);
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':ORIGIN,'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type','Cache-Control':'no-store','Vary':'Origin'}});
  if(request.method!=='POST')return reply({ok:false,error:'method_not_allowed'},405);
  if(releaseApproved!==true||env.STAGE9B_ACCEPTANCE_ENABLED!=='true')return reply({ok:false,invitationAccepted:false,error:'Invitation acceptance is not enabled.'},503);
  if(url.search)return reply({ok:false,error:'query_not_supported'},400);
  if(typeof env.SUPABASE_URL!=='string'||env.SUPABASE_URL.replace(/\/$/,'')!==PROJECT||typeof env.SUPABASE_PUBLISHABLE_KEY!=='string'||!env.SUPABASE_PUBLISHABLE_KEY||typeof env.SUPABASE_SERVICE_ROLE_KEY!=='string'||!env.SUPABASE_SERVICE_ROLE_KEY||typeof env.INVITATION_RATE_LIMITER?.limit!=='function')return reply({ok:false,error:'Invitation service unavailable.'},503);
  const auth=request.headers.get('Authorization')||'';
  if(!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(auth))return reply({ok:false,error:'Sign in required.'},401);
  if(request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!=='application/json')return reply({ok:false,error:'JSON required.'},415);
  let body;
  try{
   const reader=request.body?.getReader();if(!reader)throw Error();const decoder=new TextDecoder('utf-8',{fatal:true});let size=0,text='';
   for(;;){const r=await reader.read();if(r.done)break;size+=r.value.byteLength;if(size>1024){await reader.cancel();throw Error();}text+=decoder.decode(r.value,{stream:true});}text+=decoder.decode();body=JSON.parse(text);
   if(!body||Array.isArray(body)||Object.keys(body).join(',')!=='token'||typeof body.token!=='string'||!/^[a-f0-9]{64}$/.test(body.token))throw Error();
  }catch{return reply({ok:false,error:'Invalid invitation request.'},400);}
  const key=env.SUPABASE_SERVICE_ROLE_KEY,server={apikey:key,...(key.startsWith('sb_secret_')?{}:{Authorization:'Bearer '+key})};
  const query=(table,params)=>'/rest/v1/'+table+'?'+new URLSearchParams(params);
  const call=async(path,headers=server,data)=>{
   const response=await fetcher(PROJECT+path,{method:data?'POST':'GET',headers:{...headers,...(data?{'Content-Type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{}),redirect:'manual',signal:AbortSignal.timeout(15000)});
   if(path==='/auth/v1/user'&&[401,403].includes(response.status))return null;
   if(!response.ok)throw Error('Provider unavailable');const reader=response.body?.getReader();if(!reader)throw Error();
   const decoder=new TextDecoder('utf-8',{fatal:true});let size=0,raw='';
   for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>100000){await reader.cancel();throw Error();}raw+=decoder.decode(part.value,{stream:true});}
   return JSON.parse(raw+decoder.decode());
  };
  try{
   const user=await call('/auth/v1/user',{apikey:env.SUPABASE_PUBLISHABLE_KEY,Authorization:auth});
   if(!UUID.test(user?.id||'')||!user.email_confirmed_at||typeof user.email!=='string')return reply({ok:false,error:'Verified sign in required.'},401);
   if((await env.INVITATION_RATE_LIMITER.limit({key:'ironcrest-accept:'+user.id}))?.success!==true)return reply({ok:false,error:'Please wait before trying again.'},429);
   const digest=await cryptoApi.subtle.digest('SHA-256',new TextEncoder().encode(body.token));
   const hash=Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('');
   const unavailable=()=>reply({ok:false,invitationAccepted:false,error:'Invitation unavailable or not linked to your active membership.'},409);
   if(status){
    // This path only reads. It cannot accept an invitation or restore revoked membership.
    const rows=await call(query('ironcrest_invitations',{select:'id,organization_id,email,role,status,accepted_at,revoked_at,token_hash',token_hash:'eq.'+hash,status:'eq.accepted',limit:'2'}));
    if(!Array.isArray(rows)||rows.length!==1)return unavailable();const invitation=rows[0];
    if(invitation.token_hash!==hash||!UUID.test(invitation.id)||!UUID.test(invitation.organization_id)||invitation.status!=='accepted'||!['employee','manager'].includes(invitation.role)||invitation.revoked_at!==null||!Number.isFinite(Date.parse(invitation.accepted_at))||typeof invitation.email!=='string'||invitation.email.trim().toLowerCase()!==user.email.trim().toLowerCase())return unavailable();
    const members=await call(query('ironcrest_memberships',{select:'id,organization_id,user_id,role,active',user_id:'eq.'+user.id,active:'eq.true',limit:'2'}));
    if(!Array.isArray(members)||members.length!==1)return unavailable();const member=members[0];
    if(!UUID.test(member.id)||member.user_id!==user.id||member.organization_id!==invitation.organization_id||member.active!==true||member.role!==invitation.role)return unavailable();
    const companies=await call(query('ironcrest_organizations',{select:'id,created_by',id:'eq.'+invitation.organization_id,limit:'1'}));
    if(!Array.isArray(companies)||companies.length!==1||companies[0].id!==invitation.organization_id||!UUID.test(companies[0].created_by))return unavailable();
    const owners=await call(query('ironcrest_memberships',{select:'id',organization_id:'eq.'+invitation.organization_id,user_id:'eq.'+companies[0].created_by,role:'eq.owner',active:'eq.true',limit:'1'}));
    if(!Array.isArray(owners)||owners.length!==1)return unavailable();
    const entitlement=await call('/rest/v1/rpc/ironcrest_business_entitlement',server,{p_organization_id:invitation.organization_id});
    if(!Array.isArray(entitlement)||entitlement.length!==1||entitlement[0].business_active!==true)return unavailable();
    return reply({ok:true,readOnly:true,invitationAccepted:true,organizationId:invitation.organization_id,assignedRole:invitation.role});
   }
   try{
    const rows=await call('/rest/v1/rpc/ironcrest_accept_invitation',server,{p_token_hash:hash,p_user_id:user.id});
    if(!Array.isArray(rows)||rows.length!==1||!UUID.test(rows[0].invitation_id||'')||!UUID.test(rows[0].membership_id||'')||!UUID.test(rows[0].organization_id||'')||!['employee','manager'].includes(rows[0].assigned_role))throw Error();
    return reply({ok:true,invitationAccepted:true,organizationId:rows[0].organization_id,assignedRole:rows[0].assigned_role});
   }catch{return reply({ok:false,invitationAccepted:null,error:'Acceptance was rejected or its receipt was lost. Check invitation status before another attempt.'},409);}
  }catch{return reply({ok:false,invitationAccepted:false,error:'Invitation service unavailable.'},503);}
 };
}

// Preserve the complete deployed Worker until the reviewed replacement is approved.
export function withInvitationAcceptance(legacy,{releaseApproved=false,...options}={}){
 if(typeof legacy?.fetch!=='function')throw Error('Existing Worker required');
 const route=createInvitationAcceptanceRoute({...options,releaseApproved});
 return {...legacy,async fetch(request,env,context){
  if(releaseApproved!==true)return legacy.fetch(request,env,context);
  const result=await route(request,{...env,SUPABASE_URL:PROJECT});if(result)return result;
  const response=await legacy.fetch(request,env,context);
  if(new URL(request.url).pathname==='/health'&&response.status===200&&response.headers.get('Content-Type')?.includes('application/json')){
   const health=await response.clone().json();return new Response(JSON.stringify({...health,invitationStatusAvailable:env.STAGE9B_ACCEPTANCE_ENABLED==='true'}),{status:response.status,headers:response.headers});
  }
  return response;
 }};
}
