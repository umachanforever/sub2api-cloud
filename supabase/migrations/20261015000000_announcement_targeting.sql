create function public.s2a_announcement_targeting_valid(p_rules jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare g jsonb; c jsonb; gid jsonb;
begin
 if p_rules is null or jsonb_typeof(p_rules)<>'object' or p_rules-'any_of'<>'{}'::jsonb then return false;end if;
 if not p_rules ? 'any_of' then return true;end if;
 if jsonb_typeof(p_rules->'any_of')<>'array' or jsonb_array_length(p_rules->'any_of')>50 then return false;end if;
 for g in select value from jsonb_array_elements(p_rules->'any_of') loop
  if jsonb_typeof(g)<>'object' or g-'all_of'<>'{}'::jsonb or jsonb_typeof(g->'all_of') is distinct from 'array' then return false;end if;
  if jsonb_array_length(g->'all_of') not between 1 and 50 then return false;end if;
  for c in select value from jsonb_array_elements(g->'all_of') loop
   if jsonb_typeof(c)<>'object' then return false;end if;
   if c->>'type'='balance' then
    if c-'type'-'operator'-'value'<>'{}'::jsonb or coalesce(c->>'operator','') not in ('gt','gte','lt','lte','eq') or jsonb_typeof(c->'value') is distinct from 'number' then return false;end if;
    if abs((c->>'value')::numeric)>1000000000 or (c->>'value')::numeric<>round((c->>'value')::numeric,8) then return false;end if;
   elsif c->>'type'='subscription' then
    if c-'type'-'operator'-'group_ids'<>'{}'::jsonb or c->>'operator' is distinct from 'in' or jsonb_typeof(c->'group_ids') is distinct from 'array' then return false;end if;
    if jsonb_array_length(c->'group_ids') not between 1 and 100 then return false;end if;
    for gid in select value from jsonb_array_elements(c->'group_ids') loop
     if jsonb_typeof(gid)<>'string' or (gid#>>'{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false;end if;
    end loop;
   else return false;end if;
  end loop;
 end loop;
 return true;
end $$;
revoke all on function public.s2a_announcement_targeting_valid(jsonb) from public,anon,authenticated;
grant execute on function public.s2a_announcement_targeting_valid(jsonb) to service_role;
alter table public.s2a_announcements drop constraint s2a_announcements_targeting_check;
alter table public.s2a_announcements add constraint s2a_announcements_targeting_check check(public.s2a_announcement_targeting_valid(targeting));

create function public.s2a_announcement_matches(p_rules jsonb,p_user_id uuid) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare g jsonb; c jsonb; matched boolean; amount numeric:=0; v numeric; op text;
begin
 if not public.s2a_announcement_targeting_valid(p_rules) then return false;end if;
 if coalesce(p_rules->'any_of','[]')='[]'::jsonb then return true;end if;
 select coalesce((select balance from public.s2a_wallets where user_id=p_user_id),0) into amount;
 for g in select value from jsonb_array_elements(p_rules->'any_of') loop
  matched:=true;
  for c in select value from jsonb_array_elements(g->'all_of') loop
   if c->>'type'='balance' then
    v:=(c->>'value')::numeric;op:=c->>'operator';
    matched:=case op when 'gt' then amount>v when 'gte' then amount>=v when 'lt' then amount<v when 'lte' then amount<=v when 'eq' then amount=v else false end;
   else
    select exists(select 1 from public.s2a_subscriptions s where s.user_id=p_user_id and s.status='active' and s.starts_at<=now() and s.expires_at>now()
     and s.group_id in(select (value#>>'{}')::uuid from jsonb_array_elements(c->'group_ids'))) into matched;
   end if;
   exit when not matched;
  end loop;
  if matched then return true;end if;
 end loop;
 return false;
end $$;
revoke all on function public.s2a_announcement_matches(jsonb,uuid) from public,anon,authenticated;
grant execute on function public.s2a_announcement_matches(jsonb,uuid) to service_role;

create or replace function public.s2a_announcements_for_user(p_user_id uuid, p_unread_only boolean default false)
returns jsonb language sql stable set search_path = '' as $$
  with active as (
    select * from public.s2a_announcements a
    where a.status = 'active' and (a.starts_at is null or a.starts_at <= now())
      and (a.ends_at is null or a.ends_at > now())
      and public.s2a_announcement_matches(a.targeting,p_user_id)
    order by a.id desc limit 200
  ), visible as (
    select a.id, a.title, a.content, a.notify_mode, a.starts_at, a.ends_at,
      r.read_at, a.created_at, a.updated_at
    from active a left join public.s2a_announcement_reads r on r.announcement_id = a.id and r.user_id = p_user_id
    where not p_unread_only or r.read_at is null
  ) select coalesce(jsonb_agg(jsonb_strip_nulls(to_jsonb(v)) order by v.read_at is null desc, v.id desc), '[]'::jsonb)
    from visible v;
$$;
create or replace function public.s2a_announcement_mark_read(p_user_id uuid, p_announcement_id bigint)
returns boolean language plpgsql set search_path = '' as $$
begin
  -- Lock the visible row so archive/delete cannot race the receipt insertion.
  perform id from public.s2a_announcements a where a.id = p_announcement_id and a.status = 'active'
    and (a.starts_at is null or a.starts_at <= now()) and (a.ends_at is null or a.ends_at > now())
    and public.s2a_announcement_matches(a.targeting,p_user_id) for share;
  if not found then return false; end if;
  insert into public.s2a_announcement_reads(announcement_id,user_id) values(p_announcement_id,p_user_id)
    on conflict (announcement_id,user_id) do nothing;
  return true;
end $$;

create or replace function public.s2a_announcement_read_status(p_announcement_id bigint, p_page integer, p_size integer,
  p_search text default '', p_sort text default 'email', p_order text default 'asc')
returns jsonb language sql stable security definer set search_path = '' as $$
  with users as (
    select u.id user_id, coalesce(u.email,'') email, coalesce(u.raw_user_meta_data->>'username','') username,
      coalesce((select balance from public.s2a_wallets where user_id=u.id),0) balance,
      public.s2a_announcement_matches((select targeting from public.s2a_announcements where id=p_announcement_id),u.id) eligible, r.read_at, u.created_at
    from auth.users u left join public.s2a_announcement_reads r on r.user_id = u.id and r.announcement_id = p_announcement_id
    where position(lower(p_search) in lower(coalesce(u.email,'') || ' ' || coalesce(u.raw_user_meta_data->>'username',''))) > 0
  ), page as (
    select * from users order by
      case when p_order <> 'desc' then case p_sort when 'username' then username when 'id' then user_id::text else email end end asc,
      case when p_order = 'desc' then case p_sort when 'username' then username when 'id' then user_id::text else email end end desc,
      user_id asc limit p_size offset (p_page - 1) * p_size
  ) select jsonb_build_object('items', coalesce((select jsonb_agg((to_jsonb(p) - 'created_at' - 'read_at') ||
      case when p.read_at is null then '{}'::jsonb else jsonb_build_object('read_at',p.read_at) end) from page p),'[]'::jsonb),
    'total',(select count(*) from users),'page',p_page,'page_size',p_size,
    'pages',ceil((select count(*) from users)::numeric / p_size));
$$;
