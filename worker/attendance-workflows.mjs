const PROJECT='https://nhiqbcevcdxfzvrprgck.supabase.co',ORIGIN='https://ironcrest.profitharborai.com';
const UUID=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function attendanceWorkflowBody(body,action,now=Date.now()){
 const keys=['operationId','worksiteId','expectedEntryId','latitude','longitude','accuracyMeters','sampleTimestamp'];
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!==keys.sort().join(',')
  ||!UUID.test(body.operationId||'')||!UUID.test(body.worksiteId||'')
  ||(action==='clock_in'?body.expectedEntryId!==null:!UUID.test(body.expectedEntryId||''))
  ||!['clock_in','clock_out'].includes(action)
  ||typeof body.latitude!=='number'||!Number.isFinite(body.latitude)||Math.abs(body.latitude)>90
  ||typeof body.longitude!=='number'||!Number.isFinite(body.longitude)||Math.abs(body.longitude)>180
  ||typeof body.accuracyMeters!=='number'||!Number.isFinite(body.accuracyMeters)||body.accuracyMeters<0||body.accuracyMeters>100
  ||typeof body.sampleTimestamp!=='number'||!Number.isFinite(body.sampleTimestamp)||body.sampleTimestamp>now+5000||body.sampleTimestamp<now-30000
 )throw Error('Invalid attendance input');
 return body;
}
// NOT integrated or activated. The production construction must remain unapproved
// until the complete attendance release is tested and explicitly approved.
export function createAttendanceWorkflowRoute({fetcher=fetch,releaseApproved=false}={}){
 return async function attendanceWorkflows(request,env){
  const url=new URL(request.url),status=url.pathname==='/api/attendance/workflows/status';
  const action=url.pathname==='/api/attendance/workflows/clock-in'?'clock_in':url.pathname==='/api/attendance/workflows/clock-out'?'clock_out':null;
  if(!status&&!action)return null;
  const origin=request.headers.get('Origin');
  const reply=(body,code=200)=>new Response(JSON.stringify(body),{status:code,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Vary':'Origin',...(origin===ORIGIN?{'Access-Control-Allow-Origin':ORIGIN}:{})}});
  if(origin!==ORIGIN)return reply({ok:false,error:'origin_not_allowed'},403);
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':ORIGIN,'Access-Control-Allow-Methods':status?'GET, OPTIONS':'POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type','Cache-Control':'no-store','Vary':'Origin'}});
  if(request.method!==(status?'GET':'POST'))return reply({ok:false,error:'method_not_allowed'},405);
  if(url.search)return reply({ok:false,error:'Query parameters are not supported.'},400);
  if(releaseApproved!==true||env.ENABLE_ATTENDANCE_WORKFLOWS!=='true')return reply({ok:false,attendanceRecorded:false,error:'General attendance is not activated.'},403);
  if(env.SUPABASE_URL?.replace(/\/$/,'')!==PROJECT||!env.SUPABASE_PUBLISHABLE_KEY||!env.SUPABASE_SERVICE_ROLE_KEY||typeof env.INVITATION_RATE_LIMITER?.limit!=='function')return reply({ok:false,attendanceRecorded:false,error:'Attendance service unavailable.'},503);
  const authorization=request.headers.get('Authorization')||'';
  if(!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(authorization))return reply({ok:false,attendanceRecorded:false,error:'Sign in required.'},401);
  const key=env.SUPABASE_SERVICE_ROLE_KEY,server={apikey:key,...(key.startsWith('sb_secret_')?{}:{Authorization:'Bearer '+key})};
  const call=async(path,headers=server,body)=>{
   const response=await fetcher(PROJECT+path,{method:body?'POST':'GET',headers:{...headers,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'manual',signal:AbortSignal.timeout(10000)});
   if(path==='/auth/v1/user'&&[401,403].includes(response.status))return null;
   if(!response.ok)throw Error();const text=await response.text();if(text.length>1024*1024)throw Error();return JSON.parse(text);
  };
  const query=(table,params)=>'/rest/v1/'+table+'?'+new URLSearchParams(params);
  try{
   const user=await call('/auth/v1/user',{apikey:env.SUPABASE_PUBLISHABLE_KEY,Authorization:authorization});
   if(!UUID.test(user?.id||'')||!user.email_confirmed_at)return reply({ok:false,attendanceRecorded:false,error:'Verified sign-in required.'},401);
   const limit=await env.INVITATION_RATE_LIMITER.limit({key:'ironcrest-attendance-workflows:'+user.id});if(limit?.success!==true)return reply({ok:false,attendanceRecorded:false,error:'Please wait before trying again.'},429);
   const members=await call(query('ironcrest_memberships',{select:'id,organization_id,role,active',user_id:'eq.'+user.id,active:'eq.true',limit:'2'}));
   if(!Array.isArray(members)||members.length!==1||members[0].active!==true||members[0].role!=='employee'||!UUID.test(members[0].id)||!UUID.test(members[0].organization_id))return reply({ok:false,attendanceRecorded:false,error:'One active employee membership required.'},403);
   const member=members[0],org=member.organization_id;
   const organizations=await call(query('ironcrest_organizations',{select:'id,created_by',id:'eq.'+org,limit:'1'}));
   if(!Array.isArray(organizations)||organizations.length!==1||organizations[0].id!==org||!UUID.test(organizations[0].created_by))throw Error();
   const owners=await call(query('ironcrest_memberships',{select:'id',user_id:'eq.'+organizations[0].created_by,organization_id:'eq.'+org,role:'eq.owner',active:'eq.true',limit:'1'}));
   if(!Array.isArray(owners)||owners.length!==1)return reply({ok:false,attendanceRecorded:false,error:'Active company owner required.'},403);
   const ent=await call('/rest/v1/rpc/ironcrest_business_entitlement',server,{p_organization_id:org});
   if(!Array.isArray(ent)||ent.length!==1||ent[0].business_active!==true)return reply({ok:false,attendanceRecorded:false,error:'Business access required.'},403);
   if(status){
    // No location request, service-side employee/org filters, and no history disclosure.
    const rows=await call(query('ironcrest_attendance_entries',{select:'id,organization_id,employee_user_id,worksite_id,clock_in_at',organization_id:'eq.'+org,employee_user_id:'eq.'+user.id,clock_out_at:'is.null',limit:'2'}));
    if(!Array.isArray(rows)||rows.length>1||rows.some(x=>x.organization_id!==org||x.employee_user_id!==user.id||!UUID.test(x.id)||!UUID.test(x.worksite_id)||!Number.isFinite(Date.parse(x.clock_in_at))))throw Error();
    const assignments=await call(query('ironcrest_employee_worksite_assignments',{select:'worksite_id,organization_id,membership_id,active',organization_id:'eq.'+org,membership_id:'eq.'+member.id,active:'eq.true',limit:'101'}));
    if(!Array.isArray(assignments)||assignments.length>100||assignments.some(a=>a.organization_id!==org||a.membership_id!==member.id||a.active!==true||!UUID.test(a.worksite_id)))throw Error();
    const assignedIds=[...new Set(assignments.map(a=>a.worksite_id))];
    const sites=assignedIds.length?await call(query('ironcrest_worksites',{select:'id,name,organization_id,active',organization_id:'eq.'+org,id:'in.('+assignedIds.join(',')+')',active:'eq.true',order:'name,id',limit:'101'})):[];
    if(!Array.isArray(sites)||sites.length>100||sites.some(s=>s.organization_id!==org||s.active!==true||!assignedIds.includes(s.id)||typeof s.name!=='string'))throw Error();
    const entry=rows[0];return reply({ok:true,readOnly:true,worksites:sites.map(s=>({id:s.id,name:s.name})),openShift:entry?{entryId:entry.id,worksiteId:entry.worksite_id,clockInAt:entry.clock_in_at}:null});
   }
   if(request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!=='application/json')return reply({ok:false,attendanceRecorded:false,error:'JSON required.'},415);
   let body;try{
    const reader=request.body?.getReader();if(!reader)throw Error();const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false});let size=0,text='';
    while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>2048){await reader.cancel();throw Error();}text+=decoder.decode(value,{stream:true});}text+=decoder.decode();body=attendanceWorkflowBody(JSON.parse(text),action);
   }catch{return reply({ok:false,attendanceRecorded:false,error:'A fresh accurate location and valid attendance request are required.'},400);}
   try{
    const result=await call('/rest/v1/rpc/ironcrest_attendance_workflow',server,{p_actor:user.id,p_operation_id:body.operationId,p_worksite_id:body.worksiteId,p_action:action,p_expected_entry_id:body.expectedEntryId,p_latitude:body.latitude,p_longitude:body.longitude,p_accuracy_m:body.accuracyMeters,p_sample_at:new Date(body.sampleTimestamp).toISOString()});
    if(!UUID.test(result?.entryId||'')||result.action!==action||result.operationId!==body.operationId||typeof result.replayed!=='boolean'||(action==='clock_out'&&result.entryId!==body.expectedEntryId)||!Number.isFinite(Date.parse(result[action==='clock_in'?'clockInAt':'clockOutAt'])))throw Error();
    return reply({ok:true,attendanceRecorded:true,result});
   }catch{return reply({ok:false,attendanceRecorded:null,operationId:body.operationId,error:'Attendance was rejected or its outcome is uncertain. Check the current shift and time records before another action. Do not create a replacement request.'},409);}
  }catch{return reply({ok:false,attendanceRecorded:false,error:'Attendance checks are temporarily unavailable.'},503);}
 };
}
