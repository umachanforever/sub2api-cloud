-- Use transaction-local mutation events, and never persist changed values.
create or replace function public.s2a_audit_mutation() returns trigger
language plpgsql security definer set search_path = '' as $$
declare headers jsonb; before_row jsonb; after_row jsonb; changed jsonb;
begin
  -- Native Auth does not supply trustworthy application actor headers.
  headers := case when tg_table_schema = 'auth' then '{}'::jsonb
    else coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb end;
  before_row := case when tg_op = 'INSERT' then '{}'::jsonb else to_jsonb(old) end;
  after_row := case when tg_op = 'DELETE' then '{}'::jsonb else to_jsonb(new) end;
  select coalesce(jsonb_agg(case when k='encrypted_password' then 'password' else k end order by k), '[]'::jsonb) into changed
  from jsonb_object_keys(before_row || after_row) k
  where k not in ('ciphertext','iv','key_hash','refresh_lock_id','refresh_lock_until',
    'last_used_at','window_start','window_count','credential_version','cooldown_until')
    and (tg_table_schema <> 'auth' or k in ('email','phone','encrypted_password','banned_until','raw_user_meta_data','raw_app_meta_data','deleted_at','last_sign_in_at','email_confirmed_at','phone_confirmed_at','is_anonymous','is_sso_user','role','id','user_id','factor_type','status','friendly_name'))
    and (tg_op <> 'UPDATE' or k not in ('created_at','updated_at'))
    and before_row->k is distinct from after_row->k;
  if tg_op = 'UPDATE' and (before_row->'ciphertext' is distinct from after_row->'ciphertext'
    or before_row->'iv' is distinct from after_row->'iv') then
    changed := changed || '["credentials"]'::jsonb;
  end if;
  if changed = '[]'::jsonb then
    return coalesce(new,old);
  end if;
  insert into public.s2a_audit_logs(actor_user_id,actor_email,actor_role,auth_method,
    action,method,path,request_id,extra)
  values(nullif(headers->>'x-s2a-actor-id','')::uuid,
    coalesce(headers->>'x-s2a-actor-email',''),
    coalesce(headers->>'x-s2a-actor-role','system'),
    case when tg_table_schema = 'auth' then 'supabase-auth' when headers ? 'x-s2a-actor-id' then 'jwt' else 'service' end,
    case when tg_table_schema = 'auth' then 'auth.' else '' end || tg_table_name || '.' || lower(tg_op),
    coalesce(headers->>'x-s2a-request-method',''),
    coalesce(headers->>'x-s2a-request-path',''),
    coalesce(headers->>'x-s2a-request-id',''),
    jsonb_build_object('resource_id',coalesce(after_row->>'id',before_row->>'id',after_row->>'announcement_id',before_row->>'announcement_id'),
      'changed_fields',changed,'resource_refs',jsonb_strip_nulls(jsonb_build_object(
        'user_id',coalesce(after_row->>'user_id',before_row->>'user_id'),
        'group_id',coalesce(after_row->>'group_id',before_row->>'group_id'),
        'announcement_id',coalesce(after_row->>'announcement_id',before_row->>'announcement_id')))));
  return coalesce(new,old);
end $$;
create trigger s2a_announcements_audit after insert or update or delete on public.s2a_announcements
  for each row execute function public.s2a_audit_mutation();
create trigger s2a_announcement_reads_audit after insert or update or delete on public.s2a_announcement_reads
  for each row execute function public.s2a_audit_mutation();
create trigger s2a_auth_users_audit after insert or update or delete on auth.users
  for each row execute function public.s2a_audit_mutation();
create trigger s2a_auth_factors_audit after insert or update or delete on auth.mfa_factors
  for each row execute function public.s2a_audit_mutation();
