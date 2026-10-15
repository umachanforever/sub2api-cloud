create table public.s2a_account_import_operations (
 actor_id uuid not null references auth.users(id) on delete cascade,
 idempotency_key text not null check(length(idempotency_key) between 1 and 128),
 payload_hash text not null check(length(payload_hash)=64),
 result jsonb,
 account_ids uuid[] not null default '{}',
 created_at timestamptz not null default now(),
 primary key(actor_id,idempotency_key)
);
alter table public.s2a_account_import_operations enable row level security;
revoke all on public.s2a_account_import_operations from public,anon,authenticated;
grant select,insert,update,delete on public.s2a_account_import_operations to service_role;

create function public.s2a_account_data_import(p_actor_id uuid,p_key text,p_hash text,p_rows jsonb,p_errors jsonb default '[]',p_skip_default boolean default true)
returns jsonb language plpgsql set search_path='' as $$
declare operation public.s2a_account_import_operations;row jsonb;patch jsonb;r jsonb;groups uuid[];imported_ids uuid[]:='{}';
 errors jsonb:=p_errors;created integer:=0;failed integer:=0;outcome jsonb;g uuid;item_name text;
begin
 if p_key is null or length(btrim(p_key)) not between 1 and 128 or p_key ~ '[[:cntrl:]]' or p_hash is null or p_hash !~ '^[a-f0-9]{64}$'
  or jsonb_typeof(p_rows) is distinct from 'array' or jsonb_typeof(p_errors) is distinct from 'array' or p_skip_default is null then
  return jsonb_build_object('error','invalid_import_request','status',400);end if;
 if jsonb_array_length(p_rows)>1000 or jsonb_array_length(p_errors)>1000 then return jsonb_build_object('error','import_too_large','status',400);end if;
 insert into public.s2a_account_import_operations(actor_id,idempotency_key,payload_hash) values(p_actor_id,btrim(p_key),p_hash) on conflict do nothing;
 select * into operation from public.s2a_account_import_operations where actor_id=p_actor_id and idempotency_key=btrim(p_key) for update;
 if operation.created_at<now()-interval '2 hours' then
  update public.s2a_account_import_operations set payload_hash=p_hash,result=null,account_ids='{}',created_at=now() where actor_id=p_actor_id and idempotency_key=btrim(p_key);
  operation.payload_hash:=p_hash;operation.result:=null;
 end if;
 if operation.payload_hash<>p_hash then return jsonb_build_object('error','idempotency_conflict','status',409);end if;
 if operation.result is not null then return jsonb_build_object('data',operation.result,'account_ids',to_jsonb(operation.account_ids),'replayed',true);end if;
 for row in select value from jsonb_array_elements(p_rows) loop
  item_name:=coalesce(row->>'name','');
  if row ? 'error' then
   failed:=failed+1;errors:=errors||jsonb_build_array(jsonb_build_object('kind','account','name',item_name,'message',row->>'error'));continue;
  end if;
  begin
   patch:=row->'patch';groups:='{}';
   if not p_skip_default then
    select id into g from public.s2a_groups where name=(patch->>'platform')||'-default' and platform=patch->>'platform' and enabled for share;
    if found then groups:=array[g];end if;
   end if;
   r:=public.s2a_account_save(null,patch,groups);
   if r ? 'error' then
    failed:=failed+1;errors:=errors||jsonb_build_array(jsonb_build_object('kind','account','name',item_name,'message',r->>'error'));
   else
    created:=created+1;imported_ids:=array_append(imported_ids,(r->>'id')::uuid);
   end if;
  exception when unique_violation then
   failed:=failed+1;errors:=errors||jsonb_build_array(jsonb_build_object('kind','account','name',item_name,'message','account_credentials_already_registered'));
  when check_violation or not_null_violation or invalid_text_representation or numeric_value_out_of_range or foreign_key_violation then
   failed:=failed+1;errors:=errors||jsonb_build_array(jsonb_build_object('kind','account','name',item_name,'message','invalid_account_data'));
  end;
 end loop;
 outcome:=jsonb_build_object('proxy_created',0,'proxy_reused',0,'proxy_failed',jsonb_array_length(p_errors),'account_created',created,'account_failed',failed,'errors',errors);
 update public.s2a_account_import_operations set result=outcome,account_ids=imported_ids where actor_id=p_actor_id and idempotency_key=btrim(p_key);
 return jsonb_build_object('data',outcome,'account_ids',to_jsonb(imported_ids),'replayed',false);
end $$;
revoke all on function public.s2a_account_data_import(uuid,text,text,jsonb,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.s2a_account_data_import(uuid,text,text,jsonb,jsonb,boolean) to service_role;
notify pgrst,'reload schema';
