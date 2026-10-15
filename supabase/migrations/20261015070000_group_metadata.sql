alter table public.s2a_groups
 add column description text check(description is null or length(description)<=10000),
 add column sort_order integer not null default 0;
create index s2a_groups_sort on public.s2a_groups(sort_order,id);
create or replace function public.s2a_group_create(p_name text,p_user_id uuid,p_platform text default 'openai',p_rate_multiplier numeric default 1,p_options jsonb default '{}')
returns jsonb language plpgsql set search_path='' as $$
declare g public.s2a_groups;
begin
 if p_options is null or jsonb_typeof(p_options)<>'object' or exists(select 1 from jsonb_object_keys(p_options) k where k not in ('description','sort_order','subscription_type','daily_limit_usd','weekly_limit_usd','monthly_limit_usd')) then
  return jsonb_build_object('error','invalid_group_options','status',400);
 end if;
 insert into public.s2a_groups(name,platform,rate_multiplier,description,sort_order,subscription_type,daily_limit_usd,weekly_limit_usd,monthly_limit_usd)
 values(p_name,p_platform,p_rate_multiplier,p_options->>'description',coalesce((p_options->>'sort_order')::integer,0),coalesce(p_options->>'subscription_type','standard'),(p_options->>'daily_limit_usd')::numeric,(p_options->>'weekly_limit_usd')::numeric,(p_options->>'monthly_limit_usd')::numeric) returning * into g;
 insert into public.s2a_memberships(user_id,group_id) values(p_user_id,g.id);
 return to_jsonb(g);
end $$;
create function public.s2a_groups_sort(p_updates jsonb)
returns jsonb language plpgsql set search_path='' as $$
begin
 if p_updates is null or jsonb_typeof(p_updates)<>'array' then return jsonb_build_object('error','invalid_group_sort_updates','status',400);end if;
 if jsonb_array_length(p_updates) not between 1 and 1000 then return jsonb_build_object('error','invalid_group_sort_updates','status',400);end if;
 if exists(select 1 from jsonb_array_elements(p_updates) x where jsonb_typeof(x)<>'object' or not (x ? 'id' and x ? 'sort_order') or jsonb_typeof(x->'id')<>'string' or jsonb_typeof(x->'sort_order')<>'number' or (select count(*) from jsonb_object_keys(x))<>2) then return jsonb_build_object('error','invalid_group_sort_updates','status',400);end if;
 if (select count(distinct id) from jsonb_to_recordset(p_updates) as x(id uuid,sort_order integer))<>jsonb_array_length(p_updates) then return jsonb_build_object('error','duplicate_group_ids','status',400);end if;
 perform g.id from public.s2a_groups g join jsonb_to_recordset(p_updates) as x(id uuid,sort_order integer) on g.id=x.id order by g.id for update of g;
 if (select count(*) from public.s2a_groups g join jsonb_to_recordset(p_updates) as x(id uuid,sort_order integer) on g.id=x.id)<>jsonb_array_length(p_updates) then return jsonb_build_object('error','group_not_found','status',404);end if;
 update public.s2a_groups g set sort_order=x.sort_order from jsonb_to_recordset(p_updates) as x(id uuid,sort_order integer) where g.id=x.id;
 return jsonb_build_object('ok',true);
exception when invalid_text_representation or numeric_value_out_of_range then return jsonb_build_object('error','invalid_group_sort_updates','status',400);
end $$;
revoke all on function public.s2a_groups_sort(jsonb) from public,anon,authenticated;
grant execute on function public.s2a_groups_sort(jsonb) to service_role;
notify pgrst,'reload schema';
