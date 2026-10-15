create view public.s2a_ops_requests as
 select 'success'::text kind,u.created_at,u.request_id::text request_id,
 coalesce(nullif(g.platform,''),a.platform,'') platform,u.model,u.duration_ms,null::integer first_token_ms,
 u.status status_code,null::bigint error_id,null::text phase,null::text severity,null::text message,
 u.user_id,u.key_id api_key_id,u.account_id,u.group_id,u.stream,a.name account_name
 from public.s2a_usage u
 left join public.s2a_groups g on g.id=u.group_id
 left join public.s2a_accounts a on a.id=u.account_id
 where u.outcome='completed' and u.status between 200 and 299
 and not exists(select 1 from public.s2a_ops_errors e where e.request_id=u.request_id and e.kind='request')
 union all
 select 'error',e.created_at,e.request_id::text,e.platform,e.model,e.response_latency_ms,null::integer,
 e.status_code,e.id,e.phase,e.severity,e.message,e.user_id,e.api_key_id,e.account_id,e.group_id,e.stream,e.account_name
 from public.s2a_ops_errors e where e.kind='request';
revoke all on public.s2a_ops_requests from public,anon,authenticated;
grant select on public.s2a_ops_requests to service_role;
