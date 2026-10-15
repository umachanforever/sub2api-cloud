create table public.s2a_announcements (
  id bigint generated always as identity primary key,
  title text not null check (octet_length(btrim(title)) between 1 and 200),
  content text not null check (length(btrim(content)) > 0),
  status text not null default 'draft' check (status in ('draft','active','archived')),
  notify_mode text not null default 'silent' check (notify_mode in ('silent','popup')),
  -- shortcut: targeting needs the billing/subscription domain; reject nonempty rules until that domain is ported.
  targeting jsonb not null default '{}' check (
    jsonb_typeof(targeting) = 'object' and (targeting - 'any_of') = '{}'::jsonb and
    (not targeting ? 'any_of' or targeting->'any_of' = '[]'::jsonb)
  ),
  starts_at timestamptz,
  ends_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (starts_at is null or ends_at is null or starts_at < ends_at)
);
create table public.s2a_announcement_reads (
  announcement_id bigint not null references public.s2a_announcements(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (announcement_id, user_id)
);
create index s2a_announcement_reads_user on public.s2a_announcement_reads(user_id, announcement_id);
alter table public.s2a_announcements enable row level security;
alter table public.s2a_announcement_reads enable row level security;
revoke all on public.s2a_announcements, public.s2a_announcement_reads from public, anon, authenticated;
revoke all on sequence public.s2a_announcements_id_seq from public, anon, authenticated;
grant all on public.s2a_announcements, public.s2a_announcement_reads to service_role;
grant usage, select on sequence public.s2a_announcements_id_seq to service_role;

create function public.s2a_announcements_for_user(p_user_id uuid, p_unread_only boolean default false)
returns jsonb language sql stable set search_path = '' as $$
  with active as (
    select * from public.s2a_announcements a
    where a.status = 'active' and (a.starts_at is null or a.starts_at <= now())
      and (a.ends_at is null or a.ends_at > now())
      and (not a.targeting ? 'any_of' or a.targeting->'any_of' = '[]'::jsonb)
    order by a.id desc limit 200
  ), visible as (
    select a.id, a.title, a.content, a.notify_mode, a.starts_at, a.ends_at,
      r.read_at, a.created_at, a.updated_at
    from active a left join public.s2a_announcement_reads r on r.announcement_id = a.id and r.user_id = p_user_id
    where not p_unread_only or r.read_at is null
  ) select coalesce(jsonb_agg(jsonb_strip_nulls(to_jsonb(v)) order by v.read_at is null desc, v.id desc), '[]'::jsonb)
    from visible v;
$$;
create function public.s2a_announcement_mark_read(p_user_id uuid, p_announcement_id bigint)
returns boolean language plpgsql set search_path = '' as $$
begin
  -- Lock the visible row so archive/delete cannot race the receipt insertion.
  perform id from public.s2a_announcements a where a.id = p_announcement_id and a.status = 'active'
    and (a.starts_at is null or a.starts_at <= now()) and (a.ends_at is null or a.ends_at > now())
    and (not a.targeting ? 'any_of' or a.targeting->'any_of' = '[]'::jsonb) for share;
  if not found then return false; end if;
  insert into public.s2a_announcement_reads(announcement_id,user_id) values(p_announcement_id,p_user_id)
    on conflict (announcement_id,user_id) do nothing;
  return true;
end $$;

create function public.s2a_announcement_read_status(p_announcement_id bigint, p_page integer, p_size integer,
  p_search text default '', p_sort text default 'email', p_order text default 'asc')
returns jsonb language sql stable security definer set search_path = '' as $$
  with users as (
    select u.id user_id, coalesce(u.email,'') email, coalesce(u.raw_user_meta_data->>'username','') username,
      null::numeric balance, true eligible, r.read_at, u.created_at
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
revoke all on function public.s2a_announcements_for_user(uuid,boolean), public.s2a_announcement_mark_read(uuid,bigint),
  public.s2a_announcement_read_status(bigint,integer,integer,text,text,text) from public, anon, authenticated;
grant execute on function public.s2a_announcements_for_user(uuid,boolean), public.s2a_announcement_mark_read(uuid,bigint),
  public.s2a_announcement_read_status(bigint,integer,integer,text,text,text) to service_role;
