create function public.s2a_account_save(p_account_id uuid,p_patch jsonb,p_groups uuid[],
 p_oauth_ticket uuid default null,p_user_id uuid default null,p_rotation jsonb default null)
returns jsonb language plpgsql set search_path='' as $$
declare a public.s2a_accounts; v public.s2a_accounts; provider text; result jsonb; ticket public.s2a_oauth_tickets;
begin
 if p_groups is null or cardinality(p_groups) not between 1 and 100 or array_position(p_groups,null) is not null
  or cardinality(p_groups)<>(select count(distinct x) from unnest(p_groups) x)
  or p_patch is null or jsonb_typeof(p_patch)<>'object' then return jsonb_build_object('error','invalid_account_groups','status',400);end if;
 if p_account_id is null then
  if exists(select 1 from jsonb_object_keys(p_patch) k where k not in
   ('name','notes','extra','status','priority','concurrency','group_id','schedulable','expires_at','auto_pause_on_expired','platform','type','account_fingerprint','ciphertext','iv')) then return jsonb_build_object('error','invalid_account_update','status',400);end if;
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
   ('name','notes','extra','status','priority','concurrency','group_id','schedulable','expires_at','auto_pause_on_expired')) then return jsonb_build_object('error','invalid_account_update','status',400);end if;
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
  else
   v:=jsonb_populate_record(null::public.s2a_accounts,p_patch);
   insert into public.s2a_accounts(name,notes,extra,status,priority,concurrency,group_id,schedulable,expires_at,auto_pause_on_expired,platform,type,account_fingerprint,ciphertext,iv)
    values(v.name,v.notes,v.extra,v.status,v.priority,v.concurrency,v.group_id,v.schedulable,v.expires_at,v.auto_pause_on_expired,v.platform,v.type,v.account_fingerprint,v.ciphertext,v.iv) returning id into p_account_id;
  end if;
 elsif p_rotation is not null then
  result:=public.s2a_apikey_account_update(p_account_id,provider,(p_rotation->>'expected_version')::integer,p_rotation->>'fingerprint',p_rotation->>'ciphertext',p_rotation->>'iv',p_patch);
  if result ? 'error' then return result;end if;
 else
  v:=jsonb_populate_record(a,p_patch);
  update public.s2a_accounts set name=v.name,notes=v.notes,extra=v.extra,status=v.status,priority=v.priority,concurrency=v.concurrency,
   group_id=v.group_id,schedulable=v.schedulable,expires_at=v.expires_at,auto_pause_on_expired=v.auto_pause_on_expired where id=a.id;
 end if;
 result:=public.s2a_account_groups_replace(p_account_id,p_groups);
 if result ? 'error' then raise check_violation using message='account_groups_save_failed';end if;
 return jsonb_build_object('id',p_account_id);
exception when unique_violation then return jsonb_build_object('error','account_credentials_already_registered','status',409);
end $$;
revoke all on function public.s2a_account_save(uuid,jsonb,uuid[],uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.s2a_account_save(uuid,jsonb,uuid[],uuid,uuid,jsonb) to service_role;
