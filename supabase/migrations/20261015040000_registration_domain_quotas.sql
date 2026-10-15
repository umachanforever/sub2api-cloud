create function public.s2a_registration_domain(p_domain text) returns text
language plpgsql stable security definer set search_path='' as $$
declare domain text:=rtrim(lower(trim(coalesce(p_domain,''))),'.'); labels text[]; n integer; i integer; suffix text; suffix_size integer:=1;
begin
 if domain='' then return '';end if;
 labels:=string_to_array(domain,'.');n:=array_length(labels,1);
 for i in 1..n loop
  suffix:=array_to_string(labels[i:n],'.');
  if exists(select 1 from public.s2a_public_suffixes where rule='!'||suffix) then
   suffix_size:=n-i;exit;
  end if;
  if exists(select 1 from public.s2a_public_suffixes where rule=suffix) then suffix_size:=greatest(suffix_size,n-i+1);end if;
  if i>1 and exists(select 1 from public.s2a_public_suffixes where rule='*.'||suffix) then suffix_size:=greatest(suffix_size,n-i+2);end if;
 end loop;
 if n<=suffix_size then return domain;end if;
 return array_to_string(labels[n-suffix_size:n],'.');
end $$;
revoke all on function public.s2a_registration_domain(text) from public,anon,authenticated;
grant execute on function public.s2a_registration_domain(text) to service_role;
update public.s2a_settings set data=data||'{"registration_email_domain_quota_enabled":false}' where id='11111111-0000-4000-8000-000000000001';

create or replace function public.s2a_settings_update(p_patch jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; entry jsonb;
begin
 if p_patch is null or jsonb_typeof(p_patch)<>'object' or exists(select 1 from jsonb_object_keys(p_patch) k where k not in
 ('registration_email_domain_quota_enabled','custom_menu_items','custom_endpoints','backend_mode_enabled','hide_ccs_import_button','promo_code_enabled','registration_enabled','invitation_code_enabled','registration_email_suffix_whitelist','default_balance','default_concurrency','default_user_rpm_limit','default_subscriptions','site_name','site_logo','site_subtitle','compact_home_enabled','api_base_url','contact_info','doc_url','home_content')) then
  return jsonb_build_object('error','invalid_settings','status',400);
 end if;
 select data||p_patch into result from public.s2a_settings where id='11111111-0000-4000-8000-000000000001' for update;
 if jsonb_typeof(result->'registration_email_domain_quota_enabled')<>'boolean' or jsonb_typeof(result->'backend_mode_enabled')<>'boolean' or jsonb_typeof(result->'hide_ccs_import_button')<>'boolean' or jsonb_typeof(result->'custom_menu_items')<>'array' or jsonb_array_length(result->'custom_menu_items')>100 or jsonb_typeof(result->'custom_endpoints')<>'array' or jsonb_array_length(result->'custom_endpoints')>100 or jsonb_typeof(result->'promo_code_enabled')<>'boolean' or jsonb_typeof(result->'registration_enabled')<>'boolean' or jsonb_typeof(result->'invitation_code_enabled')<>'boolean'
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
declare settings jsonb; invitation public.s2a_redeem_codes; supplied text; suffix text; rule text; allowed boolean:=false; entry jsonb; result jsonb; authorized text; capability text; quota_domain text;
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
 suffix:=rtrim(lower(split_part(coalesce(new.email,''),'@',2)),'.');
 if jsonb_array_length(settings->'registration_email_suffix_whitelist')>0 then
  for rule in select jsonb_array_elements_text(settings->'registration_email_suffix_whitelist') loop
   if left(rule,2)='*.' then
    allowed:=allowed or suffix=substring(rule from 3) or (length(suffix)>length(substring(rule from 3))+1 and right(suffix,length(substring(rule from 3))+1)='.'||substring(rule from 3));
   else allowed:=allowed or suffix=ltrim(rule,'@'); end if;
  end loop;
  if not allowed then
   if not coalesce((settings->>'registration_email_domain_quota_enabled')::boolean,false) then raise check_violation using message='email_suffix_not_allowed';end if;
   quota_domain:=public.s2a_registration_domain(suffix);
   if quota_domain='' then raise check_violation using message='email_suffix_not_allowed';end if;
   perform pg_advisory_xact_lock(hashtextextended('s2a-email-domain|'||quota_domain,0));
   if exists(select 1 from auth.users u where u.id<>new.id and u.deleted_at is null and
     (rtrim(lower(split_part(coalesce(u.email,''),'@',2)),'.')=quota_domain or right(rtrim(lower(split_part(coalesce(u.email,''),'@',2)),'.'),length(quota_domain)+1)='.'||quota_domain)) then
    raise check_violation using message='email_domain_registration_limit';
   end if;
  end if;
 end if;
 -- Serialize aliases before checking the existing inbox identity and issuing signup grants.
 -- shortcut: canonical checks scan Auth users; add a private identity index when registration volume warrants it.
 perform pg_advisory_xact_lock(hashtextextended('s2a-email-alias|'||public.s2a_email_identity(new.email),0));
 if exists(select 1 from auth.users u where u.id<>new.id and public.s2a_email_identity(u.email)=public.s2a_email_identity(new.email)) then
  raise unique_violation using message='email_alias_already_registered';
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


