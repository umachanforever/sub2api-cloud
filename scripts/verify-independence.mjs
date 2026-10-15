import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { verifyCloud } from './verify-cloud.mjs';

const containers = ['sub2api-supabase-console', 'sub2api-supabase-management', 'sub2api-supabase-redis'];
export async function verifyIndependence(config, run = docker, verify = verifyCloud) {
  const base = new URL(config.base_url);
  if (base.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/.test(base.hostname) || base.port || base.username || base.password || base.search || base.hash || !base.pathname.endsWith('/functions/v1/sub2api/v1') || !config.api_key || !config.model) throw Error('Configure a cloud base_url, api_key, and model before stopping local services');
  const running = [];
  // Inspect every target before changing anything; never touch another Compose project.
  for (const name of containers) {
    const entries = JSON.parse(await run(['inspect', name]));
    const entry = entries[0];
    if (entries.length !== 1 || entry.Name !== '/' + name || entry.Config?.Labels?.['com.docker.compose.project'] !== 'sub2api-supabase') throw Error('Local container ownership could not be verified');
    if (entry.State?.Running) running.push(name);
  }
  const stopped = [];
  let result, failure;
  try {
    for (const name of running) {
      // A command can stop the container and still report an error; restore it either way.
      stopped.push(name);
      await run(['stop', '--timeout', '20', name]);
    }
    result = await verify(config);
  } catch (error) { failure = error; }
  const restoreErrors = [];
  for (const name of stopped.reverse()) {
    try { await run(['start', name]); } catch { restoreErrors.push(name); }
  }
  if (restoreErrors.length) throw Error('Restore these local containers: ' + restoreErrors.join(', '));
  if (failure) throw failure;
  return result;
}
function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000 });
  if (result.error || result.status !== 0) throw Error('Docker ' + args[0] + ' failed');
  return result.stdout;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const interruption = new AbortController();
  const interrupt = () => interruption.abort(Error('Verification interrupted'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    const config = JSON.parse(await readFile(new URL('../.local/agent-access.json', import.meta.url), 'utf8'));
    const checks = await verifyIndependence(config, docker, value => verifyCloud(value, (url, init) => fetch(url, { ...init, signal: AbortSignal.any([init.signal, interruption.signal]) })));
    console.log('Cloud independence verified; local containers restored: ' + checks.join(', ') + '.');
  } catch (error) {
    console.error('Cloud independence verification failed: ' + error.message);
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}
