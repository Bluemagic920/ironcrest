const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const [baselinePath,expectedHash,targetArg]=process.argv.slice(2);
if(!baselinePath||!/^[a-f0-9]{64}$/i.test(expectedHash||''))throw Error('Supply the inspected active Worker file and its approved SHA256');
const baseline=fs.readFileSync(path.resolve(baselinePath),'utf8');
const hash=crypto.createHash('sha256').update(baseline).digest('hex');if(hash.toLowerCase()!==expectedHash.toLowerCase())throw Error('Active Worker baseline mismatch');
if((baseline.match(/export default/g)||[]).length!==1||/^import |^export (?!default)/m.test(baseline)||baseline.includes('__ironcrestLegacyDefault'))throw Error('Baseline requires manual module review');
let patched=baseline.replace('const VERSION = "0.8.54-attendance-corrections";','const VERSION = "0.8.55-invitation-recovery";');const patchedModules=[];
function patchModule(name,file,construction){
 const marker='const '+name+' = (() => {';
 if(!patched.includes(name))return;
 const matches=[...patched.matchAll(new RegExp('const\\s+'+name+'\\s*=\\s*\\(\\s*\\(\\s*\\)\\s*=>\\s*\\{','g'))];
 const start=matches[0]?.index??-1,returnAt=patched.indexOf(construction,start),end=patched.indexOf('})();',returnAt);
 if(matches.length!==1||start<0||returnAt<0||end<0)throw Error('Embedded '+name+' requires manual comparison');
 const moduleSource=fs.readFileSync(path.resolve(__dirname,'../worker',file),'utf8').replace(/^export (?=(?:async )?function)/gm,'');
 patched=patched.slice(0,start)+marker+'\n'+moduleSource+'\n'+construction+'\n})();'+patched.slice(end+5);patchedModules.push(name);
}
patchModule('ironcrestOwnerInvitations','owner-invitations.mjs','return createOwnerInvitationsRoute({emailBuilder:buildInvitationEmail});');
patchModule('ironcrestAttendanceWorkflows','attendance-workflows.mjs','return createAttendanceWorkflowRoute({releaseApproved:GENERAL_ATTENDANCE_RELEASE_APPROVED});');
const legacy=patched.replace('export default','const __ironcrestLegacyDefault =');
const modulePath=path.resolve(__dirname,'../worker/invitation-acceptance.mjs');
const source=fs.readFileSync(modulePath,'utf8').replace(/^export function /gm,'function ');
const output='// Reviewed invitation patch; unrelated Worker paths remain delegated to the inspected baseline.\nconst __legacy=(()=>{\n'+legacy+'\nreturn __ironcrestLegacyDefault;\n})();\nconst {withInvitationAcceptance}=(()=>{\n'+source+'\nreturn {withInvitationAcceptance};\n})();\nconst INVITATION_STATUS_RELEASE_APPROVED=false;\nexport default withInvitationAcceptance(__legacy,{releaseApproved:INVITATION_STATUS_RELEASE_APPROVED});\n';
const target=path.resolve(targetArg||path.join(__dirname,'../work/invitation-release/worker.mjs'));fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,output);
console.log(JSON.stringify({path:target,baselineSha256:hash,patchedModules,sha256:crypto.createHash('sha256').update(output).digest('hex')}));
