-- Native API-key providers share the existing encrypted credential and lease tables.
alter table public.s2a_groups add column platform text not null default 'openai'
  check (platform in ('openai', 'anthropic', 'gemini'));
alter table public.s2a_accounts drop constraint s2a_accounts_platform_check;
alter table public.s2a_accounts drop constraint s2a_accounts_type_check;
alter table public.s2a_accounts add constraint s2a_accounts_provider_check check (
  (platform = 'openai' and type in ('oauth', 'apikey'))
  or (platform in ('anthropic', 'gemini') and type = 'apikey')
);

-- Lock the routing group so a concurrent platform change cannot mix providers.
create function public.s2a_account_group_platform_check()
returns trigger language plpgsql set search_path = '' as $$
declare group_platform text;
begin
  select platform into group_platform from public.s2a_groups where id = new.group_id for share;
  if group_platform is null or group_platform <> new.platform then
    raise check_violation using message = 'account_group_platform_mismatch';
  end if;
  return new;
end $$;
create trigger s2a_account_group_platform before insert or update of group_id, platform
  on public.s2a_accounts for each row execute function public.s2a_account_group_platform_check();
create function public.s2a_group_account_platform_check()
returns trigger language plpgsql set search_path = '' as $$
begin
  if exists(select 1 from public.s2a_accounts where group_id = new.id and platform <> new.platform) then
    raise check_violation using message = 'account_group_platform_mismatch';
  end if;
  return new;
end $$;
create trigger s2a_group_account_platform before update of platform on public.s2a_groups
  for each row execute function public.s2a_group_account_platform_check();
revoke all on function public.s2a_account_group_platform_check() from public, anon, authenticated;
revoke all on function public.s2a_group_account_platform_check() from public, anon, authenticated;

-- Drop the old overload to keep PostgREST named-argument resolution unambiguous.
drop function public.s2a_group_create(text,uuid);
create function public.s2a_group_create(p_name text, p_user_id uuid, p_platform text default 'openai')
returns jsonb language plpgsql set search_path = '' as $$
declare g public.s2a_groups;
begin
  insert into public.s2a_groups(name,platform) values(p_name,p_platform) returning * into g;
  insert into public.s2a_memberships(user_id,group_id) values(p_user_id,g.id);
  return to_jsonb(g);
end $$;
revoke all on function public.s2a_group_create(text,uuid,text) from public, anon, authenticated;
grant execute on function public.s2a_group_create(text,uuid,text) to service_role;
