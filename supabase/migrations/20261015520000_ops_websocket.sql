create table public.s2a_ops_ws_leases (
 id uuid primary key,user_id uuid not null references auth.users(id) on delete cascade,expires_at timestamptz not null
);
alter table public.s2a_ops_ws_leases enable row level security;
revoke all on public.s2a_ops_ws_leases from public,anon,authenticated,service_role;
create function public.s2a_ops_ws_lease(p_id uuid,p_user uuid,p_action text) returns jsonb language plpgsql security definer set search_path='' as $$
declare enabled boolean;stats jsonb;requests bigint;
begin
 if p_id is null or p_user is null or p_action is null or p_action not in('claim','refresh','release') then raise exception 'invalid_websocket_lease';end if;
 if p_action='release' then delete from public.s2a_ops_ws_leases where id=p_id and user_id=p_user;return '{}';end if;
 select coalesce((data->>'ops_monitoring_enabled')::boolean,true) and coalesce((data->>'ops_realtime_monitoring_enabled')::boolean,true) into enabled from public.s2a_settings;
 if not (p_user=any(public.s2a_active_admin_ids())) then return '{"allowed":false,"enabled":true}';end if;
 if not enabled then delete from public.s2a_ops_ws_leases where id=p_id and user_id=p_user;return '{"allowed":true,"enabled":false}';end if;
 if p_action='claim' then
  perform pg_advisory_xact_lock(hashtextextended('s2a-ops-ws-leases',0));
  delete from public.s2a_ops_ws_leases where expires_at<=now();
  if (select count(*) from public.s2a_ops_ws_leases)>=100 or (select count(*) from public.s2a_ops_ws_leases where user_id=p_user)>=20 then return '{"allowed":false,"enabled":true}';end if;
  insert into public.s2a_ops_ws_leases values(p_id,p_user,now()+interval '30 seconds');
  return '{"allowed":true,"enabled":true}';
 end if;
 update public.s2a_ops_ws_leases set expires_at=now()+interval '30 seconds' where id=p_id and user_id=p_user and expires_at>now();
 if not found then return '{"allowed":false,"enabled":true}';end if;
 stats:=public.s2a_ops_realtime_traffic(now()-interval '1 minute',now(),'',null);
 select count(*) into requests from public.s2a_ops_requests where created_at>=now()-interval '1 minute' and created_at<now();
 return jsonb_build_object('allowed',true,'enabled',true,'data',jsonb_build_object('type','qps_update','timestamp',now(),'data',jsonb_build_object('qps',stats->'qps'->'current','tps',stats->'tps'->'current','request_count',requests,'unknown_token_attempts',stats->'unknown_token_attempts')));
end $$;
revoke all on function public.s2a_ops_ws_lease(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.s2a_ops_ws_lease(uuid,uuid,text) to service_role;
