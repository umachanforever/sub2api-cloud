BEGIN;
CREATE TABLE IF NOT EXISTS s2a_private.chat_media (
 path text PRIMARY KEY, expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '8 days'
);
ALTER TABLE s2a_private.chat_media OWNER TO s2a_management;
ALTER TABLE s2a_private.chat_media ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON s2a_private.chat_media FROM PUBLIC,anon,authenticated,service_role;
CREATE INDEX IF NOT EXISTS chat_media_expiry ON s2a_private.chat_media(expires_at);
CREATE OR REPLACE FUNCTION public.s2a_chat_media_register(p_lease_id uuid,p_path text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF p_path IS NULL OR p_path !~ '^images/imgtask_[a-f0-9]{32}/image-1\.(png|jpg|webp)$' THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM s2a_private.personal_gateway_leases l JOIN public.groups g ON g.id=l.group_id WHERE l.id=p_lease_id AND l.finished_at IS NULL AND l.expires_at>clock_timestamp() AND g.allow_image_generation) THEN RETURN false; END IF;
 INSERT INTO s2a_private.chat_media(path) VALUES(p_path) ON CONFLICT DO NOTHING;
 RETURN true;
END $$;
CREATE OR REPLACE FUNCTION public.s2a_chat_media_expired()
RETURNS SETOF text LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT path FROM s2a_private.chat_media WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 20;
$$;
CREATE OR REPLACE FUNCTION public.s2a_chat_media_deleted(p_path text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 DELETE FROM s2a_private.chat_media WHERE path=p_path AND expires_at<=clock_timestamp();
$$;
ALTER FUNCTION public.s2a_chat_media_register(uuid,text) OWNER TO s2a_management;
ALTER FUNCTION public.s2a_chat_media_expired() OWNER TO s2a_management;
ALTER FUNCTION public.s2a_chat_media_deleted(text) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION public.s2a_chat_media_register(uuid,text),public.s2a_chat_media_expired(),public.s2a_chat_media_deleted(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.s2a_chat_media_register(uuid,text),public.s2a_chat_media_expired(),public.s2a_chat_media_deleted(text) TO service_role;
COMMIT;
