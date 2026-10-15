import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const exec = promisify(execFile);

test(
  "PostgreSQL enforces leases, group isolation, rate limits, refresh ownership and restricted grants",
  { skip: process.env.S2A_DATABASE_TEST !== "1", timeout: 60_000 },
  async () => {
    const container = `s2a-test-${crypto.randomUUID()}`;
    const sql = async (input) => {
      const child = execFile("docker", [
        "exec",
        "-e",
        "PGPASSWORD=local-test-only",
        "-i",
        container,
        "psql",
        "-h",
        "127.0.0.1",
        "-U",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
        "-At",
      ], { maxBuffer: 1024 * 1024 });
      child.stdin.end(input);
      return await new Promise((resolve, reject) => {
        let stdout = "", stderr = "";
        child.stdout.on("data", (data) => {
          stdout += data;
        });
        child.stderr.on("data", (data) => {
          stderr += data;
        });
        child.on("error", reject);
        child.on(
          "close",
          (code) =>
            code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr)),
        );
      });
    };
    try {
      await exec("docker", [
        "run",
        "--rm",
        "-d",
        "--name",
        container,
        "-e",
        "POSTGRES_PASSWORD=local-test-only",
        "postgres:17-alpine",
      ]);
      let ready = false;
      for (let i = 0; i < 100; i++) {
        try {
          await sql("select 1;");
          ready = true;
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      assert.equal(ready, true, "PostgreSQL must start");
      await sql(`create schema storage;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);
      create schema auth;
      create table auth.users(id uuid primary key, banned_until timestamptz, encrypted_password text,
        email text,deleted_at timestamptz,raw_user_meta_data jsonb default '{}',raw_app_meta_data jsonb default '{}',
        created_at timestamptz default now(),updated_at timestamptz default now());
      create table auth.mfa_factors(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,
        factor_type text,status text,friendly_name text,secret text,created_at timestamptz default now(),updated_at timestamptz default now());
      create role anon; create role authenticated; create role service_role bypassrls;
      grant usage on schema auth to service_role;`);
      const migrations = new URL("../supabase/migrations/", import.meta.url);
      for (const name of (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort()) await sql(await readFile(new URL(name, migrations), "utf8"));
      await sql("alter table auth.users alter column raw_app_meta_data set default '{\"s2a_managed_user\":true}'::jsonb;");
      await assert.rejects(
        sql("set role service_role; select encrypted_password from auth.users;"),
        /permission denied/,
      );
      await sql(await readFile(new URL('./announcements.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./announcement-targeting.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./users.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./openai-oauth.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./account-lifecycle.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./account-runtime.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./apikey-rotation.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./account-save.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./group-metadata.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./group-duplicate.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./model-policy.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./model-mapping.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./model-metadata.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./openai-quota-cache.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./openai-quota-reset.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./ops-logs.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./ops-settings.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./ops-errors.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./ops-requests.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./first-token.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./ops-dashboard.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./ops-model-stats.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./ops-capacity.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./ops-realtime-traffic.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./ops-monitoring.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./ops-advanced.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./ops-alerts.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./ops-mail.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./smtp.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./ops-ws.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./proxy-registry.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./account-proxy.database.sql', import.meta.url), 'utf8'));
      const alertRule=JSON.parse(await sql(`select public.s2a_ops_alert_rule_save(null,'{"name":"Concurrent evaluation","metric_type":"concurrency_queue_depth","operator":">=","threshold":0}');`));
      await Promise.all([sql('select public.s2a_ops_alert_tick();'),sql('select public.s2a_ops_alert_tick();')]);
      assert.equal(await sql(`select count(*) from public.s2a_ops_alert_events where rule_id=${alertRule.id} and status='firing';`),'1','concurrent evaluators create one event');
      assert.equal(await sql(`select consecutive_breaches from public.s2a_ops_alert_state where rule_id=${alertRule.id};`),'1','same tick cannot count twice');
      await sql(`select public.s2a_ops_alert_rule_delete(${alertRule.id});`);
      await sql(await readFile(new URL('./openai-auto-reset.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./openai-quota-pause.database.sql', import.meta.url), 'utf8'));
      const autoAccounts=Array.from({length:5},()=>crypto.randomUUID());
      await sql(`insert into public.s2a_accounts(id,name,account_fingerprint,ciphertext,iv,extra) values ${autoAccounts.map(id=>`('${id}','Concurrent auto reset','${id}','cipher','iv','{"privacy_mode":"training_off","auto_reset_credit_enabled":true}')`).join(',')};`);
      const autoClaims=await Promise.all([0,1].map(()=>sql('select public.s2a_openai_auto_reset_claim();').then(JSON.parse)));
      assert.deepEqual(autoClaims.map(rows=>rows.length).sort(),[1,4],'each auto reset batch is bounded to four');
      assert.equal(new Set(autoClaims.flat().map(job=>job.account_id)).size,5,'concurrent workers never claim the same account');
      await sql(`delete from public.s2a_accounts where id in (${autoAccounts.map(id=>`'${id}'`).join(',')});`);
      const resetAccount=crypto.randomUUID(),resetActor=crypto.randomUUID();
      await sql(`insert into auth.users(id) values('${resetActor}');insert into public.s2a_accounts(id,name,account_fingerprint,ciphertext,iv,extra) values('${resetAccount}','Concurrent resets','${resetAccount}','encrypted','iv','{"privacy_mode":"training_off"}');`);
      const resetClaims=await Promise.all(['first','second'].map(key=>sql(`select public.s2a_openai_quota_reset_begin('${resetAccount}','${resetActor}','${key}',1);`).then(JSON.parse)));
      assert.equal(resetClaims.filter(r=>r.id).length,1,'only one reset worker may dispatch');
      assert.equal(resetClaims.filter(r=>r.error==='openai_quota_reset_in_progress').length,1);
      const resetOperation=resetClaims.find(r=>r.id);
      assert.equal(await sql(`select cardinality(request_keys) from public.s2a_openai_quota_resets where id='${resetOperation.id}';`),'2','concurrent retry keys bind to the same operation');
      await sql(`delete from public.s2a_openai_quota_resets where id='${resetOperation.id}';delete from public.s2a_accounts where id='${resetAccount}';delete from auth.users where id='${resetActor}';`);

      await sql(await readFile(new URL('./unbound-accounts.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./account-data-import.database.sql', import.meta.url), 'utf8'));
      const importActor=crypto.randomUUID(),importFingerprint=crypto.randomUUID();
      await sql(`insert into auth.users(id) values('${importActor}');`);
      const importRows=JSON.stringify([{name:'Concurrent import',patch:{name:'Concurrent import',platform:'openai',type:'apikey',status:'active',priority:50,concurrency:3,notes:'',extra:{},model_mapping:{alias:'gpt-4.1'},schedulable:true,auto_pause_on_expired:true,account_fingerprint:importFingerprint,ciphertext:'encrypted',iv:'iv'}}]);
      const importCall=()=>sql(`select public.s2a_account_data_import('${importActor}','concurrent-import','${'a'.repeat(64)}','${importRows}');`).then(JSON.parse);
      const imports=await Promise.all([importCall(),importCall()]);
      assert.deepEqual(imports.map(r=>r.replayed).sort(),[false,true],'concurrent imports replay exactly one durable result');
      assert.deepEqual(imports[0].account_ids,imports[1].account_ids);
      assert.equal(await sql(`select count(*) from public.s2a_accounts where account_fingerprint='${importFingerprint}';`),'1');
      await sql(`delete from public.s2a_accounts where account_fingerprint='${importFingerprint}';delete from auth.users where id='${importActor}';`);
      const duplicateActors=[crypto.randomUUID(),crypto.randomUUID()],duplicateSource=crypto.randomUUID();
      await sql(`insert into auth.users(id) values('${duplicateActors[0]}'),('${duplicateActors[1]}');insert into public.s2a_groups(id,name) values('${duplicateSource}','Concurrent duplicate');`);
      const duplicateCall=actor=>sql(`select public.s2a_group_duplicate('${duplicateSource}','${actor}','concurrent-key');`).then(JSON.parse);
      const duplicates=await Promise.all([duplicateCall(duplicateActors[0]),duplicateCall(duplicateActors[0])]);
      assert.equal(duplicates[0].group.id,duplicates[1].group.id,'concurrent retries create exactly one copy');
      assert.deepEqual(duplicates.map(r=>r.replayed).sort(),[false,true]);
      const otherDuplicate=await duplicateCall(duplicateActors[1]);
      assert.notEqual(otherDuplicate.group.id,duplicates[0].group.id,'administrator retry scopes remain independent');
      assert.equal(otherDuplicate.group.name,'Concurrent duplicate (Copy 2)');
      await sql(`delete from public.s2a_groups where id in('${duplicateSource}','${duplicates[0].group.id}','${otherDuplicate.group.id}');delete from auth.users where id in('${duplicateActors[0]}','${duplicateActors[1]}');`);
      await sql(await readFile(new URL('./identity-announcement-audit.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./shared-usage.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./user-configuration.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./group-rates.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./group-rpm.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./public-groups.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./key-windows.database.sql', import.meta.url), 'utf8'));
      const customUsers=[crypto.randomUUID(),crypto.randomUUID()],customGroup=crypto.randomUUID();
      const customHash=crypto.randomUUID().replaceAll('-','').repeat(2);
      await sql(`insert into auth.users(id) values('${customUsers[0]}'),('${customUsers[1]}');insert into public.s2a_groups(id,name,is_exclusive) values('${customGroup}','Concurrent custom keys',false);`);
      const customResults=await Promise.all(customUsers.map(owner=>sql(`select public.s2a_custom_key_create('${owner}',true,jsonb_build_object('user_id','${owner}','group_id','${customGroup}','name','Concurrent custom','key_hash','${customHash}','key_prefix','cust'));`).then(JSON.parse)));
      assert.equal(customResults.filter(result=>result.id).length,1,'a custom secret belongs to only one key');
      assert.equal(customResults.filter(result=>result.error==='api_key_already_exists').length,1);
      assert.equal(await sql(`select sum(failures) from public.s2a_key_create_attempts where user_id in('${customUsers[0]}','${customUsers[1]}');`),'1','concurrent duplicate failures remain recorded');
      await sql(`delete from public.s2a_keys where group_id='${customGroup}';delete from public.s2a_groups where id='${customGroup}';delete from auth.users where id in('${customUsers[0]}','${customUsers[1]}');`);
      await sql(await readFile(new URL('./platform-quotas.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./user-attributes.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./admin-roles.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./account-cost.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./group-privacy.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./openai-privacy.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./privacy-jobs.database.sql', import.meta.url), 'utf8'));
      const privacyIds=Array.from({length:8},()=>crypto.randomUUID());
      await sql(privacyIds.map(id=>`insert into public.s2a_accounts(id,name,account_fingerprint,ciphertext,iv) values('${id}','Concurrent privacy','${id}','encrypted','iv');`).join('\n'));
      const privacyClaims=await Promise.all([1,2].map(()=>sql('select public.s2a_privacy_jobs_claim();').then(JSON.parse)));
      assert.deepEqual(privacyClaims.map(j=>j.length),[4,4]);
      assert.equal(new Set(privacyClaims.flat().map(j=>j.account_id)).size,8,'concurrent privacy claims never overlap');
      await sql(`delete from public.s2a_accounts where id in(${privacyIds.map(id=>`'${id}'`).join(',')});`);
      const roleUsers=[crypto.randomUUID(),crypto.randomUUID()];
      await sql(`insert into auth.users(id) values('${roleUsers[0]}'),('${roleUsers[1]}');select public.s2a_admin_context(array['${roleUsers[0]}'::uuid,'${roleUsers[1]}'::uuid]);`);
      const retirements=await Promise.allSettled(roleUsers.map(id=>sql(`update auth.users set banned_until=now()+interval '1 day' where id='${id}';`)));
      assert.equal(retirements.filter(r=>r.status==='fulfilled').length,1,'concurrent bans preserve one active administrator');
      assert.equal(retirements.filter(r=>r.status==='rejected'&&/cannot_disable_or_delete_sole_admin/.test(r.reason.message)).length,1);
      assert.equal(await sql('select cardinality(public.s2a_active_admin_ids());'),'1');
      await sql(`update auth.users set banned_until=null where id=any(array['${roleUsers[0]}'::uuid,'${roleUsers[1]}'::uuid]);`);
      const demotions=await Promise.all(roleUsers.map((actor,index)=>sql(`select public.s2a_admin_role_set('${actor}','${roleUsers[1-index]}','user');`).then(JSON.parse)));
      assert.equal(demotions.filter(r=>r.admin_ids?.length===1).length,1,'one concurrent demotion succeeds');
      assert.equal(demotions.filter(r=>r.error==='admin_required').length,1,'demoted actor loses administration');
      await sql(`delete from public.s2a_admin_roles;update public.s2a_admin_bootstrap set initialized=false;delete from auth.users where id=any(array['${roleUsers[0]}'::uuid,'${roleUsers[1]}'::uuid]);`);
      const rpmUser=crypto.randomUUID(),rpmGroup=crypto.randomUUID();
      const rpmHashes=[crypto.randomUUID().replaceAll('-','').repeat(2),crypto.randomUUID().replaceAll('-','').repeat(2)];
      await sql(`insert into auth.users(id) values('${rpmUser}');
        insert into public.s2a_groups(id,name,rpm_limit) values('${rpmGroup}','Concurrent group RPM',1);
        insert into public.s2a_memberships(user_id,group_id) values('${rpmUser}','${rpmGroup}');
        insert into public.s2a_accounts(group_id,name,account_fingerprint,ciphertext,iv) values('${rpmGroup}','RPM account','${crypto.randomUUID()}','encrypted','iv');
        insert into public.s2a_keys(user_id,group_id,name,key_hash,key_prefix) values
          ('${rpmUser}','${rpmGroup}','RPM first','${rpmHashes[0]}','first'),('${rpmUser}','${rpmGroup}','RPM second','${rpmHashes[1]}','second');`);
      const rpmResults=await Promise.all(rpmHashes.map(hash=>sql(`select public.s2a_acquire('${hash}','gpt-4.1','${crypto.randomUUID()}');`).then(JSON.parse)));
      assert.equal(rpmResults.filter(result=>result.lease_id).length,1,'concurrent keys share one group window');
      assert.equal(rpmResults.filter(result=>result.error==='group_rate_limit_exceeded').length,1);
      await sql(`delete from public.s2a_leases where key_id in(select id from public.s2a_keys where user_id='${rpmUser}');delete from public.s2a_keys where user_id='${rpmUser}';delete from public.s2a_accounts where group_id='${rpmGroup}';delete from public.s2a_groups where id='${rpmGroup}';delete from auth.users where id='${rpmUser}';`);
      const rateUser=crypto.randomUUID(),rateGroup=crypto.randomUUID();
      await sql(`insert into auth.users(id) values('${rateUser}');insert into public.s2a_groups(id,name) values('${rateGroup}','Rate lock ordering');`);
      const rateBatch=sql(`begin;set local application_name='s2a-rate-lock-order';
        select id from public.s2a_groups where id='${rateGroup}' for no key update;
        select pg_sleep(1);
        select public.s2a_group_rates_set('${rateGroup}','[{"user_id":"${rateUser}","rate_multiplier":0.5}]');commit;`);
      let groupLocked=false;
      for(let attempt=0;attempt<10;attempt++) {
        if(await sql("select count(*) from pg_stat_activity where application_name='s2a-rate-lock-order' and wait_event='PgSleep';")==='1'){groupLocked=true;break;}
      }
      assert.ok(groupLocked,'batch must hold the group before a concurrent user update');
      await Promise.all([rateBatch,sql(`select public.s2a_user_configure('${rateUser}',null,null,null,null,null,'{"${rateGroup}":0.25}');`)]);
      assert.equal(await sql(`select rate_multiplier from public.s2a_user_group_rates where user_id='${rateUser}' and group_id='${rateGroup}';`),'0.250000','user update waits for the full-group replacement without deadlocking');
      await sql(`delete from auth.users where id='${rateUser}';delete from public.s2a_groups where id='${rateGroup}';`);

      await sql(await readFile(new URL('./model-billing.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./subscriptions.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./usage-filters.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./registration-domain.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./email-alias.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./promo.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./settings.database.sql', import.meta.url), 'utf8'));
      await sql(await readFile(new URL('./redeem.database.sql', import.meta.url), 'utf8'));
      const user = "11111111-1111-4111-8111-111111111111";
      const group = "22222222-2222-4222-8222-222222222222";
      const account = "33333333-3333-4333-8333-333333333333";
      await sql(`insert into auth.users(id) values ('${user}');
      insert into public.s2a_groups(id,name) values ('${group}','Test');
      insert into public.s2a_memberships values ('${user}','${group}');
      insert into public.s2a_accounts(id,group_id,name,concurrency,account_fingerprint,ciphertext,iv) values ('${account}','${group}','Test',1,'identity','encrypted','iv');
      insert into public.s2a_keys(user_id,group_id,name,key_hash,key_prefix,concurrency,rpm)
        select '${user}','${group}','Key ' || n, lpad(n::text,64,'0'),'prefix',10,60 from generate_series(1,8) n;`);
      const reserve = (n) =>
        sql(
          `set role service_role; select public.s2a_acquire('${
            String(n).padStart(64, "0")
          }','test','${crypto.randomUUID()}');`,
        );
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => reserve(i + 1)),
      );
      const decoded = results.map((output) =>
        JSON.parse(output.split("\n").at(-1))
      );
      const successes = decoded.filter((item) => item.lease_id);
      assert.equal(
        successes.length,
        1,
        "parallel API keys cannot overbook the same account",
      );
      const lease = successes[0].lease_id;
      const finish =
        `select public.s2a_finish('${lease}',200,'completed',12,3);`;
      await sql(finish + finish);
      assert.equal(
        await sql("select count(*) from public.s2a_usage;"),
        "1",
        "finishing a lease is idempotent",
      );
      assert.equal(await sql("select count(*) from public.s2a_leases;"), "0");
      const lock = crypto.randomUUID();
      assert.equal(
        await sql(
          `select public.s2a_refresh_acquire('${account}',1,'${lock}');`,
        ),
        "t",
      );
      assert.equal(
        await sql(
          `select public.s2a_refresh_acquire('${account}',1,'${crypto.randomUUID()}');`,
        ),
        "f",
      );
      assert.equal(
        await sql(
          `select public.s2a_refresh_save('${account}','${crypto.randomUUID()}','new','iv');`,
        ),
        "f",
      );
      assert.equal(
        await sql(
          `select public.s2a_refresh_save('${account}','${lock}','new','iv');`,
        ),
        "t",
      );
      assert.equal(
        await sql(
          `select public.s2a_refresh_acquire('${account}',1,'${crypto.randomUUID()}');`,
        ),
        "f",
        "stale snapshots cannot rotate the token again",
      );
      const dashboard = JSON.parse(await sql(`select public.s2a_dashboard('${user}',now()-interval '1 day',now()+interval '1 second');`));
      assert.equal(dashboard.summary.requests, 1);
      assert.equal(dashboard.summary.input_tokens, 12);
      const hourly = JSON.parse(await sql(`select public.s2a_dashboard('${user}',now()-interval '1 day',now()+interval '1 second','Asia/Shanghai',null,null,'hour');`));
      assert.equal(hourly.daily.length >= 24, true);
      const wrongModel = JSON.parse(await sql(`select public.s2a_dashboard('${user}',now()-interval '1 day',now()+interval '1 second','Asia/Shanghai',null,'missing-model','day',false);`));
      assert.equal(wrongModel.summary.requests, 0);
      assert.deepEqual(wrongModel.daily, []);
      const isolated = JSON.parse(await sql(`select public.s2a_dashboard('${crypto.randomUUID()}',now()-interval '1 day',now()+interval '1 second');`));
      assert.equal(isolated.summary.requests, 0);
      assert.equal(JSON.parse(await sql(`select public.s2a_credentials_replace('${account}','identity','replacement','iv');`)).status, 409);
      await sql(`update public.s2a_accounts set status='disabled' where id='${account}';`);
      assert.equal(JSON.parse(await sql(`select public.s2a_credentials_replace('${account}','wrong','replacement','iv');`)).status, 400);
      assert.equal(JSON.parse(await sql(`select public.s2a_credentials_replace('${account}','identity','replacement','iv');`)).ok, true);
      assert.equal(await sql(`select credential_version from public.s2a_accounts where id='${account}';`), "3");
      const createdGroup = JSON.parse(await sql(`select public.s2a_group_create('New group','${user}');`));
      await sql(`select public.s2a_membership_set('${user}','${createdGroup.id}'); select public.s2a_membership_set('${user}','${createdGroup.id}');`);
      assert.equal(await sql(`select count(*) from public.s2a_memberships where group_id='${createdGroup.id}';`), "1");
      await sql("update public.s2a_keys set window_count = rpm;");
      assert.equal(
        JSON.parse((await reserve(1)).split("\n").at(-1)).error,
        "rate_limit_exceeded",
      );
      await sql(`delete from public.s2a_memberships;`);
      assert.equal(
        JSON.parse((await reserve(1)).split("\n").at(-1)).status,
        403,
      );
      await assert.rejects(
        sql("set role anon; select * from public.s2a_accounts;"),
        /permission denied/,
      );
      await assert.rejects(
        sql(
          `set role authenticated; select public.s2a_refresh_acquire('${account}',2,'${lock}');`,
        ),
        /permission denied/,
      );
      await sql(
        `insert into public.s2a_memberships values ('${user}','${group}'); update auth.users set banned_until = now() + interval '1 day';`,
      );
      assert.equal(
        JSON.parse((await reserve(1)).split("\n").at(-1)).status,
        401,
      );
      const context = JSON.stringify({"x-s2a-actor-id": user,"x-s2a-actor-email":"test@example.com",
        "x-s2a-actor-role":"admin","x-s2a-request-method":"PUT",
        "x-s2a-request-path":"/api/v1/admin/groups/test","x-s2a-request-id":"test-request"});
      await sql(`begin; set local request.headers = '${context}';
        update public.s2a_groups set name='Audited change' where id='${group}'; commit;`);
      const audit = JSON.parse(await sql(`select row_to_json(a) from public.s2a_audit_logs a
        where request_id='test-request';`));
      assert.equal(audit.actor_user_id, user);
      assert.equal(audit.actor_role, 'admin');
      assert.deepEqual(audit.extra.changed_fields, ['name']);
      assert.equal((await sql(`select coalesce(jsonb_agg(extra)::text,'[]') from public.s2a_audit_logs;`)).includes('encrypted'), false);
      await assert.rejects(sql('set role service_role; delete from public.s2a_audit_logs;'), /permission denied/);
      const billedUser=crypto.randomUUID(), billedGroup=crypto.randomUUID(), billedAccount=crypto.randomUUID();
      await sql(`insert into auth.users(id) values('${billedUser}');
        insert into public.s2a_groups(id,name) values('${billedGroup}','Concurrent billing');
        insert into public.s2a_memberships values('${billedUser}','${billedGroup}');
        insert into public.s2a_accounts(id,group_id,name,concurrency,account_fingerprint,ciphertext,iv)
          values('${billedAccount}','${billedGroup}','Concurrent billing',3,'concurrent-billing','encrypted','iv');
        insert into public.s2a_keys(user_id,group_id,name,key_hash,key_prefix)
          select '${billedUser}','${billedGroup}','Billed '||n,repeat('a',63)||n,'prefix' from generate_series(1,3) n;
        select public.s2a_wallet_update('${billedUser}',1,'set');`);
      const billedLeases=await Promise.all([1,2,3].map(async n=>JSON.parse(await sql(
        `select public.s2a_acquire('${'a'.repeat(63)}${n}','gpt-4.1','${crypto.randomUUID()}','{}',true,null,'{}');`))));
      assert.ok(billedLeases.every(r=>r.lease_id),'funded parallel keys must reserve distinct leases');
      await Promise.all(billedLeases.flatMap(r=>[1,2].map(()=>sql(`select public.s2a_finish('${r.lease_id}',200,'completed',100,10,0,20);`))));
      assert.equal(await sql(`select balance from public.s2a_wallets where user_id='${billedUser}';`),'0.99925000','concurrent finishes debit each lease exactly once');
      assert.equal(await sql(`select count(*) from public.s2a_wallet_ledger where user_id='${billedUser}' and reason='usage';`),'3');
      const otherRedeemer=crypto.randomUUID();
      await sql(`insert into auth.users(id) values('${otherRedeemer}');
        insert into public.s2a_redeem_codes(code,type,value) values('parallel-redemption','balance',0.5);`);
      const redemptions=await Promise.all([billedUser,otherRedeemer].map(async id=>JSON.parse(await sql(
        `select public.s2a_redeem_use('${id}','parallel-redemption');`))));
      assert.equal(redemptions.filter(r=>r.status==='used').length,1,'only one competing user may redeem a code');
      assert.equal(redemptions.filter(r=>r.error==='redeem_code_used').length,1);
      const fulfillments=await Promise.all([1,2,3].map(async()=>JSON.parse(await sql(
        `select public.s2a_redeem_create_and_use('${billedUser}','parallel-order','balance',0.75);`))));
      assert.ok(fulfillments.every(r=>r.redeem_code?.status==='used'),'fixed-order retries must return the same fulfillment');
      assert.equal(await sql(`select sum(balance) from public.s2a_wallets where user_id in('${billedUser}','${otherRedeemer}');`),'2.24925000','races cannot duplicate monetary credits');
      assert.equal(await sql(`select count(*) from public.s2a_wallet_ledger where user_id in('${billedUser}','${otherRedeemer}') and reason='redeem';`),'2');
      await assert.rejects(sql(`set role anon; select public.s2a_redeem_use('${billedUser}','parallel-redemption');`),/permission denied/);
      const cleared = JSON.parse(await sql(`set role service_role; select public.s2a_audit_clear('${user}','test@example.com');`).then(x=>x.split('\n').at(-1)));
      assert.equal(cleared.deleted > 0, true);
      assert.equal(await sql('select count(*) from public.s2a_audit_logs;'), '1');
      await sql(`update public.s2a_keys set revoked=true,deleted_at=now() where key_hash=lpad('8',64,'0');`);
      await assert.rejects(sql(`update public.s2a_keys set revoked=false where key_hash=lpad('8',64,'0');`), /s2a_deleted_key_revoked/);
      await assert.rejects(sql(`update public.s2a_keys set deleted_at=null where key_hash=lpad('8',64,'0');`), /deleted API keys cannot be restored/);
    } finally {
      await exec("docker", ["rm", "-f", container]).catch(() => {});
    }
  },
);

test('Supabase migration versions are unique for CLI deployment', async () => {
  const files = (await readdir(new URL('../supabase/migrations/', import.meta.url))).filter(name => name.endsWith('.sql'));
  const versions = new Map();
  for (const name of files) {
    const version = name.match(/^([0-9]{14})_/ )?.[1];
    assert.ok(version, `Invalid migration filename: ${name}`);
    assert.equal(versions.has(version), false, `Duplicate migration version: ${versions.get(version)} and ${name}`);
    versions.set(version, name);
  }
});
