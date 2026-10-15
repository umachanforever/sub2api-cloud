update public.s2a_settings set data='{"ops_monitoring_enabled":true,"ops_realtime_monitoring_enabled":true}'::jsonb||data;

create function public.s2a_ops_monitoring_enabled(p_realtime boolean default false) returns boolean
language sql stable security definer set search_path='' as $$
 select coalesce(data->'ops_monitoring_enabled'<>'false'::jsonb,true)
 and (not p_realtime or coalesce(data->'ops_realtime_monitoring_enabled'<>'false'::jsonb,true)) from public.s2a_settings;
$$;
revoke all on function public.s2a_ops_monitoring_enabled(boolean) from public,anon,authenticated;
grant execute on function public.s2a_ops_monitoring_enabled(boolean) to service_role;

do $$
declare definition text;needle text;
begin
 definition:=pg_get_functiondef('public.s2a_admin_context(uuid[])'::regprocedure);
 needle:='return jsonb_build_object(''admin_ids'',public.s2a_active_admin_ids());';
 if strpos(definition,needle)=0 then raise exception 'admin context definition changed';end if;
 execute replace(definition,needle,'return jsonb_build_object(''admin_ids'',public.s2a_active_admin_ids(),''ops_monitoring_enabled'',public.s2a_ops_monitoring_enabled(),''ops_realtime_monitoring_enabled'',public.s2a_ops_monitoring_enabled(true));');
 definition:=pg_get_functiondef('public.s2a_ops_error_record(jsonb)'::regprocedure);
 needle:='begin';
 execute replace(definition,needle,'begin'||chr(10)||' if not public.s2a_ops_monitoring_enabled() then return null;end if;');
end $$;

alter function public.s2a_settings_update(jsonb) rename to s2a_settings_update_without_monitoring;
revoke all on function public.s2a_settings_update_without_monitoring(jsonb) from service_role;
create function public.s2a_settings_update(p_patch jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;field text;patch jsonb;
begin
 if p_patch is null or jsonb_typeof(p_patch)<>'object' then return jsonb_build_object('error','invalid_settings','status',400);end if;
 foreach field in array array['ops_monitoring_enabled','ops_realtime_monitoring_enabled'] loop
  if p_patch?field and jsonb_typeof(p_patch->field)<>'boolean' then return jsonb_build_object('error','invalid_monitoring_settings','status',400);end if;
 end loop;
 result:=public.s2a_settings_update_without_monitoring(p_patch-'ops_monitoring_enabled'-'ops_realtime_monitoring_enabled');
 if result?'error' then return result;end if;
 patch:=jsonb_strip_nulls(jsonb_build_object('ops_monitoring_enabled',p_patch->'ops_monitoring_enabled','ops_realtime_monitoring_enabled',p_patch->'ops_realtime_monitoring_enabled'));
 if patch<>'{}'::jsonb then update public.s2a_settings set data=data||patch,updated_at=now() where id='11111111-0000-4000-8000-000000000001' returning data into result;end if;
 return result;
end $$;
revoke all on function public.s2a_settings_update(jsonb) from public,anon,authenticated;
grant execute on function public.s2a_settings_update(jsonb) to service_role;
notify pgrst,'reload schema';
