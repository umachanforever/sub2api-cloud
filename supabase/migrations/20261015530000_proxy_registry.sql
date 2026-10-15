create table public.s2a_proxies (
 id bigint generated always as identity primary key,name text not null check(length(name) between 1 and 100),
 protocol text not null check(protocol in('http','https','socks5','socks5h')),host text not null check(length(host) between 1 and 253),port integer not null check(port between 1 and 65535),
 username text not null default '',ciphertext text not null,iv text not null,fingerprint text not null check(fingerprint~'^[a-f0-9]{64}$'),
 status text not null default 'active' check(status in('active','inactive')),expires_at timestamptz,
 fallback_mode text not null default 'none' check(fallback_mode in('none','proxy','direct')),backup_proxy_id bigint references public.s2a_proxies(id) on delete restrict,
 expiry_warn_days integer not null default 7 check(expiry_warn_days between 0 and 36500),
 probe_snapshot jsonb not null default '{}',
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 check(backup_proxy_id is null or backup_proxy_id<>id),check(fallback_mode<>'proxy' or backup_proxy_id is not null)
);
create trigger s2a_proxy_audit after insert or update or delete on public.s2a_proxies for each row execute function public.s2a_audit_mutation();
create index s2a_proxy_fingerprint on public.s2a_proxies(fingerprint);
alter table public.s2a_accounts add column proxy_id bigint references public.s2a_proxies(id) on delete restrict;
create index s2a_account_proxy on public.s2a_accounts(proxy_id) where proxy_id is not null;
alter table public.s2a_proxies enable row level security;
revoke all on public.s2a_proxies from public,anon,authenticated,service_role;

create function public.s2a_proxy_read(p_id bigint default null,p_filter jsonb default '{}',p_all boolean default false) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare field text:=coalesce(nullif(p_filter->>'sort_by',''),'id');direction text:=coalesce(nullif(p_filter->>'sort_order',''),'desc');page integer:=coalesce((p_filter->>'page')::integer,1);size integer:=coalesce((p_filter->>'page_size')::integer,20);result jsonb;
begin
 if field not in('id','name','protocol','host','port','status','expires_at','created_at','updated_at','account_count') or direction not in('asc','desc')
 or page not between 1 and 100000 or size not between 1 and 200 or length(coalesce(p_filter->>'search',''))>100
 or coalesce(p_filter->>'protocol','') not in('','http','https','socks5','socks5h') or coalesce(p_filter->>'status','') not in('','active','inactive','expired') then raise exception 'invalid_proxy_filter';end if;
 if field='status' then field:='display_status';end if;
 execute format($q$with rows as materialized (
 select p.*,case when p.expires_at<=now() then 'expired' else p.status end display_status,
 (select count(*) from public.s2a_accounts a where a.proxy_id=p.id) account_count
 from public.s2a_proxies p where ($1 is null or p.id=$1)
 and (coalesce($2->>'protocol','')='' or p.protocol=$2->>'protocol')
 and (coalesce($2->>'status','')='' or case when p.expires_at<=now() then 'expired' else p.status end=$2->>'status')
 and (coalesce($2->>'search','')='' or strpos(lower(p.name||' '||p.host||' '||p.username),lower($2->>'search'))>0)
 ), selected as (select * from rows order by %I %s,id %s limit case when $3 then null else $4 end offset case when $3 then 0 else $5 end)
 select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(s)-'status'-'display_status'||jsonb_build_object('status',s.display_status)) from selected s),'[]'),
 'total',(select count(*) from rows),'page',$6,'page_size',$4,'pages',ceil((select count(*) from rows)::numeric/$4))$q$,field,direction,direction)
 into result using p_id,p_filter,p_all,size,(page-1)*size,page;
 return result;
