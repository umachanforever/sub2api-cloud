alter table public.s2a_usage
  add column if not exists cache_creation_tokens bigint check (cache_creation_tokens >= 0),
  add column if not exists cache_read_tokens bigint check (cache_read_tokens >= 0);

drop function if exists public.s2a_finish(uuid, integer, text, bigint, bigint, integer);
create function public.s2a_finish(
  p_lease_id uuid, p_status integer, p_outcome text,
  p_input_tokens bigint default null, p_output_tokens bigint default null,
  p_cache_creation_tokens bigint default null, p_cache_read_tokens bigint default null,
  p_cooldown_seconds integer default 0
) returns void language plpgsql set search_path = '' as $$
declare l public.s2a_leases;
begin
  select * into l from public.s2a_leases where id = p_lease_id for update;
  if not found then return; end if;
  insert into public.s2a_usage(
    id, request_id, account_id, key_id, user_id, model, status, outcome,
    input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, duration_ms
  )
    select l.id, l.request_id, l.account_id, l.key_id, k.user_id, l.model,
      p_status, p_outcome, p_input_tokens, p_output_tokens,
      p_cache_creation_tokens, p_cache_read_tokens,
      greatest(0, floor(extract(epoch from (clock_timestamp() - l.started_at)) * 1000)::integer)
    from public.s2a_keys k where k.id = l.key_id;
  if p_cooldown_seconds > 0 then
    update public.s2a_accounts
      set cooldown_until = greatest(coalesce(cooldown_until, now()), now() + make_interval(secs => least(p_cooldown_seconds, 3600)))
      where id = l.account_id;
  end if;
  delete from public.s2a_leases where id = l.id;
end $$;

create or replace function public.s2a_dashboard(
  p_user_id uuid, p_start timestamptz, p_end timestamptz,
  p_timezone text default 'Asia/Shanghai', p_key_id uuid default null,
  p_model text default null, p_granularity text default 'day',
  p_include_series boolean default true
) returns jsonb language sql stable set search_path = '' as $$
  with filtered as (
    select * from public.s2a_usage u where u.created_at >= p_start and u.created_at < p_end
      and (p_user_id is null or u.user_id = p_user_id) and u.model <> '__models__'
      and (p_key_id is null or u.key_id = p_key_id) and (p_model is null or u.model = p_model)
  ), latest as (
    select distinct on (request_id) * from filtered order by request_id, created_at desc, id desc
  ), summary as (
    select jsonb_build_object(
      'requests', (select count(*) from latest), 'attempts', count(*),
      'completed', (select count(*) from latest where outcome = 'completed'),
      'input_tokens', coalesce(sum(input_tokens),0), 'output_tokens', coalesce(sum(output_tokens),0),
      'cache_creation_tokens', coalesce(sum(cache_creation_tokens),0),
      'cache_read_tokens', coalesce(sum(cache_read_tokens),0),
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
      coalesce(sum(u.cache_read_tokens),0) cache_read_tokens
      from days d left join filtered u on date_trunc(p_granularity, u.created_at at time zone p_timezone) = d.bucket
      group by d.bucket order by d.bucket
  ), models as (
    select model, count(distinct request_id) requests, count(*) attempts,
      coalesce(sum(input_tokens),0) input_tokens, coalesce(sum(output_tokens),0) output_tokens,
      coalesce(sum(cache_creation_tokens),0) cache_creation_tokens,
      coalesce(sum(cache_read_tokens),0) cache_read_tokens
      from filtered group by model
      order by sum(coalesce(input_tokens,0)+coalesce(output_tokens,0)) desc, model limit 20
  ) select jsonb_build_object('summary', (select value from summary),
    'daily', coalesce((select jsonb_agg(to_jsonb(daily)) from daily),'[]'::jsonb),
    'models', coalesce((select jsonb_agg(to_jsonb(models)) from models),'[]'::jsonb));
$$;

revoke all on function public.s2a_finish(uuid, integer, text, bigint, bigint, bigint, bigint, integer) from public, anon, authenticated;
grant execute on function public.s2a_finish(uuid, integer, text, bigint, bigint, bigint, bigint, integer) to service_role;
