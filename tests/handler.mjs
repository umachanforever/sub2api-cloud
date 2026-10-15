import {createHandler as handler} from '../supabase/functions/sub2api/app.ts';

export function createBackendHandler(config, fetchImpl, smtp) {
 return handler(config, async (url, init) => ['s2a_log_write', 's2a_ops_error_record'].some(name => String(url).endsWith('/rest/v1/rpc/'+name))
  ? Response.json(true) : fetchImpl(url, init), smtp);
}

export const createHandler = createBackendHandler;
