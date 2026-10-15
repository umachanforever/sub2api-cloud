alter table public.s2a_keys add column deleted_at timestamptz;
update public.s2a_keys set deleted_at=now() where revoked;
alter table public.s2a_keys add constraint s2a_deleted_key_revoked
  check (deleted_at is null or revoked);
create function public.s2a_prevent_key_undelete() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.deleted_at is not null and new.deleted_at is distinct from old.deleted_at then
    raise exception 'deleted API keys cannot be restored';
  end if;
  return new;
end $$;
revoke all on function public.s2a_prevent_key_undelete() from public,anon,authenticated,service_role;
create trigger s2a_key_no_undelete before update on public.s2a_keys
  for each row execute function public.s2a_prevent_key_undelete();
