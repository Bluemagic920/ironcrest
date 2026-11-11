(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.IroncrestAttendance=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 function time(value){
  if(typeof value!=='string')return NaN;
  const parts=value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/);if(!parts)return NaN;
  const [y,m,d,h,min,sec]=parts.slice(1,7).map(Number),date=new Date(Date.UTC(y,m-1,d));
  if(date.getUTCFullYear()!==y||date.getUTCMonth()!==m-1||date.getUTCDate()!==d||h>23||min>59||sec>59)return NaN;
  return Date.parse(value);
 }
 function entrySummary(row,window,now=Date.now()){
  const start=time(row.clock_in_at),end=row.clock_out_at===null?null:time(row.clock_out_at),from=time(window.start),to=time(window.end);
  const invalid=!Number.isFinite(start)||!Number.isFinite(from)||!Number.isFinite(to)||to<=from||start>now+5000||(end!==null&&(!Number.isFinite(end)||end<start||end>now+5000));
  if(invalid)return {state:'Needs review',seconds:0};
  if(end===null)return {state:'Open shift',seconds:0};
  const seconds=Math.max(0,Math.min(end,to)-Math.max(start,from))/1000;
  return {state:row.clock_in_exception_id||row.clock_out_exception_id?'Closed - exception linked':'Closed',seconds};
 }
 function analyzeEntries(rows,window,now=Date.now()){
  const summaries=rows.map(row=>entrySummary(row,window,now));
  for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++){
   if(rows[i].employee_user_id!==rows[j].employee_user_id)continue;
   const starts=[time(rows[i].clock_in_at),time(rows[j].clock_in_at)],ends=[rows[i].clock_out_at===null?now:time(rows[i].clock_out_at),rows[j].clock_out_at===null?now:time(rows[j].clock_out_at)];
   if([...starts,...ends].every(Number.isFinite)&&Math.max(...starts,time(window.start))<Math.min(...ends,time(window.end))){
    for(const index of [i,j])summaries[index]={state:'Needs review - overlapping shifts',seconds:0};
   }
  }
  return summaries;
 }
 function csvCell(value){let text=String(value??'');if(/^[\s\uFEFF]*[=+@-]/.test(text)||/^[\t\r\n]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';}
 function rowsCsv(rows){return '\uFEFF'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';}
 function mount({document,client,verifyOwner,apiBase,endpoint='/api/attendance/records',selfOnly=false,fetcher=fetch,download}){
  const $=id=>document.getElementById(id),panel=$('attendance-records'),button=$('attendance-records-load');
  if(!panel||!button)return;
  let generation=0,report=null,org=null,controller=null;
  const status=$('attendance-records-status'),body=$('attendance-records-body'),exceptionBody=$('attendance-exceptions-body'),exportButton=$('attendance-records-export');
  const names=(type,id)=>report?.[type]?.[id]||(id?(selfOnly&&type==='employeeNames'?'You':(type==='employeeNames'?'Employee ':'Worksite ')+id.slice(-8)):'Not specified');
  const date=value=>Number.isFinite(time(value))?new Date(value).toISOString().replace('T',' ').replace('.000Z',' UTC'):'-';
  const text=(tag,value)=>{const el=document.createElement(tag);el.textContent=String(value??'');return el;};
  function clear(){generation++;controller?.abort();controller=null;report=null;org=null;body.replaceChildren();exceptionBody.replaceChildren();for(const id of ['attendance-employee','attendance-worksite']){const option=document.createElement('option');option.value='';option.textContent='All';$(id).replaceChildren(option);$(id).value='';}exportButton.disabled=true;button.disabled=false;$('attendance-records-summary').textContent='';status.textContent='Select dates and load recorded attendance.';}
  function filtered(){return (report?.entries||[]).filter(row=>(!$('attendance-employee').value||row.employee_user_id===$('attendance-employee').value)&&(!$('attendance-worksite').value||row.worksite_id===$('attendance-worksite').value));}
  function render(){if(!report)return;const rows=filtered(),analysis=analyzeEntries(report.entries,report.window),summaries=new Map(report.entries.map((row,i)=>[row,analysis[i]]));let seconds=0,open=0,review=0;body.replaceChildren();exceptionBody.replaceChildren();
   for(const row of rows){const summary=summaries.get(row);seconds+=summary.seconds;if(row.clock_out_at===null)open++;if(summary.state.startsWith('Needs review'))review++;
    const tr=document.createElement('tr');for(const value of [names('employeeNames',row.employee_user_id),names('worksiteNames',row.worksite_id),date(row.clock_in_at),row.clock_out_at===null?'Still open':date(row.clock_out_at),(summary.seconds/3600).toFixed(2),summary.state])tr.appendChild(text('td',value));body.appendChild(tr);}
   if(!rows.length){const tr=document.createElement('tr'),td=text('td','No recorded shifts match these filters.');td.colSpan=6;tr.appendChild(td);body.appendChild(tr);}
   const exceptions=report.exceptions.filter(row=>(!$('attendance-employee').value||row.employee_user_id===$('attendance-employee').value)&&(!$('attendance-worksite').value||row.worksite_id===$('attendance-worksite').value));
   for(const row of exceptions){const tr=document.createElement('tr');for(const value of [names('employeeNames',row.employee_user_id),names('worksiteNames',row.worksite_id),({clock_in:'Clock in',clock_out:'Clock out'}[row.requested_action]||'Action unavailable'),({pending:'Pending',approved:'Approved',rejected:'Rejected',cancelled:'Cancelled'}[row.status]||'Status unavailable'),date(row.requested_at)])tr.appendChild(text('td',value));exceptionBody.appendChild(tr);}
   $('attendance-records-summary').textContent=rows.length+' displayed shifts | '+(seconds/3600).toFixed(2)+' closed hours within selected dates | '+open+' open | '+review+' need review | '+exceptions.length+' exception requests';
   exportButton.disabled=rows.length===0;
  }
  function options(id,rows,key,label){const select=$(id);select.replaceChildren();const all=text('option','All');all.value='';select.appendChild(all);for(const value of [...new Set(rows.map(row=>row[key]).filter(Boolean))]){const option=text('option',names(label,value));option.value=value;select.appendChild(option);}}
  async function load(){clear();const version=generation;button.disabled=true;controller=new AbortController();status.textContent='Loading recorded attendance...';
   try{const owner=await verifyOwner();if(version!==generation)return;org=owner;
    const {data,error}=await client.auth.getSession();if(version!==generation)return;if(error||!data?.session?.access_token)throw Error('Please sign in again.');
    const params=new URLSearchParams({start:$('attendance-start').value,end:$('attendance-end').value});
    const response=await fetcher(apiBase+endpoint+'?'+params,{method:'GET',headers:{Authorization:'Bearer '+data.session.access_token},cache:'no-store',referrerPolicy:'no-referrer',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000)])});
    const dataReport=await response.json();if(version!==generation)return;
    if(!response.ok)throw Error(response.status===401?'Your session expired. Please sign in again.':response.status===503?'Attendance reporting is not available yet.':response.status===403?(selfOnly?'Active employee access is required.':'Owner Business access is required.'):'Unable to load records. Check the selected dates.');
    const latest=await verifyOwner();if(version!==generation||latest!==org)return;
    if(dataReport?.ok!==true||dataReport.readOnly!==true||dataReport.organizationScoped!==true||(selfOnly&&dataReport.selfScoped!==true)||!Array.isArray(dataReport.entries)||!Array.isArray(dataReport.exceptions)||dataReport.entries.length>200||dataReport.exceptions.length>200||!Number.isFinite(time(dataReport.window?.start))||!Number.isFinite(time(dataReport.window?.end)))throw Error('Attendance response could not be verified.');
    report=dataReport;options('attendance-employee',[...report.entries,...report.exceptions],'employee_user_id','employeeNames');options('attendance-worksite',[...report.entries,...report.exceptions],'worksite_id','worksiteNames');render();
    status.textContent=(report.entriesTruncated||report.exceptionsTruncated?'Showing the first 200 records per list. Narrow the dates for a complete result. ':'Recorded attendance loaded. ')+'Totals cover displayed closed shifts only. Open shifts are not counted as worked hours. Times are UTC; this is not a payroll approval.';
   }catch(error){if(version===generation){report=null;body.replaceChildren();exceptionBody.replaceChildren();exportButton.disabled=true;status.textContent=error.message||'Unable to load records.';}}
   finally{if(version===generation)button.disabled=false;}
  }
  $('attendance-records-open').disabled=false;
  $('attendance-records-open').addEventListener('click',()=>{panel.hidden=false;$('attendance-records-open').setAttribute('aria-expanded','true');panel.scrollIntoView({behavior:'smooth',block:'start'});});
  $('attendance-records-close').addEventListener('click',()=>{clear();panel.hidden=true;$('attendance-records-open').setAttribute('aria-expanded','false');});
  button.addEventListener('click',load);for(const id of ['attendance-employee','attendance-worksite'])$(id).addEventListener('change',render);
  for(const id of ['attendance-start','attendance-end'])$(id).addEventListener('change',clear);
  exportButton.addEventListener('click',()=>{if(!report)return;const rows=filtered(),analysis=analyzeEntries(report.entries,report.window),summaries=new Map(report.entries.map((row,i)=>[row,analysis[i]]));const csv=rowsCsv([['Employee','Worksite','Clock in (UTC)','Clock out (UTC)','Closed hours within selected dates','Status'],...rows.map(row=>{const s=summaries.get(row);return [names('employeeNames',row.employee_user_id),names('worksiteNames',row.worksite_id),date(row.clock_in_at),row.clock_out_at===null?'Open':date(row.clock_out_at),(s.seconds/3600).toFixed(2),s.state];})]);download(csv,'ironcrest-attendance.csv');});
  client.auth.onAuthStateChange(()=>{clear();panel.hidden=true;});
  const today=new Date();$('attendance-end').value=today.toISOString().slice(0,10);$('attendance-start').value=new Date(today.getTime()-6*86400000).toISOString().slice(0,10);
  clear();return {clear,load};
 }
 return {entrySummary,analyzeEntries,csvCell,rowsCsv,mount};
});
