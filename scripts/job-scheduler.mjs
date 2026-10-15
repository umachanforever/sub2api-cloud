import {jobSigningKey} from '../supabase/functions/sub2api/job_signing.ts';
export async function configureJobScheduler(env, target=env.SUPABASE_URL, fetchImpl=fetch) {
  if (env.SUB2API_DATA_MODEL === "native") {
    try {
    const response = await fetchImpl(`${env.SUPABASE_URL}/rest/v1/rpc/s2a_codex_scheduler_configure`, {
      method: 'POST', headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ p_url: target, p_service_key: await jobSigningKey(env.GPT_SUBSCRIPTION_CREDENTIALS_KEY_B64), p_enabled: true }), signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) { await response.body?.cancel(); throw Error('Codex scheduler configuration failed'); }
    if ((await response.json()).enabled !== true) throw Error('Codex scheduler extensions are unavailable');
    } catch { throw Error('Codex scheduler configuration failed; verify Supabase extensions and service credentials'); }
    return;
  }
  try {
    const response=await fetchImpl(`${env.SUPABASE_URL}/rest/v1/rpc/s2a_privacy_scheduler_configure`,{
      method:'POST',headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,'content-type':'application/json'},
      body:JSON.stringify({p_url:target,p_service_key:env.SUPABASE_SERVICE_ROLE_KEY,p_enabled:true}),signal:AbortSignal.timeout(20_000),
    });
    if(!response.ok){await response.body?.cancel();throw Error();}
    if((await response.json()).enabled!==true)throw Error();
    const auto=await fetchImpl(`${env.SUPABASE_URL}/rest/v1/rpc/s2a_openai_auto_reset_scheduler_configure`,{
      method:'POST',headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,'content-type':'application/json'},
      body:JSON.stringify({p_enabled:true}),signal:AbortSignal.timeout(20_000),
    });
    if(!auto.ok){await auto.body?.cancel();throw Error();}
    if((await auto.json()).enabled!==true)throw Error();
    const logs=await fetchImpl(`${env.SUPABASE_URL}/rest/v1/rpc/s2a_log_scheduler_configure`,{
      method:'POST',headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,'content-type':'application/json'},
      body:JSON.stringify({p_enabled:true}),signal:AbortSignal.timeout(20_000),
    });
    if(!logs.ok){await logs.body?.cancel();throw Error();}
    if((await logs.json()).enabled!==true)throw Error();
    const ops=await fetchImpl(`${env.SUPABASE_URL}/rest/v1/rpc/s2a_ops_scheduler_configure`,{
      method:'POST',headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,'content-type':'application/json'},
      body:'{}',signal:AbortSignal.timeout(20_000),
    });
    if(!ops.ok){await ops.body?.cancel();throw Error();}
    const settings=await ops.json();
    if(typeof settings.cleanup_enabled!=='boolean'||typeof settings.aggregation_enabled!=='boolean')throw Error();
    const alerts=await fetchImpl(`${env.SUPABASE_URL}/rest/v1/rpc/s2a_ops_alert_scheduler_configure`,{
      method:'POST',headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,'content-type':'application/json'},
      body:'{}',signal:AbortSignal.timeout(20_000),
    });
    if(!alerts.ok){await alerts.body?.cancel();throw Error();}
    if((await alerts.json()).enabled!==true)throw Error();
    const mail=await fetchImpl(`${env.SUPABASE_URL}/rest/v1/rpc/s2a_ops_email_scheduler_configure`,{
      method:'POST',headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,'content-type':'application/json'},
      body:'{}',signal:AbortSignal.timeout(20_000),
    });
    if(!mail.ok){await mail.body?.cancel();throw Error();}
    if(typeof (await mail.json()).enabled!=='boolean')throw Error();
  } catch { throw Error('Job scheduler configuration failed; verify Supabase extensions and service credentials'); }
}
