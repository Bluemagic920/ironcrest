const PROJECT='https://nhiqbcevcdxfzvrprgck.supabase.co',ORIGIN='https://ironcrest.profitharborai.com';
const UUID=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function validateEmployeeProfile(value,self){
 const fields=self?['revision','phoneNumber','email']:['membershipId','revision','firstName','lastName','jobTitle','phoneNumber','email','employmentStatus'];
 if(!value||Array.isArray(value)||Object.keys(value).sort().join(',')!==fields.sort().join(',')||!Number.isSafeInteger(value.revision)||value.revision<0||value.revision>=Number.MAX_SAFE_INTEGER)throw Error('invalid_profile');
 const text=(key,max,required=false)=>{if(typeof value[key]!=='string')throw Error('invalid_profile');const clean=value[key].trim();if(clean.length>max||required&&!clean||/[\x00-\x1f\x7f]/.test(clean))throw Error('invalid_profile');return clean;};
 const phoneNumber=text('phoneNumber',30),email=text('email',254);
 if(phoneNumber&&(phoneNumber.length<7||!/^[+0-9() .-]+$/.test(phoneNumber))||email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw Error('invalid_contact_details');
 const changes={phoneNumber,email};
 if(!self){if(!UUID.test(value.membershipId)||!['active','inactive','on_leave'].includes(value.employmentStatus))throw Error('invalid_profile');Object.assign(changes,{firstName:text('firstName',100,true),lastName:text('lastName',100,true),jobTitle:text('jobTitle',120),employmentStatus:value.employmentStatus});}
 return {revision:value.revision,membershipId:self?null:value.membershipId,changes};
}
export function createEmployeeProfilesRoute({fetcher=fetch}={}){
 return async function employeeProfiles(request,env){
  const url=new URL(request.url),self=url.pathname==='/api/employee/profile';if(!self&&url.pathname!=='/api/employees/profile')return null;
  // Existing owner route remains unchanged until the new release is enabled.
  if(!self&&env.ENABLE_EMPLOYEE_PROFILES!=='true')return null;
  const origin=request.headers.get('Origin');
  const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Vary':'Origin',...(origin===ORIGIN?{'Access-Control-Allow-Origin':ORIGIN}:{})}});
  if(origin!==ORIGIN)return reply({ok:false,error:'origin_not_allowed'},403);
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':ORIGIN,'Access-Control-Allow-Methods':self?'GET, PATCH, OPTIONS':'PATCH, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type','Cache-Control':'no-store','Vary':'Origin'}});
  if(request.method!=='PATCH'&&!(self&&request.method==='GET'))return reply({ok:false,error:'method_not_allowed'},405);
  if(env.ENABLE_EMPLOYEE_PROFILES!=='true')return reply({ok:false,error:'employee_profiles_not_released'},503);
  if(url.search)return reply({ok:false,error:'unexpected_parameters'},400);
  if(env.SUPABASE_URL?.replace(/\/$/,'')!==PROJECT||!env.SUPABASE_SERVICE_ROLE_KEY||!env.SUPABASE_PUBLISHABLE_KEY||typeof env.INVITATION_RATE_LIMITER?.limit!=='function')return reply({ok:false,error:'profile_unavailable'},503);
  const auth=request.headers.get('Authorization')||'';if(!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(auth))return reply({ok:false,error:'verified_access_required'},401);
  let input;
  if(request.method==='PATCH'){
   if(request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!=='application/json')return reply({ok:false,error:'json_required'},415);
   try{const reader=request.body?.getReader();if(!reader)throw Error();const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false});let raw='',size=0;
    while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>4096){await reader.cancel();throw Error();}raw+=decoder.decode(value,{stream:true});}raw+=decoder.decode();
    const body=JSON.parse(raw);if(!self&&body&&!Object.hasOwn(body,'revision'))return reply({ok:false,error:'Reload the employee directory before saving.'},409);
    input=validateEmployeeProfile(body,self);
   }catch{return reply({ok:false,error:'Check the profile fields and contact details.'},400);}
  }
  const key=env.SUPABASE_SERVICE_ROLE_KEY,server={apikey:key,...(key.startsWith('sb_secret_')?{}:{Authorization:'Bearer '+key})};
  const query=(table,params)=>'/rest/v1/'+table+'?'+new URLSearchParams(params);
  const call=async(path,headers=server,body)=>{
   const response=await fetcher(PROJECT+path,{method:body?'POST':'GET',headers:{...headers,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'manual',signal:AbortSignal.timeout(8000)});
   if(path==='/auth/v1/user'&&[401,403].includes(response.status))return null;if(!response.ok)throw Error();const raw=await response.text();if(raw.length>65536)throw Error();return JSON.parse(raw);
  };
  const project=row=>({firstName:row.first_name??null,lastName:row.last_name??null,jobTitle:row.job_title??null,employmentStatus:row.employment_status,phoneNumber:row.phone_number??null,email:row.email??null,revision:row.revision});
  try{
   const user=await call('/auth/v1/user',{apikey:env.SUPABASE_PUBLISHABLE_KEY,Authorization:auth});if(!UUID.test(user?.id||'')||!user.email_confirmed_at)return reply({ok:false,error:'verified_access_required'},401);
   if((await env.INVITATION_RATE_LIMITER.limit({key:'ironcrest-employee-profile:'+user.id}))?.success!==true)return reply({ok:false,error:'rate_limited'},429);
   const memberships=await call(query('ironcrest_memberships',{select:'id,organization_id',user_id:'eq.'+user.id,role:self?'eq.employee':'eq.owner',active:'eq.true',limit:'2'}));
   if(!Array.isArray(memberships)||memberships.length!==1||!UUID.test(memberships[0]?.id||'')||!UUID.test(memberships[0]?.organization_id||''))return reply({ok:false,error:'verified_access_required'},403);
   const org=memberships[0].organization_id,memberId=self?memberships[0].id:input.membershipId;
   const organizations=await call(query('ironcrest_organizations',{select:'id',id:'eq.'+org,...(!self?{created_by:'eq.'+user.id}:{}),limit:'1'}));if(!Array.isArray(organizations)||organizations.length!==1||organizations[0].id!==org)return reply({ok:false,error:'verified_access_required'},403);
   const entitlement=await call('/rest/v1/rpc/ironcrest_business_entitlement',server,{p_organization_id:org});if(!Array.isArray(entitlement)||entitlement.length!==1||entitlement[0].business_active!==true)return reply({ok:false,error:'business_access_required'},403);
   if(request.method==='GET'){
    const rows=await call(query('ironcrest_employee_profiles',{select:'first_name,last_name,job_title,employment_status,phone_number,email,revision',membership_id:'eq.'+memberId,organization_id:'eq.'+org,limit:'1'}));if(!Array.isArray(rows)||rows.length>1)throw Error();
    return reply({ok:true,selfScoped:true,organizationScoped:true,profile:rows[0]?project(rows[0]):null,contactEditsOnly:true});
   }
   const result=await call('/rest/v1/rpc/ironcrest_update_employee_profile',server,{p_actor:user.id,p_organization_id:org,p_membership_id:memberId,p_expected_revision:input.revision,p_changes:input.changes,p_self:self});
   const messages={profile_conflict:'This profile changed in another window. Reload before saving.',profile_not_ready:'Your owner needs to finish setting up your profile.',owner_required:'Owner access is required.',active_employee_required:'Active employee access is required.',employee_not_found:'Employee not found.',business_access_required:'Business access is required.',invalid_profile:'Check the profile fields.',invalid_contact_details:'Check the phone number and contact email.',contact_fields_only:'Employees can edit contact details only.'};
   if(result?.ok!==true){const code=result?.error;return reply({ok:false,error:messages[code]||'Profile update unavailable.',code:Object.hasOwn(messages,code)?code:'profile_unavailable'},code==='profile_conflict'?409:code==='employee_not_found'||code==='profile_not_ready'?404:code?.endsWith('required')?403:Object.hasOwn(messages,code)?400:503);}
   if(!Number.isSafeInteger(result.revision)||result.revision<1||result.profile?.revision!==result.revision)throw Error();
   const profile=Object.fromEntries(['firstName','lastName','jobTitle','employmentStatus','phoneNumber','email','revision'].map(k=>[k,result.profile[k]??null]));
   return reply({ok:true,updated:true,organizationScoped:true,selfScoped:self,contactEditsOnly:self,revision:result.revision,profile,attendanceEnabled:false,attendanceWritesEnabled:false});
  }catch{return reply({ok:false,error:'Profile service is temporarily unavailable.'},503);}
 };
}
