import { openAIPlanTypeKey, openAIPlanTypeLabel, openAIPlanTypes } from '@/utils/planType'
import {
  BUILTIN_PLATFORM_CATALOG,
  getProviderMode,
  getProviderProfile,
  type ProviderProtocolRule
} from '@/constants/platformCatalog'

export function applyInterceptWarmup(
  credentials: Record<string, unknown>,
  enabled: boolean,
  mode: 'create' | 'edit'
): void {
  if (enabled) {
    credentials.intercept_warmup_requests = true
  } else if (mode === 'edit') {
    delete credentials.intercept_warmup_requests
  }
}

export const ANTIGRAVITY_PROJECT_ID_CREDENTIAL_KEY = 'antigravity_project_id'

export function applyAntigravityProjectID(
  credentials: Record<string, unknown>,
  projectId: string,
  mode: 'create' | 'edit'
): void {
  const trimmed = projectId.trim()
  if (trimmed) {
    credentials[ANTIGRAVITY_PROJECT_ID_CREDENTIAL_KEY] = trimmed
  } else if (mode === 'edit') {
    delete credentials[ANTIGRAVITY_PROJECT_ID_CREDENTIAL_KEY]
  }
}

// ========== Request-header overrides (API-key platforms + grok api_key/oauth accounts) ==========

export const HEADER_OVERRIDE_ENABLED_CREDENTIAL_KEY = 'header_override_enabled'
export const HEADER_OVERRIDES_CREDENTIAL_KEY = 'header_overrides'

export interface HeaderOverrideRow {
  name: string
  value: string
}

/** Request-header override eligibility (kept consistent with the backend IsHeaderOverrideEligible) */
export function isHeaderOverrideCapable(platform: string, type: string): boolean {
  if (platform === 'anthropic' || platform === 'openai' || isMultiProtocolApiKeyPlatform(platform)) {
    return type === 'apikey'
  }
  if (platform === 'grok') {
    return type === 'apikey' || type === 'oauth'
  }
  return false
}

/** Request headers that cannot be overridden (kept consistent with the backend headerOverrideBlockedNames) */
const HEADER_OVERRIDE_BLOCKED_NAMES = new Set([
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'upgrade',
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'cookie',
  'accept-encoding',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-protocol',
  'sec-websocket-accept',
  'session_id',
  'conversation_id',
  'x-codex-turn-state',
  'x-codex-turn-metadata',
  'chatgpt-account-id',
  'x-claude-code-session-id',
  'x-client-request-id',
  'x-grok-conv-id'
])

/** RFC 7230 token: valid character set for HTTP header names */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

function isValidHeaderOverrideName(name: string): boolean {
  return HEADER_NAME_PATTERN.test(name)
}

/** Kept consistent with the backend maxHeaderOverride* constants */
const HEADER_OVERRIDE_MAX_ENTRIES = 64
const HEADER_OVERRIDE_MAX_NAME_LENGTH = 200
const HEADER_OVERRIDE_MAX_VALUE_LENGTH = 8192

/** Header values must not contain control characters (aligned with the backend httpguts.ValidHeaderFieldValue) */
// eslint-disable-next-line no-control-regex
const HEADER_VALUE_INVALID_PATTERN = /[\x00-\x08\x0a-\x1f\x7f]/

/** Length limits are measured in UTF-8 bytes (aligned with the backend Go len(), preventing multibyte values from passing the frontend and causing a backend 400) */
const HEADER_TEXT_ENCODER = new TextEncoder()
function utf8ByteLength(value: string): number {
  return HEADER_TEXT_ENCODER.encode(value).length
}

/**
 * Validates request-header override rows and returns the i18n key of the first error (null if none).
 * Empty name with non-empty value → invalidName; invalid name → invalidName;
 * Forbidden override → blockedName; case-insensitive duplicate name → duplicateName;
 * Value contains control characters or is too long → invalidValue; too many entries → tooManyEntries.
 */
