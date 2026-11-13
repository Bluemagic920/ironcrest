const PROJECT='https://nhiqbcevcdxfzvrprgck.supabase.co',ORIGIN='https://ironcrest.profitharborai.com';
const UUID=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function jobTransitionBody(body){
 if(!body||Array.isArray(body)||Object.keys(body).sort().join(',')!=='action,expectedUpdatedAt,jobId'||!UUID.test(body.jobId)||!['start','complete'].includes(body.action)||typeof body.expectedUpdatedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.test(body.expectedUpdatedAt)||!Number.isFinite(Date.parse(body.expectedUpdatedAt)))throw Error('Invalid transition');
 return body;
}
export function createEmployeeJobWorkflowRoute({fetcher=fetch}={}){
 return async function jobWorkflows(request,env){
  const url=new URL(request.url),owner=url.pathname==='/api/jobs',write=url.pathname==='/api/employee/jobs/transition';
  if(!owner&&!write&&url.pathname!=='/api/employee/jobs')return null;
  // Existing controlled release remains exactly as-is until the new gate is enabled.
  if(env.ENABLE_EMPLOYEE_JOB_WORKFLOWS!=='true')return null;
  const origin=request.headers.get('Origin'),reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Vary':'Origin',...(origin===ORIGIN?{'Access-Control-Allow-Origin':ORIGIN}:{})}});
  if(origin!==ORIGIN)return reply({ok:false,error:'origin_not_allowed'},403);
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':ORIGIN,'Access-Control-Allow-Methods':owner?'GET, POST, PATCH, OPTIONS':write?'POST, OPTIONS':'GET, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type','Cache-Control':'no-store','Vary':'Origin'}});
  if(!(owner?['GET','POST','PATCH'].includes(request.method):write?request.method==='POST':request.method==='GET'))return reply({ok:false,error:'method_not_allowed'},405);
  if(url.search)return reply({ok:false,error:'Query parameters are not supported.'},400);
  if(env.SUPABASE_URL?.replace(/\/$/,'')!==PROJECT||!env.SUPABASE_PUBLISHABLE_KEY||!env.SUPABASE_SERVICE_ROLE_KEY||typeof env.INVITATION_RATE_LIMITER?.limit!=='function')return reply({ok:false,error:'Jobs service unavailable.'},503);
  if(write&&env.IRONCREST_EMPLOYEE_JOB_UPDATES!=='enabled')return reply({ok:false,error:'Employee updates are unavailable.'},403);
  const authorization=request.headers.get('Authorization')||'';if(!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(authorization))return reply({ok:false,error:'Sign in is required.'},401);
  const key=env.SUPABASE_SERVICE_ROLE_KEY,server={apikey:key,...(key.startsWith('sb_secret_')?{}:{Authorization:'Bearer '+key})};
  const call=async(path,headers=server,body)=>{
   const response=await fetcher(PROJECT+path,{method:body?'POST':'GET',headers:{...headers,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'manual',signal:AbortSignal.timeout(10000)});
   if(path==='/auth/v1/user'&&[401,403].includes(response.status))return null;
   if(!response.ok)throw Error('Service unavailable');const raw=await response.text();if(raw.length>1024*1024)throw Error();return JSON.parse(raw);
  };
  const query=(table,params)=>'/rest/v1/'+table+'?'+new URLSearchParams(params);
  try{
   const user=await call('/auth/v1/user',{apikey:env.SUPABASE_PUBLISHABLE_KEY,Authorization:authorization});
   if(!UUID.test(user?.id||'')||!user.email_confirmed_at)return reply({ok:false,error:'Verified sign-in required.'},401);
   const rate=await env.INVITATION_RATE_LIMITER.limit({key:'ironcrest-job-workflows:'+user.id});if(rate?.success!==true)return reply({ok:false,error:'Please wait before trying again.'},429);
   const members=await call(query('ironcrest_memberships',{select:'id,organization_id,role,active',user_id:'eq.'+user.id,active:'eq.true',limit:'2'}));
   if(!Array.isArray(members)||members.length!==1||members[0].role!==(owner?'owner':'employee')||members[0].active!==true||!UUID.test(members[0].id)||!UUID.test(members[0].organization_id))return reply({ok:false,error:'One active company membership is required.'},403);
   const member=members[0],org=member.organization_id;
   const organizations=await call(query('ironcrest_organizations',{select:'id,created_by',id:'eq.'+org,limit:'1'}));
   if(!Array.isArray(organizations)||organizations.length!==1||organizations[0].id!==org||!UUID.test(organizations[0].created_by)||owner&&organizations[0].created_by!==user.id)return reply({ok:false,error:'Company access could not be verified.'},403);
   const owners=await call(query('ironcrest_memberships',{select:'id',user_id:'eq.'+organizations[0].created_by,organization_id:'eq.'+org,role:'eq.owner',active:'eq.true',limit:'1'}));if(!Array.isArray(owners)||owners.length!==1)return reply({ok:false,error:'Active company owner required.'},403);
   const ent=await call('/rest/v1/rpc/ironcrest_business_entitlement',server,{p_organization_id:org});if(!Array.isArray(ent)||ent.length!==1||ent[0].business_active!==true)return reply({ok:false,error:'Business access required.'},403);
   // The existing owner create/edit/list handlers retain their flags and validation.
   if(owner)return null;
   if(write){
    if(request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!=='application/json')return reply({ok:false,error:'JSON required.'},415);
    let body;try{
     const reader=request.body?.getReader();if(!reader)throw Error();const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false});let size=0,text='';while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>1024){await reader.cancel();throw Error();}text+=decoder.decode(value,{stream:true});}text+=decoder.decode();body=jobTransitionBody(JSON.parse(text));
    }catch{return reply({ok:false,error:'Check the job action and version.'},400);}
    try{
     const result=await call('/rest/v1/rpc/ironcrest_employee_job_workflow',server,{p_actor:user.id,p_job_id:body.jobId,p_expected_updated_at:body.expectedUpdatedAt,p_action:body.action});
     const expected=body.action==='start'?'in_progress':'completed';
     if(result?.jobId!==body.jobId||result.status!==expected||!UUID.test(result.eventId||''))throw Error();
     return reply({ok:true,jobUpdated:true,job:result,assignedOnly:true,notificationEmailSent:false});
    }catch{return reply({ok:false,jobUpdated:null,error:'Job action was rejected or its outcome is uncertain. Reload assigned jobs before trying again.'},409);}
   }
   const jobs=await call(query('ironcrest_jobs',{select:'id,organization_id,assigned_membership_id,title,description,priority,status,due_date,created_at,updated_at,completed_at',organization_id:'eq.'+org,assigned_membership_id:'eq.'+member.id,order:'created_at.desc,id.desc',limit:'101'}));
   if(!Array.isArray(jobs)||jobs.length>101||jobs.some(j=>j.organization_id!==org||j.assigned_membership_id!==member.id||!UUID.test(j.id)))throw Error();
   const fields=['id','title','description','priority','status','due_date','created_at','updated_at','completed_at'];const shown=jobs.slice(0,100).map(j=>Object.fromEntries(fields.map(k=>[k,j[k]??null])));
   return reply({ok:true,readOnly:true,assignedOnly:true,jobCount:shown.length,jobs:shown,truncated:jobs.length>100});
  }catch{return reply({ok:false,error:'Jobs service is temporarily unavailable.'},503);}
 };
}
