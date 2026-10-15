update public.s2a_settings set data=data||'{"custom_menu_items":[],"custom_endpoints":[],"backend_mode_enabled":false,"hide_ccs_import_button":false}' where id='11111111-0000-4000-8000-000000000001';

create or replace function public.s2a_settings_update(p_patch jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; entry jsonb;
begin
 if p_patch is null or jsonb_typeof(p_patch)<>'object' or exists(select 1 from jsonb_object_keys(p_patch) k where k not in
 ('custom_menu_items','custom_endpoints','backend_mode_enabled','hide_ccs_import_button','promo_code_enabled','registration_enabled','invitation_code_enabled','registration_email_suffix_whitelist','default_balance','default_concurrency','default_user_rpm_limit','default_subscriptions','site_name','site_logo','site_subtitle','compact_home_enabled','api_base_url','contact_info','doc_url','home_content')) then
  return jsonb_build_object('error','invalid_settings','status',400);
 end if;
 select data||p_patch into result from public.s2a_settings where id='11111111-0000-4000-8000-000000000001' for update;
 if jsonb_typeof(result->'backend_mode_enabled')<>'boolean' or jsonb_typeof(result->'hide_ccs_import_button')<>'boolean' or jsonb_typeof(result->'custom_menu_items')<>'array' or jsonb_array_length(result->'custom_menu_items')>100 or jsonb_typeof(result->'custom_endpoints')<>'array' or jsonb_array_length(result->'custom_endpoints')>100 or jsonb_typeof(result->'promo_code_enabled')<>'boolean' or jsonb_typeof(result->'registration_enabled')<>'boolean' or jsonb_typeof(result->'invitation_code_enabled')<>'boolean'
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

