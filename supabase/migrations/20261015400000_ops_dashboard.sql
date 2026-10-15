create index s2a_usage_time on public.s2a_usage(created_at desc);
create or replace function public.s2a_ops_dashboard(p_start timestamptz,p_end timestamptz,p_platform text default '',p_group uuid default null,p_bucket integer default 60,p_part text default 'snapshot-v2')
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if p_start is null or p_end is null or not isfinite(p_start) or not isfinite(p_end) or p_start>=p_end or p_end-p_start>interval '31 days'
 or p_platform is null or p_platform not in('','openai','anthropic','gemini') or p_bucket is null or p_bucket not in(60,300,3600)
 or p_part is null or p_part not in('overview','snapshot-v2','throughput-trend','error-trend','error-distribution','latency-histogram') then raise exception 'invalid_dashboard_filter';end if;
 return (
 with requests as materialized (
  select r.*,coalesce(e.is_business_limited,false) limited,coalesce(nullif(e.group_name,''),g.name,'') group_name
  from public.s2a_ops_requests r left join public.s2a_ops_errors e on e.id=r.error_id left join public.s2a_groups g on g.id=r.group_id
  where r.created_at>=p_start and r.created_at<p_end and (p_platform='' or r.platform=p_platform) and (p_group is null or r.group_id=p_group)
 ), usage as materialized (
  select u.*,coalesce(nullif(g.platform,''),a.platform,'') platform,coalesce(g.name,'') group_name,
  coalesce(u.input_tokens,0)+coalesce(u.output_tokens,0) tokens
  from public.s2a_usage u left join public.s2a_groups g on g.id=u.group_id left join public.s2a_accounts a on a.id=u.account_id
  where u.model<>'__models__' and u.created_at>=p_start and u.created_at<p_end and (p_platform='' or coalesce(nullif(g.platform,''),a.platform,'')=p_platform) and (p_group is null or u.group_id=p_group)
 ), upstream as materialized (
  select e.* from public.s2a_ops_errors e where e.kind='upstream' and e.created_at>=p_start and e.created_at<p_end
  and (p_platform='' or e.platform=p_platform) and (p_group is null or e.group_id=p_group)
 ), events as materialized (
  select r.created_at,r.kind,r.platform,r.group_id,r.group_name,0::bigint tokens,r.limited,r.status_code from requests r
  union all select u.created_at,'usage',u.platform,u.group_id,u.group_name,u.tokens,false,u.status from usage u
  union all select e.created_at,'upstream',e.platform,e.group_id,e.group_name,0::bigint,false,e.status_code from upstream e
 ), previous_attempts as (
  select distinct on(e.request_id) e.created_at,e.request_id::text,e.account_id,e.id seq
  from public.s2a_ops_errors e where e.kind='upstream' and e.created_at<p_start and e.account_id is not null
  and e.request_id::text in(select request_id from requests union select request_id::text from upstream)
  order by e.request_id,e.created_at desc,e.id desc
 ), attempts as (
  select created_at,request_id::text,account_id,id seq from upstream where account_id is not null
  union all select created_at,request_id,account_id,coalesce(error_id,0) from requests where account_id is not null
  union all select * from previous_attempts
 ), switches as (
  select created_at from (select *,lag(account_id) over(partition by request_id order by created_at,seq) previous from attempts) a
  where previous is not null and previous<>account_id and created_at>=p_start
 ), counts as (
  select count(*) filter(where kind='success') successes,count(*) filter(where kind='error') errors,
  count(*) filter(where kind='error' and limited) limited,count(*) filter(where kind='error' and not limited) sla_errors,
  count(*) filter(where kind='upstream' and status_code not in(429,529)) upstream_errors,
  count(*) filter(where kind='upstream' and status_code=429) upstream_429,count(*) filter(where kind='upstream' and status_code=529) upstream_529,
  coalesce(sum(tokens),0) tokens from events
 ), minute_rates as (
  select date_bin(interval '1 minute',created_at,'1970-01-01'::timestamptz) minute_bucket,
  count(*) filter(where kind in('success','error'))/60.0 qps,coalesce(sum(tokens),0)/60.0 tps from events group by 1
 ), current_rates as (
  select count(*) filter(where kind in('success','error'))/least(60.0,extract(epoch from(p_end-p_start))) qps,
  coalesce(sum(tokens),0)/least(60.0,extract(epoch from(p_end-p_start))) tps from events where created_at>=p_end-interval '1 minute'
 ), latency as (
  select jsonb_build_object('p50_ms',round((percentile_cont(0.5) within group(order by duration_ms))::numeric),
   'p90_ms',round((percentile_cont(0.9) within group(order by duration_ms))::numeric),
   'p95_ms',round((percentile_cont(0.95) within group(order by duration_ms))::numeric),
   'p99_ms',round((percentile_cont(0.99) within group(order by duration_ms))::numeric),'avg_ms',round(avg(duration_ms)),'max_ms',max(duration_ms)) duration,
  jsonb_build_object('p50_ms',round((percentile_cont(0.5) within group(order by first_token_ms))::numeric),
   'p90_ms',round((percentile_cont(0.9) within group(order by first_token_ms))::numeric),
   'p95_ms',round((percentile_cont(0.95) within group(order by first_token_ms))::numeric),
   'p99_ms',round((percentile_cont(0.99) within group(order by first_token_ms))::numeric),'avg_ms',round(avg(first_token_ms)),'max_ms',max(first_token_ms)) ttft
  from requests where kind='success'
 ), output_rates as (
  select u.output_tokens*1000.0/u.duration_ms rate from usage u where u.output_tokens>0 and u.duration_ms>0 and u.billing_mode='token' and u.outcome='completed' and u.status between 200 and 299
  and exists(select 1 from requests r where r.request_id=u.request_id::text and r.kind='success')
 ), output_stats as (
  select jsonb_build_object('p5',percentile_cont(0.05) within group(order by rate),'p10',percentile_cont(0.1) within group(order by rate),
   'p50',percentile_cont(0.5) within group(order by rate),'avg',avg(rate),'sample_count',count(*)) value from output_rates
 ), overview as (
  select jsonb_build_object('start_time',p_start,'end_time',p_end,'platform',p_platform,'group_id',p_group,
   'success_count',c.successes,'error_count_total',c.errors,'business_limited_count',c.limited,'error_count_sla',c.sla_errors,
   'request_count_total',c.successes+c.errors,'request_count_sla',c.successes+c.sla_errors,'token_consumed',c.tokens,
   'unknown_token_attempts',(select count(*) from usage where input_tokens is null or output_tokens is null),
   'sla',coalesce(round(c.successes::numeric/nullif(c.successes+c.sla_errors,0),4),0),
   'error_rate',coalesce(round(c.sla_errors::numeric/nullif(c.successes+c.sla_errors,0),4),0),
   'upstream_error_rate',coalesce(round(c.upstream_errors::numeric/nullif(c.successes+c.sla_errors,0),4),0),
   'upstream_error_count_excl_429_529',c.upstream_errors,'upstream_429_count',c.upstream_429,'upstream_529_count',c.upstream_529,
   'qps',jsonb_build_object('current',round(cr.qps,1),'peak',coalesce((select round(max(qps),1) from minute_rates),0),'avg',round((c.successes+c.errors)/extract(epoch from(p_end-p_start)),1)),
   'tps',jsonb_build_object('current',round(cr.tps,1),'peak',coalesce((select round(max(tps),1) from minute_rates),0),'avg',round(c.tokens/extract(epoch from(p_end-p_start)),1)),
   'duration',l.duration,'ttft',l.ttft,'output_tps',o.value) value from counts c cross join current_rates cr cross join latency l cross join output_stats o
 ), buckets as (
  select b bucket_start,extract(epoch from least(p_end,b+make_interval(secs=>p_bucket))-greatest(p_start,b)) seconds
  from generate_series(date_bin(make_interval(secs=>p_bucket),p_start,'1970-01-01'::timestamptz),date_bin(make_interval(secs=>p_bucket),p_end-interval '1 microsecond','1970-01-01'::timestamptz),make_interval(secs=>p_bucket)) b
 ), bucket_counts as (
  select date_bin(make_interval(secs=>p_bucket),created_at,'1970-01-01'::timestamptz) bucket_start,
  count(*) filter(where kind in('success','error')) requests,coalesce(sum(tokens),0) tokens,
  count(*) filter(where kind='error') errors,count(*) filter(where kind='error' and limited) limited,
  count(*) filter(where kind='error' and not limited) sla_errors,count(*) filter(where kind='upstream' and status_code not in(429,529)) upstream_errors,
  count(*) filter(where kind='upstream' and status_code=429) upstream_429,count(*) filter(where kind='upstream' and status_code=529) upstream_529
  from events group by 1
 ), switch_buckets as (
  select date_bin(make_interval(secs=>p_bucket),created_at,'1970-01-01'::timestamptz) bucket_start,count(*) count from switches group by 1
 ), platform_counts as (
  select platform,count(*) filter(where kind in('success','error')) request_count,sum(tokens) token_consumed from events where kind<>'upstream' group by platform
 ), group_counts as (
  select group_id,max(group_name) group_name,count(*) filter(where kind in('success','error')) request_count,sum(tokens) token_consumed
  from events where kind<>'upstream' and group_id is not null group by group_id order by request_count desc,group_id limit 10
 ), throughput as (
  select jsonb_build_object('bucket',case p_bucket when 60 then '1m' when 300 then '5m' else '1h' end,
  'points',(select coalesce(jsonb_agg(jsonb_build_object('bucket_start',b.bucket_start,'request_count',coalesce(c.requests,0),'token_consumed',coalesce(c.tokens,0),'switch_count',coalesce(s.count,0),'qps',round(coalesce(c.requests,0)/b.seconds,1),'tps',round(coalesce(c.tokens,0)/b.seconds,1)) order by b.bucket_start),'[]') from buckets b left join bucket_counts c using(bucket_start) left join switch_buckets s using(bucket_start)),
  'by_platform',(select coalesce(jsonb_agg(to_jsonb(p) order by request_count desc,platform),'[]') from platform_counts p),
  'top_groups',(select coalesce(jsonb_agg(to_jsonb(g) order by request_count desc,group_id),'[]') from group_counts g)) value
 ), error_trend as (
  select jsonb_build_object('bucket',case p_bucket when 60 then '1m' when 300 then '5m' else '1h' end,
  'points',(select coalesce(jsonb_agg(jsonb_build_object('bucket_start',b.bucket_start,'error_count_total',coalesce(c.errors,0),'business_limited_count',coalesce(c.limited,0),'error_count_sla',coalesce(c.sla_errors,0),'upstream_error_count_excl_429_529',coalesce(c.upstream_errors,0),'upstream_429_count',coalesce(c.upstream_429,0),'upstream_529_count',coalesce(c.upstream_529,0)) order by b.bucket_start),'[]') from buckets b left join bucket_counts c using(bucket_start))) value
 ), distribution as (
  select status_code,count(*) total,count(*) filter(where not limited) sla,count(*) filter(where limited) business_limited from requests where kind='error' group by status_code
 ), histogram as (
  select case when duration_ms<100 then 1 when duration_ms<200 then 2 when duration_ms<500 then 3 when duration_ms<1000 then 4 when duration_ms<2000 then 5 else 6 end ord,count(*) count from requests where kind='success' and duration_ms is not null group by 1
 )
 select case p_part
  when 'snapshot-v2' then jsonb_build_object('generated_at',statement_timestamp(),'overview',(select value from overview),'throughput_trend',(select value from throughput),'error_trend',(select value from error_trend))
  when 'overview' then (select value from overview)
  when 'throughput-trend' then (select value from throughput)
  when 'error-trend' then (select value from error_trend)
  when 'error-distribution' then jsonb_build_object('total',coalesce((select sum(total) from distribution),0),'items',(select coalesce(jsonb_agg(to_jsonb(d) order by total desc,status_code),'[]') from distribution d))
  when 'latency-histogram' then jsonb_build_object('start_time',p_start,'end_time',p_end,'platform',p_platform,'group_id',p_group,'total_requests',coalesce((select sum(count) from histogram),0),
   'buckets',(select jsonb_agg(jsonb_build_object('range',b.label,'count',coalesce(h.count,0)) order by b.ord) from (values(1,'0-100ms'),(2,'100-200ms'),(3,'200-500ms'),(4,'500-1000ms'),(5,'1000-2000ms'),(6,'2000ms+')) b(ord,label) left join histogram h using(ord)))
 end
 );
