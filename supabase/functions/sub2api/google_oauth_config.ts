export type GoogleOAuthClients = {
  cli?: { clientId: string; clientSecret: string };
  aiStudio?: { clientId: string; clientSecret: string };
  antigravity?: { clientId: string; clientSecret: string };
};
export const googleOAuthVariables = [
  'GEMINI_CLI_OAUTH_CLIENT_ID', 'GEMINI_CLI_OAUTH_CLIENT_SECRET',
  'GEMINI_OAUTH_CLIENT_ID', 'GEMINI_OAUTH_CLIENT_SECRET',
  'ANTIGRAVITY_OAUTH_CLIENT_ID', 'ANTIGRAVITY_OAUTH_CLIENT_SECRET',
] as const;

export function googleOAuthClients(env: Record<string, string | undefined>): GoogleOAuthClients | undefined {
  const result: GoogleOAuthClients = {};
  for (const [kind, prefix] of [['cli', 'GEMINI_CLI_OAUTH'], ['aiStudio', 'GEMINI_OAUTH'], ['antigravity', 'ANTIGRAVITY_OAUTH']] as const) {
    const clientId = env[prefix + '_CLIENT_ID']?.trim() || '';
    const clientSecret = env[prefix + '_CLIENT_SECRET']?.trim() || '';
    if (!!clientId !== !!clientSecret || [clientId, clientSecret].some(value => value.length > 8192 || /[^A-Za-z0-9_.-]/.test(value))) {
      throw new Error('Configure ' + prefix + '_CLIENT_ID and ' + prefix + '_CLIENT_SECRET together');
    }
    if (clientId) result[kind] = { clientId, clientSecret };
  }
  return Object.keys(result).length ? result : undefined;
}
