import { Database, HttpError } from './db.ts';
import { authorizeJob } from './privacy_jobs.ts';
import { currentCodexIdentity, type CodexSettings } from './codex_identity.ts';
import { json } from './http.ts';

export async function codexJobs(request: Request, db: Database) {
  await authorizeJob(request, db, 'codex');
  if (db.config.dataModel !== 'native') throw new HttpError(404, 'not_found');
  const settings = await db.rpc<CodexSettings>('s2a_gateway_codex_settings', {});
  const identity = await currentCodexIdentity(db, { codex_settings: settings }, { access_token: '' }, true);
  return json(200, { version: identity.version, enabled: settings.auto_sync !== 'false' });
}