export function validateHeaderOverrideRows(
  rows: HeaderOverrideRow[]
): 'invalidName' | 'blockedName' | 'duplicateName' | 'invalidValue' | 'tooManyEntries' | null {
  const seen = new Set<string>()
  for (const row of rows) {
    const name = row.name.trim()
    const value = row.value.trim()
    if (!name) {
      if (value) return 'invalidName'
      continue
    }
    if (!isValidHeaderOverrideName(name) || name.length > HEADER_OVERRIDE_MAX_NAME_LENGTH) {
      return 'invalidName'
    }
    const lower = name.toLowerCase()
    if (HEADER_OVERRIDE_BLOCKED_NAMES.has(lower)) return 'blockedName'
    if (seen.has(lower)) return 'duplicateName'
    if (
      HEADER_VALUE_INVALID_PATTERN.test(value) ||
      utf8ByteLength(value) > HEADER_OVERRIDE_MAX_VALUE_LENGTH
    ) {
      return 'invalidValue'
    }
    seen.add(lower)
  }
  if (seen.size > HEADER_OVERRIDE_MAX_ENTRIES) return 'tooManyEntries'
  return null
}

/** Row array → credentials storage object (lowercase names, discard empty rows) */
export function buildHeaderOverridesObject(rows: HeaderOverrideRow[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const row of rows) {
    const name = row.name.trim().toLowerCase()
    if (!name) continue
    result[name] = row.value.trim()
  }
  return result
}

/** Credentials storage object → row array (sort by name for stable display) */
export function splitHeaderOverridesObject(record: unknown): HeaderOverrideRow[] {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return []
  return Object.entries(record as Record<string, unknown>)
    .filter(([, value]) => typeof value === 'string')
    .map(([name, value]) => ({ name, value: value as string }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Parses pasted JSON text into request-header override rows.
 * Accepts only flat JSON objects; values may be string/number/boolean (all converted to strings),
 * other types or non-object input return null to indicate an invalid format. Entries with blank keys are discarded.
 */
export function parseHeaderOverridesJson(text: string): HeaderOverrideRow[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const rows: HeaderOverrideRow[] = []
  for (const [rawName, rawValue] of Object.entries(parsed as Record<string, unknown>)) {
    const name = rawName.trim()
    if (!name) continue
    if (
      typeof rawValue !== 'string' &&
      typeof rawValue !== 'number' &&
      typeof rawValue !== 'boolean'
    ) {
      return null
    }
    rows.push({ name, value: String(rawValue).trim() })
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name))
}

/** Request-header override rows → JSON text for migration/backup (skip placeholder rows with empty names) */
export function serializeHeaderOverrideRows(rows: HeaderOverrideRow[]): string {
  const record: Record<string, string> = {}
  for (const row of rows) {
    const name = row.name.trim()
    if (!name) continue
    record[name] = row.value.trim()
  }
  return JSON.stringify(record, null, 2)
}

// ========== Grok custom forwarding addresses (base_url only rewrites the forwarding endpoint; credential lifecycle is unaffected) ==========

/** CLI gateway host written by default when creating/refreshing OAuth accounts—only this is treated as "not customized". */
const GROK_DEFAULT_GATEWAY_HOST = 'cli-chat-proxy.grok.com'

/**
 * Determines whether the Grok account storage base_url is an explicitly specified upstream endpoint.
 * Operators can manually switch between the official API, regional API, and third-party forwarding addresses (to handle
 * an unavailable single endpoint); all these values must be echoed (toggle enabled + displayed address). Only the default CLI gateway
 * (automatically written on creation/refresh), empty values, and unparseable values are treated as "not customized" (aligned with
 * the fallback semantics of the backend GetGrokBaseURL), to determine the initial toggle state when editing an OAuth account.
 */
export function isCustomGrokBaseUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (!trimmed) return false
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return false
  }
  return parsed.hostname.toLowerCase() !== GROK_DEFAULT_GATEWAY_HOST
}

