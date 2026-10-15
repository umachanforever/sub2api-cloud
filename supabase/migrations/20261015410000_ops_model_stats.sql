create function public.s2a_ops_model_stats(p_start timestamptz,p_end timestamptz,p_platform text default '',p_group uuid default null,p_top_n integer default null,p_page integer default 1,p_page_size integer default 20)
returns jsonb language plpgsql stable set search_path='' as $$
begin
 if p_start is null or p_end is null or not isfinite(p_start) or not isfinite(p_end) or p_start>=p_end or p_end-p_start>interval '31 days'
 or p_platform is null or p_platform not in('','openai','anthropic','gemini')
 or p_top_n is not null and p_top_n not between 1 and 100
 or p_page is null or p_page not between 1 and 10000 or p_page_size is null or p_page_size not between 1 and 100
 or p_top_n is not null and (p_page<>1 or p_page_size<>20) then raise exception 'invalid_model_stats_filter';end if;
 return (
 with stats as materialized (
  select u.model,count(*) request_count,
  round(avg(case when u.duration_ms>0 and u.output_tokens>0 and u.billing_mode='token' then u.output_tokens*1000.0/u.duration_ms end),2) avg_tokens_per_sec,
  round(avg(u.first_token_ms),2) avg_first_token_ms,sum(u.output_tokens) total_output_tokens,count(*) filter(where u.output_tokens is null) unknown_output_requests,
  round(avg(u.duration_ms)) avg_duration_ms,count(u.first_token_ms) requests_with_first_token
  from public.s2a_usage u left join public.s2a_groups g on g.id=u.group_id left join public.s2a_accounts a on a.id=u.account_id
  where u.created_at>=p_start and u.created_at<p_end and u.model<>'__models__' and u.outcome='completed' and u.status between 200 and 299
  and (p_platform='' or coalesce(nullif(g.platform,''),a.platform,'')=p_platform) and (p_group is null or u.group_id=p_group)
  and exists(select 1 from public.s2a_ops_requests r where r.request_id=u.request_id::text and r.kind='success')
  group by u.model
 ), selected as (
  select * from stats order by request_count desc,model limit coalesce(p_top_n,p_page_size) offset case when p_top_n is not null then 0 else (p_page-1)*p_page_size end
 )
 select jsonb_build_object('start_time',p_start,'end_time',p_end,'platform',p_platform,'group_id',p_group,
  'total',(select count(*) from stats),'items',(select coalesce(jsonb_agg(to_jsonb(s) order by request_count desc,model),'[]') from selected s))
  || case when p_top_n is not null then jsonb_build_object('top_n',p_top_n) else jsonb_build_object('page',p_page,'page_size',p_page_size) end
 );
end $$;
revoke all on function public.s2a_ops_model_stats(timestamptz,timestamptz,text,uuid,integer,integer,integer) from public,anon,authenticated;
grant execute on function public.s2a_ops_model_stats(timestamptz,timestamptz,text,uuid,integer,integer,integer) to service_role;
