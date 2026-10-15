create table public.s2a_ops_errors (
 id bigint generated always as identity primary key, event_id uuid not null unique,
 created_at timestamptz not null default clock_timestamp(), kind text not null check(kind in('request','upstream')),
 request_id uuid not null, client_request_id text not null default '', status_code integer not null check(status_code between 100 and 599),
 phase text not null, type text not null, error_owner text not null, error_source text not null, severity text not null,
 is_business_limited boolean not null, message text not null, error_body text not null,
 user_id uuid, api_key_id uuid, account_id uuid, group_id uuid,
 user_email text not null default '',api_key_name text not null default '',account_name text not null default '',group_name text not null default '',api_key_prefix text,
 platform text not null default '', model text not null default '', requested_model text not null default '',upstream_model text not null default '',
 stream boolean, request_path text not null default '',inbound_endpoint text not null default '',
 response_latency_ms integer, upstream_status_code integer,upstream_error_message text,upstream_error_detail text,
 resolved boolean not null default false,resolved_at timestamptz,resolved_by_user_id uuid,
 constraint s2a_ops_errors_provider_kind check(kind<>'upstream' or error_owner='provider')
);
create index s2a_ops_errors_time on public.s2a_ops_errors(kind,created_at desc,id desc);
create index s2a_ops_errors_request on public.s2a_ops_errors(request_id,kind);
create index s2a_ops_errors_user on public.s2a_ops_errors(user_id,created_at desc) where kind='request';
alter table public.s2a_ops_errors enable row level security;
revoke all on public.s2a_ops_errors from public,anon,authenticated,service_role;
create view public.s2a_ops_error_details as select e.*,
 (e.api_key_id is not null and (k.id is null or k.deleted_at is not null)) api_key_deleted,
 null::text client_ip,null::text user_agent,null::text upstream_endpoint,null::smallint request_type,
 null::integer auth_latency_ms,null::integer routing_latency_ms,null::integer upstream_latency_ms,null::integer time_to_first_token_ms,
 null::text upstream_errors
 from public.s2a_ops_errors e left join public.s2a_keys k on k.id=e.api_key_id;
revoke all on public.s2a_ops_error_details from public,anon,authenticated;
grant select on public.s2a_ops_error_details to service_role;
create trigger s2a_ops_errors_audit after update of resolved on public.s2a_ops_errors for each row execute function public.s2a_audit_mutation();

create function public.s2a_ops_error_record(p_event jsonb) returns bigint language plpgsql security definer set search_path='' as $$
declare k public.s2a_keys;a public.s2a_accounts;gid uuid;eid bigint;field record;value text;lease uuid;
begin
 if p_event is null or jsonb_typeof(p_event)<>'object' or octet_length(p_event::text)>8192 then raise exception 'invalid_ops_error';end if;
 for field in select * from jsonb_each(p_event) loop
  value:=field.value#>>'{}';
  if field.key in('event_id','request_id','account_id','lease_id') then
   if field.value<>'null'::jsonb then perform value::uuid;end if;
  elsif field.key in('duration_ms','status_code') then
   if jsonb_typeof(field.value)<>'number' or value !~ '^[0-9]+$' or value::numeric>2147483647 then raise exception 'invalid_ops_error';end if;
  elsif field.key in('limited','stream') then
   if field.key='stream' and field.value='null'::jsonb then continue;end if;
   if jsonb_typeof(field.value)<>'boolean' then raise exception 'invalid_ops_error';end if;
  elsif field.key in('kind','phase','type','owner','source','code','key_hash','model','upstream_model','platform','endpoint') then
   if jsonb_typeof(field.value)<>'string' or length(value)>200 or value ~ '[[:cntrl:]]' then raise exception 'invalid_ops_error';end if;
  else raise exception 'invalid_ops_error';end if;
 end loop;
 if p_event->>'event_id' is null or p_event->>'request_id' is null or p_event->>'status_code' is null
  or (p_event->>'status_code')::integer not between 100 and 599
  or coalesce(p_event->>'kind','') not in('request','upstream')
  or coalesce(p_event->>'phase','') not in('auth','request','routing','upstream','account_auth','network','internal')
  or coalesce(p_event->>'owner','') not in('client','provider','platform')
  or coalesce(p_event->>'source','') not in('client_request','upstream_http','gateway')
  or (p_event->>'kind'='upstream' and p_event->>'owner'<>'provider')
  or coalesce(p_event->>'type','') !~ '^[a-z_]{1,80}$' or coalesce(p_event->>'code','') !~ '^[a-z_]{1,80}$'
  or jsonb_typeof(p_event->'limited') is distinct from 'boolean' then raise exception 'invalid_ops_error';end if;
 if p_event->>'key_hash' is not null then
  if p_event->>'key_hash' !~ '^[a-f0-9]{64}$' then raise exception 'invalid_ops_error';end if;
  select * into k from public.s2a_keys where key_hash=p_event->>'key_hash';
 end if;
 lease:=(p_event->>'lease_id')::uuid;
 select coalesce((l.billing->>'group_id')::uuid,k.group_id) into gid from public.s2a_leases l where l.id=lease and l.request_id=(p_event->>'request_id')::uuid and l.key_id=k.id;
 if gid is null then select u.group_id into gid from public.s2a_usage u where u.id=lease and u.request_id=(p_event->>'request_id')::uuid and u.key_id=k.id;end if;
 gid:=coalesce(gid,k.group_id);
 select * into a from public.s2a_accounts where id=(p_event->>'account_id')::uuid;
 insert into public.s2a_ops_errors(event_id,kind,request_id,status_code,phase,type,error_owner,error_source,severity,is_business_limited,message,error_body,
 user_id,api_key_id,account_id,group_id,user_email,api_key_name,account_name,group_name,api_key_prefix,platform,model,requested_model,upstream_model,
 stream,request_path,inbound_endpoint,response_latency_ms,upstream_status_code,upstream_error_message)
 values((p_event->>'event_id')::uuid,p_event->>'kind',(p_event->>'request_id')::uuid,(p_event->>'status_code')::integer,
 p_event->>'phase',p_event->>'type',p_event->>'owner',p_event->>'source',case when (p_event->>'status_code')::integer>=500 then 'critical' else 'warning' end,
 (p_event->>'limited')::boolean,p_event->>'code',jsonb_build_object('error',jsonb_build_object('type',p_event->>'type','message',p_event->>'code'))::text,
 k.user_id,k.id,a.id,gid,coalesce((select email from auth.users where id=k.user_id),''),coalesce(k.name,''),coalesce(a.name,''),coalesce((select name from public.s2a_groups where id=gid),''),k.key_prefix,
 coalesce(nullif(p_event->>'platform',''),a.platform,''),coalesce(p_event->>'model',''),coalesce(p_event->>'model',''),coalesce(p_event->>'upstream_model',''),
 (p_event->>'stream')::boolean,coalesce(p_event->>'endpoint',''),coalesce(p_event->>'endpoint',''),(p_event->>'duration_ms')::integer,
 case when p_event->>'source'='upstream_http' then (p_event->>'status_code')::integer end,
 case when p_event->>'owner'='provider' then p_event->>'code' end)
 on conflict(event_id) do nothing returning id into eid;
 if eid is null then select id into eid from public.s2a_ops_errors where event_id=(p_event->>'event_id')::uuid and request_id=(p_event->>'request_id')::uuid and kind=p_event->>'kind';
  if eid is null then raise exception 'ops_error_identity_conflict';end if;
 end if;
 return eid;
