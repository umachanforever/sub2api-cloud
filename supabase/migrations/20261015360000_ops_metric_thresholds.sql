create table public.s2a_ops_metric_thresholds (
 id boolean primary key default true check(id),
 thresholds jsonb not null default '{"sla_percent_min":99.5,"ttft_p99_ms_max":500,"request_error_rate_percent_max":5,"upstream_error_rate_percent_max":5}'
);
insert into public.s2a_ops_metric_thresholds(id) values(true);
alter table public.s2a_ops_metric_thresholds enable row level security;
revoke all on public.s2a_ops_metric_thresholds from public,anon,authenticated,service_role;
create trigger s2a_ops_metric_thresholds_audit after update on public.s2a_ops_metric_thresholds for each row execute function public.s2a_audit_mutation();
create function public.s2a_ops_metric_thresholds_get() returns jsonb language sql stable security definer set search_path='' as $$
 select thresholds from public.s2a_ops_metric_thresholds where id=true;
$$;
create function public.s2a_ops_metric_thresholds_set(p_thresholds jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare e record; n numeric;
begin
 if p_thresholds is null or jsonb_typeof(p_thresholds)<>'object' or octet_length(p_thresholds::text)>4096
  or (select count(*) from jsonb_object_keys(p_thresholds))<>4 then raise exception 'invalid_metric_thresholds';end if;
 for e in select * from jsonb_each(p_thresholds) loop
  if e.key not in('sla_percent_min','ttft_p99_ms_max','request_error_rate_percent_max','upstream_error_rate_percent_max') then raise exception 'invalid_metric_thresholds';end if;
  if e.value='null'::jsonb then continue;end if;
  if jsonb_typeof(e.value)<>'number' then raise exception 'invalid_metric_thresholds';end if;
  n:=(e.value#>>'{}')::numeric;
  if n<0 or (e.key<>'ttft_p99_ms_max' and n>100) or n>1.7976931348623157e308 then raise exception 'invalid_metric_thresholds';end if;
 end loop;
 update public.s2a_ops_metric_thresholds set thresholds=p_thresholds where id=true;
 return public.s2a_ops_metric_thresholds_get();
end $$;
revoke all on function public.s2a_ops_metric_thresholds_get(),public.s2a_ops_metric_thresholds_set(jsonb) from public,anon,authenticated;
grant execute on function public.s2a_ops_metric_thresholds_get(),public.s2a_ops_metric_thresholds_set(jsonb) to service_role;
notify pgrst,'reload schema';
