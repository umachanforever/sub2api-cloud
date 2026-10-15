alter table public.s2a_usage add column first_token_ms integer check(first_token_ms>=0);
alter function public.s2a_finish(uuid,integer,text,bigint,bigint,bigint,bigint,integer,bigint) rename to s2a_finish_without_timing;
revoke all on function public.s2a_finish_without_timing(uuid,integer,text,bigint,bigint,bigint,bigint,integer,bigint) from public,anon,authenticated,service_role;
create function public.s2a_finish(
 p_lease_id uuid,p_status integer,p_outcome text,
 p_input_tokens bigint default null,p_output_tokens bigint default null,
 p_cache_creation_tokens bigint default null,p_cache_read_tokens bigint default null,
 p_cooldown_seconds integer default 0,p_credential_version bigint default null,p_first_token_ms integer default null)
returns void language plpgsql security definer set search_path='' as $$
begin
 if p_first_token_ms<0 then raise exception 'invalid_first_token_ms';end if;
 perform public.s2a_finish_without_timing(p_lease_id,p_status,p_outcome,p_input_tokens,p_output_tokens,p_cache_creation_tokens,p_cache_read_tokens,p_cooldown_seconds,p_credential_version);
 if p_first_token_ms is not null then
  update public.s2a_usage set first_token_ms=p_first_token_ms where id=p_lease_id and first_token_ms is null;
 end if;
end $$;
revoke all on function public.s2a_finish(uuid,integer,text,bigint,bigint,bigint,bigint,integer,bigint,integer) from public,anon,authenticated;
grant execute on function public.s2a_finish(uuid,integer,text,bigint,bigint,bigint,bigint,integer,bigint,integer) to service_role;

create or replace view public.s2a_ops_requests as
 select 'success'::text kind,u.created_at,u.request_id::text request_id,
 coalesce(nullif(g.platform,''),a.platform,'') platform,u.model,u.duration_ms,u.first_token_ms,
 u.status status_code,null::bigint error_id,null::text phase,null::text severity,null::text message,
 u.user_id,u.key_id api_key_id,u.account_id,u.group_id,u.stream,a.name account_name
 from public.s2a_usage u
 left join public.s2a_groups g on g.id=u.group_id
 left join public.s2a_accounts a on a.id=u.account_id
 where u.outcome='completed' and u.status between 200 and 299
 and not exists(select 1 from public.s2a_ops_errors e where e.request_id=u.request_id and e.kind='request')
 union all
 select 'error',e.created_at,e.request_id::text,e.platform,e.model,e.response_latency_ms,
 (select u.first_token_ms from public.s2a_usage u where u.request_id=e.request_id and u.account_id=e.account_id and u.first_token_ms is not null order by u.created_at desc,u.id desc limit 1),
 e.status_code,e.id,e.phase,e.severity,e.message,e.user_id,e.api_key_id,e.account_id,e.group_id,e.stream,e.account_name
 from public.s2a_ops_errors e where e.kind='request';

create or replace view public.s2a_ops_error_details as select e.*,
 (e.api_key_id is not null and (k.id is null or k.deleted_at is not null)) api_key_deleted,
 null::text client_ip,null::text user_agent,null::text upstream_endpoint,null::smallint request_type,
 null::integer auth_latency_ms,null::integer routing_latency_ms,null::integer upstream_latency_ms,
 case when e.kind='request' then (select u.first_token_ms from public.s2a_usage u where u.request_id=e.request_id and u.account_id=e.account_id and u.first_token_ms is not null order by u.created_at desc,u.id desc limit 1) end time_to_first_token_ms,
 null::text upstream_errors
 from public.s2a_ops_errors e left join public.s2a_keys k on k.id=e.api_key_id;
