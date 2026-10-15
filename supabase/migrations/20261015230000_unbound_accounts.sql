alter table public.s2a_accounts alter column group_id drop not null;

create or replace function public.s2a_account_group_seed() returns trigger
language plpgsql set search_path = '' as $$
begin
 if tg_op='UPDATE' and old.group_id is distinct from new.group_id then
  delete from public.s2a_account_groups where account_id=new.id and group_id=old.group_id;
 end if;
 if new.group_id is not null then
  insert into public.s2a_account_groups(account_id,group_id) values(new.id,new.group_id) on conflict do nothing;
 end if;
 return new;
end $$;

create or replace function public.s2a_account_groups_replace(p_account_id uuid, p_group_ids uuid[])
returns jsonb language plpgsql set search_path = '' as $$
declare a public.s2a_accounts; primary_group uuid;
begin
  if p_group_ids is null or cardinality(p_group_ids)>100 or array_position(p_group_ids,null) is not null or cardinality(p_group_ids)<>(select count(distinct x) from unnest(p_group_ids) x) then
    return jsonb_build_object('error','group_required','status',400);
  end if;
  select * into a from public.s2a_accounts where id = p_account_id for update;
  if not found then return jsonb_build_object('error','account_not_found','status',404); end if;
  if (select count(*) from public.s2a_groups g where g.id = any(p_group_ids) and g.platform = a.platform) <> cardinality(p_group_ids)
    then return jsonb_build_object('error','account_group_platform_mismatch','status',400); end if;
  primary_group := p_group_ids[1];
  update public.s2a_accounts set group_id = primary_group where id = a.id;
  delete from public.s2a_account_groups where account_id = a.id;
  insert into public.s2a_account_groups(account_id, group_id)
    select a.id, g from unnest(p_group_ids) as g;
  return jsonb_build_object('account_id', a.id, 'group_ids', to_jsonb(p_group_ids));
end $$;
revoke all on function public.s2a_account_groups_replace(uuid,uuid[]) from public, anon, authenticated;
grant execute on function public.s2a_account_groups_replace(uuid,uuid[]) to service_role;

create or replace function public.s2a_oauth_account_create(p_ticket_id uuid,p_user_id uuid,p_group_id uuid,p_name text,
  p_concurrency integer,p_priority integer,p_notes text default '',p_extra jsonb default '{}',p_schedulable boolean default true,p_expires_at timestamptz default null,p_auto_pause_on_expired boolean default true,p_status text default 'active')
returns jsonb language plpgsql set search_path='' as $$
declare t public.s2a_oauth_tickets; a public.s2a_accounts;
begin
  select * into t from public.s2a_oauth_tickets where id=p_ticket_id and user_id=p_user_id and expires_at > now() for update;
  if not found then return jsonb_build_object('error','oauth_ticket_invalid','status',400); end if;
  if t.used_account_id is not null then
    if t.used_for <> 'create' then return jsonb_build_object('error','oauth_ticket_used','status',409); end if;
    return jsonb_build_object('id',t.used_account_id);
  end if;
  if p_group_id is not null then
    perform 1 from public.s2a_groups where id=p_group_id and platform='openai' for share;
    if not found then return jsonb_build_object('error','account_group_platform_mismatch','status',400); end if;
  end if;
  insert into public.s2a_accounts(group_id,name,platform,type,concurrency,priority,notes,extra,account_fingerprint,ciphertext,iv,schedulable,expires_at,auto_pause_on_expired,status)
    values(p_group_id,p_name,'openai','oauth',p_concurrency,p_priority,p_notes,t.metadata || p_extra,t.account_fingerprint,t.ciphertext,t.iv,p_schedulable,p_expires_at,p_auto_pause_on_expired,p_status)
    returning * into a;
  update public.s2a_oauth_tickets set used_account_id=a.id,used_for='create',ciphertext=null,iv=null where id=t.id;
  return jsonb_build_object('id',a.id);
end $$;
revoke all on function public.s2a_oauth_account_create(uuid,uuid,uuid,text,integer,integer,text,jsonb,boolean,timestamptz,boolean,text) from public,anon,authenticated;
grant execute on function public.s2a_oauth_account_create(uuid,uuid,uuid,text,integer,integer,text,jsonb,boolean,timestamptz,boolean,text) to service_role;

create or replace function public.s2a_account_save(p_account_id uuid,p_patch jsonb,p_groups uuid[],
 p_oauth_ticket uuid default null,p_user_id uuid default null,p_rotation jsonb default null)
