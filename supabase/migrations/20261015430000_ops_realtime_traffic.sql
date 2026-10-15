create function public.s2a_ops_realtime_traffic(p_start timestamptz,p_end timestamptz,p_platform text default '',p_group uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if p_start is null or p_end is null or not isfinite(p_start) or not isfinite(p_end) or p_start>=p_end or p_end-p_start>interval '1 hour'
 or p_platform is null or p_platform not in('','openai','anthropic','gemini') then raise exception 'invalid_traffic_filter';end if;
 return (
 with requests as (
  select r.created_at from public.s2a_ops_requests r where r.created_at>=p_start and r.created_at<p_end
  and (p_platform='' or r.platform=p_platform) and (p_group is null or r.group_id=p_group)
 ), usage as (
  select u.created_at,coalesce(u.input_tokens,0)+coalesce(u.output_tokens,0) tokens,
   u.input_tokens is null or u.output_tokens is null unknown_tokens
  from public.s2a_usage u left join public.s2a_groups g on g.id=u.group_id left join public.s2a_accounts a on a.id=u.account_id
  where u.model<>'__models__' and u.created_at>=p_start and u.created_at<p_end
  and (p_platform='' or coalesce(nullif(g.platform,''),a.platform,'')=p_platform) and (p_group is null or u.group_id=p_group)
 ), events as materialized (
  select created_at,1 requests,0::bigint tokens,false unknown_tokens from requests
  union all select created_at,0,tokens,unknown_tokens from usage
 ), minutes as (
  select date_bin(interval '1 minute',created_at,'1970-01-01'::timestamptz) bucket,sum(requests)/60.0 qps,sum(tokens)/60.0 tps from events group by 1
 )
 select jsonb_build_object(
  'qps',jsonb_build_object('current',round(coalesce(sum(requests) filter(where created_at>=p_end-interval '1 minute'),0)/least(60.0,extract(epoch from(p_end-p_start))),1),
   'peak',coalesce((select round(max(qps),1) from minutes),0),'avg',round(coalesce(sum(requests),0)/extract(epoch from(p_end-p_start)),1)),
  'tps',jsonb_build_object('current',round(coalesce(sum(tokens) filter(where created_at>=p_end-interval '1 minute'),0)/least(60.0,extract(epoch from(p_end-p_start))),1),
   'peak',coalesce((select round(max(tps),1) from minutes),0),'avg',round(coalesce(sum(tokens),0)/extract(epoch from(p_end-p_start)),1)),
  'unknown_token_attempts',count(*) filter(where unknown_tokens)) from events
 );
end $$;
revoke all on function public.s2a_ops_realtime_traffic(timestamptz,timestamptz,text,uuid) from public,anon,authenticated;
grant execute on function public.s2a_ops_realtime_traffic(timestamptz,timestamptz,text,uuid) to service_role;
