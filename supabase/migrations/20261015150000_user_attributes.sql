create table public.s2a_attribute_definitions (
 id bigint generated always as identity primary key,
 key text not null check(length(key) between 1 and 100),name text not null check(length(name) between 1 and 255),
 description text not null default '' check(length(description)<=10000),
 type text not null check(type in ('text','textarea','number','email','url','date','select','multi_select')),
 options jsonb not null default '[]' check(jsonb_typeof(options)='array'),
 required boolean not null default false,validation jsonb not null default '{}' check(jsonb_typeof(validation)='object'),
 placeholder text not null default '' check(length(placeholder)<=10000),display_order integer not null default 0,enabled boolean not null default false,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),deleted_at timestamptz
);
create unique index s2a_attribute_key on public.s2a_attribute_definitions(key) where deleted_at is null;
create table public.s2a_attribute_values (
 id bigint generated always as identity primary key,
 user_id uuid not null references auth.users(id) on delete cascade,
 attribute_id bigint not null references public.s2a_attribute_definitions(id),
 value text not null check(length(value)<=10000),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(user_id,attribute_id)
);
create index s2a_attribute_values_filter on public.s2a_attribute_values(attribute_id,user_id);
alter table public.s2a_attribute_definitions enable row level security;
alter table public.s2a_attribute_values enable row level security;
revoke all on public.s2a_attribute_definitions,public.s2a_attribute_values from public,anon,authenticated;
grant select,insert,update,delete on public.s2a_attribute_definitions,public.s2a_attribute_values to service_role;
grant usage,select on sequence public.s2a_attribute_definitions_id_seq,public.s2a_attribute_values_id_seq to service_role;
create trigger s2a_attribute_definition_audit after insert or update or delete on public.s2a_attribute_definitions for each row execute function public.s2a_audit_mutation();
create trigger s2a_attribute_value_audit after insert or update or delete on public.s2a_attribute_values for each row execute function public.s2a_audit_mutation();