export interface GrokBaseUrlPreset {
  /** i18n subkey: admin.accounts.grokCustomBaseUrl.presets.<labelKey> */
  labelKey?: 'cli' | 'official'
  /** Literal label (such as the regional identifier us-east-1); proper nouns are not localized */
  label?: string
  url: string
}

/**
 * Grok quick endpoints (for quick filling only; the input still allows any forwarding address).
 * When the official endpoint is intermittently unavailable, operators can manually switch endpoints using these presets.
 */
export const GROK_BASE_URL_PRESETS: GrokBaseUrlPreset[] = [
  { labelKey: 'cli', url: 'https://cli-chat-proxy.grok.com/v1' },
  { labelKey: 'official', url: 'https://api.x.ai/v1' },
  { label: 'us-east-1', url: 'https://us-east-1.api.x.ai/v1' },
  { label: 'us-west-2', url: 'https://us-west-2.api.x.ai/v1' },
  { label: 'eu-west-1', url: 'https://eu-west-1.api.x.ai/v1' }
]

// ========== Multi-protocol API key providers (domestic vendors and aggregation platforms) ==========
// Default endpoints, native protocol capabilities, and built-in routing rules come from the platform catalog (constants/platformCatalog,
// i.e. the backend ProviderProfile); newly registered providers do not need to be added here.
// Account type (account_mode, such as payg usage-based billing / coding coding plan) determines quota monitoring and
// the default endpoint; the API protocol (chat_completions / anthropic / responses) determines the forwarding endpoint and
// format. The two are orthogonal. Requests using the same protocol pass through without conversion; cross-protocol combinations use the conversion chain.

export type CnAccountMode = 'payg' | 'coding'
export type OpenCodeAccountMode = 'zen' | 'go'
export type CnProviderPlatform = 'kimi' | 'zhipu' | 'deepseek' | 'minimax'

/** adaptive selects the native endpoint based on the inbound protocol (or model rules). */
export type CnApiProtocol = 'adaptive' | 'chat_completions' | 'anthropic' | 'responses'
export type CnNativeApiProtocol = Exclude<CnApiProtocol, 'adaptive'>

const NATIVE_API_PROTOCOLS: CnNativeApiProtocol[] = ['chat_completions', 'anthropic', 'responses']

export function isCNProviderPlatform(platform: string): platform is CnProviderPlatform {
  return platform === 'kimi' || platform === 'zhipu' || platform === 'deepseek' || platform === 'minimax'
}

/** Whether the platform is a multi-protocol API key provider (has a profile in the platform catalog). */
export function isMultiProtocolApiKeyPlatform(platform: string): boolean {
  return !!getProviderProfile(platform)
}

/** Whether the provider offers a native endpoint for a protocol in this access mode (unknown modes use the default mode). */
export function providerSupportsProtocol(platform: string, mode: string | undefined, protocol: CnNativeApiProtocol): boolean {
  return !!getProviderMode(platform, mode)?.base_urls[protocol]
}

/** Whether the provider offers a native Responses endpoint (DeepSeek / Kimi / MiniMax / OpenCode, etc.). */
export function cnSupportsNativeResponses(platform: string, mode?: string): boolean {
  return providerSupportsProtocol(platform, mode, 'responses')
}

/** Native protocols available for direct connection in this access mode (in chat_completions, anthropic, responses order). */
export function providerNativeProtocols(platform: string, mode?: string): CnNativeApiProtocol[] {
  return NATIVE_API_PROTOCOLS.filter(protocol => providerSupportsProtocol(platform, mode, protocol))
}

/** The provider selects the upstream protocol by model name (multi-model aggregation platform); adaptive accounts carry routing rules in this case. */
export function providerRoutesByModel(platform: string): boolean {
  return getProviderProfile(platform)?.routing === 'by_model'
}

/** The upstream model catalog specifies the protocols supported by each model; models not matched by routing rules select a protocol accordingly. */
export function providerHasModelCatalog(platform: string): boolean {
  return getProviderProfile(platform)?.model_catalog === true
}

