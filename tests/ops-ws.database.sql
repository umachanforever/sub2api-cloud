begin;
do $$
declare u uuid:=gen_random_uuid();other_user uuid:=gen_random_uuid();l uuid:=gen_random_uuid();v jsonb;
begin
 insert into auth.users(id,email) values(u,'ws-fixture@example.com');
 insert into public.s2a_admin_roles(user_id) values(u);
 delete from public.s2a_ops_ws_leases;
 update public.s2a_settings set data=data||'{"ops_monitoring_enabled":true,"ops_realtime_monitoring_enabled":true}';
 v:=public.s2a_ops_ws_lease(l,u,'claim');assert (v->>'allowed')::boolean;
 v:=public.s2a_ops_ws_lease(l,u,'refresh');assert v->'data'->>'type'='qps_update';assert v->'data'->'data'?'request_count';
 assert not (public.s2a_ops_ws_lease(l,gen_random_uuid(),'refresh')->>'allowed')::boolean;
 perform public.s2a_ops_ws_lease(l,u,'release');assert not exists(select 1 from public.s2a_ops_ws_leases);
 for i in 1..20 loop perform public.s2a_ops_ws_lease(gen_random_uuid(),u,'claim');end loop;
 assert not (public.s2a_ops_ws_lease(gen_random_uuid(),u,'claim')->>'allowed')::boolean,'per-user limit is strict';
 update public.s2a_ops_ws_leases set expires_at=now()-interval '1 second';
 assert (public.s2a_ops_ws_lease(l,u,'claim')->>'allowed')::boolean,'expired leases release capacity';
 update public.s2a_settings set data=data||'{"ops_realtime_monitoring_enabled":false}';
 assert not (public.s2a_ops_ws_lease(l,u,'refresh')->>'enabled')::boolean;
 assert not exists(select 1 from public.s2a_ops_ws_leases);
 update public.s2a_settings set data=data||'{"ops_realtime_monitoring_enabled":true}';
 insert into auth.users(id,email) values(other_user,'ws-other@example.com');
 insert into public.s2a_admin_roles(user_id) values(other_user);
 insert into public.s2a_ops_ws_leases select gen_random_uuid(),u,now()+interval '30 seconds' from generate_series(1,100);
 assert not (public.s2a_ops_ws_lease(gen_random_uuid(),other_user,'claim')->>'allowed')::boolean,'global limit applies across administrators';
 assert not has_table_privilege('service_role','public.s2a_ops_ws_leases','SELECT');
 assert not has_function_privilege('authenticated','public.s2a_ops_ws_lease(uuid,uuid,text)','EXECUTE');
end $$;
rollback;