create function public.s2a_attribute_definition_save(p_id bigint,p_patch jsonb) returns jsonb
language plpgsql set search_path='' as $$
declare d public.s2a_attribute_definitions;merged jsonb;v jsonb;
begin
 if p_patch is null or jsonb_typeof(p_patch)<>'object' then return jsonb_build_object('error','invalid_attribute_definition','status',400);end if;
 if p_patch='{}' or exists(select 1 from jsonb_object_keys(p_patch) k where k not in ('key','name','description','type','options','required','validation','placeholder','enabled','display_order')) then return jsonb_build_object('error','invalid_attribute_definition','status',400);end if;
 perform pg_advisory_xact_lock(hashtextextended('s2a-attribute-definitions',0));
 if p_id is not null then
  select * into d from public.s2a_attribute_definitions where id=p_id and deleted_at is null for update;
  if not found then return jsonb_build_object('error','attribute_definition_not_found','status',404);end if;
 end if;
 merged:=case when p_id is null then jsonb_build_object('description','','options','[]'::jsonb,'validation','{}'::jsonb,'placeholder','','required',false,'enabled',false,'display_order',coalesce((select max(display_order)+1 from public.s2a_attribute_definitions where deleted_at is null),0)) else to_jsonb(d) end||p_patch;
 if jsonb_typeof(merged->'key') is distinct from 'string' or length(merged->>'key') not between 1 and 100 or jsonb_typeof(merged->'name') is distinct from 'string' or length(merged->>'name') not between 1 and 255 or jsonb_typeof(merged->'type') is distinct from 'string' or merged->>'type' not in ('text','textarea','number','email','url','date','select','multi_select') then return jsonb_build_object('error','invalid_attribute_definition','status',400);end if;
 if jsonb_typeof(merged->'options') is distinct from 'array' or jsonb_typeof(merged->'validation') is distinct from 'object' then return jsonb_build_object('error','invalid_attribute_definition','status',400);end if;
 if jsonb_typeof(merged->'required')<>'boolean' or jsonb_typeof(merged->'enabled')<>'boolean' or jsonb_typeof(merged->'display_order')<>'number' or (merged->>'display_order')::numeric<>trunc((merged->>'display_order')::numeric) then return jsonb_build_object('error','invalid_attribute_definition','status',400);end if;
 if jsonb_array_length(merged->'options')>500 or exists(select 1 from jsonb_array_elements(merged->'options') e where jsonb_typeof(e)<>'object') then return jsonb_build_object('error','invalid_attribute_options','status',400);end if;
 if exists(select 1 from jsonb_array_elements(merged->'options') e where jsonb_typeof(e->'value') is distinct from 'string' or jsonb_typeof(e->'label') is distinct from 'string' or length(e->>'value') not between 1 and 1000 or length(e->>'label') not between 1 and 1000 or exists(select 1 from jsonb_object_keys(e) k where k not in ('value','label'))) or (select count(distinct e->>'value') from jsonb_array_elements(merged->'options') e)<>jsonb_array_length(merged->'options') then return jsonb_build_object('error','invalid_attribute_options','status',400);end if;
 v:=merged->'validation';
 if exists(select 1 from jsonb_object_keys(v) k where k not in ('min_length','max_length','min','max','pattern','message')) then return jsonb_build_object('error','invalid_attribute_validation','status',400);end if;
 if exists(select 1 from jsonb_each(v) x where x.key in ('min_length','max_length','min','max') and jsonb_typeof(x.value) not in ('number','null')) then return jsonb_build_object('error','invalid_attribute_validation','status',400);end if;
 if exists(select 1 from jsonb_each_text(v) x where x.key in ('min_length','max_length','min','max') and x.value is not null and x.value::numeric<>trunc(x.value::numeric)) or (v->>'min_length')::numeric<0 or (v->>'min_length')::numeric>10000 or (v->>'max_length')::numeric<0 or (v->>'max_length')::numeric>10000 or (v->>'min_length')::numeric>(v->>'max_length')::numeric or (v->>'min')::numeric>(v->>'max')::numeric then return jsonb_build_object('error','invalid_attribute_validation','status',400);end if;
 if exists(select 1 from jsonb_each(v) x where x.key in ('pattern','message') and (jsonb_typeof(x.value) not in ('string','null') or length(x.value#>>'{}')>2000)) then return jsonb_build_object('error','invalid_attribute_validation','status',400);end if;
 if coalesce(v->>'pattern','')<>'' then perform '' ~ (v->>'pattern');end if;
 d:=jsonb_populate_record(null::public.s2a_attribute_definitions,merged);
 if p_id is null then
  insert into public.s2a_attribute_definitions(key,name,description,type,options,required,validation,placeholder,display_order,enabled)
   values(d.key,d.name,d.description,d.type,d.options,d.required,d.validation,d.placeholder,d.display_order,d.enabled) returning * into d;
 else
  update public.s2a_attribute_definitions set key=d.key,name=d.name,description=d.description,type=d.type,options=d.options,required=d.required,validation=d.validation,placeholder=d.placeholder,display_order=d.display_order,enabled=d.enabled,updated_at=now() where id=p_id returning * into d;
 end if;
 return to_jsonb(d)-'deleted_at';
exception when unique_violation then return jsonb_build_object('error','attribute_key_exists','status',409);
 when invalid_regular_expression then return jsonb_build_object('error','invalid_attribute_pattern','status',400);
 when invalid_text_representation or numeric_value_out_of_range or not_null_violation or check_violation then return jsonb_build_object('error','invalid_attribute_definition','status',400);
end $$;
create function public.s2a_attribute_definition_delete(p_id bigint) returns jsonb
language plpgsql set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('s2a-attribute-definitions',0));
 perform id from public.s2a_attribute_definitions where id=p_id and deleted_at is null for update;
 if not found then return jsonb_build_object('error','attribute_definition_not_found','status',404);end if;
 delete from public.s2a_attribute_values where attribute_id=p_id;
 update public.s2a_attribute_definitions set deleted_at=now(),updated_at=now() where id=p_id;
 return jsonb_build_object('message','Attribute deleted');
end $$;
create function public.s2a_attribute_reorder(p_ids bigint[]) returns jsonb
language plpgsql set search_path='' as $$
begin
 if p_ids is null or cardinality(p_ids) not between 1 and 500 or exists(select 1 from unnest(p_ids) id where id is null or id<1) or (select count(distinct id) from unnest(p_ids) id)<>cardinality(p_ids) then return jsonb_build_object('error','invalid_attribute_order','status',400);end if;
 perform pg_advisory_xact_lock(hashtextextended('s2a-attribute-definitions',0));
 perform id from public.s2a_attribute_definitions where id=any(p_ids) and deleted_at is null order by id for update;
 if (select count(*) from public.s2a_attribute_definitions where id=any(p_ids) and deleted_at is null)<>cardinality(p_ids) then return jsonb_build_object('error','attribute_definition_not_found','status',404);end if;
 update public.s2a_attribute_definitions d set display_order=x.position-1,updated_at=now() from unnest(p_ids) with ordinality x(id,position) where d.id=x.id;
 return jsonb_build_object('message','Attribute order updated');
end $$;
create function public.s2a_attribute_values_get(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from auth.users where id=p_user_id and deleted_at is null) then return jsonb_build_object('error','user_not_found','status',404);end if;
 return coalesce((select jsonb_agg(to_jsonb(v) order by attribute_id) from public.s2a_attribute_values v where user_id=p_user_id),'[]'::jsonb);
end $$;
create function public.s2a_attribute_values_batch(p_user_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if p_user_ids is null or cardinality(p_user_ids)>500 or array_position(p_user_ids,null) is not null then return jsonb_build_object('error','invalid_attribute_users','status',400);end if;
 return jsonb_build_object('attributes',coalesce((select jsonb_object_agg(user_id,saved_values) from (
  select v.user_id,jsonb_object_agg(attribute_id,value) saved_values from public.s2a_attribute_values v
   join auth.users u on u.id=v.user_id and u.deleted_at is null where v.user_id=any(p_user_ids) group by v.user_id
 ) grouped),'{}'::jsonb));
end $$;
create function public.s2a_attribute_values_set(p_user_id uuid,p_values jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare entry record;d public.s2a_attribute_definitions;v text;rules jsonb;selected jsonb;item text;
begin
 if p_values is null or jsonb_typeof(p_values)<>'object' then return jsonb_build_object('error','invalid_attribute_values','status',400);end if;
 if (select count(*) from jsonb_each(p_values))>500 or exists(select 1 from jsonb_each(p_values) x where x.key !~ '^[1-9][0-9]*$' or jsonb_typeof(x.value)<>'string' or length(x.value#>>'{}')>10000) then return jsonb_build_object('error','invalid_attribute_values','status',400);end if;
 if not exists(select 1 from auth.users where id=p_user_id and deleted_at is null) then return jsonb_build_object('error','user_not_found','status',404);end if;
 perform id from public.s2a_attribute_definitions where id in(select key::bigint from jsonb_each(p_values)) order by id for share;
 if exists(select 1 from jsonb_each(p_values) x where not exists(select 1 from public.s2a_attribute_definitions where id=x.key::bigint and enabled and deleted_at is null)) then return jsonb_build_object('error','attribute_definition_not_found','status',404);end if;
 for entry in select key::bigint id,value from jsonb_each_text(p_values) loop
  select * into d from public.s2a_attribute_definitions where id=entry.id;v:=entry.value;rules:=d.validation;
  if v='' and not d.required then continue;end if;
  if v='' and d.required or length(v)<(rules->>'min_length')::integer or length(v)>(rules->>'max_length')::integer then return jsonb_build_object('error','attribute_value_validation_failed','status',400);end if;
  if d.type='number' then
   if v !~ '^[+-]?[0-9]+$' then return jsonb_build_object('error','attribute_value_validation_failed','status',400);end if;
   perform v::bigint;
   if v::bigint<(rules->>'min')::numeric or v::bigint>(rules->>'max')::numeric then return jsonb_build_object('error','attribute_value_validation_failed','status',400);end if;
  end if;
  if coalesce(rules->>'pattern','')<>'' and v !~ (rules->>'pattern') then return jsonb_build_object('error','attribute_value_validation_failed','status',400,'message',coalesce(nullif(rules->>'message',''),'Attribute format is invalid'));end if;
  if d.type='select' and not exists(select 1 from jsonb_array_elements(d.options) option where option->>'value'=v) then return jsonb_build_object('error','attribute_value_validation_failed','status',400);end if;
  if d.type='multi_select' then
   begin selected:=v::jsonb;exception when invalid_text_representation then selected:=to_jsonb(string_to_array(v,','));end;
   if jsonb_typeof(selected) is distinct from 'array' then selected:=to_jsonb(string_to_array(v,','));
   elsif exists(select 1 from jsonb_array_elements(selected) e where jsonb_typeof(e)<>'string') then selected:=to_jsonb(string_to_array(v,','));end if;
   for item in select jsonb_array_elements_text(selected) loop
    if not exists(select 1 from jsonb_array_elements(d.options) option where option->>'value'=btrim(item)) then return jsonb_build_object('error','attribute_value_validation_failed','status',400);end if;
   end loop;
  end if;
 end loop;
 insert into public.s2a_user_limits(user_id) values(p_user_id) on conflict do nothing;
 perform 1 from public.s2a_user_limits where user_id=p_user_id for update;
 insert into public.s2a_attribute_values(user_id,attribute_id,value)
  select p_user_id,key::bigint,value from jsonb_each_text(p_values) on conflict(user_id,attribute_id) do update set value=excluded.value,updated_at=now();
 return jsonb_build_object('message','Attributes updated');
exception when invalid_text_representation or numeric_value_out_of_range or invalid_regular_expression then return jsonb_build_object('error','attribute_value_validation_failed','status',400);
end $$;
revoke all on function public.s2a_attribute_definition_save(bigint,jsonb) from public,anon,authenticated;
grant execute on function public.s2a_attribute_definition_save(bigint,jsonb) to service_role;
revoke all on function public.s2a_attribute_definition_delete(bigint) from public,anon,authenticated;
grant execute on function public.s2a_attribute_definition_delete(bigint) to service_role;
revoke all on function public.s2a_attribute_reorder(bigint[]) from public,anon,authenticated;
grant execute on function public.s2a_attribute_reorder(bigint[]) to service_role;
revoke all on function public.s2a_attribute_values_get(uuid) from public,anon,authenticated;
grant execute on function public.s2a_attribute_values_get(uuid) to service_role;
revoke all on function public.s2a_attribute_values_batch(uuid[]) from public,anon,authenticated;
grant execute on function public.s2a_attribute_values_batch(uuid[]) to service_role;
revoke all on function public.s2a_attribute_values_set(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.s2a_attribute_values_set(uuid,jsonb) to service_role;
drop function public.s2a_users_list(integer,integer,text,text,text,uuid[],text,text);
create function public.s2a_users_list(p_page integer, p_size integer, p_search text default '',
  p_status text default '', p_role text default '', p_admin_ids uuid[] default '{}'::uuid[],
  p_sort text default 'created_at', p_order text default 'desc',p_group_name text default '',p_key_group_id uuid default null,p_attributes jsonb default '{}')
returns jsonb language sql stable security definer set search_path = '' as $$
  with users as (
    select u.id, coalesce(u.email,'') email, u.banned_until, u.created_at, u.updated_at,
      jsonb_build_object('username',u.raw_user_meta_data->>'username','avatar_url',u.raw_user_meta_data->>'avatar_url') user_metadata,
      jsonb_build_object('s2a_notes',u.raw_app_meta_data->>'s2a_notes') app_metadata,
      case when u.banned_until > now() then 'disabled' else 'active' end status,
      case when u.id = any(p_admin_ids) then 'admin' else 'user' end role
    from auth.users u
    where u.deleted_at is null
      and (p_group_name='' or exists(select 1 from public.s2a_memberships m join public.s2a_groups g on g.id=m.group_id where m.user_id=u.id and position(lower(p_group_name) in lower(g.name))>0))
      and (p_key_group_id is null or exists(select 1 from public.s2a_keys k where k.user_id=u.id and k.group_id=p_key_group_id and k.deleted_at is null))
      and not exists(select 1 from jsonb_each_text(p_attributes) x where not exists(select 1 from public.s2a_attribute_values v where v.user_id=u.id and v.attribute_id=x.key::bigint and position(lower(x.value) in lower(v.value))>0))
      and position(lower(p_search) in lower(coalesce(u.email,'') || ' ' || coalesce(u.raw_user_meta_data->>'username',''))) > 0
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
revoke all on function public.s2a_users_list(integer,integer,text,text,text,uuid[],text,text,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.s2a_users_list(integer,integer,text,text,text,uuid[],text,text,text,uuid,jsonb) to service_role;
notify pgrst,'reload schema';
