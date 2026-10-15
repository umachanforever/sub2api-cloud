create or replace function public.s2a_account_group_seed() returns trigger
language plpgsql set search_path = '' as $$
begin
 if tg_op='UPDATE' and old.group_id is distinct from new.group_id then
  delete from public.s2a_account_groups where account_id=new.id and group_id=old.group_id;
 end if;
 insert into public.s2a_account_groups(account_id,group_id) values(new.id,new.group_id) on conflict do nothing;
 return new;
end $$;
drop trigger s2a_account_group_seed on public.s2a_accounts;
create trigger s2a_account_group_seed after insert or update of group_id on public.s2a_accounts
 for each row execute function public.s2a_account_group_seed();
