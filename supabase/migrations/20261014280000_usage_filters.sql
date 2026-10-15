alter table public.s2a_usage
 add column billing_type smallint not null default 0 check(billing_type in (0,1)),
 add column request_type text not null default 'unknown' check(request_type in ('unknown','sync','stream','ws_v2','cyber','live')),
 add column native_compaction_v2 boolean not null default false;
-- Funding source and pricing unit are separate parts of the upstream usage contract.
update public.s2a_usage set billing_type=case when subscription_id is not null or billing_mode='subscription' then 1 else 0 end,
 billing_mode=case when billing_mode='subscription' then 'token' else billing_mode end,
 request_type=case when stream is true then 'stream' when stream is false then 'sync' else 'unknown' end;
create function public.s2a_usage_metadata() returns trigger language plpgsql set search_path='' as $$
begin
 if new.subscription_id is not null then new.billing_type:=1; end if;
 if new.billing_mode='subscription' then new.billing_mode:='token'; end if;
 if new.request_type='unknown' then
  new.request_type:=case when new.stream is true then 'stream' when new.stream is false then 'sync' else 'unknown' end;
 end if;
 return new;
end $$;
revoke all on function public.s2a_usage_metadata() from public,anon,authenticated,service_role;
create trigger s2a_usage_metadata before insert or update on public.s2a_usage for each row execute function public.s2a_usage_metadata();

drop function public.s2a_dashboard(uuid,timestamptz,timestamptz,text,uuid,text,text,boolean);
create function public.s2a_dashboard(
  p_user_id uuid, p_start timestamptz, p_end timestamptz,
  p_timezone text default 'Asia/Shanghai', p_key_id uuid default null,
  p_model text default null, p_granularity text default 'day',
  p_include_series boolean default true, p_filters jsonb default '{}'
) returns jsonb language sql stable set search_path = '' as $$
  with filtered as (
    select * from public.s2a_usage u where u.created_at >= p_start and u.created_at < p_end
      and (p_user_id is null or u.user_id = p_user_id) and u.model <> '__models__'
      and (p_key_id is null or u.key_id = p_key_id) and (p_model is null or u.model = p_model)
      and (p_filters->>'group_id' is null or u.group_id=(p_filters->>'group_id')::uuid)
      and (p_filters->>'account_id' is null or u.account_id=(p_filters->>'account_id')::uuid)
      and (p_filters->>'subscription_id' is null or u.subscription_id=(p_filters->>'subscription_id')::uuid)
      and (p_filters->>'request_type' is null or u.request_type=p_filters->>'request_type')
      and (p_filters->>'stream' is null or u.stream=(p_filters->>'stream')::boolean)
      and (p_filters->>'native_compaction_v2' is null or u.native_compaction_v2=(p_filters->>'native_compaction_v2')::boolean)
      and (p_filters->>'billing_type' is null or u.billing_type=(p_filters->>'billing_type')::smallint)
      and (p_filters->>'billing_mode' is null or u.billing_mode=p_filters->>'billing_mode')
      and (p_filters->>'outcome' is null or u.outcome=p_filters->>'outcome')
  ), latest as (
    select distinct on (request_id) * from filtered order by request_id, created_at desc, id desc
  ), summary as (
    select jsonb_build_object(
      'requests', (select count(*) from latest), 'attempts', count(*),
      'completed', (select count(*) from latest where outcome = 'completed'),
      'input_tokens', coalesce(sum(input_tokens),0), 'output_tokens', coalesce(sum(output_tokens),0),
      'cache_creation_tokens', coalesce(sum(cache_creation_tokens),0),
      'cache_read_tokens', coalesce(sum(cache_read_tokens),0),
      'total_cost',coalesce(sum(total_cost),0), 'actual_cost',coalesce(sum(actual_cost),0),
      'unknown_cost_attempts',count(*) filter(where total_cost is null),
      'unknown_attempts', count(*) filter (where input_tokens is null or output_tokens is null),
      'avg_duration_ms', coalesce(round(avg(duration_ms)),0)
    ) value from filtered
  ), days as (
    select generate_series(date_trunc(p_granularity, case when p_include_series then p_start at time zone p_timezone end),
      date_trunc(p_granularity, (p_end - interval '1 microsecond') at time zone p_timezone),
      case when p_granularity = 'hour' then interval '1 hour' else interval '1 day' end) as bucket
  ), daily as (
    select to_char(d.bucket, case when p_granularity = 'hour' then 'YYYY-MM-DD HH24:MI' else 'YYYY-MM-DD' end) as day,
      count(distinct u.request_id) requests, coalesce(sum(u.input_tokens),0) input_tokens,
      coalesce(sum(u.output_tokens),0) output_tokens,
      coalesce(sum(u.cache_creation_tokens),0) cache_creation_tokens,
      coalesce(sum(u.cache_read_tokens),0) cache_read_tokens,
      coalesce(sum(u.total_cost),0) total_cost,coalesce(sum(u.actual_cost),0) actual_cost,
      count(u.id) filter(where u.total_cost is null) unknown_cost_attempts
      from days d left join filtered u on date_trunc(p_granularity, u.created_at at time zone p_timezone) = d.bucket
      group by d.bucket order by d.bucket
  ), models as (
    select model, count(distinct request_id) requests, count(*) attempts,
      coalesce(sum(input_tokens),0) input_tokens, coalesce(sum(output_tokens),0) output_tokens,
      coalesce(sum(cache_creation_tokens),0) cache_creation_tokens,
      coalesce(sum(cache_read_tokens),0) cache_read_tokens,
      coalesce(sum(total_cost),0) total_cost,coalesce(sum(actual_cost),0) actual_cost,
      count(*) filter(where total_cost is null) unknown_cost_attempts
      from filtered group by model
      order by sum(coalesce(input_tokens,0)+coalesce(output_tokens,0)) desc, model limit 20
  ) select jsonb_build_object('summary', (select value from summary),
    'daily', coalesce((select jsonb_agg(to_jsonb(daily)) from daily),'[]'::jsonb),
    'models', coalesce((select jsonb_agg(to_jsonb(models)) from models),'[]'::jsonb));
$$;


-- Keep a single defaulted overload for PostgREST named-argument resolution.
revoke all on function public.s2a_dashboard(uuid,timestamptz,timestamptz,text,uuid,text,text,boolean,jsonb) from public,anon,authenticated;
grant execute on function public.s2a_dashboard(uuid,timestamptz,timestamptz,text,uuid,text,text,boolean,jsonb) to service_role;
