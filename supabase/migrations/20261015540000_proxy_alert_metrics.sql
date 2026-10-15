do $$
declare source text;old text:= $old$ if metric in('cpu_usage_percent','memory_usage_percent','proxy_expired_count','proxy_expiring_soon_count') then
  -- shortcut: system samples and proxy inventory are not connected, evaluate these metrics after their collectors are installed.
  return null;
 end if;$old$;
begin
 select pg_get_functiondef('public.s2a_ops_alert_metric(public.s2a_ops_alert_rules,timestamp with time zone)'::regprocedure) into source;
 if strpos(source,old)=0 then raise exception 'proxy_alert_metric_source_changed';end if;
 execute replace(source,old,$new$ if metric in('cpu_usage_percent','memory_usage_percent') then
  -- shortcut: system samples are not connected, evaluate these metrics after their collectors are installed.
  return null;
 end if;
 if metric='proxy_expired_count' then return (select count(*) from public.s2a_proxies where expires_at<=p_now);end if;
 if metric='proxy_expiring_soon_count' then return (select count(*) from public.s2a_proxies where status='active' and expires_at>p_now and expires_at<=p_now+make_interval(days=>expiry_warn_days));end if;$new$);
end $$;
