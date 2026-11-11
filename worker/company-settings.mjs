const PROJECT='https://nhiqbcevcdxfzvrprgck.supabase.co';
const ORIGIN='https://ironcrest.profitharborai.com';
const UUID=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function validateCompanySettings(value){
 if(!value||Array.isArray(value)||Object.keys(value).sort().join(',')!=='name,revision,timeZone,weekStartsOn')throw Error('invalid_settings');
 const {name,timeZone,weekStartsOn,revision}=value;
 if(typeof name!=='string'||name.trim().length<1||name.trim().length>120||/[\x00-\x1f\x7f]/.test(name)||typeof timeZone!=='string'||timeZone.length>100||!Number.isInteger(weekStartsOn)||weekStartsOn<0||weekStartsOn>6||!Number.isSafeInteger(revision)||revision<0||revision>=Number.MAX_SAFE_INTEGER)throw Error('invalid_settings');
 try{new Intl.DateTimeFormat('en',{timeZone}).format();}catch{throw Error('invalid_settings');}
 return {name:name.trim(),timeZone,weekStartsOn,revision};
}
export function createCompanySettingsRoute({fetcher=fetch}={}){
 return async function companySettingsRoute(request,env){
  const url=new URL(request.url);if(url.pathname!=='/api/company/settings')return null;
  const origin=request.headers.get('Origin');
  const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Vary':'Origin',...(origin===ORIGIN?{'Access-Control-Allow-Origin':ORIGIN}:{})}});
  if(origin!==ORIGIN)return reply({error:'origin_not_allowed'},403);
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':ORIGIN,'Access-Control-Allow-Methods':'GET, PUT, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type','Vary':'Origin','Cache-Control':'no-store'}});
  if(!['GET','PUT'].includes(request.method))return reply({error:'method_not_allowed'},405);
  if(url.search)return reply({error:'unexpected_parameters'},400);
  if(env.SUPABASE_URL?.replace(/\/$/,'')!==PROJECT||!env.SUPABASE_SERVICE_ROLE_KEY||!env.SUPABASE_PUBLISHABLE_KEY||typeof env.INVITATION_RATE_LIMITER?.limit!=='function')return reply({error:'settings_unavailable'},503);
  const auth=request.headers.get('Authorization')||'';if(!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(auth))return reply({error:'owner_required'},401);
  let input;
  if(request.method==='PUT'){
   if(request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!=='application/json')return reply({error:'json_required'},415);
   try{
    const reader=request.body?.getReader();if(!reader)throw Error();let size=0,raw='';const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false});
    while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>2048){await reader.cancel();throw Error();}raw+=decoder.decode(value,{stream:true});}raw+=decoder.decode();
    input=validateCompanySettings(JSON.parse(raw));
   }catch{return reply({error:'invalid_settings'},400);}
  }
  const key=env.SUPABASE_SERVICE_ROLE_KEY,server={apikey:key,...(key.startsWith('sb_secret_')?{}:{Authorization:'Bearer '+key})};
  const query=(table,params)=>'/rest/v1/'+table+'?'+new URLSearchParams(params);
  const call=async(path,headers=server,body)=>{
   const response=await fetcher(PROJECT+path,{method:body?'POST':'GET',headers:{...headers,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'manual',signal:AbortSignal.timeout(8000)});
   if(path==='/auth/v1/user'&&[401,403].includes(response.status))return null;
   if(!response.ok)throw Error('provider_unavailable');const raw=await response.text();if(raw.length>65536)throw Error('oversized_response');return JSON.parse(raw);
  };
  try{
   const user=await call('/auth/v1/user',{apikey:env.SUPABASE_PUBLISHABLE_KEY,Authorization:auth});
   if(!UUID.test(user?.id||'')||!user.email_confirmed_at)return reply({error:'owner_required'},401);
   if((await env.INVITATION_RATE_LIMITER.limit({key:'ironcrest-company-settings:'+user.id}))?.success!==true)return reply({error:'rate_limited'},429);
   const memberships=await call(query('ironcrest_memberships',{select:'organization_id',user_id:'eq.'+user.id,role:'eq.owner',active:'eq.true',limit:'2'}));
   if(!Array.isArray(memberships)||memberships.length!==1||!UUID.test(memberships[0]?.organization_id||''))return reply({error:'owner_required'},403);
   const org=memberships[0].organization_id;
   const organizations=await call(query('ironcrest_organizations',{select:'id,name',id:'eq.'+org,created_by:'eq.'+user.id,limit:'1'}));
   if(!Array.isArray(organizations)||organizations.length!==1||organizations[0].id!==org)return reply({error:'owner_required'},403);
   const entitlement=await call('/rest/v1/rpc/ironcrest_business_entitlement',server,{p_organization_id:org});
   if(!Array.isArray(entitlement)||entitlement.length!==1||entitlement[0].business_active!==true)return reply({error:'business_access_required'},403);
   let settings;
   if(input){
    const result=await call('/rest/v1/rpc/ironcrest_save_company_settings',server,{p_actor:user.id,p_organization_id:org,p_name:input.name,p_time_zone:input.timeZone,p_week_starts_on:input.weekStartsOn,p_expected_revision:input.revision});
    if(result?.ok!==true)return reply({error:['settings_conflict','owner_required','business_access_required','invalid_settings'].includes(result?.error)?result.error:'settings_unavailable'},result?.error==='settings_conflict'?409:result?.error==='invalid_settings'?400:result?.error?.endsWith('required')?403:503);
    settings=result.settings;
   }else{
    const rows=await call(query('ironcrest_company_settings',{select:'time_zone,week_starts_on,revision,updated_at',organization_id:'eq.'+org,limit:'1'}));
    if(!Array.isArray(rows)||rows.length>1)throw Error('invalid_response');
    const row=rows[0];settings={name:organizations[0].name,timeZone:row?.time_zone??'UTC',weekStartsOn:row?.week_starts_on??1,revision:row?.revision??0,updatedAt:row?.updated_at??null};
   }
   validateCompanySettings({name:settings.name,timeZone:settings.timeZone,weekStartsOn:settings.weekStartsOn,revision:settings.revision});
   return reply({ok:true,organizationScoped:true,settings:{name:settings.name,timeZone:settings.timeZone,weekStartsOn:settings.weekStartsOn,revision:settings.revision,updatedAt:settings.updatedAt}});
  }catch{return reply({error:'settings_unavailable'},503);}
 };
}
