create table public.s2a_smtp_credentials (
 id boolean primary key default true check(id),ciphertext text not null check(length(ciphertext) between 24 and 65536),iv text not null check(length(iv)=16),updated_at timestamptz not null default now()
);
alter table public.s2a_smtp_credentials enable row level security;
revoke all on public.s2a_smtp_credentials from public,anon,authenticated,service_role;
create trigger s2a_smtp_credentials_audit after insert or update on public.s2a_smtp_credentials for each row execute function public.s2a_audit_mutation();
create function public.s2a_smtp_worker_config() returns jsonb language sql stable security definer set search_path='' as $$
 select '{"smtp_host":"","smtp_port":587,"smtp_username":"","smtp_from_email":"","smtp_from_name":"","smtp_use_tls":true}'::jsonb||
 (select coalesce(jsonb_object_agg(key,value),'{}') from jsonb_each(data) where key in('smtp_host','smtp_port','smtp_username','smtp_from_email','smtp_from_name','smtp_use_tls'))||
 coalesce((select jsonb_build_object('ciphertext',ciphertext,'iv',iv,'smtp_password_configured',true) from public.s2a_smtp_credentials where id),'{"smtp_password_configured":false}') from public.s2a_settings;
$$;
alter function public.s2a_settings_update(jsonb) rename to s2a_settings_update_without_smtp;
revoke all on function public.s2a_settings_update_without_smtp(jsonb) from service_role;
create function public.s2a_settings_update(p_patch jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare field text;meta jsonb:='{}';old jsonb;cfg jsonb;before_cfg jsonb;secret jsonb;result jsonb;remaining jsonb;
begin
 if p_patch is null or jsonb_typeof(p_patch)<>'object' or octet_length(p_patch::text)>1000000 then return '{"error":"invalid_settings","status":400}';end if;
 select data into old from public.s2a_settings where id='11111111-0000-4000-8000-000000000001' for update;
 remaining:=p_patch;
 foreach field in array array['smtp_host','smtp_port','smtp_username','smtp_from_email','smtp_from_name','smtp_use_tls','smtp_credentials'] loop
  if not p_patch?field then continue;end if;
  remaining:=remaining-field;
  if field='smtp_credentials' then
   secret:=p_patch->field;
   if jsonb_typeof(secret) is distinct from 'object' or secret-'ciphertext'-'iv'<>'{}' or jsonb_typeof(secret->'ciphertext') is distinct from 'string' or jsonb_typeof(secret->'iv') is distinct from 'string'
   or length(secret->>'ciphertext') not between 24 and 65536 or secret->>'ciphertext' !~ '^[A-Za-z0-9+/]+={0,2}$' or length(secret->>'iv')<>16 or secret->>'iv' !~ '^[A-Za-z0-9+/]{16}$' then return '{"error":"invalid_smtp_credentials","status":400}';end if;
  elsif field='smtp_port' then
   if jsonb_typeof(p_patch->field) is distinct from 'number' or (p_patch->>field)::numeric<>trunc((p_patch->>field)::numeric) or (p_patch->>field)::numeric not between 1 and 65535 then return '{"error":"invalid_smtp_config","status":400}';end if;
  elsif field='smtp_use_tls' then
   if jsonb_typeof(p_patch->field) is distinct from 'boolean' then return '{"error":"invalid_smtp_config","status":400}';end if;
  else
   if jsonb_typeof(p_patch->field) is distinct from 'string' or length(p_patch->>field)>(case when field='smtp_username' then 512 else 254 end) or p_patch->>field ~ '[[:cntrl:]]' then return '{"error":"invalid_smtp_config","status":400}';end if;
   if field='smtp_host' and p_patch->>field<>'' and p_patch->>field !~ '^[A-Za-z0-9.:-]+$' then return '{"error":"invalid_smtp_config","status":400}';end if;
   if field='smtp_from_email' and p_patch->>field<>'' and p_patch->>field !~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+$' then return '{"error":"invalid_smtp_config","status":400}';end if;
  end if;
  if field<>'smtp_credentials' then meta:=meta||jsonb_build_object(field,p_patch->field);end if;
 end loop;
 before_cfg:=public.s2a_smtp_worker_config();cfg:=before_cfg||meta;
 if secret is null and coalesce(cfg->>'smtp_host','')<>'' and (cfg->>'smtp_password_configured')::boolean and
  (cfg->>'smtp_host' is distinct from before_cfg->>'smtp_host' or cfg->>'smtp_username' is distinct from before_cfg->>'smtp_username' or cfg->>'smtp_port' is distinct from before_cfg->>'smtp_port') then return '{"error":"smtp_password_required_for_changed_server","status":400}';end if;
 result:=public.s2a_settings_update_without_smtp(remaining);if result?'error' then return result;end if;
 if secret is not null then
  insert into public.s2a_smtp_credentials(id,ciphertext,iv) values(true,secret->>'ciphertext',secret->>'iv') on conflict(id) do update set ciphertext=excluded.ciphertext,iv=excluded.iv,updated_at=now();
  meta:=meta||'{"smtp_password_configured":true}';
 end if;
 if meta<>'{}' then update public.s2a_settings set data=data||meta,updated_at=now() where id='11111111-0000-4000-8000-000000000001' returning data into result;end if;
 return result;
end $$;
revoke all on function public.s2a_smtp_worker_config(),public.s2a_settings_update(jsonb) from public,anon,authenticated;
grant execute on function public.s2a_smtp_worker_config(),public.s2a_settings_update(jsonb) to service_role;
-- SMTP has no idempotency guarantee after a connection loss during submission.
do $$
declare definition text;
begin
 definition:=pg_get_functiondef('public.s2a_ops_mail_finish(uuid,uuid,text)'::regprocedure);
 if strpos(definition,'p_error<>''delivery_failed''')=0 or strpos(definition,'when attempts>=8 then')=0 then raise exception 'mail_completion_definition_changed';end if;
 definition:=replace(definition,'p_error<>''delivery_failed''','p_error not in(''delivery_failed'',''smtp_delivery_uncertain'')');
 definition:=replace(definition,'when attempts>=8 then','when p_error=''smtp_delivery_uncertain'' or attempts>=8 then');
 execute definition;
end $$;
notify pgrst,'reload schema';
