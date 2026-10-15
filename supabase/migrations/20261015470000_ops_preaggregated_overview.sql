create table public.s2a_ops_aggregation_coverage(bucket_start timestamptz primary key,computed_at timestamptz not null default statement_timestamp());
alter table public.s2a_ops_aggregation_coverage enable row level security;
revoke all on public.s2a_ops_aggregation_coverage from public,anon,authenticated,service_role;

do $$
declare definition text;needle text:=' get diagnostics written=row_count;';
begin
 definition:=pg_get_functiondef('public.s2a_ops_aggregate(timestamptz,timestamptz)'::regprocedure);
 if strpos(definition,needle)=0 then raise exception 'aggregation definition changed';end if;
 definition:=replace(definition,needle,needle||chr(10)||' insert into public.s2a_ops_aggregation_coverage(bucket_start) select generate_series(start_at,end_at-interval ''1 hour'',interval ''1 hour'') on conflict(bucket_start) do update set computed_at=statement_timestamp();');
 needle:=' delete from public.s2a_ops_metrics where bucket_start>=start_at and bucket_start<end_at;'||chr(10)||' get diagnostics removed=row_count;';
 if strpos(definition,needle)=0 then raise exception 'aggregation replacement changed';end if;
 definition:=replace(definition,needle,' select count(*) into removed from public.s2a_ops_metrics where bucket_start>=start_at and bucket_start<end_at;');
 needle:=' from events cross join (values(60),(3600)) resolutions(resolution) group by 1,2,3,4;';
 if strpos(definition,needle)=0 then raise exception 'aggregation insertion changed';end if;
 -- shortcut: closed snapshots survive source retention; add per-request deltas before supporting late historical imports.
 definition:=replace(definition,needle,' from events cross join (values(60),(3600)) resolutions(resolution) group by 1,2,3,4
 on conflict(bucket_start,resolution,platform,group_id) do update set
 success_count=excluded.success_count,error_count=excluded.error_count,business_limited_count=excluded.business_limited_count,
 upstream_error_count=excluded.upstream_error_count,upstream_429_count=excluded.upstream_429_count,upstream_529_count=excluded.upstream_529_count,
 token_consumed=excluded.token_consumed,unknown_token_attempts=excluded.unknown_token_attempts,switch_count=excluded.switch_count,updated_at=excluded.updated_at
 where excluded.success_count>=s2a_ops_metrics.success_count and excluded.error_count>=s2a_ops_metrics.error_count
 and excluded.business_limited_count>=s2a_ops_metrics.business_limited_count and excluded.upstream_error_count>=s2a_ops_metrics.upstream_error_count
 and excluded.upstream_429_count>=s2a_ops_metrics.upstream_429_count and excluded.upstream_529_count>=s2a_ops_metrics.upstream_529_count
 and excluded.token_consumed>=s2a_ops_metrics.token_consumed and excluded.unknown_token_attempts>=s2a_ops_metrics.unknown_token_attempts
 and excluded.switch_count>=s2a_ops_metrics.switch_count;');
 execute definition;
 definition:=pg_get_functiondef('public.s2a_ops_cleanup()'::regprocedure);
 needle:=' return jsonb_build_object(''errors_deleted'',errors';
 if strpos(definition,needle)=0 then raise exception 'cleanup definition changed';end if;
 execute replace(definition,needle,' delete from public.s2a_ops_aggregation_coverage where bucket_start<cutoff-make_interval(days=>(cfg->>''hourly_metrics_retention_days'')::integer);'||chr(10)||needle);
end $$;

alter function public.s2a_ops_dashboard(timestamptz,timestamptz,text,uuid,integer,text) rename to s2a_ops_dashboard_raw;
revoke all on function public.s2a_ops_dashboard_raw(timestamptz,timestamptz,text,uuid,integer,text) from service_role;
create function public.s2a_ops_dashboard(p_start timestamptz,p_end timestamptz,p_platform text default '',p_group uuid default null,p_bucket integer default 60,p_part text default 'snapshot-v2',p_mode text default 'auto')
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;raw_overview jsonb;overview jsonb;head jsonb:='{}';tail jsonb:='{}';totals jsonb;field text;value bigint;
 full_start timestamptz;full_end timestamptz;requests bigint;sla_requests bigint;seconds numeric;complete boolean;
begin
 if p_mode is null or p_mode not in('auto','raw','preagg') then raise exception 'invalid_query_mode';end if;
 result:=public.s2a_ops_dashboard_raw(p_start,p_end,p_platform,p_group,p_bucket,p_part);
 if p_part not in('snapshot-v2','overview') then return result;end if;
 raw_overview:=case when p_part='overview' then result else result->'overview' end;
 full_start:=date_bin(interval '1 hour',p_start,'1970-01-01'::timestamptz);
 if full_start<p_start then full_start:=full_start+interval '1 hour';end if;
 full_end:=date_bin(interval '1 hour',least(p_end,statement_timestamp()-interval '5 minutes'),'1970-01-01'::timestamptz);
 if p_mode='raw' or full_start>=full_end then
  overview:=raw_overview||jsonb_build_object('query_mode','raw','raw_samples_complete',true);
 else
  select not exists(select 1 from generate_series(full_start,full_end-interval '1 hour',interval '1 hour') h
   where not exists(select 1 from public.s2a_ops_aggregation_coverage c where c.bucket_start=h)) into complete;
  if not complete then
   if p_mode='preagg' then return jsonb_build_object('error','ops_preaggregation_not_populated','status',503);end if;
   overview:=raw_overview||jsonb_build_object('query_mode','raw','raw_samples_complete',true);
  else
   if p_start<full_start then head:=public.s2a_ops_dashboard_raw(p_start,full_start,p_platform,p_group,p_bucket,'overview');end if;
   if full_end<p_end then tail:=public.s2a_ops_dashboard_raw(full_end,p_end,p_platform,p_group,p_bucket,'overview');end if;
   select jsonb_build_object('success_count',coalesce(sum(success_count),0),'error_count_total',coalesce(sum(error_count),0),
    'business_limited_count',coalesce(sum(business_limited_count),0),'upstream_error_count_excl_429_529',coalesce(sum(upstream_error_count),0),
    'upstream_429_count',coalesce(sum(upstream_429_count),0),'upstream_529_count',coalesce(sum(upstream_529_count),0),
    'token_consumed',coalesce(sum(token_consumed),0),'unknown_token_attempts',coalesce(sum(unknown_token_attempts),0)) into totals
   from public.s2a_ops_metrics where resolution=3600 and bucket_start>=full_start and bucket_start<full_end
   and (p_platform='' or platform=p_platform) and (p_group is null or group_id=p_group);
   foreach field in array array['success_count','error_count_total','business_limited_count','upstream_error_count_excl_429_529','upstream_429_count','upstream_529_count','token_consumed','unknown_token_attempts'] loop
    value:=(totals->>field)::bigint+coalesce((head->>field)::bigint,0)+coalesce((tail->>field)::bigint,0);
    totals:=totals||jsonb_build_object(field,value);
    complete:=complete and value=(raw_overview->>field)::bigint;
   end loop;
   requests:=(totals->>'success_count')::bigint+(totals->>'error_count_total')::bigint;
   sla_requests:=requests-(totals->>'business_limited_count')::bigint;
   seconds:=extract(epoch from(p_end-p_start));
   complete:=complete and requests=(raw_overview->>'request_count_total')::bigint;
   overview:=raw_overview||totals||jsonb_build_object('query_mode','preagg','raw_samples_complete',complete,
    'request_count_total',requests,'request_count_sla',sla_requests,'error_count_sla',sla_requests-(totals->>'success_count')::bigint,
    'sla',coalesce(round((totals->>'success_count')::numeric/nullif(sla_requests,0),4),0),
    'error_rate',coalesce(round((sla_requests-(totals->>'success_count')::bigint)::numeric/nullif(sla_requests,0),4),0),
    'upstream_error_rate',coalesce(round((totals->>'upstream_error_count_excl_429_529')::numeric/nullif(sla_requests,0),4),0),
    'qps',(raw_overview->'qps')||jsonb_build_object('avg',round(requests/seconds,1),'peak',case when requests=(raw_overview->>'request_count_total')::bigint then raw_overview->'qps'->'peak' else 'null'::jsonb end),
    'tps',(raw_overview->'tps')||jsonb_build_object('avg',round((totals->>'token_consumed')::numeric/seconds,1),'peak',case when (totals->>'token_consumed')::bigint=(raw_overview->>'token_consumed')::bigint then raw_overview->'tps'->'peak' else 'null'::jsonb end));
   -- Percentiles use individual samples; discarded samples cannot yield exact window percentiles.
   if (totals->>'success_count')::bigint<>(raw_overview->>'success_count')::bigint then
    overview:=overview||jsonb_build_object('duration',jsonb_build_object('p50_ms',null,'p90_ms',null,'p95_ms',null,'p99_ms',null,'avg_ms',null,'max_ms',null),
     'ttft',jsonb_build_object('p50_ms',null,'p90_ms',null,'p95_ms',null,'p99_ms',null,'avg_ms',null,'max_ms',null),'output_tps',null);
   end if;
  end if;
 end if;
 return case when p_part='overview' then overview else result||jsonb_build_object('overview',overview) end;
end $$;
revoke all on function public.s2a_ops_dashboard(timestamptz,timestamptz,text,uuid,integer,text,text) from public,anon,authenticated;
grant execute on function public.s2a_ops_dashboard(timestamptz,timestamptz,text,uuid,integer,text,text) to service_role;
notify pgrst,'reload schema';