/** Display name of the access mode; unknown modes are displayed unchanged. */
export function providerModeLabel(mode: string, t: (key: string) => string): string {
  switch (mode) {
    case 'payg':
      return t('admin.accounts.cnProviders.accountMode.payg')
    case 'coding':
      return t('admin.accounts.cnProviders.accountMode.coding')
    case 'zen':
      return t('admin.accounts.opencodeGo.accountMode.zen')
    case 'go':
      return t('admin.accounts.opencodeGo.accountMode.go')
    default:
      return mode
  }
}

/** The provider's access modes, with the default mode first. */
export function providerAccountModes(platform: string): string[] {
  return getProviderProfile(platform)?.modes.map(item => item.mode) ?? []
}

/** Normalized access mode: values not in the provider's mode list fall back to the default mode. */
export function resolveProviderAccountMode(platform: string, value: unknown): string {
  const profile = getProviderProfile(platform)
  if (!profile) return typeof value === 'string' ? value : ''
  if (typeof value === 'string' && profile.modes.some(item => item.mode === value)) return value
  return profile.default_mode
}

function builtinModeBaseUrl(platform: string, mode: string, protocol: CnNativeApiProtocol): string {
  const profile = BUILTIN_PLATFORM_CATALOG.platforms.find(spec => spec.id === platform)?.multi_protocol
  return profile?.modes.find(item => item.mode === mode)?.base_urls[protocol] ?? ''
}

export const OPENCODE_GO_BASE_URL = builtinModeBaseUrl('opencode_go', 'go', 'chat_completions')
export const OPENCODE_GO_ANTHROPIC_BASE_URL = builtinModeBaseUrl('opencode_go', 'go', 'anthropic')
export const OPENCODE_ZEN_BASE_URL = builtinModeBaseUrl('opencode_go', 'zen', 'chat_completions')
export const OPENCODE_ZEN_ANTHROPIC_BASE_URL = builtinModeBaseUrl('opencode_go', 'zen', 'anthropic')

export function isOpenCodeGoPlatform(platform: string): boolean {
  return platform === 'opencode_go'
}

export const OPENCODE_GO_PROTOCOL_RULES_KEY = 'protocol_rules'

export interface OpenCodeGoProtocolRule {
  pattern: string
  /** Preferred protocol: used when the inbound protocol is not among the model's supported protocols. */
  protocol: CnNativeApiProtocol
  /** Other protocols supported by the model (excluding protocol); when the inbound protocol is among them, same-protocol passthrough avoids protocol conversion. */
  extraProtocols?: CnNativeApiProtocol[]
}

function isNativeOpenCodeGoProtocol(value: unknown): value is CnNativeApiProtocol {
  return value === 'chat_completions' || value === 'anthropic' || value === 'responses'
}

/** Extracts native protocols other than the preferred protocol from the protocols list (deduplicated, preserving order). */
function extraRuleProtocols(protocol: CnNativeApiProtocol, protocols: unknown): CnNativeApiProtocol[] {
  if (!Array.isArray(protocols)) return []
  const extra: CnNativeApiProtocol[] = []
  for (const item of protocols) {
    if (isNativeOpenCodeGoProtocol(item) && item !== protocol && !extra.includes(item)) extra.push(item)
  }
  return extra
}

function buildRule(pattern: string, protocol: CnNativeApiProtocol, protocols?: unknown): OpenCodeGoProtocolRule {
  const extra = extraRuleProtocols(protocol, protocols)
  return extra.length > 0 ? { pattern, protocol, extraProtocols: extra } : { pattern, protocol }
}

/** Protocol set supported by the rule, with the preferred protocol first. */
export function protocolRuleSet(rule: OpenCodeGoProtocolRule): CnNativeApiProtocol[] {
  return [rule.protocol, ...extraRuleProtocols(rule.protocol, rule.extraProtocols)]
}

