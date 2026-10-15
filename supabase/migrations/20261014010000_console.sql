create index s2a_usage_created on public.s2a_usage(created_at desc, id desc);

create function public.s2a_dashboard(p_user_id uuid, p_start timestamptz, p_end timestamptz, p_timezone text default 'Asia/Shanghai', p_key_id uuid default null, p_model text default null, p_granularity text default 'day', p_include_series boolean default true)
returns jsonb language sql stable set search_path = '' as $$
  with filtered as (
    select * from public.s2a_usage u where u.created_at >= p_start and u.created_at < p_end
      and (p_user_id is null or u.user_id = p_user_id) and u.model <> '__models__'
      and (p_key_id is null or u.key_id = p_key_id) and (p_model is null or u.model = p_model)
  ), latest as (
    select distinct on (request_id) * from filtered order by request_id, created_at desc, id desc
  ), summary as (
    select jsonb_build_object(
      'requests', (select count(*) from latest),
      'attempts', count(*),
      'completed', (select count(*) from latest where outcome = 'completed'),
      'input_tokens', coalesce(sum(input_tokens),0),
      'output_tokens', coalesce(sum(output_tokens),0),
      'unknown_attempts', count(*) filter (where input_tokens is null or output_tokens is null),
      'avg_duration_ms', coalesce(round(avg(duration_ms)),0)
    ) value from filtered
  ), days as (
    select generate_series(date_trunc(p_granularity, case when p_include_series then p_start at time zone p_timezone end),
      date_trunc(p_granularity, (p_end - interval '1 microsecond') at time zone p_timezone),
      case when p_granularity = 'hour' then interval '1 hour' else interval '1 day' end) as bucket
  ), daily as (
    select to_char(d.bucket, case when p_granularity = 'hour' then 'YYYY-MM-DD HH24:MI' else 'YYYY-MM-DD' end) as day,
      count(distinct u.request_id) requests,
      coalesce(sum(u.input_tokens),0) input_tokens, coalesce(sum(u.output_tokens),0) output_tokens
      from days d left join filtered u on date_trunc(p_granularity, u.created_at at time zone p_timezone) = d.bucket
      group by d.bucket order by d.bucket
  ), models as (
    select model, count(distinct request_id) requests, count(*) attempts,
      coalesce(sum(input_tokens),0) input_tokens, coalesce(sum(output_tokens),0) output_tokens
      from filtered group by model order by sum(coalesce(input_tokens,0)+coalesce(output_tokens,0)) desc, model limit 20
  ) select jsonb_build_object('summary', (select value from summary),
    'daily', coalesce((select jsonb_agg(to_jsonb(daily)) from daily),'[]'::jsonb),
    'models', coalesce((select jsonb_agg(to_jsonb(models)) from models),'[]'::jsonb));
$$;

create function public.s2a_group_create(p_name text, p_user_id uuid)
returns jsonb language plpgsql set search_path = '' as $$
declare g public.s2a_groups;
begin
  insert into public.s2a_groups(name) values(p_name) returning * into g;
  insert into public.s2a_memberships(user_id,group_id) values(p_user_id,g.id);
  return to_jsonb(g);
end $$;

create function public.s2a_membership_set(p_user_id uuid, p_group_id uuid)
returns void language sql set search_path = '' as $$
  insert into public.s2a_memberships(user_id,group_id) values(p_user_id,p_group_id) on conflict do nothing;
$$;

create function public.s2a_credentials_replace(p_account_id uuid, p_fingerprint text, p_ciphertext text, p_iv text)
returns jsonb language plpgsql set search_path = '' as $$
declare a public.s2a_accounts;
begin
  select * into a from public.s2a_accounts where id = p_account_id for update;
  if not found then return jsonb_build_object('error','account_not_found','status',404); end if;
  if a.account_fingerprint <> p_fingerprint then return jsonb_build_object('error','account_identity_mismatch','status',400); end if;
  if a.status <> 'disabled' or a.refresh_lock_until > now()
    or exists(select 1 from public.s2a_leases where account_id = a.id and expires_at > now()) then
    return jsonb_build_object('error','account_busy_disable_first','status',409);
  end if;
  update public.s2a_accounts set ciphertext = p_ciphertext, iv = p_iv, credential_version = credential_version + 1,
    refresh_lock_id = null, refresh_lock_until = null, cooldown_until = null where id = a.id;
  return jsonb_build_object('ok',true);
end $$;

revoke all on function public.s2a_dashboard(uuid,timestamptz,timestamptz,text,uuid,text,text,boolean) from public, anon, authenticated;
revoke all on function public.s2a_group_create(text,uuid) from public, anon, authenticated;
revoke all on function public.s2a_membership_set(uuid,uuid) from public, anon, authenticated;
revoke all on function public.s2a_credentials_replace(uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.s2a_dashboard(uuid,timestamptz,timestamptz,text,uuid,text,text,boolean) to service_role;
grant execute on function public.s2a_group_create(text,uuid) to service_role;
grant execute on function public.s2a_membership_set(uuid,uuid) to service_role;
grant execute on function public.s2a_credentials_replace(uuid,text,text,text) to service_role;
