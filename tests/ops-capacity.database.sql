begin;
do $$
declare actor uuid:=gen_random_uuid();unlimited uuid:=gen_random_uuid();banned uuid:=gen_random_uuid();gid uuid:=gen_random_uuid();private_group uuid:=gen_random_uuid();
 a uuid:=gen_random_uuid();b uuid:=gen_random_uuid();rate uuid:=gen_random_uuid();err uuid:=gen_random_uuid();expired uuid:=gen_random_uuid();unbound uuid:=gen_random_uuid();quota uuid:=gen_random_uuid();overloaded uuid:=gen_random_uuid();temporary uuid:=gen_random_uuid();blocked uuid:=gen_random_uuid();unpaused uuid:=gen_random_uuid();
 k1 uuid:=gen_random_uuid();k2 uuid:=gen_random_uuid();k3 uuid:=gen_random_uuid();k4 uuid:=gen_random_uuid();v jsonb;r jsonb;
begin
 insert into auth.users(id,email,raw_user_meta_data,banned_until) values(actor,'capacity@example.com','{"username":"Capacity owner"}',null),(unlimited,'unlimited@example.com','{}',null),(banned,'banned@example.com','{}',now()+interval '1 day');
 insert into public.s2a_user_limits(user_id,concurrency) values(actor,4),(unlimited,0);
 insert into public.s2a_groups(id,name,require_privacy_set) values(gid,'Shared pool',false),(private_group,'Private pool',true);
 insert into public.s2a_accounts(id,name,group_id,platform,type,account_fingerprint,ciphertext,iv,concurrency,extra,status,schedulable,expires_at,auto_pause_on_expired,cooldown_until,cooldown_status) values
 (a,'Full shared',gid,'openai','apikey',a::text,'private-cipher','private-iv',2,'{"privacy_mode":"training_off"}','active',true,null,true,null,null),
 (b,'Healthy shared',gid,'openai','apikey',b::text,'private-cipher','private-iv',3,'{}','active',true,null,true,null,null),
 (rate,'Rate limited',gid,'openai','apikey',rate::text,'private-cipher','private-iv',2,'{}','active',true,null,true,now()+interval '5 minutes',429),
 (err,'Error',gid,'openai','apikey',err::text,'private-cipher','private-iv',2,'{}','error',true,null,true,now()+interval '5 minutes',503),
 (expired,'Expired',gid,'openai','apikey',expired::text,'private-cipher','private-iv',2,'{}','active',true,now()-interval '1 day',true,null,null),
 (unbound,'Unbound',null,'openai','apikey',unbound::text,'private-cipher','private-iv',2,'{}','active',true,null,true,null,null),
 (quota,'Quota paused',gid,'openai','apikey',quota::text,'private-cipher','private-iv',2,jsonb_build_object('auto_pause_5h_threshold',0.8,'codex_5h_used_percent',90,'codex_usage_updated_at',now(),'codex_5h_reset_at',now()+interval '1 hour'),'active',true,null,true,null,null),
 (overloaded,'Overloaded',gid,'openai','apikey',overloaded::text,'private-cipher','private-iv',2,'{}','active',true,null,true,now()+interval '5 minutes',503),
 (temporary,'Temporary',gid,'openai','apikey',temporary::text,'private-cipher','private-iv',2,'{}','active',true,null,true,now()+interval '5 minutes',400),
 (blocked,'Disabled scheduling',gid,'openai','apikey',blocked::text,'private-cipher','private-iv',2,'{}','active',false,null,true,null,null),
 (unpaused,'Expiry exempt',gid,'openai','apikey',unpaused::text,'private-cipher','private-iv',2,'{}','active',true,now()-interval '1 day',false,null,null);
 insert into public.s2a_account_groups(account_id,group_id) values(a,private_group),(b,private_group);
 insert into public.s2a_keys(id,user_id,group_id,name,key_hash,key_prefix) values(k1,actor,gid,'First',repeat('a',64),'prefix'),(k2,actor,private_group,'Second',repeat('b',64),'prefix'),(k3,unlimited,gid,'Unlimited',repeat('c',64),'prefix'),(k4,banned,gid,'Banned',repeat('d',64),'prefix');
 insert into public.s2a_leases(request_id,account_id,key_id,model,expires_at,billing) values
 (gen_random_uuid(),a,k1,'alias',now()+interval '1 minute',jsonb_build_object('group_id',gid)),
 (gen_random_uuid(),a,k2,'alias',now()+interval '1 minute',jsonb_build_object('group_id',private_group)),
 (gen_random_uuid(),b,k3,'alias',now()+interval '1 minute',jsonb_build_object('group_id',gid)),
 (gen_random_uuid(),err,k4,'alias',now()+interval '1 minute',jsonb_build_object('group_id',gid)),
 (gen_random_uuid(),b,k1,'alias',now()-interval '1 minute',jsonb_build_object('group_id',gid));
 set local role service_role;
 v:=public.s2a_ops_capacity('concurrency','openai');
 assert (v->'platform'->'openai'->>'max_capacity')::int=23 and (v->'platform'->'openai'->>'current_in_use')::int=4,'platform capacity deduplicates shared accounts and excludes expired leases';
 assert (v->'group'->gid::text->>'max_capacity')::int=21 and (v->'group'->private_group::text->>'max_capacity')::int=5;
 assert (v->'group'->private_group::text->>'current_in_use')::int=3,'each group sees shared pool occupancy';
 assert (v->'account'->b::text->>'current_in_use')::int=1;
 r:=public.s2a_ops_capacity('concurrency','openai',private_group);assert (select count(*) from jsonb_object_keys(r->'account'))=2 and (r->'account'->a::text->>'group_id')::uuid=private_group;
 v:=public.s2a_ops_capacity('account-availability','openai');
 assert (v->'platform'->'openai'->>'available_count')::int=2 and (v->'platform'->'openai'->>'rate_limit_count')::int=2 and (v->'platform'->'openai'->>'error_count')::int=1;
 assert v->'account'->a::text->'is_available'='false'::jsonb and v->'account'->b::text->'is_available'='true'::jsonb;
 assert (v->'group'->private_group::text->>'available_count')::int=0,'privacy is evaluated for the selected binding';
 assert v->'account'->unbound::text->'is_available'='false'::jsonb and v->'account'->expired::text->'is_available'='false'::jsonb;
 assert v->'account'->unpaused::text->'is_available'='true'::jsonb and v->'account'->blocked::text->'is_available'='false'::jsonb;
 assert v->'account'->quota::text->'is_rate_limited'='true'::jsonb and not (v->'account'->quota::text)?'rate_limit_remaining_sec','unknown quota recovery never becomes zero seconds';
 assert v->'account'->err::text->'has_error'='true'::jsonb and v->'account'->err::text->'is_overloaded'='false'::jsonb;
 assert v->'account'->overloaded::text->'is_overloaded'='true'::jsonb and (v->'account'->overloaded::text->>'overload_remaining_sec')::int>0;
 assert (v->'account'->temporary::text)?'temp_unschedulable_until';
 v:=public.s2a_ops_capacity('user-concurrency');assert (v->'user'->actor::text->>'current_in_use')::int=2 and (v->'user'->actor::text->>'load_percentage')::numeric=50;
 assert (v->'user'->unlimited::text->>'max_capacity')::int=0 and (v->'user'->unlimited::text->>'current_in_use')::int=1 and not (v->'user')?banned::text;
 assert not v::text like '%private-%' and not v::text like '%encrypted_password%';
 r:=public.s2a_ops_capacity('concurrency','gemini');assert r->'account'='{}'::jsonb;
 begin perform public.s2a_ops_capacity('user-concurrency','openai');raise exception 'user filtering accepted';exception when raise_exception then assert sqlerrm='invalid_capacity_filter';end;
 reset role;
 update public.s2a_accounts set cooldown_until=now()-interval '1 second' where id=rate;
 v:=public.s2a_ops_capacity('account-availability','openai',gid);assert v->'account'->rate::text->'is_available'='true'::jsonb,'elapsed cooldowns recover without a mutation job';
 assert not has_function_privilege('authenticated','public.s2a_ops_capacity(text,text,uuid)','execute');
 assert not has_function_privilege('anon','public.s2a_ops_capacity(text,text,uuid)','execute');
end $$;
rollback;