function normalizeProfileRules(rules: ProviderProtocolRule[] | undefined): OpenCodeGoProtocolRule[] {
  return (rules ?? [])
    .filter(rule => rule.pattern && isNativeOpenCodeGoProtocol(rule.protocol))
    .map(rule => buildRule(rule.pattern, rule.protocol as CnNativeApiProtocol, rule.protocols))
}

function builtinProtocolRules(platform: string, mode: string): OpenCodeGoProtocolRule[] {
  const profile = BUILTIN_PLATFORM_CATALOG.platforms.find(spec => spec.id === platform)?.multi_protocol
  return normalizeProfileRules(profile?.modes.find(item => item.mode === mode)?.protocol_rules)
}

export const DEFAULT_OPENCODE_GO_PROTOCOL_RULES: OpenCodeGoProtocolRule[] = builtinProtocolRules('opencode_go', 'go')
export const DEFAULT_OPENCODE_ZEN_PROTOCOL_RULES: OpenCodeGoProtocolRule[] = builtinProtocolRules('opencode_go', 'zen')

/** Built-in routing rules for the provider's access mode (first matching rule applies; unknown modes use the default mode). */
export function defaultProviderProtocolRules(platform: string, mode?: string): OpenCodeGoProtocolRule[] {
  return normalizeProfileRules(getProviderMode(platform, mode)?.protocol_rules)
}

export function resolveOpenCodeAccountMode(value: unknown): OpenCodeAccountMode {
  return value === 'zen' ? 'zen' : 'go'
}

export function defaultOpenCodeProtocolRules(mode: string = 'go'): OpenCodeGoProtocolRule[] {
  return defaultProviderProtocolRules('opencode_go', mode === 'zen' ? 'zen' : 'go')
}

export function cloneOpenCodeGoProtocolRules(
  rules: OpenCodeGoProtocolRule[] = DEFAULT_OPENCODE_GO_PROTOCOL_RULES
): OpenCodeGoProtocolRule[] {
  return rules.map(rule => buildRule(rule.pattern, rule.protocol, rule.extraProtocols))
}

export function parseOpenCodeGoProtocolRules(raw: unknown): OpenCodeGoProtocolRule[] | null {
  if (raw == null) return null
  if (!Array.isArray(raw)) return cloneOpenCodeGoProtocolRules()
  const rules: OpenCodeGoProtocolRule[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const pattern = typeof (item as { pattern?: unknown }).pattern === 'string'
      ? (item as { pattern: string }).pattern.trim()
      : ''
    const protocols = (item as { protocols?: unknown }).protocols
    let protocol = (item as { protocol?: unknown }).protocol
    // Consistent with the backend: when only protocols is provided, its first entry is the preferred protocol.
    if ((protocol == null || protocol === '') && Array.isArray(protocols)) protocol = protocols[0]
    if (!pattern || !isNativeOpenCodeGoProtocol(protocol)) continue
    rules.push(buildRule(pattern, protocol, protocols))
  }
  return rules
}

export function applyOpenCodeGoProtocolRules(
  credentials: Record<string, unknown>,
  rules: OpenCodeGoProtocolRule[],
  mode: 'create' | 'edit'
): void {
  const serialized = rules
    .filter(rule => isNativeOpenCodeGoProtocol(rule.protocol))
    .map(rule => {
      const entry: { pattern: string; protocol: CnNativeApiProtocol; protocols?: CnNativeApiProtocol[] } = {
        pattern: rule.pattern.trim().toLowerCase(),
        protocol: rule.protocol
      }
      const protocols = protocolRuleSet(rule)
      if (protocols.length > 1) entry.protocols = protocols
      return entry
    })
    .filter(rule => rule.pattern.length > 0)
  if (serialized.length > 0 || mode === 'edit') {
    credentials[OPENCODE_GO_PROTOCOL_RULES_KEY] = serialized
  }
}

export interface CnBaseUrlPreset {
  mode: CnAccountMode
  protocol: CnApiProtocol
  /** Proper noun, not localized */
  label: string
  url: string
}

