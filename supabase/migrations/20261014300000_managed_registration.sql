create table public.s2a_registration_authorizations (
 token_hash text primary key check(token_hash ~ '^[0-9a-f]{64}$'),
 email text not null,
 expires_at timestamptz not null default (now()+interval '5 minutes')
);
alter table public.s2a_registration_authorizations enable row level security;
revoke all on public.s2a_registration_authorizations from public,anon,authenticated,service_role;
create function public.s2a_registration_authorize(p_email text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare token text:=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
begin
 if p_email is null or length(p_email)>320 or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then return jsonb_build_object('error','invalid_email','status',400);end if;
 delete from public.s2a_registration_authorizations where expires_at<=now();
 insert into public.s2a_registration_authorizations(token_hash,email) values(encode(sha256(convert_to(token,'UTF8')),'hex'),lower(trim(p_email)));
 return jsonb_build_object('token',token);
end $$;
revoke all on function public.s2a_registration_authorize(text) from public,anon,authenticated;
grant execute on function public.s2a_registration_authorize(text) to service_role;

create or replace function public.s2a_registration_bootstrap() returns trigger
language plpgsql security definer set search_path='' as $$
declare settings jsonb; invitation public.s2a_redeem_codes; supplied text; suffix text; rule text; allowed boolean:=false; entry jsonb; result jsonb; authorized text; capability text;
begin
 capability:=coalesce(new.raw_user_meta_data->>'s2a_registration_ticket','');
 if length(capability)=64 then
  delete from public.s2a_registration_authorizations
   where token_hash=encode(sha256(convert_to(capability,'UTF8')),'hex') and email=lower(new.email) and expires_at>now()
   returning token_hash into authorized;
 end if;
 -- GoTrue admin creation writes app metadata after insertion; its backend ticket supplies the trusted context.
 if authorized is not null or new.raw_app_meta_data->>'s2a_managed_user'='true' then
  update auth.users set raw_user_meta_data=raw_user_meta_data-'s2a_registration_ticket'-'invitation_code' where id=new.id;
  return new;
 end if;
 select data into settings from public.s2a_settings for share;
 if not (settings->>'registration_enabled')::boolean then raise check_violation using message='registration_disabled'; end if;
 suffix:=lower(split_part(coalesce(new.email,''),'@',2));
 if jsonb_array_length(settings->'registration_email_suffix_whitelist')>0 then
  for rule in select jsonb_array_elements_text(settings->'registration_email_suffix_whitelist') loop
   if left(rule,2)='*.' then
    allowed:=allowed or (length(suffix)>length(substring(rule from 3))+1 and right(suffix,length(substring(rule from 3))+1)='.'||substring(rule from 3));
   else allowed:=allowed or suffix=ltrim(rule,'@'); end if;
  end loop;
  if not allowed then raise check_violation using message='email_suffix_not_allowed'; end if;
 end if;
 supplied:=trim(coalesce(new.raw_user_meta_data->>'invitation_code',''));
 if (settings->>'invitation_code_enabled')::boolean then
  if supplied='' then raise check_violation using message='invitation_code_required'; end if;
  select * into invitation from public.s2a_redeem_codes where code=supplied and type='invitation' for update;
  if not found or invitation.status<>'unused' or invitation.expires_at<=now() then raise check_violation using message='invitation_code_invalid'; end if;
  update public.s2a_redeem_codes set status='used',used_by=new.id,used_at=now() where id=invitation.id;
 end if;
 insert into public.s2a_user_limits(user_id,concurrency,rpm_limit)
  values(new.id,(settings->>'default_concurrency')::integer,(settings->>'default_user_rpm_limit')::integer);
 if (settings->>'default_balance')::numeric>0 then
  result:=public.s2a_wallet_adjust(new.id,(settings->>'default_balance')::numeric,'signup','Signup credit');
  if result ? 'error' then raise check_violation using message='signup_balance_failed'; end if;
 end if;
 for entry in select value from jsonb_array_elements(settings->'default_subscriptions') loop
  result:=public.s2a_subscription_assign(new.id,(entry->>'group_id')::uuid,(entry->>'validity_days')::integer);
  if result ? 'error' then raise check_violation using message='signup_subscription_failed'; end if;
 end loop;
 if new.raw_user_meta_data ? 'invitation_code' or new.raw_user_meta_data ? 's2a_registration_ticket' then
  update auth.users set raw_user_meta_data=raw_user_meta_data-'invitation_code'-'s2a_registration_ticket' where id=new.id;
 end if;
 return new;
end $$;

create function public.s2a_registration_metadata() returns trigger language plpgsql set search_path='' as $$
begin
 new.raw_user_meta_data:=new.raw_user_meta_data-'s2a_registration_ticket'-'invitation_code';
 return new;
end $$;
revoke all on function public.s2a_registration_metadata() from public,anon,authenticated,service_role;
create trigger s2a_registration_metadata before update of raw_user_meta_data on auth.users for each row execute function public.s2a_registration_metadata();
