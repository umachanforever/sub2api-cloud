-- API-key validation reads account status; Supabase does not grant this by default.
grant select (id, banned_until) on auth.users to service_role;
