-- Failures must leave a reusable ticket; successful creation/replacement is atomic and idempotent.
begin;
insert into auth.users(id,email) values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1','oauth@example.com'),('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2','other@example.com');
insert into public.s2a_groups(id,name) values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3','OAuth SQL test');
select public.s2a_oauth_session_start('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1','state-hash','pkce-encrypted','iv');
do $$ begin
 if public.s2a_oauth_session_claim('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2','state-hash') is not null then raise exception 'wrong session owner'; end if;
 if public.s2a_oauth_session_claim('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1','wrong') is not null then raise exception 'wrong session state'; end if;
 if public.s2a_oauth_session_claim('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1','state-hash') is null then raise exception 'valid session refused'; end if;
 if public.s2a_oauth_session_claim('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1','state-hash') is not null then raise exception 'session replay'; end if;
end $$;
insert into public.s2a_oauth_tickets(id,user_id,account_fingerprint,ciphertext,iv,metadata)
 values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1','oauth-sql-fingerprint','credential-encrypted','iv','{"email":"oauth@example.com"}');
do $$ declare r jsonb; a uuid; begin
 r:=public.s2a_oauth_account_create('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3','OAuth',3,50);
 if r->>'error'<>'oauth_ticket_invalid' then raise exception 'ticket owner bypass'; end if;
 r:=public.s2a_oauth_account_create('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3','OAuth',3,50,'Notes','{}',false,'2020-01-01',false,'active');
 a:=(r->>'id')::uuid;
 if a is null then raise exception 'ticket create failed %',r; end if;
 if not exists(select 1 from public.s2a_accounts where id=a and not schedulable and expires_at='2020-01-01' and not auto_pause_on_expired and status='active') then raise exception 'ticket lifecycle settings lost'; end if;
 if exists(select 1 from public.s2a_oauth_tickets where id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5' and ciphertext is not null) then raise exception 'consumed secret retained'; end if;
 if public.s2a_oauth_account_create('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3','OAuth',3,50)->>'id' <> a::text then raise exception 'idempotency failed'; end if;
 if (select count(*) from public.s2a_accounts where account_fingerprint='oauth-sql-fingerprint') <> 1 then raise exception 'duplicate account'; end if;
 insert into public.s2a_oauth_tickets(id,user_id,account_fingerprint,ciphertext,iv,metadata)
  values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee6','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1','oauth-sql-fingerprint','replacement','new-iv','{"plan_type":"plus"}');
 r:=public.s2a_oauth_account_replace('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee6','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1',a);
 if r->>'status'<>'409' then raise exception 'active account replacement allowed'; end if;
 if not exists(select 1 from public.s2a_oauth_tickets where id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee6' and ciphertext='replacement') then raise exception 'failed replacement lost ticket'; end if;
 update public.s2a_accounts set status='disabled' where id=a;
 r:=public.s2a_oauth_account_replace('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee6','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1',a);
 if r->>'ok'<>'true' then raise exception 'replacement failed %',r; end if;
 if not exists(select 1 from public.s2a_accounts where id=a and credential_version=2 and ciphertext='replacement' and status='disabled' and extra->>'email'='oauth@example.com' and extra->>'plan_type'='plus') then raise exception 'replacement state wrong'; end if;
 perform public.s2a_oauth_account_replace('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee6','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1',a);
 if (select credential_version from public.s2a_accounts where id=a) <> 2 then raise exception 'replacement replay rotated twice'; end if;
end $$;
set local role authenticated;
do $$ begin
 begin perform * from public.s2a_oauth_tickets; raise exception 'ticket grant bypass'; exception when insufficient_privilege then null; end;
 begin perform public.s2a_oauth_session_claim('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1','state-hash');raise exception 'claim grant bypass';exception when insufficient_privilege then null;end;
end $$;
rollback;
