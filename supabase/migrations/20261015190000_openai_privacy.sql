create function public.s2a_account_privacy_save(p_account_id uuid,p_version bigint,p_previous jsonb,p_mode text)
returns boolean language plpgsql set search_path = '' as $$
begin
  if p_mode not in ('training_off','training_set_failed','training_set_cf_blocked') or p_mode is null then
    raise exception 'invalid_privacy_mode';
  end if;
  update public.s2a_accounts set extra = extra || jsonb_build_object('privacy_mode',p_mode)
    where id=p_account_id and credential_version=p_version and platform='openai' and type='oauth'
      and nullif(extra->'privacy_mode','null'::jsonb) is not distinct from p_previous;
  return found;
end $$;
revoke all on function public.s2a_account_privacy_save(uuid,bigint,jsonb,text) from public,anon,authenticated;
grant execute on function public.s2a_account_privacy_save(uuid,bigint,jsonb,text) to service_role;
notify pgrst,'reload schema';
