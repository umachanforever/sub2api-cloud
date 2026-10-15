import { Database, HttpError } from "./db.ts";
import { json } from "./http.ts";
import { ensureOpenAIPrivacy } from "./openai_privacy.ts";

type Job = {account_id:string; revision:number; lease_id:string};

export async function runPrivacyJobs(db:Database) {
  const jobs=await db.rpc<Job[]>("s2a_privacy_jobs_claim",{});
  let finished=0;
  await Promise.all(jobs.map(async job=>{
    let error:null|string=null;
    try { await ensureOpenAIPrivacy(db,job.account_id); } catch { error="worker_failed"; }
    try {
      if(await db.rpc<boolean>("s2a_privacy_jobs_finish",{p_account_id:job.account_id,p_revision:job.revision,p_lease_id:job.lease_id,p_error:error}))finished++;
    } catch { console.warn("privacy_job_finish_failed"); }
  }));
  return {claimed:jobs.length,finished};
}

function equalBytes(a:Uint8Array,b:Uint8Array) {
  let difference=a.length^b.length;
  for(let i=0;i<a.length;i++)difference|=a[i]^(b[i]??0);
  return difference===0;
}

export async function authorizeJob(request:Request,db:Database,scope:'privacy'|'quota-reset'|'mail'|'codex'|'gemini-cache') {
  const supplied=request.headers.get("authorization")?.match(/^Bearer (\S+)$/i)?.[1]??"";
  const digest=async(value:string)=>new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)));
  let authorized=!!supplied && !!db.config.serviceKey && equalBytes(await digest(supplied),await digest(db.config.serviceKey));
  if(!authorized && db.config.serviceKey) {
    const ticket=request.headers.get(`x-s2a-${scope}-job-token`)??"";
    const parts=ticket.match(/^(\d{10}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9a-f]{64})$/);
    const now=Math.floor(Date.now()/1000);
    if(parts && Number(parts[1])>=now && Number(parts[1])<=now+90) {
      const signingKey=['codex','gemini-cache'].includes(scope) ? db.config.jobSigningKey ?? db.config.serviceKey : db.config.serviceKey;
      const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(signingKey),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
      const signature=new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(`s2a-${scope}:${parts[1]}:${parts[2]}`)));
      authorized=equalBytes(signature,new Uint8Array(parts[3].match(/../g)!.map(byte=>parseInt(byte,16))));
    }
  }
  if(!authorized)throw new HttpError(401,"unauthorized");
  if(request.method!=="POST")throw new HttpError(405,"method_not_allowed");
}

export async function privacyJobs(request:Request,db:Database) {
  await authorizeJob(request,db,'privacy');
  return json(200,await runPrivacyJobs(db));
}
