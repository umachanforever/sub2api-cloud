create table public.s2a_ops_metrics (
 bucket_start timestamptz not null,resolution integer not null check(resolution in(60,3600)),
 platform text not null,group_id uuid,
 success_count bigint not null,error_count bigint not null,business_limited_count bigint not null,
 upstream_error_count bigint not null,upstream_429_count bigint not null,upstream_529_count bigint not null,
 token_consumed bigint not null,unknown_token_attempts bigint not null,switch_count bigint not null,
 updated_at timestamptz not null default statement_timestamp(),
 unique nulls not distinct(bucket_start,resolution,platform,group_id)
);
alter table public.s2a_ops_metrics enable row level security;
revoke all on public.s2a_ops_metrics from public,anon,authenticated,service_role;
grant select on public.s2a_ops_metrics to service_role;
create index s2a_ops_metrics_scope on public.s2a_ops_metrics(resolution,platform,group_id,bucket_start);

create function public.s2a_ops_aggregate(p_start timestamptz default null,p_end timestamptz default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare start_at timestamptz;end_at timestamptz;removed bigint;written bigint;
begin
 start_at:=date_bin(interval '1 hour',coalesce(p_start,now()-interval '2 hours'),'1970-01-01'::timestamptz);
 end_at:=date_bin(interval '1 hour',coalesce(p_end,now()),'1970-01-01'::timestamptz);
 if not isfinite(start_at) or not isfinite(end_at) or start_at>=end_at or end_at-start_at>interval '31 days'
 or end_at>date_bin(interval '1 hour',now(),'1970-01-01'::timestamptz) then raise exception 'invalid_aggregation_window';end if;
 if not pg_try_advisory_xact_lock(hashtextextended('s2a-ops-aggregation',0)) then return jsonb_build_object('skipped',true);end if;
 delete from public.s2a_ops_metrics where bucket_start>=start_at and bucket_start<end_at;
 get diagnostics removed=row_count;
 insert into public.s2a_ops_metrics(bucket_start,resolution,platform,group_id,success_count,error_count,business_limited_count,
 upstream_error_count,upstream_429_count,upstream_529_count,token_consumed,unknown_token_attempts,switch_count)
 with requests as materialized (
  select r.*,coalesce(e.is_business_limited,false) limited
  from public.s2a_ops_requests r left join public.s2a_ops_errors e on e.id=r.error_id
  where r.created_at>=start_at and r.created_at<end_at
 ), upstream as materialized (
  select e.* from public.s2a_ops_errors e where e.kind='upstream' and e.created_at>=start_at and e.created_at<end_at
 ), previous_attempts as (
  select distinct on(e.request_id) e.created_at,e.request_id::text,e.account_id,e.id seq,e.platform,e.group_id
  from public.s2a_ops_errors e where e.kind='upstream' and e.created_at<start_at and e.account_id is not null
  and e.request_id::text in(select request_id from requests union select request_id::text from upstream)
  order by e.request_id,e.created_at desc,e.id desc
 ), attempts as (
  select created_at,request_id::text,account_id,id seq,platform,group_id from upstream where account_id is not null
  union all select created_at,request_id,account_id,coalesce(error_id,0),platform,group_id from requests where account_id is not null
  union all select * from previous_attempts
 ), switches as (
  select created_at,platform,group_id from (
   select *,lag(account_id) over(partition by request_id order by created_at,seq) previous from attempts
  ) a where previous is not null and previous<>account_id and created_at>=start_at
 ), events as (
  select created_at,platform,group_id,kind,limited,status_code,0::bigint tokens,false unknown_tokens from requests
  union all select created_at,platform,group_id,'upstream',false,status_code,0,false from upstream
  union all select u.created_at,coalesce(nullif(g.platform,''),a.platform,''),u.group_id,'usage',false,u.status,
   coalesce(u.input_tokens,0)+coalesce(u.output_tokens,0),u.input_tokens is null or u.output_tokens is null
  from public.s2a_usage u left join public.s2a_groups g on g.id=u.group_id left join public.s2a_accounts a on a.id=u.account_id
  where u.model<>'__models__' and u.created_at>=start_at and u.created_at<end_at
  union all select created_at,platform,group_id,'switch',false,200,0,false from switches
 )
 select date_bin(make_interval(secs=>resolution),created_at,'1970-01-01'::timestamptz),resolution,platform,group_id,
 count(*) filter(where kind='success'),count(*) filter(where kind='error'),count(*) filter(where kind='error' and limited),
 count(*) filter(where kind='upstream' and status_code not in(429,529)),count(*) filter(where kind='upstream' and status_code=429),
 count(*) filter(where kind='upstream' and status_code=529),coalesce(sum(tokens),0),count(*) filter(where unknown_tokens),count(*) filter(where kind='switch')
 from events cross join (values(60),(3600)) resolutions(resolution) group by 1,2,3,4;
 get diagnostics written=row_count;
 return jsonb_build_object('start_time',start_at,'end_time',end_at,'replaced_rows',removed,'written_rows',written);
end $$;
revoke all on function public.s2a_ops_aggregate(timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.s2a_ops_aggregate(timestamptz,timestamptz) to service_role;
notify pgrst,'reload schema';
