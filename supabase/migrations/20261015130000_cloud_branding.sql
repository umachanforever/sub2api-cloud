UPDATE public.settings SET value = 'sub2api-cloud' WHERE key = 'site_name' AND lower(btrim(value)) IN ('sub2api', 'sub2api-supabase');
UPDATE public.s2a_settings SET data = jsonb_set(data, '{site_name}', '"sub2api-cloud"'::jsonb), updated_at = now() WHERE lower(btrim(data->>'site_name')) IN ('sub2api', 'sub2api-supabase');