end $$;
create function public.s2a_ops_error_resolve(p_actor_id uuid,p_id bigint,p_kind text,p_resolved boolean) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if not coalesce(p_actor_id=any(public.s2a_active_admin_ids()),false) then return jsonb_build_object('error','admin_required','status',403);end if;
 if p_resolved is null or p_kind is null or p_kind not in('request','upstream') then return jsonb_build_object('error','invalid_resolution','status',400);end if;
 update public.s2a_ops_errors set resolved=p_resolved,resolved_at=case when p_resolved then clock_timestamp() end,
 resolved_by_user_id=case when p_resolved then p_actor_id end where id=p_id and kind=p_kind and resolved is distinct from p_resolved;
 if not exists(select 1 from public.s2a_ops_errors where id=p_id and kind=p_kind) then return jsonb_build_object('error','not_found','status',404);end if;
 return jsonb_build_object('resolved',p_resolved);
end $$;
revoke all on function public.s2a_ops_error_record(jsonb),public.s2a_ops_error_resolve(uuid,bigint,text,boolean) from public,anon,authenticated;
grant execute on function public.s2a_ops_error_record(jsonb),public.s2a_ops_error_resolve(uuid,bigint,text,boolean) to service_role;
notify pgrst,'reload schema';

create function public.s2a_ops_error_user_window(p_start_date date default null,p_end_date date default null,p_timezone text default 'Asia/Shanghai') returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if p_timezone is null or length(p_timezone)>100 or not exists(select 1 from pg_catalog.pg_timezone_names where lower(name)=lower(p_timezone)) then raise exception 'invalid_timezone';end if;
 if p_start_date>p_end_date then raise exception 'invalid_date_range';end if;
 return jsonb_build_object('start_time',coalesce(p_start_date,(now() at time zone p_timezone)::date-6)::timestamp at time zone p_timezone,
  'end_time',case when p_end_date is null then now() else (p_end_date+1)::timestamp at time zone p_timezone end);
end $$;
revoke all on function public.s2a_ops_error_user_window(date,date,text) from public,anon,authenticated;
grant execute on function public.s2a_ops_error_user_window(date,date,text) to service_role;

alter function public.s2a_log_retention() rename to s2a_log_retention_without_ops_errors;
create function public.s2a_log_retention() returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;removed bigint;
begin
 result:=public.s2a_log_retention_without_ops_errors();
 delete from public.s2a_ops_errors where id in(select id from public.s2a_ops_errors where created_at<now()-interval '30 days' order by created_at,id limit 10000);
 get diagnostics removed=row_count;
 return result||jsonb_build_object('errors_deleted',removed);
end $$;
revoke all on function public.s2a_log_retention() from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
