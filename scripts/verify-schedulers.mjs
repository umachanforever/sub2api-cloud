import {pathToFileURL} from 'node:url';
export async function verifySchedulers(env=process.env,fetcher=fetch,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))){
 const base=new URL(env.SUPABASE_URL);
 if(base.protocol!=='https:'||!/^([a-z0-9-]+)\.supabase\.co$/.test(base.hostname)||base.port||base.username||base.password||base.search||base.hash||base.pathname!=='/')throw Error('Configure a cloud Supabase project URL');
 if(!env.SUPABASE_ACCESS_TOKEN)throw Error('Configure SUPABASE_ACCESS_TOKEN to verify cloud scheduler delivery');
 const ref=base.hostname.split('.')[0];
 const sql=async query=>{
  const response=await fetcher(`https://api.supabase.com/v1/projects/${ref}/database/query`,{method:'POST',redirect:'error',headers:{authorization:'Bearer '+env.SUPABASE_ACCESS_TOKEN,'content-type':'application/json'},body:JSON.stringify({query}),signal:AbortSignal.timeout(20000)});
  if(!response.ok){await response.body?.cancel();throw Error('Scheduler database verification failed: HTTP '+response.status);}
  const value=await response.json();if(!Array.isArray(value))throw Error('Invalid scheduler database response');return value;
 };
 const expected=['s2a-codex-jobs','s2a-gemini-cache-jobs','s2a-images-jobs','s2a-batch-images-jobs','s2a-gateway-maintenance'];
 const jobs=await sql("SELECT jobname,active,EXISTS(SELECT FROM public.settings WHERE key='openai_codex_version_auto_sync_enabled' AND value='false') AS codex_disabled FROM cron.job WHERE jobname IN ('s2a-codex-jobs','s2a-gemini-cache-jobs','s2a-images-jobs','s2a-batch-images-jobs','s2a-gateway-maintenance')");
 for(const name of expected)if(!jobs.some(job=>job.jobname===name&&job.active===true))throw Error('Scheduler is missing or disabled: '+name);
 const dispatched=await sql("SELECT 'codex' AS kind,public.s2a_codex_jobs_dispatch() AS request_id UNION ALL SELECT 'gemini-cache',public.s2a_gemini_cache_jobs_dispatch() UNION ALL SELECT 'images',public.s2a_image_jobs_dispatch() UNION ALL SELECT 'batch-images',public.s2a_batch_image_jobs_dispatch()");
 const kinds=['codex','gemini-cache','images','batch-images'];
 if(dispatched.length!==4||new Set(dispatched.map(row=>row.kind)).size!==4||dispatched.some(row=>!kinds.includes(row.kind)))throw Error('Invalid scheduler dispatch response');
 const pending=new Map(),results=[];
 for(const row of dispatched){
  if(row.kind==='codex'&&row.request_id===null&&jobs.some(job=>job.jobname==='s2a-codex-jobs'&&job.codex_disabled===true)){results.push('codex-disabled-by-setting');continue;}
  if(!/^[1-9][0-9]*$/.test(String(row.request_id))||!Number.isSafeInteger(Number(row.request_id)))throw Error('Scheduler did not enqueue a request: '+row.kind);
  pending.set(String(row.request_id),row.kind);
 }
 for(let attempt=0;attempt<55&&pending.size;attempt++){
  const rows=await sql(`SELECT id,status_code,timed_out,error_msg IS NOT NULL AS has_error FROM net._http_response WHERE id IN (${[...pending.keys()].join(',')})`);
  for(const row of rows){
   const kind=pending.get(String(row.id));if(!kind)continue;
   if(row.timed_out||row.has_error||![200,202].includes(row.status_code))throw Error(`Scheduler delivery failed: ${kind} (HTTP ${row.status_code??'none'})`);
   pending.delete(String(row.id));results.push(kind);
  }
  if(pending.size)await pause(1000);
 }
 if(pending.size)throw Error('Scheduler responses are still pending: '+[...pending.values()].join(', '));
 return results;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{console.log('Cloud scheduler delivery verified: '+(await verifySchedulers()).join(', ')+'.');}
 catch(error){console.error(error.message);process.exitCode=1;}
}
