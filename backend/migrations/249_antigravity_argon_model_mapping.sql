-- Add Argon to legacy saved mappings while preserving explicit and wildcard routes.
DO $$
DECLARE account_row record; original_mapping jsonb; mapping jsonb; model text; target text;
BEGIN
    FOR account_row IN
        SELECT id,credentials FROM accounts
        WHERE platform='antigravity' AND deleted_at IS NULL
        FOR UPDATE
    LOOP
        original_mapping := account_row.credentials->'model_mapping';
        IF jsonb_typeof(original_mapping) IS DISTINCT FROM 'object' THEN CONTINUE; END IF;
        IF NOT EXISTS (SELECT FROM jsonb_each(original_mapping) WHERE jsonb_typeof(value)='string') THEN CONTINUE; END IF;
        mapping := original_mapping;
        FOR model,target IN SELECT key,value FROM jsonb_each_text('{
            "gemini-4-argon":"gemini-4-argon-high",
            "gemini-4-argon-low":"gemini-4-argon-low",
            "gemini-4-argon-medium":"gemini-4-argon-medium",
            "gemini-4-argon-high":"gemini-4-argon-high"
        }'::jsonb)
        LOOP
            IF NOT EXISTS (
                SELECT FROM jsonb_each(mapping)
                WHERE jsonb_typeof(value)='string'
                  AND (key=model OR (right(key,1)='*' AND starts_with(model,left(key,-1))))
            ) THEN
                mapping := mapping || jsonb_build_object(model,target);
            END IF;
        END LOOP;
        IF mapping IS DISTINCT FROM original_mapping THEN
            UPDATE accounts SET credentials=jsonb_set(account_row.credentials,'{model_mapping}',mapping),updated_at=now()
            WHERE id=account_row.id;
        END IF;
    END LOOP;
END $$;
