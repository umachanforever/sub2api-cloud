-- Run as the database administrator after personal-gateway.sql.
BEGIN;
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN
  PERFORM cron.schedule('s2a-gateway-maintenance','43 * * * *','SELECT s2a_private.prune_personal_gateway_leases();');
 END IF;
END $$;
COMMIT;
