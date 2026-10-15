create table public.s2a_promo_codes (
 id bigint generated always as identity primary key,
 code text not null unique check(length(code) between 1 and 32),
 bonus_amount numeric(20,8) not null check(bonus_amount between 0 and 1000000000),
 max_uses integer not null default 0 check(max_uses>=0),
 used_count integer not null default 0 check(used_count>=0),
 status text not null default 'active' check(status in ('active','disabled')),
 expires_at timestamptz,
 notes text not null default '',
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create table public.s2a_promo_usages (
 id bigint generated always as identity primary key,
 promo_code_id bigint not null references public.s2a_promo_codes(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 bonus_amount numeric(20,8) not null,
 used_at timestamptz not null default now(),
 unique(promo_code_id,user_id)
);
create index s2a_promo_usages_time on public.s2a_promo_usages(promo_code_id,used_at desc,id desc);
alter table public.s2a_promo_codes enable row level security;
alter table public.s2a_promo_usages enable row level security;
revoke all on public.s2a_promo_codes,public.s2a_promo_usages from public,anon,authenticated,service_role;
grant select,delete on public.s2a_promo_codes to service_role;
grant insert(code,bonus_amount,max_uses,expires_at,notes),update(code,bonus_amount,max_uses,status,expires_at,notes,updated_at) on public.s2a_promo_codes to service_role;
grant select on public.s2a_promo_usages to service_role;
grant usage on sequence public.s2a_promo_codes_id_seq to service_role;
create trigger s2a_promo_audit after insert or update or delete on public.s2a_promo_codes for each row execute function public.s2a_audit_mutation();

create function public.s2a_promo_status(p_code public.s2a_promo_codes) returns text
language sql stable set search_path='' as $$
 select case when p_code.id is null then 'PROMO_CODE_NOT_FOUND'
 when p_code.expires_at<=now() then 'PROMO_CODE_EXPIRED'
 when p_code.status='disabled' then 'PROMO_CODE_DISABLED'
 when p_code.max_uses>0 and p_code.used_count>=p_code.max_uses then 'PROMO_CODE_MAX_USED' end;
$$;
revoke all on function public.s2a_promo_status(public.s2a_promo_codes) from public,anon,authenticated,service_role;

create function public.s2a_promo_validate(p_code text,p_scope text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.s2a_promo_codes; failure text; attempts public.s2a_invitation_attempts;
begin
 if p_code is null or length(p_code)>32 or p_scope is null or p_scope !~ '^[0-9a-f]{64}$' then return jsonb_build_object('error','invalid_promo_code','status',400);end if;
 if not coalesce((select (data->>'promo_code_enabled')::boolean from public.s2a_settings),false) then return jsonb_build_object('valid',false,'error_code','PROMO_CODE_DISABLED');end if;
 insert into public.s2a_invitation_attempts(scope_hash) values(p_scope) on conflict do nothing;
 select * into attempts from public.s2a_invitation_attempts where scope_hash=p_scope for update;
 if attempts.window_start<=now()-interval '10 minutes' then
  update public.s2a_invitation_attempts set failures=0,window_start=now() where scope_hash=p_scope;attempts.failures:=0;
 end if;
 if attempts.failures>=30 then return jsonb_build_object('error','promo_validation_rate_limited','status',429);end if;
 select * into c from public.s2a_promo_codes where code=trim(p_code);
 failure:=case when trim(p_code)='' then 'PROMO_CODE_INVALID' else public.s2a_promo_status(c) end;
 if failure is null then return jsonb_build_object('valid',true,'bonus_amount',c.bonus_amount);end if;
 update public.s2a_invitation_attempts set failures=failures+1 where scope_hash=p_scope;
 return jsonb_build_object('valid',false,'error_code',failure);
end $$;
revoke all on function public.s2a_promo_validate(text,text) from public,anon,authenticated;
grant execute on function public.s2a_promo_validate(text,text) to service_role;

create function public.s2a_promo_apply(p_user_id uuid,p_code text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.s2a_promo_codes; failure text; result jsonb;
begin
 if coalesce(trim(p_code),'')='' then return jsonb_build_object('ok',true);end if;
 if not coalesce((select (data->>'promo_code_enabled')::boolean from public.s2a_settings),false) then return jsonb_build_object('error','PROMO_CODE_DISABLED','status',400);end if;
 select * into c from public.s2a_promo_codes where code=trim(p_code) for update;
 failure:=public.s2a_promo_status(c);
 if failure is not null then return jsonb_build_object('error',failure,'status',400);end if;
 if exists(select 1 from public.s2a_promo_usages where promo_code_id=c.id and user_id=p_user_id) then return jsonb_build_object('error','PROMO_CODE_ALREADY_USED','status',409);end if;
 if c.bonus_amount>0 then
  result:=public.s2a_wallet_adjust(p_user_id,c.bonus_amount,'promo','Promo code '||c.id::text);
  if result ? 'error' then raise check_violation using message='promo_credit_failed';end if;
 end if;
 insert into public.s2a_promo_usages(promo_code_id,user_id,bonus_amount) values(c.id,p_user_id,c.bonus_amount);
 update public.s2a_promo_codes set used_count=used_count+1,updated_at=now() where id=c.id;
 return jsonb_build_object('ok',true,'bonus_amount',c.bonus_amount);
end $$;
revoke all on function public.s2a_promo_apply(uuid,text) from public,anon,authenticated,service_role;

create function public.s2a_promo_usages_list(p_id bigint,p_page integer,p_size integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare total bigint; items jsonb;
begin
 if p_page not between 1 and 1000000 or p_size not between 1 and 100 then return jsonb_build_object('error','invalid_pagination','status',400);end if;
 if not exists(select 1 from public.s2a_promo_codes where id=p_id) then return jsonb_build_object('error','promo_code_not_found','status',404);end if;
 select count(*) into total from public.s2a_promo_usages where promo_code_id=p_id;
 select coalesce(jsonb_agg(to_jsonb(x)),'[]') into items from
 (select u.*,jsonb_build_object('id',a.id,'email',a.email,'username',a.raw_user_meta_data->>'username') as "user"
 from public.s2a_promo_usages u join auth.users a on a.id=u.user_id where u.promo_code_id=p_id order by u.used_at desc,u.id desc limit p_size offset (p_page-1)::bigint*p_size) x;
 return jsonb_build_object('items',items,'total',total,'page',p_page,'page_size',p_size,'pages',ceil(total::numeric/p_size));
end $$;
revoke all on function public.s2a_promo_usages_list(bigint,integer,integer) from public,anon,authenticated;
grant execute on function public.s2a_promo_usages_list(bigint,integer,integer) to service_role;

update public.s2a_settings set data=data||'{"promo_code_enabled":true}' where id='11111111-0000-4000-8000-000000000001';

create or replace function public.s2a_settings_update(p_patch jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; entry jsonb;
begin
 if p_patch is null or jsonb_typeof(p_patch)<>'object' or exists(select 1 from jsonb_object_keys(p_patch) k where k not in
 ('promo_code_enabled','registration_enabled','invitation_code_enabled','registration_email_suffix_whitelist','default_balance','default_concurrency','default_user_rpm_limit','default_subscriptions','site_name','site_logo','site_subtitle','compact_home_enabled','api_base_url','contact_info','doc_url','home_content')) then
  return jsonb_build_object('error','invalid_settings','status',400);
 end if;
 select data||p_patch into result from public.s2a_settings where id='11111111-0000-4000-8000-000000000001' for update;
 if jsonb_typeof(result->'promo_code_enabled')<>'boolean' or jsonb_typeof(result->'registration_enabled')<>'boolean' or jsonb_typeof(result->'invitation_code_enabled')<>'boolean'
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

create or replace function public.s2a_registration_bootstrap() returns trigger
language plpgsql security definer set search_path='' as $$
declare settings jsonb; invitation public.s2a_redeem_codes; supplied text; suffix text; rule text; allowed boolean:=false; entry jsonb; result jsonb; authorized text; capability text;
begin
 capability:=coalesce(new.raw_user_meta_data->>'s2a_registration_ticket','');
 if length(capability)=64 then
  delete from public.s2a_registration_authorizations
   where token_hash=encode(sha256(convert_to(capability,'UTF8')),'hex') and email=lower(new.email) and expires_at>now()
   returning token_hash into authorized;
 end if;
 -- GoTrue admin creation writes app metadata after insertion; its backend ticket supplies the trusted context.
 if authorized is not null or new.raw_app_meta_data->>'s2a_managed_user'='true' then
  update auth.users set raw_user_meta_data=raw_user_meta_data-'s2a_registration_ticket'-'invitation_code'-'promo_code' where id=new.id;
  return new;
 end if;
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
 -- Invalid or exhausted promo codes do not prevent signup, matching the upstream flow.
 perform public.s2a_promo_apply(new.id,new.raw_user_meta_data->>'promo_code');
 if new.raw_user_meta_data ? 'promo_code' or new.raw_user_meta_data ? 'invitation_code' or new.raw_user_meta_data ? 's2a_registration_ticket' then
  update auth.users set raw_user_meta_data=raw_user_meta_data-'invitation_code'-'promo_code'-'s2a_registration_ticket' where id=new.id;
 end if;
 return new;
end $$;


create or replace function public.s2a_registration_metadata() returns trigger language plpgsql set search_path='' as $$
begin
 new.raw_user_meta_data:=new.raw_user_meta_data-'s2a_registration_ticket'-'invitation_code'-'promo_code';
 return new;
end $$;
