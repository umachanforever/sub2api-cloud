import {readFile} from 'node:fs/promises';
import {issueUsageAccess} from './usage-access.mjs';

try {
  const config = JSON.parse(await readFile(new URL('../.local/agent-access.json', import.meta.url), 'utf8'));
  await issueUsageAccess({...process.env, GPT_SUBSCRIPTION_GATEWAY_KEY: config.api_key}, {link:true});
} catch (error) { console.error(error.message); process.exitCode = 1; }
