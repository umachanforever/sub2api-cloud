create or replace function public.s2a_email_identity(p_email text) returns text
language plpgsql immutable set search_path='' as $$
declare address text:=lower(trim(coalesce(p_email,''))); local_part text; domain text; plus integer;
begin
 if address !~ '^[^@]+@[^@]+$' then return address;end if;
 local_part:=split_part(address,'@',1);domain:=rtrim(split_part(address,'@',2),'.');
 if domain='' then return address;end if;
 plus:=strpos(local_part,'+');if plus>1 then local_part:=substring(local_part from 1 for plus-1);end if;
 if domain in ('gmail.com','googlemail.com') then local_part:=replace(local_part,'.','');domain:='gmail.com';end if;
 return local_part||'@'||domain;
end $$;
revoke all on function public.s2a_email_identity(text) from public,anon,authenticated;
grant execute on function public.s2a_email_identity(text) to service_role;

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
  update auth.users set raw_user_meta_data=raw_user_meta_data-'s2a_registration_ticket'-'invitation_code'-'promo_code' where id=new.id;
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
 -- Serialize aliases before checking the existing inbox identity and issuing signup grants.
 -- shortcut: canonical checks scan Auth users; add a private identity index when registration volume warrants it.
 perform pg_advisory_xact_lock(hashtextextended('s2a-email-alias|'||public.s2a_email_identity(new.email),0));
 if exists(select 1 from auth.users u where u.id<>new.id and public.s2a_email_identity(u.email)=public.s2a_email_identity(new.email)) then
  raise unique_violation using message='email_alias_already_registered';
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
 -- Invalid or exhausted promo codes do not prevent signup, matching the upstream flow.
 perform public.s2a_promo_apply(new.id,new.raw_user_meta_data->>'promo_code');
 if new.raw_user_meta_data ? 'promo_code' or new.raw_user_meta_data ? 'invitation_code' or new.raw_user_meta_data ? 's2a_registration_ticket' then
  update auth.users set raw_user_meta_data=raw_user_meta_data-'invitation_code'-'promo_code'-'s2a_registration_ticket' where id=new.id;
 end if;
 return new;
end $$;


