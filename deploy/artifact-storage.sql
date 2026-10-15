-- Keep queued request bodies and generated media out of public database rows.
DO $$
BEGIN
    IF to_regclass('storage.buckets') IS NULL THEN RETURN; END IF;
    INSERT INTO storage.buckets(id,name,public,file_size_limit)
        VALUES('sub2api-artifacts','sub2api-artifacts',false,268435456)
        ON CONFLICT(id) DO UPDATE SET public=false,file_size_limit=excluded.file_size_limit;
END $$;
