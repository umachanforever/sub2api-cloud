-- Profiles stay in Supabase Auth metadata; the service-only list exposes only DTO fields.
create function public.s2a_users_list(p_page integer, p_size integer, p_search text default '',
  p_status text default '', p_role text default '', p_admin_ids uuid[] default '{}'::uuid[],
  p_sort text default 'created_at', p_order text default 'desc')
returns jsonb language sql stable security definer set search_path = '' as $$
  with users as (
    select u.id, coalesce(u.email,'') email, u.banned_until, u.created_at, u.updated_at,
      jsonb_build_object('username',u.raw_user_meta_data->>'username','avatar_url',u.raw_user_meta_data->>'avatar_url') user_metadata,
      jsonb_build_object('s2a_notes',u.raw_app_meta_data->>'s2a_notes') app_metadata,
      case when u.banned_until > now() then 'disabled' else 'active' end status,
      case when u.id = any(p_admin_ids) then 'admin' else 'user' end role
    from auth.users u
    where position(lower(p_search) in lower(coalesce(u.email,'') || ' ' || coalesce(u.raw_user_meta_data->>'username',''))) > 0
  ), filtered as (
    select * from users where (p_status = '' or status = p_status) and (p_role = '' or role = p_role)
  ), page as (
    select * from filtered order by
      case when p_order = 'asc' then case p_sort
        when 'email' then email when 'username' then user_metadata->>'username'
        when 'status' then status when 'role' then role when 'id' then id::text
        when 'updated_at' then updated_at::text else created_at::text end end asc,
      case when p_order <> 'asc' then case p_sort
        when 'email' then email when 'username' then user_metadata->>'username'
        when 'status' then status when 'role' then role when 'id' then id::text
        when 'updated_at' then updated_at::text else created_at::text end end desc,
      id asc limit p_size offset (p_page - 1) * p_size
  ) select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(p) - 'role' - 'status') from page p),'[]'::jsonb),
    'total',(select count(*) from filtered),'page',p_page,'page_size',p_size,
    'pages',ceil((select count(*) from filtered)::numeric / p_size));
$$;
revoke all on function public.s2a_users_list(integer,integer,text,text,text,uuid[],text,text) from public, anon, authenticated;
grant execute on function public.s2a_users_list(integer,integer,text,text,text,uuid[],text,text) to service_role;