/** Quick endpoints for each provider by account type × API protocol (click to fill quickly; the input still allows free-form entry). */
export const CN_BASE_URL_PRESETS: Record<CnProviderPlatform, CnBaseUrlPreset[]> = {
  kimi: [
    { mode: 'payg', protocol: 'chat_completions', label: 'Moonshot', url: 'https://api.moonshot.cn/v1' },
    { mode: 'payg', protocol: 'anthropic', label: 'Moonshot Anthropic', url: 'https://api.moonshot.cn/anthropic' },
    { mode: 'payg', protocol: 'responses', label: 'Moonshot Responses', url: 'https://api.moonshot.cn/v1' },
    { mode: 'coding', protocol: 'chat_completions', label: 'Kimi For Coding', url: 'https://api.kimi.com/coding/v1' },
    { mode: 'coding', protocol: 'anthropic', label: 'Kimi Coding Anthropic', url: 'https://api.kimi.com/coding' },
    { mode: 'coding', protocol: 'responses', label: 'Kimi Coding Responses', url: 'https://api.kimi.com/coding/v1' }
  ],
  zhipu: [
    { mode: 'payg', protocol: 'chat_completions', label: 'GLM PaaS', url: 'https://open.bigmodel.cn/api/paas/v4' },
    { mode: 'payg', protocol: 'anthropic', label: 'GLM Anthropic', url: 'https://open.bigmodel.cn/api/anthropic' },
    { mode: 'coding', protocol: 'chat_completions', label: 'GLM Coding', url: 'https://open.bigmodel.cn/api/coding/paas/v4' },
    { mode: 'coding', protocol: 'anthropic', label: 'GLM Coding Anthropic', url: 'https://open.bigmodel.cn/api/anthropic' }
  ],
  deepseek: [
    { mode: 'payg', protocol: 'chat_completions', label: 'DeepSeek', url: 'https://api.deepseek.com' },
    { mode: 'payg', protocol: 'anthropic', label: 'DeepSeek Anthropic', url: 'https://api.deepseek.com/anthropic' },
    { mode: 'payg', protocol: 'responses', label: 'DeepSeek Responses', url: 'https://api.deepseek.com' }
  ],
  minimax: [
    { mode: 'payg', protocol: 'chat_completions', label: 'MiniMax CN', url: 'https://api.minimaxi.com/v1' },
    { mode: 'payg', protocol: 'anthropic', label: 'MiniMax CN Anthropic', url: 'https://api.minimaxi.com/anthropic' },
    { mode: 'payg', protocol: 'responses', label: 'MiniMax CN Responses', url: 'https://api.minimaxi.com/v1' },
    { mode: 'payg', protocol: 'chat_completions', label: 'MiniMax Intl', url: 'https://api.minimax.io/v1' },
    { mode: 'payg', protocol: 'anthropic', label: 'MiniMax Intl Anthropic', url: 'https://api.minimax.io/anthropic' },
    { mode: 'payg', protocol: 'responses', label: 'MiniMax Intl Responses', url: 'https://api.minimax.io/v1' },
    { mode: 'coding', protocol: 'chat_completions', label: 'MiniMax Coding CN', url: 'https://api.minimaxi.com/v1' },
    { mode: 'coding', protocol: 'anthropic', label: 'MiniMax Coding CN Anthropic', url: 'https://api.minimaxi.com/anthropic' },
    { mode: 'coding', protocol: 'responses', label: 'MiniMax Coding CN Responses', url: 'https://api.minimaxi.com/v1' },
    { mode: 'coding', protocol: 'chat_completions', label: 'MiniMax Coding Intl', url: 'https://api.minimax.io/v1' },
    { mode: 'coding', protocol: 'anthropic', label: 'MiniMax Coding Intl Anthropic', url: 'https://api.minimax.io/anthropic' },
    { mode: 'coding', protocol: 'responses', label: 'MiniMax Coding Intl Responses', url: 'https://api.minimax.io/v1' }
  ]
}

