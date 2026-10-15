begin;
do $$
declare a uuid:=gen_random_uuid(); metadata jsonb:='{"model":{"id":"model","reasoning":false,"input_modalities":["text"],"context_window":100,"codex_tool_capabilities":{"supports_search_tool":true}}}';r jsonb;
begin
 insert into public.s2a_accounts(id,name,account_fingerprint,ciphertext,iv,type,extra) values(a,'Metadata CAS','metadata-cas','cipher','iv','apikey','{"keep":"metadata"}');
 r:=public.s2a_account_model_metadata_save(a,1,'{}',metadata,'upstream',array['model'],true);
 if r->>'saved'<>'true' or (select extra->>'keep' from public.s2a_accounts where id=a)<>'metadata' then raise exception 'snapshot save failed';end if;
 update public.s2a_accounts set credential_version=2 where id=a;
 if public.s2a_account_model_metadata_save(a,1,'{}',metadata,'upstream',array['model'],true)->>'saved'<>'false' then raise exception 'stale credential saved';end if;
 update public.s2a_accounts set model_mapping='{"alias":"model"}' where id=a;
 if public.s2a_account_model_metadata_save(a,2,'{}',metadata,'upstream',array['model'],true)->>'saved'<>'false' then raise exception 'stale mapping saved';end if;
 r:=public.s2a_account_model_metadata_save(a,2,'{"alias":"model"}',metadata #- '{model,codex_tool_capabilities}','models.dev',array['model'],true);
 if not (select (extra->'upstream_model_metadata'->'models'->'model'->'codex_tool_capabilities'->>'supports_search_tool')::boolean from public.s2a_accounts where id=a) then raise exception 'known tool capability lost';end if;
 metadata:='{"other":{"id":"other","reasoning":false,"input_modalities":["image"],"context_window":200}}';
 r:=public.s2a_account_model_metadata_save(a,2,'{"alias":"model"}',metadata,'upstream',array['other'],false);
 if not (select extra->'upstream_model_metadata'->'models'?'model' from public.s2a_accounts where id=a) then raise exception 'unsupported list lost previous snapshot';end if;
 r:=public.s2a_account_model_metadata_save(a,2,'{"alias":"model"}',metadata,'upstream',array['other'],true);
 if (select extra->'upstream_model_metadata'->'models'?'model' from public.s2a_accounts where id=a) then raise exception 'removed model retained after authoritative listing';end if;
 begin perform public.s2a_account_model_metadata_save(a,2,'{"alias":"model"}','{"bad":{"id":"bad","reasoning":true,"context_window":100,"input_modalities":["text"]}}','upstream',array['bad'],true);raise exception 'accepted_incomplete';exception when others then if sqlerrm<>'invalid_model_metadata' then raise;end if;end;
 if has_function_privilege('anon','public.s2a_account_model_metadata_save(uuid,bigint,jsonb,jsonb,text,text[],boolean)','execute') or has_function_privilege('authenticated','public.s2a_account_model_metadata_save(uuid,bigint,jsonb,jsonb,text,text[],boolean)','execute') then raise exception 'snapshot RPC exposed';end if;
end $$;
rollback;
