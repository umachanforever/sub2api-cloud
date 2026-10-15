create table public.s2a_settings (
 id uuid primary key default '11111111-0000-4000-8000-000000000001' check(id='11111111-0000-4000-8000-000000000001'),
 data jsonb not null check(jsonb_typeof(data)='object'),
 updated_at timestamptz not null default now()
);
insert into public.s2a_settings(data) values('{"registration_enabled":true,"invitation_code_enabled":false,"registration_email_suffix_whitelist":[],"default_balance":0,"default_concurrency":3,"default_user_rpm_limit":0,"default_subscriptions":[],"site_name":"sub2api-cloud","site_logo":"","site_subtitle":"A developer-friendly AI API gateway for multiple providers, powered by Supabase","compact_home_enabled":true,"api_base_url":"","contact_info":"","doc_url":"","home_content":""}');
alter table public.s2a_settings enable row level security;
revoke all on public.s2a_settings from public,anon,authenticated;
grant select on public.s2a_settings to service_role;
create trigger s2a_settings_audit after update on public.s2a_settings for each row execute function public.s2a_audit_mutation();
create function public.s2a_settings_update(p_patch jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; entry jsonb;
begin
 if p_patch is null or jsonb_typeof(p_patch)<>'object' or exists(select 1 from jsonb_object_keys(p_patch) k where k not in
 ('registration_enabled','invitation_code_enabled','registration_email_suffix_whitelist','default_balance','default_concurrency','default_user_rpm_limit','default_subscriptions','site_name','site_logo','site_subtitle','compact_home_enabled','api_base_url','contact_info','doc_url','home_content')) then
  return jsonb_build_object('error','invalid_settings','status',400);
 end if;
 select data||p_patch into result from public.s2a_settings where id='11111111-0000-4000-8000-000000000001' for update;
 if jsonb_typeof(result->'registration_enabled')<>'boolean' or jsonb_typeof(result->'invitation_code_enabled')<>'boolean'
  or jsonb_typeof(result->'compact_home_enabled')<>'boolean' or jsonb_typeof(result->'default_balance')<>'number'
  or (result->>'default_balance')::numeric not between 0 and 1000000000 or (result->>'default_balance')::numeric<>round((result->>'default_balance')::numeric,8)
  or jsonb_typeof(result->'default_concurrency')<>'number' or (result->>'default_concurrency')::numeric not between 0 and 1000000 or (result->>'default_concurrency')::numeric<>trunc((result->>'default_concurrency')::numeric)
  or jsonb_typeof(result->'default_user_rpm_limit')<>'number' or (result->>'default_user_rpm_limit')::numeric not between 0 and 1000000 or (result->>'default_user_rpm_limit')::numeric<>trunc((result->>'default_user_rpm_limit')::numeric)
  or jsonb_typeof(result->'default_subscriptions')<>'array' or jsonb_array_length(result->'default_subscriptions')>100
  or jsonb_typeof(result->'registration_email_suffix_whitelist')<>'array' or jsonb_array_length(result->'registration_email_suffix_whitelist')>100 then
  return jsonb_build_object('error','invalid_registration_settings','status',400);
 end if;
 for entry in select value from jsonb_array_elements(result->'default_subscriptions') loop
  if jsonb_typeof(entry)<>'object' or jsonb_typeof(entry->'validity_days')<>'number' or (entry->>'validity_days')::numeric not between 1 and 36500
   or (entry->>'validity_days')::numeric<>trunc((entry->>'validity_days')::numeric) or not exists(select 1 from public.s2a_groups where id=(entry->>'group_id')::uuid and enabled and subscription_type='subscription') then
   return jsonb_build_object('error','invalid_default_subscription','status',400);
  end if;
 end loop;
 update public.s2a_settings set data=result,updated_at=now() where id='11111111-0000-4000-8000-000000000001';
 return result;
end $$;
revoke all on function public.s2a_settings_update(jsonb) from public,anon,authenticated;
grant execute on function public.s2a_settings_update(jsonb) to service_role;

create function public.s2a_registration_bootstrap() returns trigger
language plpgsql security definer set search_path='' as $$
declare settings jsonb; invitation public.s2a_redeem_codes; supplied text; suffix text; rule text; allowed boolean:=false; entry jsonb; result jsonb;
begin
 -- Auth owns app metadata; public signup data cannot mark an account as administrator-created.
 if new.raw_app_meta_data->>'s2a_managed_user'='true' then return new; end if;
 select data into settings from public.s2a_settings for share;
 if not (settings->>'registration_enabled')::boolean then raise check_violation using message='registration_disabled'; end if;
 suffix:=lower(split_part(coalesce(new.email,''),'@',2));
 if jsonb_array_length(settings->'registration_email_suffix_whitelist')>0 then
  for rule in select jsonb_array_elements_text(settings->'registration_email_suffix_whitelist') loop
   if left(rule,2)='*.' then
    allowed:=allowed or (length(suffix)>length(substring(rule from 3))+1 and right(suffix,length(substring(rule from 3))+1)='.'||substring(rule from 3));
   else allowed:=allowed or suffix=ltrim(rule,'@'); end if;
  end loop;
  if not allowed then raise check_violation using message='email_suffix_not_allowed'; end if;
 end if;
 supplied:=trim(coalesce(new.raw_user_meta_data->>'invitation_code',''));
 if (settings->>'invitation_code_enabled')::boolean then
  if supplied='' then raise check_violation using message='invitation_code_required'; end if;
  select * into invitation from public.s2a_redeem_codes where code=supplied and type='invitation' for update;
  if not found or invitation.status<>'unused' or invitation.expires_at<=now() then raise check_violation using message='invitation_code_invalid'; end if;
  update public.s2a_redeem_codes set status='used',used_by=new.id,used_at=now() where id=invitation.id;
 end if;
 insert into public.s2a_user_limits(user_id,concurrency,rpm_limit)
  values(new.id,(settings->>'default_concurrency')::integer,(settings->>'default_user_rpm_limit')::integer);
 if (settings->>'default_balance')::numeric>0 then
  result:=public.s2a_wallet_adjust(new.id,(settings->>'default_balance')::numeric,'signup','Signup credit');
  if result ? 'error' then raise check_violation using message='signup_balance_failed'; end if;
 end if;
 for entry in select value from jsonb_array_elements(settings->'default_subscriptions') loop
  result:=public.s2a_subscription_assign(new.id,(entry->>'group_id')::uuid,(entry->>'validity_days')::integer);
  if result ? 'error' then raise check_violation using message='signup_subscription_failed'; end if;
 end loop;
 if new.raw_user_meta_data ? 'invitation_code' then
  update auth.users set raw_user_meta_data=raw_user_meta_data-'invitation_code' where id=new.id;
 end if;
 return new;
end $$;
revoke all on function public.s2a_registration_bootstrap() from public,anon,authenticated,service_role;
create trigger s2a_registration_bootstrap after insert on auth.users for each row execute function public.s2a_registration_bootstrap();

create table public.s2a_invitation_attempts (
 scope_hash text primary key check(scope_hash ~ '^[0-9a-f]{64}$'),
 failures integer not null default 0,
 window_start timestamptz not null default now()
);
alter table public.s2a_invitation_attempts enable row level security;
revoke all on public.s2a_invitation_attempts from public,anon,authenticated;
create function public.s2a_invitation_validate(p_code text,p_scope text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare attempts public.s2a_invitation_attempts;
begin
 if p_code is null or length(trim(p_code)) not between 3 and 128 or p_scope is null or p_scope !~ '^[0-9a-f]{64}$' then return jsonb_build_object('error','invalid_invitation_code','status',400); end if;
 insert into public.s2a_invitation_attempts(scope_hash) values(p_scope) on conflict do nothing;
 select * into attempts from public.s2a_invitation_attempts where scope_hash=p_scope for update;
 if attempts.window_start<=now()-interval '10 minutes' then
  update public.s2a_invitation_attempts set failures=0,window_start=now() where scope_hash=p_scope;
  attempts.failures:=0;
 end if;
 if attempts.failures>=30 then return jsonb_build_object('error','invitation_validation_rate_limited','status',429); end if;
 if exists(select 1 from public.s2a_redeem_codes where code=trim(p_code) and type='invitation' and status='unused' and (expires_at is null or expires_at>now())) then
  return jsonb_build_object('valid',true);
 end if;
 update public.s2a_invitation_attempts set failures=failures+1 where scope_hash=p_scope;
 return jsonb_build_object('valid',false,'error_code','INVITATION_CODE_INVALID');
end $$;
revoke all on function public.s2a_invitation_validate(text,text) from public,anon,authenticated;
grant execute on function public.s2a_invitation_validate(text,text) to service_role;
