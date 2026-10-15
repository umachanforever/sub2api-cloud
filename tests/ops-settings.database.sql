begin;
do $$
declare defaults jsonb:=public.s2a_ops_metric_thresholds_get(); disabled jsonb:='{"sla_percent_min":null,"ttft_p99_ms_max":null,"request_error_rate_percent_max":null,"upstream_error_rate_percent_max":null}';
 bad jsonb; actor uuid:='d2000000-0000-4000-8000-000000000001';
begin
 assert defaults='{"sla_percent_min":99.5,"ttft_p99_ms_max":500,"request_error_rate_percent_max":5,"upstream_error_rate_percent_max":5}'::jsonb;
 insert into auth.users(id) values(actor);
 perform set_config('request.headers',jsonb_build_object('x-s2a-actor-id',actor,'x-s2a-actor-role','admin','x-s2a-request-id','ops-threshold-fixture')::text,true);
 assert public.s2a_ops_metric_thresholds_set(disabled)=disabled;
 assert public.s2a_ops_metric_thresholds_get()=disabled,'disabled thresholds survive reload';
 assert public.s2a_ops_metric_thresholds_set(disabled||'{"sla_percent_min":0,"ttft_p99_ms_max":0}')=disabled||'{"sla_percent_min":0,"ttft_p99_ms_max":0}';
 for bad in select value from jsonb_array_elements('[{"sla_percent_min":101},{"ttft_p99_ms_max":-1},{"request_error_rate_percent_max":"5"},{"unexpected":null},{"upstream_error_rate_percent_max":false}]') loop
  begin perform public.s2a_ops_metric_thresholds_set(disabled||bad);raise exception 'bad threshold accepted';exception when raise_exception then assert sqlerrm='invalid_metric_thresholds';end;
 end loop;
 assert (select count(*)=2 from public.s2a_audit_logs where request_id='ops-threshold-fixture' and actor_user_id=actor),'settings changes carry the authenticated actor';
 assert not has_table_privilege('authenticated','public.s2a_ops_metric_thresholds','select');
 assert not has_table_privilege('service_role','public.s2a_ops_metric_thresholds','update');
 assert not has_function_privilege('anon','public.s2a_ops_metric_thresholds_get()','execute');
 assert not has_function_privilege('authenticated','public.s2a_ops_metric_thresholds_set(jsonb)','execute');
 assert has_function_privilege('service_role','public.s2a_ops_metric_thresholds_set(jsonb)','execute');
end $$;
rollback;
