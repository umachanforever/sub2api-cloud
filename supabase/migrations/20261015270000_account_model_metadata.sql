create function public.s2a_account_model_metadata_save(p_account_id uuid,p_version bigint,p_mapping jsonb,p_models jsonb,p_source text,p_retain_ids text[],p_live boolean)
returns jsonb language plpgsql set search_path='' as $$
declare a public.s2a_accounts; previous jsonb; merged jsonb:=p_models; entry record; retained jsonb;
begin
 if p_source is null or p_source not in ('upstream','models.dev') or p_models is null or jsonb_typeof(p_models)<>'object' or p_models='{}'
 or octet_length(p_models::text)>8*1024*1024 or p_retain_ids is null or cardinality(p_retain_ids)>10500 or p_live is null then raise exception 'invalid_model_metadata';end if;
 select * into a from public.s2a_accounts where id=p_account_id for update;
 if not found then return jsonb_build_object('error','account_not_found','status',404);end if;
 if a.credential_version is distinct from p_version or a.model_mapping is distinct from p_mapping then return jsonb_build_object('saved',false);end if;
 for entry in select * from jsonb_each(p_models) loop
  if length(entry.key)>200 or jsonb_typeof(entry.value)<>'object' or entry.value->>'id' is distinct from entry.key
    or jsonb_typeof(entry.value->'reasoning') is distinct from 'boolean' or jsonb_typeof(entry.value->'input_modalities') is distinct from 'array'
    or jsonb_array_length(entry.value->'input_modalities')=0 or jsonb_typeof(entry.value->'context_window') is distinct from 'number' then raise exception 'invalid_model_metadata';end if;
  if (entry.value->>'context_window')::numeric<=0 or ((entry.value->>'reasoning')::boolean and
    (jsonb_typeof(entry.value->'supported_reasoning_levels') is distinct from 'array' or jsonb_array_length(entry.value->'supported_reasoning_levels')=0)) then raise exception 'invalid_model_metadata';end if;
 end loop;
 previous:=a.extra->'upstream_model_metadata'->'models';
 if jsonb_typeof(previous)='object' then
  for entry in select * from jsonb_each(previous) loop
   if entry.key=any(p_retain_ids) or not p_live then
    if not merged?entry.key then merged:=merged||jsonb_build_object(entry.key,entry.value);
    elsif jsonb_typeof(entry.value->'codex_tool_capabilities')='object' then
     retained:=entry.value->'codex_tool_capabilities'||coalesce(merged->entry.key->'codex_tool_capabilities','{}'::jsonb);
     merged:=jsonb_set(merged,array[entry.key,'codex_tool_capabilities'],retained);
    end if;
   end if;
  end loop;
 end if;
 update public.s2a_accounts set extra=extra||jsonb_build_object('upstream_model_metadata',jsonb_build_object('source',p_source,'synced_at',now(),'models',merged)) where id=a.id;
 return jsonb_build_object('saved',true);
end $$;
revoke all on function public.s2a_account_model_metadata_save(uuid,bigint,jsonb,jsonb,text,text[],boolean) from public,anon,authenticated;
grant execute on function public.s2a_account_model_metadata_save(uuid,bigint,jsonb,jsonb,text,text[],boolean) to service_role;
notify pgrst,'reload schema';
