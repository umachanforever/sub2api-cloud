import { CODEX_VERSION, type OAuthCredentials } from './gateway.ts';
import type { Database } from './db.ts';
export type CodexSettings = { version?: string; synced?: string; synced_at?: string; auto_sync?: string; user_agent?: string };
export type CodexIdentity = { version: string; userAgent: string; originator: string };
export function codexVersion(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length <= 64 && /^\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.]+)?$/.test(value.trim()) ? value.trim() : undefined;
}
const official = new Set(['codex_cli_rs','codex-tui','codex_vscode','codex_vscode_copilot','codex_app','codex_chatgpt_desktop','codex_atlas','codex_exec','codex_sdk_ts']);
function pairedUA(value: unknown): { originator: string; suffix: string } | undefined {
  if (typeof value !== 'string' || /[\x00-\x08\x0a-\x1f\x7f]/.test(value) || value.length > 8192) return;
  const match = value.trim().match(/^([^/]+)\/([^\s]+)(.*)$/);
  if (!match) return;
  const trailer = value.trim().match(/\(([^();]+);[^()]*\)\s*$/)?.[1]?.trim();
  for (const name of [match[1].trim(), trailer]) {
    if (!name || name.length > 64 || /[^\x20-\x7e]/.test(name)) continue;
    if (official.has(name.toLowerCase())) return { originator: name.toLowerCase(), suffix: match[3] };
    if (name.toLowerCase().startsWith('codex ')) return { originator: name, suffix: match[3] };
  }
}
export function resolveCodexIdentity(settings: CodexSettings = {}, credentials?: OAuthCredentials): CodexIdentity {
  let version = codexVersion(settings.version) ?? codexVersion(settings.synced) ?? CODEX_VERSION;
  const parts = version.split('-')[0].split('.').map(Number);
  if (parts[0] === 0 && (parts[1] ?? 0) < 144) version = CODEX_VERSION;
  const accountUA = (credentials as OAuthCredentials & { user_agent?: unknown } | undefined)?.user_agent;
  const pair = pairedUA(accountUA) ?? pairedUA(settings.user_agent);
  const originator = pair?.originator ?? 'codex-tui';
  return { version, originator, userAgent: `${originator}/${version}${pair?.suffix ?? ' (Ubuntu 22.4.0; x86_64) xterm-256color'}` };
}
const attempts = new WeakMap<Database, { until: number; pending?: Promise<void>; saved?: { version?: string; synced_at?: string } }>();
export async function currentCodexIdentity(db: Database, account: { codex_settings?: CodexSettings }, credentials: OAuthCredentials): Promise<CodexIdentity> {
  const settings = { ...account.codex_settings };
  if (db.config.dataModel !== 'native' || !account.codex_settings || settings.auto_sync === 'false') return resolveCodexIdentity(settings, credentials);
  const synced = Date.parse(settings.synced_at ?? '');
  if (Number.isFinite(synced) && Date.now() - synced < 6 * 3600000) return resolveCodexIdentity(settings, credentials);
  const cached = attempts.get(db);
  if (!cached || cached.until <= Date.now()) {
    const state: { until: number; pending?: Promise<void>; saved?: { version?: string; synced_at?: string } } = { until: Date.now() + 60000 };
    state.pending = (async () => {
      try {
        const response = await db.fetchImpl('https://api.github.com/repos/openai/codex/releases/latest', { headers: { accept: 'application/vnd.github+json', 'user-agent': 'sub2api-supabase' }, signal: AbortSignal.timeout(3000), redirect: 'error' });
        if (!response.ok) { await response.body?.cancel(); return; }
        const release = await response.json();
        const version = typeof release.tag_name === 'string' && /^rust-v\d+\.\d+\.\d+$/.test(release.tag_name) && release.draft === false && release.prerelease === false ? release.tag_name.slice(6) : undefined;
        if (!version) return;
        const saved = await db.rpc<{ version?: string; synced_at?: string }>('s2a_gateway_codex_version_save', { p_version: version });
        if (saved.version) { state.saved = saved; settings.synced = saved.version; settings.synced_at = saved.synced_at; state.until = Date.now() + 6 * 3600000; }
      } catch { /* Retain the last known identity when synchronization is unavailable. */ }
    })();
    attempts.set(db, state);
    await state.pending;
  } else if (cached.pending) await cached.pending;
  const saved = attempts.get(db)?.saved;
  if (saved?.version) { settings.synced = saved.version; settings.synced_at = saved.synced_at; }
  return resolveCodexIdentity(settings, credentials);
}