/**
 * Returns the default base URL for the specified provider + access mode + API protocol (from the platform catalog).
 * Falls back to the Chat Completions base URL when the mode does not provide a native Responses endpoint; returns an empty string when it does not provide Anthropic.
 */
export function defaultCNBaseUrl(
  platform: string,
  mode: string,
  protocol: CnApiProtocol = 'chat_completions'
): string {
  const baseUrls = getProviderMode(platform, mode)?.base_urls
  if (!baseUrls) return ''
  const chatBaseUrl = baseUrls.chat_completions ?? ''
  switch (protocol) {
    case 'anthropic':
      return baseUrls.anthropic ?? ''
    case 'responses':
      return baseUrls.responses || chatBaseUrl
    default:
      return chatBaseUrl
  }
}

/** Returns the default endpoints for each native protocol in adaptive mode; unsupported protocols return an empty string. */
export function defaultCNAdaptiveBaseUrls(
  platform: string,
  mode: string
): Record<CnNativeApiProtocol, string> {
  const baseUrls = getProviderMode(platform, mode)?.base_urls ?? {}
  return {
    chat_completions: baseUrls.chat_completions ?? '',
    anthropic: baseUrls.anthropic ?? '',
    responses: baseUrls.responses ?? ''
  }
}

// ===== Usage cell visibility for domestic providers (single source of truth) =====
// Placeholder determination for CNProviderQuotaCell / CNProviderBalanceCell and AccountUsageCell
// is shared to avoid copying conditions in multiple places and changing one while missing another.

/** Account fields required to determine usage cell visibility. */
export interface CNUsageCellAccount {
  platform: string
  type: string
  credentials?: Record<string, unknown>
}

// Command Code and Cline's credit and usage APIs query only API key accounts on the official host (consistent with the backend
// commandCodeUsageSupported / clineAccountAPISupported): custom forwarding keys are not sent to
// official APIs; the backend rejects probing directly, so the cell only displays one error line.
const OFFICIAL_ACCOUNT_API_PLATFORMS = ['command_code', 'cline']

function cnUsageCellAccountMode(account: CNUsageCellAccount): string {
  const mode = account.credentials?.account_mode
  return typeof mode === 'string' ? mode : ''
}

/** Consistent with the backend Account.GetAPIProtocol: providers with model-based routing use adaptive when no native protocol is specified. */
function accountUsesAdaptiveProtocol(platform: string, mode: string, protocol: unknown): boolean {
  if (protocol === 'adaptive') return true
  if (protocol === 'chat_completions' || protocol === 'anthropic') return false
  if (protocol === 'responses' && cnSupportsNativeResponses(platform, mode)) return false
  return providerRoutesByModel(platform)
}

/**
 * The Chat Completions endpoint actually used by the account (consistent with backend Account.GetOpenAIBaseURL): adaptive
 * accounts prioritize protocol-specific endpoints, then base_url; when neither is set, they use the default endpoint from the platform catalog.
 */
function accountChatBaseUrl(account: CNUsageCellAccount, mode: string): string {
  const credentials = account.credentials
  const baseUrls = credentials?.api_base_urls
  if (baseUrls && typeof baseUrls === 'object' && accountUsesAdaptiveProtocol(account.platform, mode, credentials?.api_protocol)) {
    const chat = (baseUrls as Record<string, unknown>).chat_completions
    if (typeof chat === 'string' && chat.trim()) return chat.trim()
  }
  const baseUrl = credentials?.base_url
  if (typeof baseUrl === 'string' && baseUrl.trim()) return baseUrl.trim()
  return defaultCNBaseUrl(account.platform, mode)
}

/** The official host is the host of the platform catalog's default endpoint, and must use https. */
function officialAccountAPISupported(account: CNUsageCellAccount, mode: string): boolean {
  if (account.type !== 'apikey') return false
  try {
    const target = new URL(accountChatBaseUrl(account, mode))
    const official = new URL(defaultCNBaseUrl(account.platform, mode))
    return target.protocol === 'https:' && target.hostname === official.hostname
  } catch {
    return false
  }
}

