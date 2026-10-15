create table public.s2a_redeem_codes (
 id uuid primary key default gen_random_uuid(),
 code text not null unique check(length(code) between 3 and 128),
 type text not null check(type in ('balance','concurrency','subscription','invitation')),
 value numeric(20,8) not null check(abs(value)<=1000000000),
 status text not null default 'unused' check(status in ('unused','disabled','used','expired')),
 used_by uuid references auth.users(id) on delete set null,
 used_at timestamptz,
 expires_at timestamptz,
 notes text not null default '' check(length(notes)<=10000),
 group_id uuid references public.s2a_groups(id),
 validity_days integer not null default 0 check(validity_days between -36500 and 36500),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check((type='invitation' and value=0) or (type<>'invitation' and value<>0)),
 check(type<>'concurrency' or (value=trunc(value) and abs(value)<=1000000)),
 check(type<>'subscription' or group_id is not null),
 check(status<>'used' or used_at is not null)
);
create index s2a_redeem_codes_user on public.s2a_redeem_codes(used_by,used_at desc,id);
create index s2a_redeem_codes_created on public.s2a_redeem_codes(created_at desc,id);
create table public.s2a_redeem_attempts (
 user_id uuid primary key references auth.users(id) on delete cascade,
 window_start timestamptz not null default now(),
 failures integer not null default 0 check(failures>=0)
);
do $$ declare t text; begin
 foreach t in array array['s2a_redeem_codes','s2a_redeem_attempts'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select,insert,update,delete on public.%I to service_role',t);
 end loop;
end $$;

create function public.s2a_redeem_guard() returns trigger language plpgsql set search_path='' as $$
begin
 if old.status='used' then
  if tg_op='DELETE' then raise check_violation using message='cannot_delete_used_redeem_code'; end if;
  if row(new.code,new.type,new.value,new.status,new.group_id,new.validity_days,new.used_at,new.expires_at)
    is distinct from row(old.code,old.type,old.value,old.status,old.group_id,old.validity_days,old.used_at,old.expires_at)
    or new.used_by is distinct from old.used_by and new.used_by is not null then
   raise check_violation using message='used_redeem_code_immutable';
  end if;
 end if;
 if tg_op='UPDATE' then new.updated_at:=now(); return new; end if;
 return old;
end $$;
create trigger s2a_redeem_guard before update or delete on public.s2a_redeem_codes
 for each row execute function public.s2a_redeem_guard();
create trigger s2a_redeem_audit after insert or update or delete on public.s2a_redeem_codes
 for each row execute function public.s2a_audit_mutation();

create function public.s2a_redeem_dto(p_id uuid,p_admin boolean default false)
returns jsonb language sql stable security definer set search_path='' as $$
 select (to_jsonb(c)-case when p_admin then '__none__' else 'notes' end)||jsonb_build_object(
  'status',case when c.status<>'used' and c.expires_at<=now() then 'expired' else c.status end,
  'user',(select jsonb_build_object('id',u.id,'email',u.email) from auth.users u where u.id=c.used_by),
  'group',(select jsonb_build_object('id',g.id,'name',g.name) from public.s2a_groups g where g.id=c.group_id))
 from public.s2a_redeem_codes c where c.id=p_id;
$$;

create function public.s2a_redeem_generate(p_count integer,p_type text,p_value numeric,
 p_expires_at timestamptz default null,p_notes text default '')
returns jsonb language plpgsql set search_path='' as $$
declare c public.s2a_redeem_codes; result jsonb:='[]'; token text; n integer;
begin
 if p_count is null or p_count not between 1 and 100 or p_type is null or p_type not in ('balance','concurrency','invitation','subscription')
  or p_notes is null or length(p_notes)>10000 or p_expires_at<=now() then
  return jsonb_build_object('error','invalid_redeem_code','status',400);
 end if;
 if p_type='subscription' then return jsonb_build_object('error','subscription_redemption_not_supported','status',501); end if;
 if p_type='invitation' then p_value:=0; end if;
 if p_value is null or p_value::text in ('NaN','Infinity','-Infinity') or abs(p_value)>1000000000 or p_value<>round(p_value,8)
  or p_type<>'invitation' and p_value=0 or p_type='concurrency' and (p_value<>trunc(p_value) or abs(p_value)>1000000) then
  return jsonb_build_object('error','invalid_redeem_value','status',400);
 end if;
 for n in 1..p_count loop
  token:=upper(replace(gen_random_uuid()::text,'-',''));
  token:=substring(token,1,8)||'-'||substring(token,9,8)||'-'||substring(token,17,8)||'-'||substring(token,25,8);
  insert into public.s2a_redeem_codes(code,type,value,expires_at,notes) values(token,p_type,p_value,p_expires_at,p_notes) returning * into c;
  result:=result||jsonb_build_array(to_jsonb(c));
 end loop;
 return result;
end $$;

create function public.s2a_redeem_use(p_user_id uuid,p_code text,p_admin boolean default false)
returns jsonb language plpgsql set search_path='' as $$
declare c public.s2a_redeem_codes; attempts public.s2a_redeem_attempts; result jsonb; failure text; status_code integer; next_limit integer;
begin
 p_admin:=coalesce(p_admin,false);
 if not exists(select 1 from auth.users where id=p_user_id and (banned_until is null or banned_until<=now())) then
  return jsonb_build_object('error','user_not_found','status',404);
 end if;
 if p_code is null or length(trim(p_code)) not between 3 and 128 then return jsonb_build_object('error','invalid_redeem_code','status',400); end if;
 insert into public.s2a_user_limits(user_id) values(p_user_id) on conflict do nothing;
 perform 1 from public.s2a_user_limits where user_id=p_user_id for update;
 insert into public.s2a_redeem_attempts(user_id) values(p_user_id) on conflict do nothing;
 select * into attempts from public.s2a_redeem_attempts where user_id=p_user_id for update;
 if attempts.window_start<=now()-interval '10 minutes' then
  update public.s2a_redeem_attempts set window_start=now(),failures=0 where user_id=p_user_id;
  attempts.failures:=0;
 end if;
 if not p_admin and attempts.failures>=30 then return jsonb_build_object('error','redeem_rate_limited','status',429); end if;
 select * into c from public.s2a_redeem_codes where code=trim(p_code) for update;
 if not found then failure:='redeem_code_not_found'; status_code:=404;
 elsif c.status='used' then
  if p_admin and c.used_by=p_user_id then return public.s2a_redeem_dto(c.id,true); end if;
  failure:='redeem_code_used'; status_code:=409;
 elsif c.status='expired' or c.expires_at<=now() then failure:='redeem_code_expired'; status_code:=409;
 elsif c.status='disabled' then failure:='redeem_code_disabled'; status_code:=409;
 end if;
 if failure is not null then
  if not p_admin then update public.s2a_redeem_attempts set failures=failures+1 where user_id=p_user_id; end if;
  return jsonb_build_object('error',failure,'status',status_code);
 end if;
 if c.type='invitation' then return jsonb_build_object('error','invitation_requires_registration','status',400); end if;
 if c.type='subscription' then return jsonb_build_object('error','subscription_redemption_not_supported','status',501); end if;
 if c.type='balance' then
  result:=public.s2a_wallet_adjust(p_user_id,c.value,'redeem',c.id::text);
  if result ? 'error' then return result; end if;
 elsif c.type='concurrency' then
  select concurrency+c.value::integer into next_limit from public.s2a_user_limits where user_id=p_user_id;
  if next_limit not between 0 and 1000000 then return jsonb_build_object('error','invalid_resulting_concurrency','status',400); end if;
  update public.s2a_user_limits set concurrency=next_limit where user_id=p_user_id;
  result:=jsonb_build_object('new_concurrency',next_limit);
 end if;
 update public.s2a_redeem_codes set status='used',used_by=p_user_id,used_at=now() where id=c.id;
 return public.s2a_redeem_dto(c.id,p_admin)||jsonb_build_object('message','Code redeemed successfully')||
  case when c.type='balance' then jsonb_build_object('new_balance',result->'balance') else result end;
end $$;

create function public.s2a_redeem_create_and_use(p_user_id uuid,p_code text,p_type text,p_value numeric,
 p_expires_at timestamptz default null,p_notes text default '')
returns jsonb language plpgsql set search_path='' as $$
declare c public.s2a_redeem_codes; result jsonb;
begin
 if p_code is null or length(trim(p_code)) not between 3 and 128 or p_type is null or p_type not in ('balance','concurrency')
  or p_value is null or p_value::text in ('NaN','Infinity','-Infinity') or p_value=0 or abs(p_value)>1000000000 or p_value<>round(p_value,8)
  or p_type='concurrency' and (p_value<>trunc(p_value) or abs(p_value)>1000000)
  or p_notes is null or length(p_notes)>10000 or p_expires_at<=now() then
  return jsonb_build_object('error','invalid_redeem_code','status',400);
 end if;
 if not exists(select 1 from auth.users where id=p_user_id and (banned_until is null or banned_until<=now())) then return jsonb_build_object('error','user_not_found','status',404); end if;
 insert into public.s2a_user_limits(user_id) values(p_user_id) on conflict do nothing;
 perform 1 from public.s2a_user_limits where user_id=p_user_id for update;
 insert into public.s2a_redeem_codes(code,type,value,expires_at,notes) values(trim(p_code),p_type,p_value,p_expires_at,p_notes) on conflict(code) do nothing;
 select * into c from public.s2a_redeem_codes where code=trim(p_code) for update;
 if c.type<>p_type or c.value<>p_value or c.status='used' and c.used_by is distinct from p_user_id then
  return jsonb_build_object('error','redeem_code_conflict','status',409);
 end if;
 result:=public.s2a_redeem_use(p_user_id,p_code,true);
 if result ? 'error' then return result; end if;
 return jsonb_build_object('redeem_code',public.s2a_redeem_dto(c.id,true));
end $$;

create function public.s2a_redeem_mutate(p_ids uuid[],p_operation text,p_fields jsonb default '{}')
returns jsonb language plpgsql set search_path='' as $$
declare affected integer;
begin
 if cardinality(p_ids) is null or cardinality(p_ids) not between 1 and 500 or p_operation is null or p_operation not in ('delete','update','expire') or p_fields is null or jsonb_typeof(p_fields)<>'object' or exists(select 1 from unnest(p_ids) id where id is null) then
  return jsonb_build_object('error','invalid_redeem_update','status',400);
 end if;
 perform 1 from public.s2a_redeem_codes where id=any(p_ids) order by id for update;
 if p_operation<>'delete' and (select count(*) from public.s2a_redeem_codes where id=any(p_ids))<>(select count(distinct id) from unnest(p_ids) id) then
  return jsonb_build_object('error','redeem_code_not_found','status',404);
 end if;
 if p_operation='delete' then
  delete from public.s2a_redeem_codes where id=any(p_ids) and status<>'used';
  get diagnostics affected=row_count;
  return jsonb_build_object('deleted',affected,'message','Redeem codes deleted');
 end if;
 if exists(select 1 from public.s2a_redeem_codes where id=any(p_ids) and status='used') and (p_operation='expire' or p_fields ?| array['status','expires_at','group_id']) then
  return jsonb_build_object('error','used_redeem_code_immutable','status',409);
 end if;
 if p_operation='expire' then
  update public.s2a_redeem_codes set status='expired' where id=any(p_ids);
 else
  if p_fields='{}' or exists(select 1 from jsonb_object_keys(p_fields) k where k not in ('status','expires_at','notes','group_id'))
   or p_fields ? 'status' and coalesce(p_fields->>'status','') not in ('unused','disabled')
   or p_fields ? 'notes' and (jsonb_typeof(p_fields->'notes')<>'string' or length(p_fields->>'notes')>10000)
   or p_fields->>'expires_at' is not null and (p_fields->>'expires_at')::timestamptz<=now() then
   return jsonb_build_object('error','invalid_redeem_update','status',400);
  end if;
  if p_fields ? 'group_id' and exists(select 1 from public.s2a_redeem_codes where id=any(p_ids) and
    (type='subscription' and p_fields->>'group_id' is null or p_fields->>'group_id' is not null and not exists(select 1 from public.s2a_groups where id=(p_fields->>'group_id')::uuid))) then
   return jsonb_build_object('error','invalid_redeem_group','status',400);
  end if;
  update public.s2a_redeem_codes set
   status=case when p_fields ? 'status' then p_fields->>'status' else status end,
   notes=case when p_fields ? 'notes' then p_fields->>'notes' else notes end,
   expires_at=case when p_fields ? 'expires_at' then (p_fields->>'expires_at')::timestamptz else expires_at end,
   group_id=case when p_fields ? 'group_id' then (p_fields->>'group_id')::uuid else group_id end
   where id=any(p_ids);
 end if;
 get diagnostics affected=row_count;
 return jsonb_build_object('updated',affected,'message','Redeem codes updated');
exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
 return jsonb_build_object('error','invalid_redeem_update','status',400);
end $$;

create function public.s2a_redeem_list(p_user_id uuid default null,p_page integer default 1,p_size integer default 20,
 p_type text default '',p_status text default '',p_search text default '',p_sort text default 'created_at',p_order text default 'desc')
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare items jsonb; total bigint; clause text; field text;
begin
 if p_page is null or p_size is null or p_sort is null or p_order is null or p_page not between 1 and 1000000 or p_size not between 1 and 10000 or p_sort not in ('id','code','type','value','status','created_at','used_at','expires_at') or p_order not in ('asc','desc') then
  return jsonb_build_object('error','invalid_redeem_query','status',400);
 end if;
 field:=case when p_sort='status' then 'effective_status' else p_sort end;
 clause:='from (select c.*,case when c.status<>''used'' and c.expires_at<=now() then ''expired'' else c.status end effective_status from public.s2a_redeem_codes c) c
 where ($1 is null or c.used_by=$1) and ($2='''' or c.type=$2) and ($3='''' or c.effective_status=$3)
 and strpos(lower(c.code),lower($4))>0';
 execute 'select count(*) '||clause into total using p_user_id,p_type,case when p_status='active' then 'unused' else p_status end,p_search;
 execute format('select coalesce(jsonb_agg(public.s2a_redeem_dto(id,$1 is null)),''[]''::jsonb) from
  (select id %s order by %I %s,id %s limit $5 offset $6) page',clause,field,p_order,p_order)
  into items using p_user_id,p_type,case when p_status='active' then 'unused' else p_status end,p_search,p_size,(p_page-1)::bigint*p_size;
 return jsonb_build_object('items',items,'total',total,'page',p_page,'page_size',p_size,'pages',ceil(total::numeric/p_size));
end $$;

create function public.s2a_redeem_stats() returns jsonb language sql stable set search_path='' as $$
 with codes as(select *,case when status<>'used' and expires_at<=now() then 'expired' else status end effective_status from public.s2a_redeem_codes)
 select jsonb_build_object('total_codes',count(*),'active_codes',count(*) filter(where effective_status='unused'),
 'used_codes',count(*) filter(where status='used'),'expired_codes',count(*) filter(where effective_status='expired'),
 'disabled_codes',count(*) filter(where effective_status='disabled'),
 'total_value_distributed',coalesce(sum(value) filter(where status='used' and type='balance'),0),
 'by_type',jsonb_build_object('balance',count(*) filter(where type='balance'),'concurrency',count(*) filter(where type='concurrency'),
 'subscription',count(*) filter(where type='subscription'),'invitation',count(*) filter(where type='invitation'))) from codes;
$$;
do $$ declare fn record; begin
 for fn in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in
 ('s2a_redeem_guard','s2a_redeem_dto','s2a_redeem_generate','s2a_redeem_use','s2a_redeem_create_and_use','s2a_redeem_mutate','s2a_redeem_list','s2a_redeem_stats') loop
  execute format('revoke all on function %s from public,anon,authenticated',fn.signature);
  if fn.signature::text not like '%s2a_redeem_guard%' then execute format('grant execute on function %s to service_role',fn.signature); end if;
 end loop;
end $$;

create or replace function public.s2a_wallet_history(p_user_id uuid,p_page integer,p_size integer,p_type text default '')
returns jsonb language sql stable set search_path='' as $$
 with entries as (
  select id,'admin_balance'::text type,delta value,created_at,
   jsonb_build_object('id',id,'code','','type','admin_balance','value',delta,'status','used',
    'used_by',user_id,'used_at',created_at,'created_at',created_at,'group_id',null,'validity_days',0,
    'notes',notes,'balance_after',balance_after) data
   from public.s2a_wallet_ledger where user_id=p_user_id and reason in ('admin_set','admin_add','admin_subtract')
  union all
  select id,type,value,used_at,public.s2a_redeem_dto(id,true)
   from public.s2a_redeem_codes where used_by=p_user_id and status='used'
 ), filtered as(select * from entries where p_type='' or type=p_type),
 page as(select data from filtered order by created_at desc,id desc limit p_size offset(p_page-1)::bigint*p_size)
 select jsonb_build_object('items',coalesce((select jsonb_agg(data) from page),'[]'::jsonb),
  'total',(select count(*) from filtered),'page',p_page,'page_size',p_size,'pages',ceil((select count(*) from filtered)::numeric/p_size),
  'total_recharged',coalesce((select sum(delta) from public.s2a_wallet_ledger where user_id=p_user_id and reason='admin_add' and delta>0),0)+
   coalesce((select sum(value) from public.s2a_redeem_codes where used_by=p_user_id and status='used' and type='balance' and value>0),0));
$$;
