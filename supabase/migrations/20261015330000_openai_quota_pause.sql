create function public.s2a_quota_pause_number(p_value jsonb) returns numeric
language plpgsql immutable set search_path='' as $$
begin
 if jsonb_typeof(p_value) not in ('number','string') or p_value#>>'{}' !~ '^[+]?[0-9]+([.][0-9]+)?$' then return null;end if;
 return (p_value#>>'{}')::numeric;
exception when others then return null;
end $$;
create function public.s2a_quota_pause_time(p_value jsonb) returns timestamptz
language plpgsql stable set search_path='' as $$
begin
 if jsonb_typeof(p_value)<>'string' or length(p_value#>>'{}')>64 then return null;end if;
 return (p_value#>>'{}')::timestamptz;
exception when others then return null;
end $$;
create function public.s2a_openai_window_utilization(p_extra jsonb,p_window text,p_now timestamptz default now()) returns numeric
language plpgsql stable set search_path='' as $$
declare used numeric;updated timestamptz;reset_at timestamptz;seconds numeric;
begin
 if p_window not in ('5h','7d') then return null;end if;
 used:=public.s2a_quota_pause_number(p_extra->('codex_'||p_window||'_used_percent'));if coalesce(used,0)<=0 then return null;end if;
 updated:=public.s2a_quota_pause_time(p_extra->'codex_usage_updated_at');
 reset_at:=public.s2a_quota_pause_time(p_extra->('codex_'||p_window||'_reset_at'));
 if reset_at is null then
  seconds:=public.s2a_quota_pause_number(p_extra->('codex_'||p_window||'_reset_after_seconds'));
  if seconds>0 and seconds<=253402300799 and updated is not null then reset_at:=updated+seconds*interval '1 second';end if;
 end if;
 if reset_at<=p_now then return null;end if;
 if updated<=p_now-interval '2 hours' and reset_at is null then return null;end if;
 return used/100;
end $$;
create function public.s2a_openai_quota_paused(p_extra jsonb,p_platform text,p_type text) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare defaults jsonb;five numeric;seven numeric;threshold numeric;state jsonb;checked timestamptz;w text;
begin
 if p_platform<>'openai' then return false;end if;
 five:=public.s2a_openai_window_utilization(p_extra,'5h');seven:=public.s2a_openai_window_utilization(p_extra,'7d');
 if five is null and seven is null then return false;end if;
 if p_type='oauth' and p_extra->'auto_reset_credit_enabled'='true'::jsonb then
  if five>=coalesce(public.s2a_quota_pause_number(p_extra->'auto_reset_credit_5h_threshold'),1)
   or seven>=coalesce(public.s2a_quota_pause_number(p_extra->'auto_reset_credit_7d_threshold'),1) then return true;end if;
 end if;
 select data->'openai_account_quota_auto_pause' into defaults from public.s2a_settings;
 foreach w in array array['5h','7d'] loop
  if p_extra->('auto_pause_'||w||'_disabled')='true'::jsonb then continue;end if;
  threshold:=least(1,coalesce(public.s2a_quota_pause_number(p_extra->('auto_pause_'||w||'_threshold')),0));
  if threshold<=0 then threshold:=least(1,coalesce(public.s2a_quota_pause_number(defaults->('default_threshold_'||w)),0));end if;
  if threshold>0 and (case when w='5h' then five else seven end)>=threshold then
   if p_type='oauth' and p_extra->'auto_reset_credit_enabled'='true'::jsonb then
    state:=p_extra->'codex_auto_reset_credit_state';checked:=public.s2a_quota_pause_time(state->'checked_at');
    if state->>'status'='available' and public.s2a_quota_pause_number(state->'available_count')>0 and checked>now()-interval '10 minutes' then return false;end if;
   end if;
   return true;
  end if;
 end loop;
 return false;
end $$;

create function public.s2a_openai_quota_pause_config() returns trigger
language plpgsql security definer set search_path='' as $$
declare w text;v jsonb;
begin
 foreach w in array array['5h','7d'] loop
  if new.extra ?| array['auto_pause_'||w||'_disabled','auto_pause_'||w||'_threshold'] and new.platform<>'openai' then raise exception 'invalid_quota_pause_account';end if;
  v:=new.extra->('auto_pause_'||w||'_disabled');if v is not null and jsonb_typeof(v)<>'boolean' then raise exception 'invalid_quota_pause_disabled';end if;
  v:=new.extra->('auto_pause_'||w||'_threshold');
  if v is not null and (jsonb_typeof(v)<>'number' or public.s2a_quota_pause_number(v) is null or public.s2a_quota_pause_number(v)>1) then raise exception 'invalid_quota_pause_threshold';end if;
 end loop;
 return new;
end $$;
create trigger s2a_openai_quota_pause_config before insert or update of platform,extra on public.s2a_accounts
 for each row execute function public.s2a_openai_quota_pause_config();

do $$
declare definition text;needle text:='and candidate.status = ''active''';
begin
 definition:=pg_get_functiondef('public.s2a_acquire_key(text,text,uuid,uuid[],boolean)'::regprocedure);
 if position(needle in definition)=0 then raise exception 'scheduler_quota_pause_patch_missing';end if;
 definition:=replace(definition,needle,'and not public.s2a_openai_quota_paused(candidate.extra,candidate.platform,candidate.type) '||needle);
 execute definition;
end $$;

update public.s2a_settings set data=data||jsonb_build_object('openai_account_quota_auto_pause',jsonb_build_object('default_threshold_5h',0,'default_threshold_7d',0)) where id='11111111-0000-4000-8000-000000000001';
alter function public.s2a_settings_update(jsonb) rename to s2a_settings_update_without_quota_pause;
revoke all on function public.s2a_settings_update_without_quota_pause(jsonb) from service_role;
create function public.s2a_settings_update(p_patch jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;config jsonb;k text;
begin
 if p_patch is null or jsonb_typeof(p_patch)<>'object' then return jsonb_build_object('error','invalid_settings','status',400);end if;
 if p_patch?'openai_account_quota_auto_pause' then
  config:=p_patch->'openai_account_quota_auto_pause';
  if jsonb_typeof(config)<>'object' or exists(select 1 from jsonb_object_keys(config) field(name) where field.name not in ('default_threshold_5h','default_threshold_7d')) then return jsonb_build_object('error','invalid_quota_pause_settings','status',400);end if;
  foreach k in array array['default_threshold_5h','default_threshold_7d'] loop
   if not config?k or jsonb_typeof(config->k)<>'number' or public.s2a_quota_pause_number(config->k) is null or public.s2a_quota_pause_number(config->k)>1 then return jsonb_build_object('error','invalid_quota_pause_settings','status',400);end if;
  end loop;
 end if;
 result:=public.s2a_settings_update_without_quota_pause(p_patch-'openai_account_quota_auto_pause');
 if result?'error' then return result;end if;
 if config is not null then update public.s2a_settings set data=data||jsonb_build_object('openai_account_quota_auto_pause',config),updated_at=now() where id='11111111-0000-4000-8000-000000000001' returning data into result;end if;
 return result;
end $$;

revoke all on function public.s2a_quota_pause_number(jsonb),public.s2a_quota_pause_time(jsonb),public.s2a_openai_window_utilization(jsonb,text,timestamptz),public.s2a_openai_quota_paused(jsonb,text,text),public.s2a_openai_quota_pause_config() from public,anon,authenticated;
grant execute on function public.s2a_openai_quota_paused(jsonb,text,text) to service_role;
revoke all on function public.s2a_settings_update(jsonb) from public,anon,authenticated;
grant execute on function public.s2a_settings_update(jsonb) to service_role;
notify pgrst,'reload schema';
