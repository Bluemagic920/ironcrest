// Read-only extension for the existing Ironcrest Worker. No attendance mutations.
const PROJECT='https://nhiqbcevcdxfzvrprgck.supabase.co';
const ORIGIN='https://ironcrest.profitharborai.com';
const UUID=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function reportWindow(start,end){
 const parse=value=>{if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw Error('invalid_window');const time=Date.parse(value+'T00:00:00Z');if(!Number.isFinite(time)||new Date(time).toISOString().slice(0,10)!==value)throw Error('invalid_window');return time;};
 const from=parse(start),to=parse(end)+86400000;
 if(to<=from||to-from>31*86400000)throw Error('invalid_window');
 return {start:new Date(from).toISOString(),end:new Date(to).toISOString()};
}
export function createAttendanceRecordsRoute({fetcher=fetch}={}){
 return async function attendanceRecordsRoute(request,env){
  const url=new URL(request.url);if(!['/api/attendance/records','/api/attendance/my-records'].includes(url.pathname))return null;
  const employee=url.pathname==='/api/attendance/my-records';
  const origin=request.headers.get('Origin');
  const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Vary':'Origin',...(origin===ORIGIN?{'Access-Control-Allow-Origin':ORIGIN}:{})}});
  if(origin!==ORIGIN)return reply({error:'origin_not_allowed'},403);
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':ORIGIN,'Access-Control-Allow-Methods':'GET, OPTIONS','Access-Control-Allow-Headers':'Authorization','Cache-Control':'no-store','Vary':'Origin'}});
  if(request.method!=='GET')return reply({error:'read_only_endpoint'},405);
  if(env.ENABLE_ATTENDANCE_REPORTS_READONLY!=='true')return reply({error:'attendance_reports_not_released'},503);
  if(env.SUPABASE_URL?.replace(/\/$/,'')!==PROJECT||!env.SUPABASE_SERVICE_ROLE_KEY||!env.SUPABASE_PUBLISHABLE_KEY||typeof env.INVITATION_RATE_LIMITER?.limit!=='function')return reply({error:'reporting_configuration_unavailable'},503);
  const auth=request.headers.get('Authorization')||'';if(!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(auth))return reply({error:'verified_owner_required'},401);
  let window;
  try{if([...url.searchParams.keys()].some(key=>!['start','end'].includes(key))||url.searchParams.getAll('start').length!==1||url.searchParams.getAll('end').length!==1)throw Error();window=reportWindow(url.searchParams.get('start'),url.searchParams.get('end'));}catch{return reply({error:'select_up_to_31_calendar_days'},400);}
  const key=env.SUPABASE_SERVICE_ROLE_KEY;
  const server={apikey:key,...(key.startsWith('sb_secret_')?{}:{Authorization:'Bearer '+key})};
  let reference='REPORT_UNAVAILABLE';
  async function read(path,headers=server,body){
   const resources={user:'AUTH',ironcrest_memberships:'MEMBERSHIPS',ironcrest_organizations:'ORGANIZATION',ironcrest_business_entitlement:'ENTITLEMENT',ironcrest_attendance_entries:'ENTRIES',ironcrest_attendance_exceptions:'EXCEPTIONS'};
   const resource=resources[path.split('?')[0].split('/').pop()]||'LABELS';reference='REPORT_'+resource+'_UNAVAILABLE';
   const response=await fetcher(PROJECT+path,{method:body?'POST':'GET',headers:{...headers,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'manual',signal:AbortSignal.timeout(8000)});
   if(path==='/auth/v1/user'&&[401,403].includes(response.status))return null;
   if(!response.ok){let code='';try{const error=await response.json();if(typeof error?.code==='string'&&/^[A-Z0-9_]{1,20}$/.test(error.code))code='_'+error.code;}catch{}reference='REPORT_'+resource+'_'+response.status+code;throw Error('report_unavailable');}const raw=await response.text();if(raw.length>1024*1024)throw Error('report_too_large');return JSON.parse(raw);
  }
  const query=(table,params)=>'/rest/v1/'+table+'?'+new URLSearchParams(params);
  try{
   const user=await read('/auth/v1/user',{apikey:env.SUPABASE_PUBLISHABLE_KEY,Authorization:auth});
   if(!UUID.test(user?.id||'')||!user.email_confirmed_at)return reply({error:'verified_owner_required'},401);
   const rate=await env.INVITATION_RATE_LIMITER.limit({key:'ironcrest-attendance-records:'+(employee?'employee:':'owner:')+user.id});
   if(rate?.success!==true)return reply({error:'report_rate_limit_reached'},429);
   const memberships=await read(query('ironcrest_memberships',{select:'organization_id',user_id:'eq.'+user.id,role:employee?'eq.employee':'eq.owner',active:'eq.true',limit:'2'}));
   if(!Array.isArray(memberships)||memberships.length!==1||!UUID.test(memberships[0]?.organization_id||''))return reply({error:'one_active_owner_organization_required'},403);
   const org=memberships[0].organization_id;
   const organizations=await read(query('ironcrest_organizations',{select:'id',id:'eq.'+org,...(!employee?{created_by:'eq.'+user.id}:{}),limit:'1'}));
   if(!Array.isArray(organizations)||organizations.length!==1)return reply({error:'verified_owner_required'},403);
   // Existing STABLE, service-only entitlement RPC; this POST performs no writes.
   const entitlement=await read('/rest/v1/rpc/ironcrest_business_entitlement',server,{p_organization_id:org});
   if(!Array.isArray(entitlement)||entitlement.length!==1||entitlement[0].business_active!==true)return reply({error:'business_access_required'},403);
   const entries=await read(query('ironcrest_attendance_entries',{select:'id,employee_user_id,worksite_id,clock_in_at,clock_out_at,clock_in_exception_id,clock_out_exception_id',organization_id:'eq.'+org,...(employee?{employee_user_id:'eq.'+user.id}:{}),clock_in_at:'lt.'+window.end,or:'(clock_out_at.is.null,clock_out_at.gt.'+window.start+')',order:'clock_in_at.desc,id.desc',limit:'201'}));
   const exceptions=await read(query('ironcrest_attendance_exceptions',{select:'id,employee_user_id,worksite_id,requested_action,status,requested_at,reviewed_at',organization_id:'eq.'+org,...(employee?{employee_user_id:'eq.'+user.id}:{}),and:'(requested_at.gte.'+window.start+',requested_at.lt.'+window.end+')',order:'requested_at.desc,id.desc',limit:'201'}));
   if(!Array.isArray(entries)||!Array.isArray(exceptions)||entries.length>201||exceptions.length>201)throw Error('invalid_report');
   if(employee&&[...entries,...exceptions].some(row=>row?.employee_user_id!==user.id))throw Error('scope_mismatch');
   let employeeNames={},worksiteNames={};
   try{
    const members=await read(query('ironcrest_memberships',{select:'id,user_id',organization_id:'eq.'+org,role:'eq.employee',...(employee?{user_id:'eq.'+user.id}:{}),limit:'1001'}));
    if(Array.isArray(members)&&members.length&&members.length<=1000&&members.every(m=>UUID.test(m.id)&&UUID.test(m.user_id))){
     const profiles=await read(query('ironcrest_employee_profiles',{select:'membership_id,first_name,last_name',membership_id:'in.('+members.slice(0,100).map(m=>m.id).join(',')+')',limit:'1001'}));
     if(Array.isArray(profiles)&&profiles.length<=1000){const ids=new Map(members.map(m=>[m.id,m.user_id]));
      for(const profile of profiles){const id=ids.get(profile.membership_id);const name=[profile.first_name,profile.last_name].filter(s=>typeof s==='string').join(' ').trim().slice(0,200);if(id&&name)employeeNames[id]=name;}}
    }
    const siteIds=[...new Set([...entries,...exceptions].map(row=>row.worksite_id).filter(id=>UUID.test(id)))].slice(0,100);
    const sites=employee&&!siteIds.length?[]:await read(query('ironcrest_worksites',{select:'id,name',organization_id:'eq.'+org,...(employee?{id:'in.('+siteIds.join(',')+')'}:{}),limit:'1001'}));
    if(Array.isArray(sites)&&sites.length<=1000)for(const site of sites)if(UUID.test(site.id)&&typeof site.name==='string')worksiteNames[site.id]=site.name.slice(0,200);
   }catch{/* Names are optional; authorized records stay available with ID labels. */}
   // Explicit output projection excludes GPS, free-text notes, audit details, and organization data.
   const project=(rows,keys)=>rows.slice(0,200).map(row=>Object.fromEntries(keys.map(k=>[k,row[k]??null])));
   return reply({ok:true,readOnly:true,organizationScoped:true,selfScoped:employee,window,limit:200,entriesTruncated:entries.length>200,exceptionsTruncated:exceptions.length>200,
    employeeNames,worksiteNames,entries:project(entries,['id','employee_user_id','worksite_id','clock_in_at','clock_out_at','clock_in_exception_id','clock_out_exception_id']),
    exceptions:project(exceptions,['id','employee_user_id','worksite_id','requested_action','status','requested_at','reviewed_at'])});
  }catch{return reply({error:'attendance_records_unavailable',reference},503);}
 };
}