returns jsonb language plpgsql set search_path='' as $$
declare a public.s2a_accounts; v public.s2a_accounts; provider text; result jsonb; ticket public.s2a_oauth_tickets;
begin
 if p_groups is null or cardinality(p_groups) not between 0 and 100 or array_position(p_groups,null) is not null
  or cardinality(p_groups)<>(select count(distinct x) from unnest(p_groups) x)
  or p_patch is null or jsonb_typeof(p_patch)<>'object' then return jsonb_build_object('error','invalid_account_groups','status',400);end if;
 if p_account_id is null then
  if exists(select 1 from jsonb_object_keys(p_patch) k where k not in
   ('name','notes','extra','model_mapping','status','priority','concurrency','rate_multiplier','load_factor','group_id','schedulable','expires_at','auto_pause_on_expired','platform','type','account_fingerprint','ciphertext','iv')) then return jsonb_build_object('error','invalid_account_update','status',400);end if;
  provider:=p_patch->>'platform';
  if p_rotation is not null then return jsonb_build_object('error','invalid_account_update','status',400);end if;
  if p_oauth_ticket is not null then
   select * into ticket from public.s2a_oauth_tickets where id=p_oauth_ticket and user_id=p_user_id and expires_at>now() for update;
   if not found then return jsonb_build_object('error','oauth_ticket_invalid','status',400);end if;
   if ticket.used_account_id is not null then
    if ticket.used_for<>'create' then return jsonb_build_object('error','oauth_ticket_used','status',409);end if;
    return jsonb_build_object('id',ticket.used_account_id);
   end if;
   if provider<>'openai' or p_patch->>'type'<>'oauth' then return jsonb_build_object('error','oauth_ticket_provider_mismatch','status',400);end if;
  end if;
 else
  if p_oauth_ticket is not null or exists(select 1 from jsonb_object_keys(p_patch) k where k not in
   ('name','notes','extra','model_mapping','status','priority','concurrency','rate_multiplier','load_factor','group_id','schedulable','expires_at','auto_pause_on_expired')) then return jsonb_build_object('error','invalid_account_update','status',400);end if;
  select * into a from public.s2a_accounts where id=p_account_id for update;
  if not found then return jsonb_build_object('error','account_not_found','status',404);end if;
  provider:=a.platform;
 end if;
 -- Hold every routing group until metadata, credentials, and memberships commit together.
 perform id from public.s2a_groups where id=any(p_groups) and platform=provider order by id for share;
 if (select count(*) from public.s2a_groups where id=any(p_groups) and platform=provider)<>cardinality(p_groups) then return jsonb_build_object('error','account_group_platform_mismatch','status',400);end if;
 p_patch:=p_patch||jsonb_build_object('group_id',p_groups[1]);
 if p_account_id is null then
  if p_oauth_ticket is not null then
   result:=public.s2a_oauth_account_create(p_oauth_ticket,p_user_id,p_groups[1],p_patch->>'name',(p_patch->>'concurrency')::integer,(p_patch->>'priority')::integer,
    p_patch->>'notes',p_patch->'extra',(p_patch->>'schedulable')::boolean,(p_patch->>'expires_at')::timestamptz,(p_patch->>'auto_pause_on_expired')::boolean,p_patch->>'status');
   if result ? 'error' then return result;end if;
   p_account_id:=(result->>'id')::uuid;
   update public.s2a_accounts set model_mapping=coalesce(p_patch->'model_mapping','{}'),rate_multiplier=coalesce((p_patch->>'rate_multiplier')::numeric,1),load_factor=(p_patch->>'load_factor')::integer where id=p_account_id;
  else
   v:=jsonb_populate_record(null::public.s2a_accounts,p_patch);
   insert into public.s2a_accounts(name,notes,extra,status,priority,concurrency,group_id,schedulable,expires_at,auto_pause_on_expired,platform,type,account_fingerprint,ciphertext,iv,rate_multiplier,load_factor,model_mapping)
    values(v.name,v.notes,v.extra,v.status,v.priority,v.concurrency,v.group_id,v.schedulable,v.expires_at,v.auto_pause_on_expired,v.platform,v.type,v.account_fingerprint,v.ciphertext,v.iv,coalesce(v.rate_multiplier,1),v.load_factor,coalesce(v.model_mapping,'{}')) returning id into p_account_id;
  end if;
 elsif p_rotation is not null then
  result:=public.s2a_apikey_account_update(p_account_id,provider,(p_rotation->>'expected_version')::integer,p_rotation->>'fingerprint',p_rotation->>'ciphertext',p_rotation->>'iv',p_patch);
  if result ? 'error' then return result;end if;
 else
  v:=jsonb_populate_record(a,p_patch);
  update public.s2a_accounts set name=v.name,notes=v.notes,extra=v.extra,status=v.status,priority=v.priority,concurrency=v.concurrency,model_mapping=v.model_mapping,rate_multiplier=v.rate_multiplier,load_factor=v.load_factor,
   group_id=v.group_id,schedulable=v.schedulable,expires_at=v.expires_at,auto_pause_on_expired=v.auto_pause_on_expired where id=a.id;
 end if;
 result:=public.s2a_account_groups_replace(p_account_id,p_groups);
 if result ? 'error' then raise check_violation using message='account_groups_save_failed';end if;
 return jsonb_build_object('id',p_account_id);
exception when unique_violation then return jsonb_build_object('error','account_credentials_already_registered','status',409);
end $$;

create or replace function public.s2a_account_group_platform_check()
returns trigger language plpgsql set search_path = '' as $$
declare group_platform text;
begin
  if new.group_id is null then return new;end if;
  select platform into group_platform from public.s2a_groups where id = new.group_id for share;
  if group_platform is null or group_platform <> new.platform then
    raise check_violation using message = 'account_group_platform_mismatch';
  end if;
  return new;
end $$;
