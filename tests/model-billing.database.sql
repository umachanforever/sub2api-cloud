begin;
insert into auth.users(id) values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1');
insert into public.s2a_groups(id,name,platform,rate_multiplier) values
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2','Billing OpenAI','openai',2),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3','Billing Anthropic','anthropic',1),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4','Billing Gemini','gemini',1);
insert into public.s2a_memberships select 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',id from public.s2a_groups where name like 'Billing %';
insert into public.s2a_accounts(id,group_id,name,platform,type,account_fingerprint,ciphertext,iv) values
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2','OpenAI','openai','apikey','billing-openai','encrypted','iv'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3','Anthropic','anthropic','apikey','billing-anthropic','encrypted','iv'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb7','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4','Gemini','gemini','apikey','billing-gemini','encrypted','iv');
insert into public.s2a_keys(user_id,group_id,name,key_hash,key_prefix) values
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2','OpenAI',repeat('b',64),'prefix'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3','Anthropic',repeat('c',64),'prefix'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4','Gemini',repeat('f',64),'prefix');
do $$ declare r jsonb; lease uuid; value numeric; stats jsonb; begin
 r := public.s2a_acquire(repeat('b',64),'gpt-4.1',gen_random_uuid(),'{}',true,null,'{}');
 if r->>'error' is distinct from 'insufficient_balance' then raise exception 'unfunded request accepted: %',r; end if;
 if exists(select 1 from public.s2a_leases where key_id in(select id from public.s2a_keys where user_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1')) then raise exception 'rejection created lease'; end if;
 perform public.s2a_wallet_update('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',0.0001,'set');
 r := public.s2a_acquire(repeat('b',64),'gpt-4.1',gen_random_uuid(),'{}',true,null,'{"service_tier":"priority","native_stream":false}');
 lease := (r->>'lease_id')::uuid;
 if lease is null then raise exception 'funded request rejected: %',r; end if;
 update public.s2a_model_prices set rates='{"input_cost_per_token":0,"output_cost_per_token":0}' where platform='openai' and model='gpt-4.1';
 perform public.s2a_finish(lease,200,'completed',100,10,0,20);
 perform public.s2a_finish(lease,200,'completed',100,10,0,20);
 select actual_cost into value from public.s2a_usage where id=lease;
 if value<>0.000875 then raise exception 'cache/tier/multiplier/snapshot cost mismatch: %',value; end if;
 select balance into value from public.s2a_wallets where user_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
 if value<>-0.000775 then raise exception 'charge lost or duplicated: %',value; end if;
 if (select count(*) from public.s2a_wallet_ledger where notes=lease::text)<>1 then raise exception 'duplicate usage debit'; end if;
 r := public.s2a_acquire(repeat('c',64),'claude-sonnet-4-20250514',gen_random_uuid(),'{}',true,null,'{}');
 if r->>'error' is distinct from 'insufficient_balance' then raise exception 'debt did not block subsequent request'; end if;
 r := public.s2a_wallet_update('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',0.0002,'add');
 if (r->>'balance')::numeric<>-0.000575 then raise exception 'partial debt repayment rejected: %',r; end if;
 perform public.s2a_wallet_update('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',2,'set');
 r := public.s2a_acquire(repeat('c',64),'claude-sonnet-4-20250514',gen_random_uuid(),'{}',true,null,'{}');
 lease := (r->>'lease_id')::uuid;
 if lease is null then raise exception 'Anthropic request rejected: %',r; end if;
 perform public.s2a_finish(lease,200,'completed',80,10,10,20);
 select total_cost into value from public.s2a_usage where id=lease;
 if value<>0.0004335 then raise exception 'Anthropic cache tokens double counted: %',value; end if;
 r := public.s2a_acquire(repeat('f',64),'gemini-2.5-pro',gen_random_uuid(),'{}',true,null,'{}');
 lease := (r->>'lease_id')::uuid;
 if lease is null then raise exception 'Gemini request rejected: %',r; end if;
 perform public.s2a_finish(lease,200,'completed',150,20,0,50);
 select total_cost into value from public.s2a_usage where id=lease;
 if value<>0.00033125 then raise exception 'Gemini cache tokens double counted: %',value; end if;
 if public.s2a_price_rate('{"input_cost_per_token":0.00000125,"input_cost_per_token_above_200k_tokens":0.0000025}','input_cost_per_token',200000)<>0.00000125
  or public.s2a_price_rate('{"input_cost_per_token":0.00000125,"input_cost_per_token_above_200k_tokens":0.0000025}','input_cost_per_token',200001)<>0.0000025 then raise exception 'context boundary mismatch'; end if;
 update public.s2a_keys set monetary_quota=monetary_used where key_hash=repeat('f',64);
 r := public.s2a_acquire(repeat('f',64),'gemini-2.5-pro',gen_random_uuid(),'{}',true,null,'{}');
 if r->>'error' is distinct from 'monetary_quota_exceeded' then raise exception 'monetary quota bypassed'; end if;
 update public.s2a_keys set monetary_quota=null where key_hash=repeat('f',64);
 r := public.s2a_acquire(repeat('f',64),'gemini-2.5-pro',gen_random_uuid(),'{}',true,null,'{}');
 lease := (r->>'lease_id')::uuid;
 perform public.s2a_finish(lease,502,'failed');
 if (select total_cost from public.s2a_usage where id=lease) is not null then raise exception 'unknown usage reported as free'; end if;
 stats := public.s2a_dashboard('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',now()-interval '1 day',now()+interval '1 second');
 if (stats->'summary'->>'unknown_cost_attempts')::int<>1 then raise exception 'unknown price aggregate mismatch'; end if;
 if (stats->'summary'->>'actual_cost')::numeric<>0.00163975 then raise exception 'charge aggregate mismatch: %',stats; end if;
 r := public.s2a_acquire(repeat('f',64),'unknown-model',gen_random_uuid(),'{}',true,null,'{}');
 if r->>'error' is distinct from 'model_pricing_unavailable' then raise exception 'unknown model charged without prices'; end if;
 update public.s2a_keys set revoked=true where key_hash=repeat('f',64);
 r := public.s2a_acquire(repeat('f',64),'gemini-2.5-pro',gen_random_uuid(),'{}',true,null,'{}');
 if r->>'error' is distinct from 'invalid_api_key' then raise exception 'revoked key reached billing'; end if;
 update public.s2a_groups set rate_multiplier=1000000 where id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
 if (select rate_multiplier from public.s2a_groups where id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2')<>1000000 then raise exception 'maximum multiplier rejected'; end if;
end $$;
rollback;
