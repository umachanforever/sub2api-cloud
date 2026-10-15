begin;
do $$
declare original jsonb;v jsonb;eid bigint;event jsonb;actor uuid:=gen_random_uuid();
begin
 select data into original from public.s2a_settings;
 assert public.s2a_ops_monitoring_enabled() and public.s2a_ops_monitoring_enabled(true);
 v:=public.s2a_settings_update('{"ops_realtime_monitoring_enabled":false}');assert not v?'error';
 assert public.s2a_ops_monitoring_enabled() and not public.s2a_ops_monitoring_enabled(true);
 v:=public.s2a_admin_context('{}');assert v->'ops_monitoring_enabled'='true'::jsonb and v->'ops_realtime_monitoring_enabled'='false'::jsonb;
 v:=public.s2a_settings_update('{"ops_monitoring_enabled":false}');assert not v?'error';
 assert not public.s2a_ops_monitoring_enabled();
 event:=jsonb_build_object('event_id',gen_random_uuid(),'request_id',gen_random_uuid(),'kind','request','phase','routing','type','service_unavailable','owner','platform','source','gateway','code','no_available_account','limited',false,'status_code',503);
 eid:=public.s2a_ops_error_record(event);assert eid is null and not exists(select 1 from public.s2a_ops_errors where event_id=(event->>'event_id')::uuid);
 v:=public.s2a_settings_update('{"ops_monitoring_enabled":true,"ops_realtime_monitoring_enabled":true}');assert not v?'error';
 eid:=public.s2a_ops_error_record(event);assert eid is not null;
 v:=public.s2a_settings_update('{"ops_monitoring_enabled":"false","site_name":"Invalid patch"}');assert v->>'error'='invalid_monitoring_settings';
 assert (select data->>'site_name' from public.s2a_settings)=original->>'site_name';
 v:=public.s2a_settings_update('{"ops_monitoring_enabled":false,"unsupported_key":true}');assert v?'error' and public.s2a_ops_monitoring_enabled();
 assert not has_function_privilege('service_role','public.s2a_settings_update_without_monitoring(jsonb)','execute');
 assert not has_function_privilege('anon','public.s2a_ops_monitoring_enabled(boolean)','execute');
end $$;
rollback;
