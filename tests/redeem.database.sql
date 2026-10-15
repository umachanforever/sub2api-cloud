begin;
insert into auth.users(id,email) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1','redeem-one@example.com'),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2','redeem-two@example.com');
insert into public.s2a_redeem_codes(code,type,value,notes,status,expires_at) values
 ('credit-code','balance',5.25,'Internal order reference','unused',null),
 ('overdraft-code','balance',-20,'','unused',null),
 ('refund-code','balance',-2.25,'','unused',null),
 ('concurrency-code','concurrency',2,'','unused',null),
 ('bad-concurrency-code','concurrency',-6,'','unused',null),
 ('refund-concurrency','concurrency',-2,'','unused',null),
 ('expired-code','balance',1,'','unused',now()-interval '1 minute'),
 ('disabled-code','balance',1,'','disabled',null),
 ('limited-credit','balance',1,'','unused',null);
do $$ declare r jsonb; total numeric; id uuid; n integer; before_count integer; begin
 r:=public.s2a_redeem_use('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',' credit-code ');
 if (r->>'new_balance')::numeric<>5.25 or r ? 'notes' then raise exception 'credit or private DTO mismatch: %',r; end if;
 r:=public.s2a_redeem_use('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1','credit-code');
 if r->>'error' is distinct from 'redeem_code_used' then raise exception 'code reusable'; end if;
 if (select count(*) from public.s2a_wallet_ledger where user_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1')<>1 then raise exception 'duplicate credit'; end if;
 r:=public.s2a_redeem_use('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1','overdraft-code');
 if r->>'error' is distinct from 'insufficient_balance' or (select status from public.s2a_redeem_codes where code='overdraft-code')<>'unused' then raise exception 'failed refund consumed code'; end if;
 r:=public.s2a_redeem_use('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1','refund-code');
 if (r->>'new_balance')::numeric<>3 then raise exception 'refund failed: %',r; end if;
 r:=public.s2a_redeem_use('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1','concurrency-code');
 if (r->>'new_concurrency')::int<>5 then raise exception 'concurrency credit failed'; end if;
 r:=public.s2a_redeem_use('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1','bad-concurrency-code');
 if r->>'error' is distinct from 'invalid_resulting_concurrency' or (select status from public.s2a_redeem_codes where code='bad-concurrency-code')<>'unused' then raise exception 'failed concurrency reduction consumed code'; end if;
 r:=public.s2a_redeem_use('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1','refund-concurrency');
 if (r->>'new_concurrency')::int<>3 then raise exception 'concurrency reduction failed'; end if;
 r:=public.s2a_redeem_use('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1','expired-code');
 if r->>'error' is distinct from 'redeem_code_expired' then raise exception 'expired code accepted'; end if;
 r:=public.s2a_redeem_use('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1','disabled-code');
 if r->>'error' is distinct from 'redeem_code_disabled' then raise exception 'disabled code accepted'; end if;
 for n in 1..30 loop perform public.s2a_redeem_use('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2','missing-'||n); end loop;
 r:=public.s2a_redeem_use('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2','limited-credit');
 if r->>'error' is distinct from 'redeem_rate_limited' then raise exception 'guess limit not enforced'; end if;
 r:=public.s2a_redeem_create_and_use('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2','external-order','balance',1,null,'Private settlement');
 if r ? 'error' or r->'redeem_code'->>'status'<>'used' then raise exception 'admin fulfillment failed under rate limit: %',r; end if;
 r:=public.s2a_redeem_create_and_use('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2','external-order','balance',1);
 if r ? 'error' or (select balance from public.s2a_wallets where user_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2')<>1 then raise exception 'admin fulfillment not idempotent'; end if;
 r:=public.s2a_redeem_create_and_use('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2','external-order','balance',2);
 if r->>'error' is distinct from 'redeem_code_conflict' then raise exception 'changed fulfillment amount accepted'; end if;
 r:=public.s2a_redeem_create_and_use('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1','external-order','balance',1);
 if r->>'error' is distinct from 'redeem_code_conflict' then raise exception 'another user reused fulfillment'; end if;
 update public.s2a_redeem_attempts set window_start=now()-interval '11 minutes' where user_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
 r:=public.s2a_redeem_use('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2','limited-credit');
 if (r->>'new_balance')::numeric<>2 then raise exception 'guess window did not reset'; end if;
 select c.id into id from public.s2a_redeem_codes c where code='credit-code';
 r:=public.s2a_redeem_mutate(array[id],'update','{"status":"unused"}');
 if r->>'error' is distinct from 'used_redeem_code_immutable' then raise exception 'used code reactivated'; end if;
 r:=public.s2a_redeem_mutate(array[id],'update','{"notes":"Changed private note"}');
 if (r->>'updated')::int<>1 then raise exception 'private notes cannot be updated'; end if;
 r:=public.s2a_redeem_list('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',1,2,'','','','used_at','desc');
 if (r->>'total')::int<>4 or jsonb_array_length(r->'items')<>2 or r->'items'->0 ? 'notes' then raise exception 'history pagination or private notes mismatch'; end if;
 r:=public.s2a_wallet_history('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',2,1,'balance');
 if (r->>'total')::int<>2 or (r->>'total_recharged')::numeric<>5.25 or jsonb_array_length(r->'items')<>1 then raise exception 'combined balance history double-counted wallet ledger'; end if;
 r:=public.s2a_redeem_list(null,1,10,'balance','expired');
 if (r->>'total')::int<>1 or r->'items'->0->>'status'<>'expired' then raise exception 'effective expiry filter mismatch'; end if;
 r:=public.s2a_redeem_dto(id,true);
 if r->>'notes'<>'Changed private note' or r->'user'->>'email'<>'redeem-one@example.com' then raise exception 'admin DTO mismatch'; end if;
 r:=public.s2a_redeem_mutate(array[id,(select c.id from public.s2a_redeem_codes c where code='overdraft-code')],'delete');
 if (r->>'deleted')::int<>1 or not exists(select 1 from public.s2a_redeem_codes where code='credit-code') then raise exception 'batch delete removed used code'; end if;
 begin delete from public.s2a_redeem_codes where code='credit-code'; raise exception 'direct used-code delete accepted'; exception when check_violation then null; end;
 begin update public.s2a_redeem_codes set status='unused' where code='credit-code'; raise exception 'direct used-code reset accepted'; exception when check_violation then null; end;
 r:=public.s2a_redeem_mutate(array[(select c.id from public.s2a_redeem_codes c where code='disabled-code'),gen_random_uuid()],'update','{"status":"unused"}');
 if r->>'error' is distinct from 'redeem_code_not_found' or (select status from public.s2a_redeem_codes where code='disabled-code')<>'disabled' then raise exception 'partial batch update committed'; end if;
 r:=public.s2a_redeem_generate(2,'invitation',100);
 if jsonb_array_length(r)<>2 or (r->0->>'value')::numeric<>0 then raise exception 'invitation generator mismatch'; end if;
 if r->0->>'code' !~ '^[A-F0-9]{8}(-[A-F0-9]{8}){3}$' then raise exception 'generated code format mismatch'; end if;
 r:=public.s2a_redeem_use('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',r->0->>'code');
 if r->>'error' is distinct from 'invitation_requires_registration' then raise exception 'invitation credited wallet'; end if;
 r:=public.s2a_redeem_stats();
 if (r->>'total_value_distributed')::numeric<>5 then raise exception 'distributed value is not actual net redeemed balance: %',r; end if;
 delete from auth.users u where u.id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
 if not exists(select 1 from public.s2a_redeem_codes where code='external-order' and used_by is null and status='used') then raise exception 'user deletion destroyed redemption evidence'; end if;
end $$;
rollback;