end $$;
create function public.s2a_proxy_save(p_id bigint,p_patch jsonb,p_expected timestamptz default null,p_reuse boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
declare old public.s2a_proxies;v public.s2a_proxies;backup public.s2a_proxies;cursor_id bigint;seen bigint[]:='{}';
begin
 if p_patch is null or jsonb_typeof(p_patch)<>'object' or exists(select 1 from jsonb_object_keys(p_patch) k where k not in('name','protocol','host','port','username','ciphertext','iv','fingerprint','status','expires_at','fallback_mode','backup_proxy_id','expiry_warn_days')) then return '{"error":"invalid_proxy_update","status":400}';end if;
 -- Serialize registry mutations so backup graph validation and duplicate imports stay atomic.
 perform pg_advisory_xact_lock(hashtextextended('s2a-proxy-registry',0));
 if p_id is null then
  if p_reuse then select id into cursor_id from public.s2a_proxies where fingerprint=p_patch->>'fingerprint' order by id limit 1;if found then return jsonb_build_object('id',cursor_id,'reused',true);end if;end if;
  v:=jsonb_populate_record(null::public.s2a_proxies,'{"username":"","status":"active","fallback_mode":"none","expiry_warn_days":7}'::jsonb||p_patch);
 else
  select * into old from public.s2a_proxies where id=p_id for update;
  if not found then return '{"error":"proxy_not_found","status":404}';end if;
  if p_expected is null or old.updated_at<>p_expected then return '{"error":"proxy_changed_retry","status":409}';end if;
  v:=jsonb_populate_record(old,p_patch);
 end if;
 cursor_id:=v.backup_proxy_id;
 while cursor_id is not null loop
  if cursor_id=p_id or cursor_id=any(seen) then return '{"error":"proxy_fallback_cycle","status":400}';end if;
  seen:=array_append(seen,cursor_id);select * into backup from public.s2a_proxies where id=cursor_id;
  if not found then return '{"error":"backup_proxy_not_found","status":400}';end if;
  cursor_id:=backup.backup_proxy_id;
 end loop;
 if p_id is null then
  insert into public.s2a_proxies(name,protocol,host,port,username,ciphertext,iv,fingerprint,status,expires_at,fallback_mode,backup_proxy_id,expiry_warn_days)
  values(v.name,v.protocol,v.host,v.port,v.username,v.ciphertext,v.iv,v.fingerprint,v.status,v.expires_at,v.fallback_mode,v.backup_proxy_id,v.expiry_warn_days) returning id into p_id;
 else
  update public.s2a_proxies set name=v.name,protocol=v.protocol,host=v.host,port=v.port,username=v.username,ciphertext=v.ciphertext,iv=v.iv,fingerprint=v.fingerprint,status=v.status,expires_at=v.expires_at,fallback_mode=v.fallback_mode,backup_proxy_id=v.backup_proxy_id,expiry_warn_days=v.expiry_warn_days,probe_snapshot=case when fingerprint=v.fingerprint then probe_snapshot else '{}'::jsonb end,updated_at=clock_timestamp() where id=p_id;
 end if;
 return jsonb_build_object('id',p_id,'reused',false);
exception when check_violation or not_null_violation or invalid_text_representation or numeric_value_out_of_range or foreign_key_violation then return '{"error":"invalid_proxy_data","status":400}';
end $$;
create function public.s2a_proxy_delete(p_ids bigint[]) returns jsonb language plpgsql security definer set search_path='' as $$
declare target_id bigint;deleted bigint[]:='{}';skipped jsonb:='[]';reason text;
begin
 if p_ids is null or cardinality(p_ids) not between 1 and 1000 or array_position(p_ids,null) is not null then raise exception 'invalid_proxy_ids';end if;
 perform pg_advisory_xact_lock(hashtextextended('s2a-proxy-registry',0));
 for target_id in select distinct x from unnest(p_ids) x order by x loop
  reason:=null;
  begin
   delete from public.s2a_proxies p where p.id=target_id;
   if found then deleted:=array_append(deleted,target_id);else reason:='proxy_not_found';end if;
  exception when foreign_key_violation then reason:='proxy_in_use';end;
  if reason is not null then skipped:=skipped||jsonb_build_array(jsonb_build_object('id',target_id,'reason',reason));end if;
 end loop;
 return jsonb_build_object('deleted_ids',to_jsonb(deleted),'skipped',skipped);
end $$;
revoke all on function public.s2a_proxy_read(bigint,jsonb,boolean),public.s2a_proxy_save(bigint,jsonb,timestamptz,boolean),public.s2a_proxy_delete(bigint[]) from public,anon,authenticated;
grant execute on function public.s2a_proxy_read(bigint,jsonb,boolean),public.s2a_proxy_save(bigint,jsonb,timestamptz,boolean),public.s2a_proxy_delete(bigint[]) to service_role;
notify pgrst,'reload schema';

create function public.s2a_proxy_probe_save(p_id bigint,p_expected timestamptz,p_result jsonb) returns boolean language plpgsql security definer set search_path='' as $$
begin
 if jsonb_typeof(p_result) is distinct from 'object' or jsonb_typeof(p_result->'success') is distinct from 'boolean' or exists(select 1 from jsonb_object_keys(p_result) k where k not in('success','message','latency_ms','ip_address','city','region','country','country_code')) then raise exception 'invalid_proxy_probe';end if;
 update public.s2a_proxies set probe_snapshot=(p_result-'success'-'message')||jsonb_build_object('latency_status',case when (p_result->>'success')::boolean then 'success' else 'failed' end,'latency_message',case when (p_result->>'success')::boolean then 'Proxy is accessible' else 'Proxy connectivity check failed' end) where id=p_id and updated_at=p_expected;
 return found;
end $$;
revoke all on function public.s2a_proxy_probe_save(bigint,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.s2a_proxy_probe_save(bigint,timestamptz,jsonb) to service_role;
