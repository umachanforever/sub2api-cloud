alter table public.s2a_accounts add column proxy_fallback_origin_id bigint references public.s2a_proxies(id) on delete restrict;
create view public.s2a_proxy_public as select id,name,protocol,host,port,status,expires_at,probe_snapshot->>'country_code' country_code from public.s2a_proxies;
revoke all on public.s2a_proxy_public from public,anon,authenticated;
grant select on public.s2a_proxy_public to service_role;
create function public.s2a_proxy_binding_valid(p_id bigint) returns boolean language sql stable security definer set search_path='' as $$
 select p_id is null or exists(select 1 from public.s2a_proxies where id=p_id);
$$;
revoke all on function public.s2a_proxy_binding_valid(bigint) from public,anon,authenticated;
grant execute on function public.s2a_proxy_binding_valid(bigint) to service_role;

do $$
declare source text;signature text;needle text:=$n$'expires_at','auto_pause_on_expired'$n$;
begin
 foreach signature in array array['public.s2a_account_save(uuid,jsonb,uuid[],uuid,uuid,jsonb)','public.s2a_apikey_account_update(uuid,text,integer,text,text,text,jsonb)'] loop
  select pg_get_functiondef(signature::regprocedure) into source;
  if strpos(source,needle)=0 or strpos(source,'auto_pause_on_expired=v.auto_pause_on_expired')=0 then raise exception 'account_proxy_save_source_changed';end if;
  source:=replace(source,needle,needle||',''proxy_id''');
  source:=replace(source,E'begin\n',E'begin\n if p_patch?''proxy_id'' and p_patch->''proxy_id''<>''null''::jsonb then\n  if jsonb_typeof(p_patch->''proxy_id'')<>''number'' then return ''{"error":"invalid_proxy_id","status":400}'';end if;\n  if (p_patch->>''proxy_id'')::numeric<>trunc((p_patch->>''proxy_id'')::numeric) or (p_patch->>''proxy_id'')::numeric not between 1 and 9007199254740991 then return ''{"error":"invalid_proxy_id","status":400}'';end if;\n  if not public.s2a_proxy_binding_valid((p_patch->>''proxy_id'')::bigint) then return ''{"error":"proxy_not_found","status":400}'';end if;\n end if;\n');
  source:=replace(source,'auto_pause_on_expired=v.auto_pause_on_expired','auto_pause_on_expired=v.auto_pause_on_expired,proxy_id=v.proxy_id,proxy_fallback_origin_id=case when p_patch?''proxy_id'' then null else a.proxy_fallback_origin_id end');
  if signature like '%s2a_account_save(%' then
   if strpos(source,'auto_pause_on_expired,platform')=0 or strpos(source,'v.auto_pause_on_expired,v.platform')=0 then raise exception 'account_proxy_create_source_changed';end if;
   source:=replace(source,'auto_pause_on_expired,platform','auto_pause_on_expired,proxy_id,platform');
   source:=replace(source,'v.auto_pause_on_expired,v.platform','v.auto_pause_on_expired,v.proxy_id,v.platform');
   source:=replace(source,'update public.s2a_accounts set model_mapping=','update public.s2a_accounts set proxy_id=(p_patch->>''proxy_id'')::bigint,model_mapping=');
  end if;
  execute source;
 end loop;
end $$;

create function public.s2a_proxy_route(p_id bigint) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare original public.s2a_proxies;current_proxy public.s2a_proxies;seen bigint[]:='{}';cursor_id bigint:=p_id;
begin
 if p_id is null then return '{"proxy":null,"changed":false,"target_id":null}';end if;
 select * into original from public.s2a_proxies where id=p_id;
 if not found then return '{"error":"proxy_not_found","status":503}';end if;
 if original.status<>'active' then return '{"error":"proxy_inactive","status":503}';end if;
 current_proxy:=original;
 loop
  if current_proxy.status='active' and (current_proxy.expires_at is null or current_proxy.expires_at>now()) then return jsonb_build_object('proxy',to_jsonb(current_proxy),'changed',current_proxy.id<>original.id,'target_id',current_proxy.id);end if;
  seen:=array_append(seen,current_proxy.id);
  if current_proxy.fallback_mode='direct' then return '{"proxy":null,"changed":true,"target_id":null}';end if;
  if current_proxy.fallback_mode<>'proxy' or current_proxy.backup_proxy_id is null or current_proxy.backup_proxy_id=any(seen) then exit;end if;
  select * into current_proxy from public.s2a_proxies where id=current_proxy.backup_proxy_id;
  if not found then exit;end if;
 end loop;
 -- With no fallback, retain the original connection, matching upstream expiry behavior.
 return jsonb_build_object('proxy',to_jsonb(original),'changed',false,'target_id',original.id);
end $$;
revoke all on function public.s2a_proxy_route(bigint) from public,anon,authenticated;
grant execute on function public.s2a_proxy_route(bigint) to service_role;

create function public.s2a_proxy_sweep() returns integer language plpgsql security definer set search_path='' as $$
declare source_id bigint;route jsonb;changed integer:=0;n integer;
begin
 if not pg_try_advisory_xact_lock(hashtextextended('s2a-proxy-registry',0)) then return 0;end if;
 for source_id in select distinct a.proxy_id from public.s2a_accounts a join public.s2a_proxies p on p.id=a.proxy_id where p.status='active' and p.expires_at<=now() order by a.proxy_id loop
  route:=public.s2a_proxy_route(source_id);
  if coalesce((route->>'changed')::boolean,false) then
   update public.s2a_accounts set proxy_id=(route->>'target_id')::bigint,proxy_fallback_origin_id=coalesce(proxy_fallback_origin_id,source_id),extra=extra-'upstream_billing_probe' where proxy_id=source_id;
   get diagnostics n=row_count;changed:=changed+n;
  end if;
 end loop;
 return changed;
end $$;
create function public.s2a_account_proxy_revert(p_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.s2a_accounts;
begin
 select * into a from public.s2a_accounts where id=p_id for update;
 if not found then return '{"error":"account_not_found","status":404}';end if;
 if a.proxy_fallback_origin_id is null then return '{"error":"account_not_in_proxy_fallback","status":400}';end if;
 update public.s2a_accounts set proxy_id=a.proxy_fallback_origin_id,proxy_fallback_origin_id=null where id=p_id;
 return '{"ok":true}';
end $$;
revoke all on function public.s2a_proxy_sweep(),public.s2a_account_proxy_revert(uuid) from public,anon,authenticated;
grant execute on function public.s2a_proxy_sweep(),public.s2a_account_proxy_revert(uuid) to service_role;
do $$ begin
 if exists(select 1 from pg_extension where extname='pg_cron') then perform cron.schedule('s2a-proxy-expiry','* * * * *','select public.s2a_proxy_sweep();');end if;
end $$;
notify pgrst,'reload schema';
