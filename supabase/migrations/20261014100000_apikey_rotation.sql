-- Rotate credentials and save the editor's metadata under the scheduler's account lock.
create function public.s2a_apikey_account_update(p_account_id uuid,p_platform text,p_expected_version integer,
  p_fingerprint text,p_ciphertext text,p_iv text,p_patch jsonb default '{}')
returns jsonb language plpgsql set search_path='' as $$
declare a public.s2a_accounts; v public.s2a_accounts; changed boolean;
begin
  if jsonb_typeof(p_patch) is distinct from 'object' or exists(
    select 1 from jsonb_object_keys(p_patch) k where k not in
    ('name','notes','extra','status','priority','concurrency','group_id','schedulable','expires_at','auto_pause_on_expired')
  ) then return jsonb_build_object('error','invalid_account_update','status',400); end if;
  if p_fingerprint is null or length(p_fingerprint) <> 64 or coalesce(p_ciphertext,'')='' or coalesce(p_iv,'')='' then
    return jsonb_build_object('error','invalid_credentials','status',400);
  end if;
  select * into a from public.s2a_accounts where id=p_account_id for update;
  if not found then return jsonb_build_object('error','account_not_found','status',404); end if;
  if a.type <> 'apikey' or a.platform is distinct from p_platform then
    return jsonb_build_object('error','account_provider_type_mismatch','status',400);
  end if;
  if a.credential_version is distinct from p_expected_version then
    return jsonb_build_object('error','credential_version_conflict','status',409);
  end if;
  if a.refresh_lock_until > now() or exists(select 1 from public.s2a_leases where account_id=a.id and expires_at>now()) then
    return jsonb_build_object('error','account_busy_retry_after_requests','status',409);
  end if;
  v:=jsonb_populate_record(a,p_patch);
  changed:=a.account_fingerprint <> p_fingerprint;
  update public.s2a_accounts set name=v.name,notes=v.notes,extra=v.extra,status=v.status,
    priority=v.priority,concurrency=v.concurrency,group_id=v.group_id,schedulable=v.schedulable,
    expires_at=v.expires_at,auto_pause_on_expired=v.auto_pause_on_expired,
    account_fingerprint=p_fingerprint,
    ciphertext=case when changed then p_ciphertext else a.ciphertext end,
    iv=case when changed then p_iv else a.iv end,
    credential_version=a.credential_version+case when changed then 1 else 0 end,
    cooldown_until=case when changed then null else a.cooldown_until end where id=a.id;
  return jsonb_build_object('ok',true);
exception when unique_violation then
  return jsonb_build_object('error','account_credentials_already_registered','status',409);
end $$;
revoke all on function public.s2a_apikey_account_update(uuid,text,integer,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.s2a_apikey_account_update(uuid,text,integer,text,text,text,jsonb) to service_role;