end $$;
revoke all on function public.s2a_ops_dashboard(timestamptz,timestamptz,text,uuid,integer,text) from public,anon,authenticated;
grant execute on function public.s2a_ops_dashboard(timestamptz,timestamptz,text,uuid,integer,text) to service_role;

create or replace view public.s2a_ops_requests as
 select 'success'::text kind,u.created_at,u.request_id::text request_id,
 coalesce(nullif(g.platform,''),a.platform,'') platform,u.model,u.duration_ms,u.first_token_ms,
 u.status status_code,null::bigint error_id,null::text phase,null::text severity,null::text message,
 u.user_id,u.key_id api_key_id,u.account_id,u.group_id,u.stream,a.name account_name
 from public.s2a_usage u
 left join public.s2a_groups g on g.id=u.group_id
 left join public.s2a_accounts a on a.id=u.account_id
 where u.model<>'__models__' and u.outcome='completed' and u.status between 200 and 299
 and not exists(select 1 from public.s2a_ops_errors e where e.request_id=u.request_id and e.kind='request')
 union all
 select 'error',e.created_at,e.request_id::text,e.platform,e.model,e.response_latency_ms,
 (select u.first_token_ms from public.s2a_usage u where u.request_id=e.request_id and u.account_id=e.account_id and u.first_token_ms is not null order by u.created_at desc,u.id desc limit 1),
 e.status_code,e.id,e.phase,e.severity,e.message,e.user_id,e.api_key_id,e.account_id,e.group_id,e.stream,e.account_name
 from public.s2a_ops_errors e where e.kind='request';
