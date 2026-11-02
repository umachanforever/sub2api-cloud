BEGIN;
CREATE TABLE IF NOT EXISTS s2a_private.model_availability (
 fingerprint text PRIMARY KEY CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 key_hash text NOT NULL CHECK(key_hash ~ '^[a-f0-9]{64}$'),
 native boolean NOT NULL,platform text,client_ip text,model text NOT NULL,
 verdict text NOT NULL DEFAULT 'unverified' CHECK(verdict IN ('unverified','verified','temporary','unsupported')),
 checked_at timestamptz,last_seen timestamptz NOT NULL DEFAULT clock_timestamp(),
 due_at timestamptz NOT NULL DEFAULT clock_timestamp(),lease_id uuid,lease_until timestamptz
);
ALTER TABLE s2a_private.model_availability OWNER TO s2a_management;
ALTER TABLE s2a_private.model_availability ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON s2a_private.model_availability FROM PUBLIC,anon,authenticated,service_role;
CREATE INDEX IF NOT EXISTS model_availability_due ON s2a_private.model_availability(due_at);
-- Preserve existing verdicts while moving previous short retries to the daily cadence.
UPDATE s2a_private.model_availability SET due_at=checked_at+interval '24 hours'
WHERE checked_at IS NOT NULL AND due_at<checked_at+interval '24 hours';

CREATE OR REPLACE FUNCTION public.s2a_model_availability_read(p_key_hash text,p_native boolean,p_platform text,p_client_ip text,p_jobs jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 IF p_key_hash IS NULL OR p_key_hash !~ '^[a-f0-9]{64}$' OR p_native IS NULL
 OR (p_platform IS NOT NULL AND p_platform<>'antigravity') OR length(p_client_ip)>200
 OR jsonb_typeof(p_jobs) IS DISTINCT FROM 'array' OR jsonb_array_length(p_jobs)>1000
 OR EXISTS(SELECT FROM jsonb_array_elements(p_jobs) j WHERE coalesce(j->>'fingerprint','') !~ '^[a-f0-9]{64}$' OR coalesce(j->>'model','') !~ '^[a-zA-Z0-9._-]{1,200}$')
 THEN RAISE EXCEPTION 'invalid_model_verification_jobs'; END IF;
 INSERT INTO s2a_private.model_availability(fingerprint,key_hash,native,platform,client_ip,model)
 SELECT j->>'fingerprint',p_key_hash,p_native,p_platform,p_client_ip,j->>'model' FROM jsonb_array_elements(p_jobs) j
 ON CONFLICT(fingerprint) DO UPDATE SET last_seen=clock_timestamp(),client_ip=excluded.client_ip
 WHERE model_availability.key_hash=excluded.key_hash AND model_availability.native=excluded.native
 AND model_availability.platform IS NOT DISTINCT FROM excluded.platform
 AND model_availability.model=excluded.model;
 -- Once the canonical base is advertised, stop spending quota on hidden effort aliases.
 DELETE FROM s2a_private.model_availability a WHERE a.key_hash=p_key_hash AND a.native=p_native
 AND a.platform IS NOT DISTINCT FROM p_platform
 AND NOT EXISTS(SELECT FROM jsonb_array_elements(p_jobs) j WHERE j->>'fingerprint'=a.fingerprint)
 AND EXISTS(SELECT FROM jsonb_array_elements(p_jobs) j WHERE
  (j->>'model' LIKE 'gemini-%' AND a.model=ANY(ARRAY[(j->>'model')||'-low',(j->>'model')||'-medium',(j->>'model')||'-high',(j->>'model')||'-tiered'])) OR
  (j->>'model' LIKE 'gpt-%' AND a.model=ANY(ARRAY[(j->>'model')||'-none',(j->>'model')||'-minimal',(j->>'model')||'-low',(j->>'model')||'-medium',(j->>'model')||'-high',(j->>'model')||'-xhigh',(j->>'model')||'-max'])) OR
  (j->>'model' LIKE 'claude-%' AND a.model=ANY(ARRAY[(j->>'model')||'-low',(j->>'model')||'-medium',(j->>'model')||'-high',(j->>'model')||'-xhigh',(j->>'model')||'-max'])));
 SELECT coalesce(jsonb_agg(jsonb_build_object('fingerprint',a.fingerprint,'verdict',a.verdict,'checked_at',a.checked_at)),'[]'::jsonb) INTO result
 FROM s2a_private.model_availability a WHERE a.key_hash=p_key_hash AND a.native=p_native
 AND a.platform IS NOT DISTINCT FROM p_platform
 AND a.fingerprint IN (SELECT j->>'fingerprint' FROM jsonb_array_elements(p_jobs) j);
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.s2a_model_availability_claim()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 DELETE FROM s2a_private.model_availability WHERE last_seen<clock_timestamp()-interval '7 days' AND (lease_until IS NULL OR lease_until<clock_timestamp());
 WITH selected AS (
 SELECT fingerprint FROM s2a_private.model_availability WHERE due_at<=clock_timestamp()
 AND last_seen>clock_timestamp()-interval '7 days' AND (lease_until IS NULL OR lease_until<clock_timestamp())
 ORDER BY due_at,fingerprint LIMIT 6 FOR UPDATE SKIP LOCKED
 ), claimed AS (
 UPDATE s2a_private.model_availability a SET lease_id=gen_random_uuid(),lease_until=clock_timestamp()+interval '60 seconds'
 FROM selected s WHERE a.fingerprint=s.fingerprint RETURNING a.*
 ) SELECT coalesce(jsonb_agg(jsonb_build_object('fingerprint',fingerprint,'lease_id',lease_id,'key_hash',key_hash,'native',native,'platform',platform,'client_ip',client_ip,'model',model)),'[]'::jsonb) INTO result FROM claimed;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.s2a_model_availability_finish(p_fingerprint text,p_lease_id uuid,p_verdict text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE checked timestamptz:=clock_timestamp();
BEGIN
 IF p_verdict IS NULL OR p_verdict NOT IN ('verified','temporary','unsupported') THEN RAISE EXCEPTION 'invalid_model_verdict'; END IF;
 UPDATE s2a_private.model_availability SET verdict=p_verdict,checked_at=checked,lease_id=NULL,lease_until=NULL,
 due_at=checked+interval '24 hours'
 WHERE fingerprint=p_fingerprint AND lease_id=p_lease_id AND lease_until>clock_timestamp();
 RETURN FOUND;
END $$;
ALTER FUNCTION public.s2a_model_availability_read(text,boolean,text,text,jsonb) OWNER TO s2a_management;
ALTER FUNCTION public.s2a_model_availability_claim() OWNER TO s2a_management;
ALTER FUNCTION public.s2a_model_availability_finish(text,uuid,text) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION public.s2a_model_availability_read(text,boolean,text,text,jsonb),public.s2a_model_availability_claim(),public.s2a_model_availability_finish(text,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.s2a_model_availability_read(text,boolean,text,text,jsonb),public.s2a_model_availability_claim(),public.s2a_model_availability_finish(text,uuid,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
