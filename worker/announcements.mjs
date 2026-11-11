const PROJECT='https://nhiqbcevcdxfzvrprgck.supabase.co',ORIGIN='https://ironcrest.profitharborai.com';
const UUID=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function validTime(value){
 if(typeof value!=='string')return false;const m=value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/);if(!m)return false;
 const [y,month,day,h,min,s]=m.slice(1,7).map(Number),d=new Date(Date.UTC(y,month-1,day));return d.getUTCFullYear()===y&&d.getUTCMonth()===month-1&&d.getUTCDate()===day&&h<24&&min<60&&s<60&&Number.isFinite(Date.parse(value));
}
export function announcementCursor(value){
 if(typeof value!=='string'||value.length>256||!/^[A-Za-z0-9_-]+$/.test(value))throw Error();const parsed=JSON.parse(atob(value.replaceAll('-','+').replaceAll('_','/')));
 if(!parsed||Object.keys(parsed).sort().join(',')!=='id,time'||!UUID.test(parsed.id)||!validTime(parsed.time))throw Error();return parsed;
}
function encodeCursor(row,key){if(!UUID.test(row.id)||!validTime(row[key]))throw Error();return btoa(JSON.stringify({time:row[key],id:row.id})).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');}
export function validateAnnouncement(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||!['save_draft','publish','archive'].includes(value.action))throw Error();
 const fields=value.action==='save_draft'?['action','id','revision','title','body']:['action','id','revision'];
 if(Object.keys(value).sort().join(',')!==fields.sort().join(',')||!Number.isSafeInteger(value.revision)||value.revision<0||value.revision>=Number.MAX_SAFE_INTEGER)throw Error();
 if(value.id!==null&&!UUID.test(value.id)||value.id===null&&(value.action!=='save_draft'||value.revision!==0)||value.id!==null&&value.revision<1)throw Error();
 if(value.action==='save_draft'&&(typeof value.title!=='string'||!value.title.trim()||value.title.trim().length>160||/[\x00-\x1f\x7f]/.test(value.title)||typeof value.body!=='string'||!value.body.trim()||value.body.trim().length>5000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.body)))throw Error();
 return value;
}
export function createAnnouncementsRoute({fetcher=fetch}={}){
 return async function announcementsRoute(request,env){
  const url=new URL(request.url),self=url.pathname==='/api/employee/announcements';if(!self&&url.pathname!=='/api/announcements')return null;
  const origin=request.headers.get('Origin');const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Vary':'Origin',...(origin===ORIGIN?{'Access-Control-Allow-Origin':ORIGIN}:{})}});
  if(origin!==ORIGIN)return reply({ok:false,error:'origin_not_allowed'},403);
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':ORIGIN,'Access-Control-Allow-Methods':self?'GET, OPTIONS':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type','Cache-Control':'no-store','Vary':'Origin'}});
  if(request.method!=='GET'&&!(request.method==='POST'&&!self))return reply({ok:false,error:'method_not_allowed'},405);
  if(env.ENABLE_COMPANY_ANNOUNCEMENTS!=='true')return reply({ok:false,error:'announcements_not_released'},503);
  if(env.SUPABASE_URL?.replace(/\/$/,'')!==PROJECT||!env.SUPABASE_SERVICE_ROLE_KEY||!env.SUPABASE_PUBLISHABLE_KEY||typeof env.INVITATION_RATE_LIMITER?.limit!=='function')return reply({ok:false,error:'announcements_unavailable'},503);
  const auth=request.headers.get('Authorization')||'';if(!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(auth))return reply({ok:false,error:'verified_access_required'},401);
  let input,status='all',cursor=null;
  try{
   if(request.method==='POST'){
    if(url.search||request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw Error();
    const reader=request.body?.getReader();if(!reader)throw Error();const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false});let size=0,raw='';
    while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>32768){await reader.cancel();throw Error();}raw+=decoder.decode(value,{stream:true});}raw+=decoder.decode();input=validateAnnouncement(JSON.parse(raw));
   }else{
    const allowed=self?['cursor']:['cursor','status'];if([...url.searchParams.keys()].some(k=>!allowed.includes(k))||allowed.some(k=>url.searchParams.getAll(k).length>1))throw Error();
    status=url.searchParams.get('status')||'all';if(!['all','draft','published','archived'].includes(status))throw Error();
    if(url.searchParams.has('cursor'))cursor=announcementCursor(url.searchParams.get('cursor'));
   }
  }catch{return reply({ok:false,error:'invalid_announcement_request'},400);}
  const key=env.SUPABASE_SERVICE_ROLE_KEY,server={apikey:key,...(key.startsWith('sb_secret_')?{}:{Authorization:'Bearer '+key})};
  const query=(table,params)=>'/rest/v1/'+table+'?'+new URLSearchParams(params);
  const call=async(path,headers=server,body)=>{
   const response=await fetcher(PROJECT+path,{method:body?'POST':'GET',headers:{...headers,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'manual',signal:AbortSignal.timeout(8000)});
   if(path==='/auth/v1/user'&&[401,403].includes(response.status))return null;if(!response.ok)throw Error();const raw=await response.text();if(raw.length>1024*1024)throw Error();return JSON.parse(raw);
  };
  const project=row=>Object.fromEntries(['id','title','body','status','revision','created_at','published_at','archived_at'].map(k=>[k,row[k]??null]));
  try{
   const user=await call('/auth/v1/user',{apikey:env.SUPABASE_PUBLISHABLE_KEY,Authorization:auth});if(!UUID.test(user?.id||'')||!user.email_confirmed_at)return reply({ok:false,error:'verified_access_required'},401);
   if((await env.INVITATION_RATE_LIMITER.limit({key:'ironcrest-announcements:'+user.id}))?.success!==true)return reply({ok:false,error:'rate_limited'},429);
   const memberships=await call(query('ironcrest_memberships',{select:'organization_id',user_id:'eq.'+user.id,role:self?'eq.employee':'eq.owner',active:'eq.true',limit:'2'}));if(!Array.isArray(memberships)||memberships.length!==1||!UUID.test(memberships[0]?.organization_id||''))return reply({ok:false,error:'verified_access_required'},403);const org=memberships[0].organization_id;
   const organizations=await call(query('ironcrest_organizations',{select:'id',id:'eq.'+org,...(!self?{created_by:'eq.'+user.id}:{}),limit:'1'}));if(!Array.isArray(organizations)||organizations.length!==1||organizations[0].id!==org)return reply({ok:false,error:'verified_access_required'},403);
   const entitlement=await call('/rest/v1/rpc/ironcrest_business_entitlement',server,{p_organization_id:org});if(!Array.isArray(entitlement)||entitlement.length!==1||entitlement[0].business_active!==true)return reply({ok:false,error:'business_access_required'},403);
   if(input){
    const result=await call('/rest/v1/rpc/ironcrest_announcement_action',server,{p_actor:user.id,p_organization_id:org,p_action:input.action,p_id:input.id,p_expected_revision:input.revision,...(input.action==='save_draft'?{p_title:input.title.trim(),p_body:input.body.trim()}:{})});
    const errors=['invalid_announcement','owner_required','business_access_required','announcement_not_found','announcement_conflict','published_announcement_read_only'];
    if(result?.ok!==true){const error=errors.includes(result?.error)?result.error:'announcements_unavailable';return reply({ok:false,error},error.endsWith('required')?403:error==='announcement_not_found'?404:error==='announcements_unavailable'?503:409);}
    return reply({ok:true,organizationScoped:true,announcement:project(result.announcement)});
   }
   const sort=self?'published_at':'created_at';
   const rows=await call(query('ironcrest_announcements',{select:'id,organization_id,title,body,status,revision,created_at,published_at,archived_at',organization_id:'eq.'+org,...(self?{status:'eq.published'}:status!=='all'?{status:'eq.'+status}:{}),...(cursor?{or:'('+sort+'.lt.'+cursor.time+',and('+sort+'.eq.'+cursor.time+',id.lt.'+cursor.id+'))'}:{}),order:sort+'.desc,id.desc',limit:'26'}));
   if(!Array.isArray(rows)||rows.length>26||rows.some(r=>r.organization_id!==org||self&&(r.status!=='published'||!r.published_at)))throw Error();
   const preferences=await call(query('ironcrest_company_settings',{select:'time_zone',organization_id:'eq.'+org,limit:'1'}));if(!Array.isArray(preferences)||preferences.length>1)throw Error();const timeZone=preferences[0]?.time_zone||'UTC';new Intl.DateTimeFormat('en',{timeZone}).format();
   const page=rows.slice(0,25);return reply({ok:true,organizationScoped:true,employeeFeed:self,timeZone,announcements:page.map(project),nextCursor:rows.length>25?encodeCursor(page.at(-1),sort):null});
  }catch{return reply({ok:false,error:'announcements_unavailable'},503);}
 };
}
