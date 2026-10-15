// Derive a separate, deployment-independent key for scheduled job tickets.
// Keep the original HKDF salt stable across project branding changes.
export async function jobSigningKey(encryptionKey: string): Promise<string> {
  const bytes = Uint8Array.from(atob(encryptionKey), character => character.charCodeAt(0));
  if (bytes.length !== 32) throw Error('Invalid credential encryption key');
  const key = await crypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('sub2api-supabase'), info: new TextEncoder().encode('scheduled-jobs-v1') }, key, 256);
  return Array.from(new Uint8Array(bits), byte => byte.toString(16).padStart(2, '0')).join('');
}
