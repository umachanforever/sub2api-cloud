create function public.s2a_ops_capacity(p_part text,p_platform text default '',p_group uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if p_part is null or p_part not in('concurrency','account-availability','user-concurrency') or p_platform is null or p_platform not in('','openai','anthropic','gemini')
 or p_part='user-concurrency' and (p_platform<>'' or p_group is not null) then raise exception 'invalid_capacity_filter';end if;
 if p_part='user-concurrency' then
  return (with loads as (
   select k.user_id,count(*) current_in_use from public.s2a_leases l join public.s2a_keys k on k.id=l.key_id where l.expires_at>now() group by k.user_id
  ), users as (
   select u.id,jsonb_build_object('user_id',u.id,'user_email',coalesce(u.email,''),
    'username',case when jsonb_typeof(u.raw_user_meta_data->'username')='string' then u.raw_user_meta_data->>'username' else split_part(coalesce(u.email,''),'@',1) end,
    'current_in_use',l.current_in_use,'max_capacity',coalesce(c.concurrency,3),'waiting_in_queue',0,
    'load_percentage',case when coalesce(c.concurrency,3)>0 then round(l.current_in_use*100.0/coalesce(c.concurrency,3),2) else 0 end) value
   from loads l join auth.users u on u.id=l.user_id left join public.s2a_user_limits c on c.user_id=u.id
   where u.deleted_at is null and (u.banned_until is null or u.banned_until<=now())
  ) select jsonb_build_object('enabled',true,'timestamp',statement_timestamp(),'user',coalesce((select jsonb_object_agg(id,value) from users),'{}')));
 end if;
 return (
 with loads as materialized (
  select account_id,count(*) used from public.s2a_leases where expires_at>now() group by account_id
 ), bindings as materialized (
  select ag.account_id,ag.group_id,ag.created_at,g.name group_name,g.platform,g.enabled,g.require_privacy_set
  from public.s2a_account_groups ag join public.s2a_groups g on g.id=ag.group_id where p_group is null or ag.group_id=p_group
 ), accounts as materialized (
  select a.id,a.name,a.platform,a.type,a.extra,a.status,a.schedulable,a.concurrency,a.cooldown_until,a.cooldown_status,
  (not a.auto_pause_on_expired or a.expires_at is null or a.expires_at>now()) not_expired,
  coalesce(l.used,0) used,public.s2a_openai_quota_paused(a.extra,a.platform,a.type) quota_paused,
  coalesce(a.cooldown_until>now(),false) cooling
  from public.s2a_accounts a left join loads l on l.account_id=a.id where (p_platform='' or a.platform=p_platform)
  and (p_group is null or exists(select 1 from bindings b where b.account_id=a.id))
 ), states as materialized (
  select a.*,a.status='active' and a.schedulable and a.not_expired and not a.quota_paused and not a.cooling and a.used<a.concurrency healthy,
  a.status<>'error' and (a.quota_paused or a.cooling and a.cooldown_status=429) rate_limited,
  a.status<>'error' and not a.quota_paused and a.cooling and a.cooldown_status>=500 overloaded
  from accounts a
 ), grouped as materialized (
  select s.id,b.group_id,b.group_name,b.platform,b.created_at,s.used,s.concurrency,s.rate_limited,s.status='error' has_error,
  coalesce(s.healthy and b.enabled and (not b.require_privacy_set or case s.platform when 'openai' then s.extra->>'privacy_mode'='training_off' when 'antigravity' then s.extra->>'privacy_mode'='privacy_set' else true end),false) available
  from states s join bindings b on b.account_id=s.id
 ), display as materialized (
  select s.*,d.group_id,d.group_name,coalesce((select bool_or(g.available) from grouped g where g.id=s.id),false) available
  from states s left join lateral(select g.group_id,g.group_name from grouped g where g.id=s.id order by g.created_at,g.group_id limit 1) d on true
 ), platforms as (
  select platform,sum(used) current_in_use,sum(concurrency) max_capacity,count(*) total_accounts,
  count(*) filter(where available) available_count,count(*) filter(where rate_limited) rate_limit_count,count(*) filter(where status='error') error_count
  from display group by platform
 ), groups as (
  select group_id,max(group_name) group_name,platform,sum(used) current_in_use,sum(concurrency) max_capacity,count(*) total_accounts,
  count(*) filter(where available) available_count,count(*) filter(where rate_limited) rate_limit_count,count(*) filter(where has_error) error_count
  from grouped group by group_id,platform
 ), account_values as (
  select id,case when p_part='concurrency' then
   jsonb_build_object('account_id',id,'account_name',name,'platform',platform,'group_id',group_id,'group_name',coalesce(group_name,''),
    'current_in_use',used,'max_capacity',concurrency,'waiting_in_queue',0,'load_percentage',round(used*100.0/concurrency,2))
  else jsonb_strip_nulls(jsonb_build_object('account_id',id,'account_name',name,'platform',platform,'group_id',group_id,'group_name',coalesce(group_name,''),
    'status',status,'is_available',available,'is_rate_limited',coalesce(rate_limited,false),'is_overloaded',coalesce(overloaded,false),'has_error',status='error',
    'error_message',case when status='error' then 'account_error' end,
    'rate_limit_reset_at',case when rate_limited and not quota_paused then cooldown_until end,
    'rate_limit_remaining_sec',case when rate_limited and not quota_paused then ceil(extract(epoch from(cooldown_until-now())))::integer end,
    'overload_until',case when overloaded then cooldown_until end,'overload_remaining_sec',case when overloaded then ceil(extract(epoch from(cooldown_until-now())))::integer end,
    'temp_unschedulable_until',case when cooling and status<>'error' and not coalesce(rate_limited,false) and not coalesce(overloaded,false) then cooldown_until end)) end value
  from display
 ), platform_values as (
  select platform,case when p_part='concurrency' then jsonb_build_object('platform',platform,'current_in_use',current_in_use,'max_capacity',max_capacity,'waiting_in_queue',0,'load_percentage',round(current_in_use*100.0/max_capacity,2))
   else jsonb_build_object('platform',platform,'total_accounts',total_accounts,'available_count',available_count,'rate_limit_count',rate_limit_count,'error_count',error_count) end value from platforms
 ), group_values as (
  select group_id,case when p_part='concurrency' then jsonb_build_object('group_id',group_id,'group_name',group_name,'platform',platform,'current_in_use',current_in_use,'max_capacity',max_capacity,'waiting_in_queue',0,'load_percentage',round(current_in_use*100.0/max_capacity,2))
   else jsonb_build_object('group_id',group_id,'group_name',group_name,'platform',platform,'total_accounts',total_accounts,'available_count',available_count,'rate_limit_count',rate_limit_count,'error_count',error_count) end value from groups
 )
 select jsonb_build_object('enabled',true,'timestamp',statement_timestamp(),
  'account',coalesce((select jsonb_object_agg(id,value) from account_values),'{}'),
  'platform',coalesce((select jsonb_object_agg(platform,value) from platform_values),'{}'),
  'group',coalesce((select jsonb_object_agg(group_id,value) from group_values),'{}'))
 );
end $$;
revoke all on function public.s2a_ops_capacity(text,text,uuid) from public,anon,authenticated;
grant execute on function public.s2a_ops_capacity(text,text,uuid) to service_role;
