begin;
insert into auth.users(id,email) values('cccccccc-cccc-4ccc-8ccc-ccccccccccc1','targeting-a@example.com'),('cccccccc-cccc-4ccc-8ccc-ccccccccccc2','targeting-b@example.com');
select public.s2a_wallet_adjust('cccccccc-cccc-4ccc-8ccc-ccccccccccc1',100,'test');
insert into public.s2a_groups(id,name,subscription_type) values('cccccccc-cccc-4ccc-8ccc-ccccccccccc3','Targeting plan','subscription');
select public.s2a_subscription_assign('cccccccc-cccc-4ccc-8ccc-ccccccccccc1','cccccccc-cccc-4ccc-8ccc-ccccccccccc3',30);
set local role service_role;
do $$ declare rules jsonb:='{"any_of":[{"all_of":[{"type":"balance","operator":"gte","value":100},{"type":"subscription","operator":"in","group_ids":["cccccccc-cccc-4ccc-8ccc-ccccccccccc3"]}]}]}';
 a bigint; result jsonb; c text; expected boolean; uid uuid:='cccccccc-cccc-4ccc-8ccc-ccccccccccc1';other uuid:='cccccccc-cccc-4ccc-8ccc-ccccccccccc2';begin
 if not public.s2a_announcement_matches(rules,uid) or public.s2a_announcement_matches(rules,other) then raise exception 'AND or subscription isolation failed';end if;
 for c,expected in select * from (values('gt',false),('gte',true),('lt',false),('lte',true),('eq',true)) x loop
  if public.s2a_announcement_matches(jsonb_build_object('any_of',jsonb_build_array(jsonb_build_object('all_of',jsonb_build_array(jsonb_build_object('type','balance','operator',c,'value',100))))),uid)<>expected then raise exception 'balance operator % failed',c;end if;
 end loop;
 if not public.s2a_announcement_matches('{"any_of":[{"all_of":[{"type":"balance","operator":"eq","value":0}]}]}',other) then raise exception 'missing wallet is not zero';end if;
 insert into public.s2a_announcements(title,content,status,notify_mode,targeting) values('targeted','private message','active','popup',rules) returning id into a;
 result:=public.s2a_announcements_for_user(uid);if jsonb_array_length(result)<>1 or result->0->>'notify_mode'<>'popup' then raise exception 'eligible announcement missing';end if;
 if jsonb_array_length(public.s2a_announcements_for_user(other))<>0 or public.s2a_announcement_mark_read(other,a) then raise exception 'ineligible announcement disclosed or receipt accepted';end if;
 if not public.s2a_announcement_mark_read(uid,a) or not public.s2a_announcement_mark_read(uid,a) then raise exception 'eligible receipt not idempotent';end if;
 result:=public.s2a_announcement_read_status(a,1,20,'targeting-');
 if result->'items'->0->>'balance'<>'100.00000000' and (result->'items'->0->>'balance')::numeric<>100 then raise exception 'real balance missing';end if;
 if result->'items'->0->>'eligible'<>'true' or result->'items'->1->>'eligible'<>'false' then raise exception 'admin eligibility differs';end if;
 update public.s2a_subscriptions set status='revoked' where user_id=uid;
 if jsonb_array_length(public.s2a_announcements_for_user(uid))<>0 or public.s2a_announcement_mark_read(uid,a) then raise exception 'revoked subscription still eligible';end if;
 update public.s2a_subscriptions set status='active',expires_at=now()-interval '1 second' where user_id=uid;
 if public.s2a_announcement_matches(rules,uid) then raise exception 'expired subscription eligible';end if;
 update public.s2a_subscriptions set expires_at=now()+interval '1 day',starts_at=now()+interval '1 hour' where user_id=uid;
 if public.s2a_announcement_matches(rules,uid) then raise exception 'future subscription eligible';end if;
 update public.s2a_announcements set targeting=jsonb_set(rules,'{any_of}',rules->'any_of'||'[{"all_of":[{"type":"balance","operator":"eq","value":0}]}]'::jsonb) where id=a;
 if not public.s2a_announcement_mark_read(other,a) then raise exception 'OR rule failed';end if;
 begin update public.s2a_announcements set targeting='{"any_of":[{"all_of":[]}]}' where id=a;raise exception 'empty AND allowed';exception when check_violation then null;end;
 begin update public.s2a_announcements set targeting='{"any_of":[{"all_of":[{"type":"subscription","operator":"in","group_ids":[1]}]}]}' where id=a;raise exception 'invalid group ID allowed';exception when check_violation then null;end;
end $$;
set local role authenticated;
do $$ begin
 begin perform public.s2a_announcement_matches('{}','cccccccc-cccc-4ccc-8ccc-ccccccccccc1');raise exception 'public eligibility enumeration';exception when insufficient_privilege then null;end;
end $$;
rollback;