export function cnQuotaCellVisible(account: CNUsageCellAccount): boolean {
  const { platform } = account
  const mode = cnUsageCellAccountMode(account)
  if (platform === 'opencode_go') return mode !== 'zen'
  // Command Code and Cline: the subscription window and credits are refreshed by a single probe.
  if (OFFICIAL_ACCOUNT_API_PLATFORMS.includes(platform)) return officialAccountAPISupported(account, mode)
  return (platform === 'kimi' || platform === 'zhipu' || platform === 'minimax') && mode === 'coding'
}

export function cnBalanceCellVisible(account: CNUsageCellAccount): boolean {
  const { platform } = account
  const mode = cnUsageCellAccountMode(account)
  if (OFFICIAL_ACCOUNT_API_PLATFORMS.includes(platform)) return officialAccountAPISupported(account, mode)
  return (platform === 'kimi' || platform === 'deepseek') && mode !== 'coding'
}

/**
 * Writes request-header overrides to credentials.
 * create mode: write no fields when disabled; edit mode: delete the fields when disabled (full replacement semantics).
 */
export function applyHeaderOverride(
  credentials: Record<string, unknown>,
  enabled: boolean,
  rows: HeaderOverrideRow[],
  mode: 'create' | 'edit'
): void {
  if (enabled) {
    credentials[HEADER_OVERRIDE_ENABLED_CREDENTIAL_KEY] = true
    credentials[HEADER_OVERRIDES_CREDENTIAL_KEY] = buildHeaderOverridesObject(rows)
  } else if (mode === 'edit') {
    delete credentials[HEADER_OVERRIDE_ENABLED_CREDENTIAL_KEY]
    delete credentials[HEADER_OVERRIDES_CREDENTIAL_KEY]
  }
}

// ===== Manual override for OpenAI plan_type (ChatGPT subscription tier) =====

export interface PlanTypeOption {
  value: string
  label: string
  // Compatible with common/Select.vue's SelectOption (including the index signature)
  [key: string]: unknown
}

/**
 * Friendly display label for the plan_type value (ChatGPT tier naming).
 * Shares openAIPlanTypeLabel with PlatformTypeBadge to avoid mapping drift between the two;
 * the canonical value chatgptpro displays as Pro 200, and team displays as Business. Unknown values are returned unchanged.
 */
export function planTypeDisplayLabel(value: string): string {
  return openAIPlanTypeLabel(value) || value
}

/**
 * Reads plan_type from credentials, accepting strings only (dirty data such as 42/true is treated as empty,
 * preventing it from being retained as a valid custom option).
 */
export function readPlanType(credentials: Record<string, unknown> | undefined | null): string {
  const v = credentials?.plan_type
  return typeof v === 'string' ? v : ''
}

/** Build SKU-preserving choices; aliases replace only the same canonical SKU. */
export function buildPlanTypeOptions(current: string, clearLabel: string): PlanTypeOption[] {
  const cur = (current || '').trim()
  const key = openAIPlanTypeKey(cur)
  const opts: PlanTypeOption[] = [{ value: '', label: clearLabel }]
  for (const preset of openAIPlanTypes) {
    const value = cur && key === openAIPlanTypeKey(preset) ? cur : preset
    opts.push({ value, label: planTypeDisplayLabel(value) })
  }
  if (cur && !opts.some(option => option.value === cur)) {
    opts.push({ value: cur, label: planTypeDisplayLabel(cur) })
  }
  return opts
}

/**
 * Writes the manually selected plan_type to credentials: set the key when non-empty, delete it when empty (clear/auto-detect).
 * Mutates and returns the input object directly.
 */
export function applyPlanType(
  credentials: Record<string, unknown>,
  planType: string
): Record<string, unknown> {
  const pt = (planType || '').trim()
  if (pt) {
    credentials.plan_type = pt
  } else {
    delete credentials.plan_type
  }
  return credentials
}
