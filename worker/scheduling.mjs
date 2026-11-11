const PROJECT='https://nhiqbcevcdxfzvrprgck.supabase.co',ORIGIN='https://ironcrest.profitharborai.com';
const UUID=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function scheduleInstant(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(value))throw Error();const time=Date.parse(value);if(!Number.isFinite(time)||new Date(time).toISOString()!==value)throw Error();return time;}
export function validateScheduleAction(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||!['save_draft','publish','cancel'].includes(value.action))throw Error();
 const keys=value.action==='save_draft'?['action','id','revision','employeeId','worksiteId','title','start','end','timeZone']:['action','id','revision'];
 if(Object.keys(value).sort().join(',')!==keys.sort().join(',')||!Number.isSafeInteger(value.revision)||value.revision<0||value.revision>=Number.MAX_SAFE_INTEGER)throw Error();
 if(value.id!==null&&!UUID.test(value.id))throw Error();
 if(value.id===null&&(value.action!=='save_draft'||value.revision!==0)||value.id!==null&&value.revision<1)throw Error();
 if(value.action==='save_draft'){
  if(!UUID.test(value.employeeId)||!UUID.test(value.worksiteId)||typeof value.title!=='string'||!value.title.trim()||value.title.trim().length>120||/[\x00-\x1f\x7f]/.test(value.title)||typeof value.timeZone!=='string'||value.timeZone.length>100)throw Error();
  new Intl.DateTimeFormat('en',{timeZone:value.timeZone}).format();const duration=scheduleInstant(value.end)-scheduleInstant(value.start);if(duration<=0||duration>86400000)throw Error();
 }
 return value;
}
export function createSchedulingRoute({fetcher=fetch}={}){
 return async function schedulingRoute(request,env){
  const url=new URL(request.url),match=url.pathname.match(/^\/api\/(scheduling|my-schedule)\/(context|shifts|action)$/);if(!match)return null;
  const self=match[1]==='my-schedule',operation=match[2],origin=request.headers.get('Origin');
  const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Vary':'Origin',...(origin===ORIGIN?{'Access-Control-Allow-Origin':ORIGIN}:{})}});
  if(origin!==ORIGIN)return reply({error:'origin_not_allowed'},403);
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':ORIGIN,'Access-Control-Allow-Methods':self?'GET, OPTIONS':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type','Cache-Control':'no-store','Vary':'Origin'}});
  if(self&&operation==='action'||request.method!==(operation==='action'?'POST':'GET'))return reply({error:'method_not_allowed'},405);
  if(env.ENABLE_SCHEDULING!=='true')return reply({error:'scheduling_not_released'},503);
  if(env.SUPABASE_URL?.replace(/\/$/,'')!==PROJECT||!env.SUPABASE_SERVICE_ROLE_KEY||!env.SUPABASE_PUBLISHABLE_KEY||typeof env.INVITATION_RATE_LIMITER?.limit!=='function')return reply({error:'scheduling_unavailable'},503);
  const auth=request.headers.get('Authorization')||'';if(!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(auth))return reply({error:'verified_access_required'},401);
  let input,window;
  try{
   if(operation==='shifts'){
    if([...url.searchParams.keys()].sort().join(',')!=='end,start')throw Error();
    const start=scheduleInstant(url.searchParams.get('start')),end=scheduleInstant(url.searchParams.get('end'));if(end<=start||end-start>32*86400000)throw Error();window={start:new Date(start).toISOString(),end:new Date(end).toISOString()};
   }else if(url.search)throw Error();
   if(operation==='action'){
    if(request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw Error();
    const reader=request.body?.getReader();if(!reader)throw Error();const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false});let size=0,raw='';
    while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>4096){await reader.cancel();throw Error();}raw+=decoder.decode(value,{stream:true});}raw+=decoder.decode();input=validateScheduleAction(JSON.parse(raw));
   }
  }catch{return reply({error:'invalid_schedule_request'},400);}
  const key=env.SUPABASE_SERVICE_ROLE_KEY,server={apikey:key,...(key.startsWith('sb_secret_')?{}:{Authorization:'Bearer '+key})};
  const query=(table,params)=>'/rest/v1/'+table+'?'+new URLSearchParams(params);
  const call=async(path,headers=server,body)=>{
   const response=await fetcher(PROJECT+path,{method:body?'POST':'GET',headers:{...headers,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'manual',signal:AbortSignal.timeout(8000)});
   if(path==='/auth/v1/user'&&[401,403].includes(response.status))return null;if(!response.ok)throw Error();const raw=await response.text();if(raw.length>1024*1024)throw Error();return JSON.parse(raw);
  };
  const project=rows=>rows.map(r=>Object.fromEntries(['id','employee_user_id','worksite_id','title','starts_at','ends_at','time_zone','status','revision','published_at','cancelled_at'].map(k=>[k,r[k]??null])));
  try{
   const user=await call('/auth/v1/user',{apikey:env.SUPABASE_PUBLISHABLE_KEY,Authorization:auth});if(!UUID.test(user?.id||'')||!user.email_confirmed_at)return reply({error:'verified_access_required'},401);
   if((await env.INVITATION_RATE_LIMITER.limit({key:'ironcrest-scheduling:'+user.id}))?.success!==true)return reply({error:'rate_limited'},429);
   const memberships=await call(query('ironcrest_memberships',{select:'organization_id',user_id:'eq.'+user.id,role:self?'eq.employee':'eq.owner',active:'eq.true',limit:'2'}));
   if(!Array.isArray(memberships)||memberships.length!==1||!UUID.test(memberships[0]?.organization_id||''))return reply({error:'verified_access_required'},403);const org=memberships[0].organization_id;
   const organizations=await call(query('ironcrest_organizations',{select:'id',id:'eq.'+org,...(!self?{created_by:'eq.'+user.id}:{}),limit:'1'}));
   if(!Array.isArray(organizations)||organizations.length!==1||organizations[0].id!==org)return reply({error:'verified_access_required'},403);
   const entitlement=await call('/rest/v1/rpc/ironcrest_business_entitlement',server,{p_organization_id:org});if(!Array.isArray(entitlement)||entitlement.length!==1||entitlement[0].business_active!==true)return reply({error:'business_access_required'},403);
   if(operation==='action'){
    const result=await call('/rest/v1/rpc/ironcrest_schedule_action',server,{p_actor:user.id,p_organization_id:org,p_action:input.action,p_shift_id:input.id,p_expected_revision:input.revision,...(input.action==='save_draft'?{p_employee:input.employeeId,p_worksite:input.worksiteId,p_title:input.title.trim(),p_starts_at:input.start,p_ends_at:input.end,p_time_zone:input.timeZone}:{})});
    const allowed=['invalid_schedule','owner_required','business_access_required','shift_not_found','schedule_conflict','active_employee_required','active_worksite_required','future_shift_required','employee_schedule_overlap','company_time_zone_changed','published_shift_read_only'];
    if(result?.ok!==true){const error=allowed.includes(result?.error)?result.error:'scheduling_unavailable';return reply({error},error.endsWith('required')&&['owner_required','business_access_required'].includes(error)?403:error==='shift_not_found'?404:error==='scheduling_unavailable'?503:409);}
    return reply({ok:true,organizationScoped:true,shift:project([result.shift])[0]});
   }
   if(operation==='context'){
    const preferences=await call(query('ironcrest_company_settings',{select:'time_zone,week_starts_on',organization_id:'eq.'+org,limit:'1'}));if(!Array.isArray(preferences)||preferences.length>1)throw Error();
    const timeZone=preferences[0]?.time_zone??'UTC',weekStartsOn=preferences[0]?.week_starts_on??1;new Intl.DateTimeFormat('en',{timeZone}).format();if(!Number.isInteger(weekStartsOn)||weekStartsOn<0||weekStartsOn>6)throw Error();
    let employees=[],worksites=[],choicesTruncated=false;
    if(!self){
     const members=await call(query('ironcrest_memberships',{select:'id,user_id',organization_id:'eq.'+org,role:'eq.employee',active:'eq.true',order:'id.asc',limit:'201'}));
     if(!Array.isArray(members)||members.length>201||members.some(m=>!UUID.test(m.id)||!UUID.test(m.user_id)))throw Error();choicesTruncated=members.length>200;
     employees=members.slice(0,200).map(m=>({id:m.user_id,name:'Employee '+m.user_id.slice(-8)}));
     // Bounded profile query, names only; never phone, email, or employment details.
     for(let from=0;from<Math.min(200,members.length);from+=100){const batch=members.slice(from,from+100);const profiles=await call(query('ironcrest_employee_profiles',{select:'membership_id,first_name,last_name',organization_id:'eq.'+org,membership_id:'in.('+batch.map(m=>m.id).join(',')+')',limit:'201'}));
      if(!Array.isArray(profiles)||profiles.length>200)throw Error();for(const p of profiles){const id=batch.find(m=>m.id===p.membership_id)?.user_id,employee=employees.find(e=>e.id===id);if(employee)employee.name=[p.first_name,p.last_name].filter(x=>typeof x==='string').join(' ').trim().slice(0,200)||employee.name;}}
     const sites=await call(query('ironcrest_worksites',{select:'id,name',organization_id:'eq.'+org,active:'eq.true',order:'name.asc,id.asc',limit:'201'}));if(!Array.isArray(sites)||sites.length>201)throw Error();choicesTruncated||=sites.length>200;worksites=sites.slice(0,200).map(s=>({id:s.id,name:s.name}));
    }
    return reply({ok:true,organizationScoped:true,selfScoped:self,timeZone,weekStartsOn,employees,worksites,choicesTruncated});
   }
   const rows=await call(query('ironcrest_scheduled_shifts',{select:'id,employee_user_id,worksite_id,title,starts_at,ends_at,time_zone,status,revision,published_at,cancelled_at',organization_id:'eq.'+org,...(self?{employee_user_id:'eq.'+user.id,published_at:'not.is.null',status:'in.(published,cancelled)'}:{}),starts_at:'lt.'+window.end,ends_at:'gt.'+window.start,order:'starts_at.asc,id.asc',limit:'201'}));
   if(!Array.isArray(rows)||rows.length>201||self&&rows.some(r=>r.employee_user_id!==user.id||!r.published_at||!['published','cancelled'].includes(r.status)))throw Error();
   const ids=[...new Set(rows.map(r=>r.worksite_id))].filter(id=>UUID.test(id)).slice(0,100),worksites=[];
   if(ids.length){const sites=await call(query('ironcrest_worksites',{select:'id,name',organization_id:'eq.'+org,id:'in.('+ids.join(',')+')',limit:'101'}));if(!Array.isArray(sites)||sites.length>100)throw Error();for(const site of sites)worksites.push({id:site.id,name:site.name});}
   return reply({ok:true,organizationScoped:true,selfScoped:self,window,limit:200,truncated:rows.length>200,shifts:project(rows.slice(0,200)),worksites});
  }catch{return reply({error:'scheduling_unavailable'},503);}
 };
}
