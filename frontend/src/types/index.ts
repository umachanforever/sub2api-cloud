/**
 * Core Type Definitions for Sub2API Frontend
 */

// ==================== Common Types ====================

export interface SelectOption {
  value: string | number | boolean | null
  label: string
  [key: string]: any // Support extra properties for custom templates
}

export interface BasePaginationResponse<T> {
  items: T[]
  total: number
  page: number
  page_size: number
  pages: number
}

export interface FetchOptions {
  signal?: AbortSignal
}

// ==================== Notification Types ====================

/** Notification email entry with enable/disable and verification state.
 *  email="" is a placeholder for the primary email (user's registration email or admin email). */
export interface NotifyEmailEntry {
  email: string
  disabled: boolean
  verified: boolean
}

// ==================== User & Auth Types ====================

export type UserAuthProvider = 'email' | 'linuxdo' | 'oidc' | 'wechat' | 'github' | 'google' | 'dingtalk'

export interface UserAuthBindingStatus {
  bound?: boolean
  bound_count?: number
  provider?: UserAuthProvider | string
  provider_key?: string | null
  provider_subject?: string | null
  issuer?: string | null
  label?: string | null
  provider_label?: string | null
  display_name?: string | null
  subject_hint?: string | null
  verified_at?: string | null
  bind_start_path?: string | null
  can_bind?: boolean
  can_unbind?: boolean
  note_key?: string | null
  note?: string | null
  metadata?: Record<string, unknown>
}

export interface UserProfileSourceContext {
  provider?: UserAuthProvider | string
  source?: string | null
  label?: string | null
  provider_label?: string | null
}

export interface User {
  id: number
  username: string
  email: string
  avatar_url?: string | null
  avatar_source?: string | UserProfileSourceContext | null
  username_source?: string | UserProfileSourceContext | null
  display_name_source?: string | UserProfileSourceContext | null
  nickname_source?: string | UserProfileSourceContext | null
  profile_sources?: {
    avatar?: string | UserProfileSourceContext | null
    username?: string | UserProfileSourceContext | null
    display_name?: string | UserProfileSourceContext | null
    nickname?: string | UserProfileSourceContext | null
  }
  auth_bindings?: Partial<Record<UserAuthProvider, boolean | UserAuthBindingStatus>>
  identity_bindings?: Partial<Record<UserAuthProvider, boolean | UserAuthBindingStatus>>
  email_bound?: boolean
  linuxdo_bound?: boolean
  oidc_bound?: boolean
  wechat_bound?: boolean
  role: 'admin' | 'user' // User role for authorization
  balance: number // User balance for API usage
  frozen_balance?: number // Balance currently held by async batch jobs
  concurrency: number // Allowed concurrent requests
  rpm_limit?: number // User-level RPM cap (0 = unlimited); effective as fallback when group has no rpm_limit
  status: 'active' | 'disabled' // Account status
  allowed_groups: number[] | null // Allowed group IDs (null = all non-exclusive groups)
  balance_notify_enabled: boolean
  balance_notify_threshold: number | null
  balance_notify_extra_emails: NotifyEmailEntry[]
  subscriptions?: UserSubscription[] // User's active subscriptions
  last_active_at?: string | null
  created_at: string
  updated_at: string
  deleted_at?: string | null
}

export interface AdminUser extends User {
  // Administrator notes (not returned by regular-user APIs)
  notes: string
  last_used_at?: string | null
  // User-specific group rate multiplier configuration (group_id -> rate_multiplier)
  group_rates?: Record<number, number>
  // When true, the user may use only the public groups listed in allowed_groups.
  // Administration-side permission switch, not returned by regular-user APIs.
  restrict_public_groups?: boolean
  // Current concurrency count (returned only by the administrator list API)
  current_concurrency?: number
}

export interface LoginRequest {
  email: string
  password: string
  turnstile_token?: string
  tencent_captcha_ticket?: string
  tencent_captcha_randstr?: string
}

export interface TencentCaptchaRequestProof {
  tencent_captcha_ticket: string
  tencent_captcha_randstr: string
}

// Request credentials for action-triggered CAPTCHAs (OAuth initiation, passkey, and similar entry points):
// Use tencent_captcha_* for Tencent; Alibaba Cloud's captchaVerifyParam reuses the turnstile_token field
export interface ActionCaptchaRequestProof extends Partial<TencentCaptchaRequestProof> {
  turnstile_token?: string
}

export interface RegisterRequest {
  email: string
  password: string
  verify_code?: string
  turnstile_token?: string
  tencent_captcha_ticket?: string
  tencent_captcha_randstr?: string
  promo_code?: string
  invitation_code?: string
  aff_code?: string
}

export interface AffiliateInvitee {
  user_id: number
  email: string
  username: string
  created_at?: string
  total_rebate: number
}

export interface UserAffiliateDetail {
  user_id: number
  aff_code: string
  inviter_id?: number | null
  aff_count: number
  aff_quota: number
  aff_frozen_quota: number
  aff_history_quota: number
  /** Effective rebate percentage when the current user is the inviter (user-specific value overrides the global value). 0-100. */
  effective_rebate_rate_percent: number
  invitees: AffiliateInvitee[]
}

export interface AffiliateTransferResponse {
  transferred_quota: number
  balance: number
}

export interface SendVerifyCodeRequest {
  email: string
  turnstile_token?: string
  tencent_captcha_ticket?: string
  tencent_captcha_randstr?: string
  pending_auth_token?: string
  pending_oauth_token?: string
}

export interface SendVerifyCodeResponse {
  message: string
  countdown: number
}

export interface CustomMenuItem {
  id: string
  label: string
  icon_svg: string
  url: string
  page_slug?: string
  hide_open_button?: boolean
  visibility: 'user' | 'admin'
  sort_order: number
}

export interface CustomEndpoint {
  name: string
  endpoint: string
  description: string
}

export interface LoginAgreementDocument {
  id: string
  title: string
  content_md: string
}

export interface PublicSettings {
  email_verification_mode?: 'link' | 'code'
  registration_enabled: boolean
  email_verify_enabled: boolean
  force_email_on_third_party_signup: boolean
  registration_email_suffix_whitelist: string[]
  registration_email_domain_quota_enabled?: boolean
  promo_code_enabled: boolean
  password_reset_enabled: boolean
  invitation_code_enabled: boolean
  login_agreement_enabled?: boolean
  login_agreement_mode?: 'modal' | 'checkbox' | string
  login_agreement_updated_at?: string
  login_agreement_revision?: string
  login_agreement_documents?: LoginAgreementDocument[]
  turnstile_enabled: boolean
  tencent_captcha_enabled?: boolean
  tencent_captcha_app_id?: string
  tencent_captcha_region?: string
  passkey_enabled?: boolean
  turnstile_site_key: string
  aliyun_captcha_enabled?: boolean
  aliyun_captcha_scene_id?: string
  aliyun_captcha_prefix?: string
  aliyun_captcha_region?: string
  site_name: string
  site_logo: string
  site_subtitle: string
  api_base_url: string
  contact_info: string
  doc_url: string
  home_content: string
  compact_home_enabled: boolean
  hide_ccs_import_button: boolean
  payment_enabled: boolean
  risk_control_enabled: boolean
  table_default_page_size: number
  table_page_size_options: number[]
  custom_menu_items: CustomMenuItem[]
  custom_endpoints: CustomEndpoint[]
  linuxdo_oauth_enabled: boolean
  dingtalk_oauth_enabled?: boolean
  wechat_oauth_enabled: boolean
  wechat_oauth_open_enabled?: boolean
  wechat_oauth_mp_enabled?: boolean
  wechat_oauth_mobile_enabled?: boolean
  oidc_oauth_enabled: boolean
  oidc_oauth_provider_name: string
  github_oauth_enabled: boolean
  google_oauth_enabled: boolean
  backend_mode_enabled: boolean
  version: string
  // Server global time zone (IANA name and current UTC offset), used to label server-local time windows such as peak hours;
  // Optional: older injected __APP_CONFIG__ caches may omit this
  server_timezone?: string
  server_utc_offset?: string
  balance_low_notify_enabled: boolean
  account_quota_notify_enabled: boolean
  balance_low_notify_threshold: number
  channel_monitor_enabled: boolean
  /** Exclusive mode: v1 active probes or v2 passive aggregation. Default v2. */
  channel_monitor_mode?: 'v1' | 'v2'
  channel_monitor_default_interval_seconds: number
  /** When true, user monitor hides RPM/TPM so scale cannot be reverse-estimated. */
  channel_monitor_hide_throughput?: boolean
  /** When true, user monitor shows account quota/balance snapshots (default off). */
  channel_monitor_show_quota?: boolean
  /** When true, user monitor hides the user ranking tab and /users payload. */
  channel_monitor_hide_user_ranking?: boolean
  available_channels_enabled: boolean
  /** When false, the whole user-facing subscription surface is hidden. Default true. */
  subscription_enabled: boolean
  /** Mirrors payment config BALANCE_PAYMENT_DISABLED; true = balance top-up closed (subscription-only site). */
  payment_balance_disabled: boolean
  model_plaza_enabled: boolean
  model_plaza_require_auth: boolean
  plugin_management_enabled: boolean
  service_quota_enabled: boolean
  affiliate_enabled: boolean
  allow_user_view_error_requests?: boolean
}

export interface AuthResponse {
  access_token: string
  refresh_token?: string  // New: Refresh Token for token renewal
  expires_in?: number     // New: Access Token expiry time in seconds
  token_type: string
  user: User & { run_mode?: 'standard' | 'simple' }
}

export interface CurrentUserResponse extends User {
  run_mode?: 'standard' | 'simple'
}

// ==================== Subscription Types ====================

export interface Subscription {
  id: number
  user_id: number
  name: string
  url: string
  type: 'clash' | 'v2ray' | 'surge' | 'quantumult' | 'shadowrocket'
  update_interval: number // in hours
  last_updated: string | null
  node_count: number
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface CreateSubscriptionRequest {
  name: string
  url: string
  type: Subscription['type']
  update_interval?: number
}

export interface UpdateSubscriptionRequest {
  name?: string
  url?: string
  type?: Subscription['type']
  update_interval?: number
  is_active?: boolean
}

// ==================== Announcement Types ====================

export type AnnouncementStatus = 'draft' | 'active' | 'archived'
export type AnnouncementNotifyMode = 'silent' | 'popup'

export type AnnouncementConditionType = 'subscription' | 'balance'

export type AnnouncementOperator = 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'eq'

export interface AnnouncementCondition {
  type: AnnouncementConditionType
  operator: AnnouncementOperator
  group_ids?: number[]
  value?: number
}

export interface AnnouncementConditionGroup {
  all_of?: AnnouncementCondition[]
}

export interface AnnouncementTargeting {
  any_of?: AnnouncementConditionGroup[]
}

export interface Announcement {
  id: number
  title: string
  content: string
  status: AnnouncementStatus
  notify_mode: AnnouncementNotifyMode
  targeting: AnnouncementTargeting
  starts_at?: string
  ends_at?: string
  created_by?: number
  updated_by?: number
  created_at: string
  updated_at: string
}

export interface UserAnnouncement {
  id: number
  title: string
  content: string
  notify_mode: AnnouncementNotifyMode
  starts_at?: string
  ends_at?: string
  read_at?: string
  created_at: string
  updated_at: string
}

export interface CreateAnnouncementRequest {
  title: string
  content: string
  status?: AnnouncementStatus
  notify_mode?: AnnouncementNotifyMode
  targeting: AnnouncementTargeting
  starts_at?: number
  ends_at?: number
}

export interface UpdateAnnouncementRequest {
  title?: string
  content?: string
  status?: AnnouncementStatus
  notify_mode?: AnnouncementNotifyMode
  targeting?: AnnouncementTargeting
  starts_at?: number
  ends_at?: number
}

export interface AnnouncementUserReadStatus {
  user_id: number
  email: string
  username: string
  balance: number
  eligible: boolean
  read_at?: string
}

// ==================== Proxy Node Types ====================

export interface ProxyNode {
  id: number
  subscription_id: number
  name: string
  type: 'ss' | 'ssr' | 'vmess' | 'vless' | 'trojan' | 'hysteria' | 'hysteria2'
  server: string
  port: number
  config: Record<string, unknown> // JSON configuration specific to proxy type
  latency: number | null // in milliseconds
  last_checked: string | null
  is_available: boolean
  created_at: string
  updated_at: string
}

// ==================== Conversion Types ====================

export interface ConversionRequest {
  subscription_ids: number[]
  target_type: 'clash' | 'v2ray' | 'surge' | 'quantumult' | 'shadowrocket'
  filter?: {
    name_pattern?: string
    types?: ProxyNode['type'][]
    min_latency?: number
    max_latency?: number
    available_only?: boolean
  }
  sort?: {
    by: 'name' | 'latency' | 'type'
    order: 'asc' | 'desc'
  }
}

export interface ConversionResult {
  url: string // URL to download the converted subscription
  expires_at: string
  node_count: number
}

// ==================== Statistics Types ====================

export interface SubscriptionStats {
  subscription_id: number
  total_nodes: number
  available_nodes: number
  avg_latency: number | null
  by_type: Record<ProxyNode['type'], number>
  last_update: string
}

export interface UserStats {
  total_subscriptions: number
  total_nodes: number
  active_subscriptions: number
  total_conversions: number
  last_conversion: string | null
}

// ==================== API Response Types ====================

export interface ApiResponse<T = unknown> {
  code: number
  message: string
  data: T
}

export interface ApiError {
  detail: string
  code?: string
  field?: string
}

export interface PaginatedResponse<T> {
  items: T[]
  total: number
  page: number
  page_size: number
  pages: number
}

// ==================== UI State Types ====================

export type ToastType = 'success' | 'error' | 'info' | 'warning'

export interface Toast {
  id: string
  type: ToastType
  message: string
  title?: string
  duration?: number // in milliseconds, undefined means no auto-dismiss
  startTime?: number // timestamp when toast was created, for progress bar
}

export interface AppState {
  sidebarCollapsed: boolean
  loading: boolean
  toasts: Toast[]
}

// ==================== Validation Types ====================

export interface ValidationError {
  field: string
  message: string
}

// ==================== Table/List Types ====================

export interface SortConfig {
  key: string
  order: 'asc' | 'desc'
}

export interface FilterConfig {
  [key: string]: string | number | boolean | null | undefined
}

export interface PaginationConfig {
  page: number
  page_size: number
}

// ==================== API Key & Group Types ====================

/**
 * Group platform: a specific platform or composite. Specific platforms follow the platform catalog (constants/platformCatalog);
 * platforms newly registered by the backend are strings outside KnownAccountPlatform.
 */
export type GroupPlatform = AccountPlatform | 'composite'

export type VideoModelPrices = Record<string, Record<string, number>>

export type SubscriptionType = 'standard' | 'subscription'

export interface OpenAIMessagesDispatchModelConfig {
  opus_mapped_model?: string
  sonnet_mapped_model?: string
  haiku_mapped_model?: string
  exact_model_mappings?: Record<string, string>
}

export type ReasoningEffortMatchType = 'exact' | 'prefix' | 'suffix'

export interface ReasoningEffortMapping {
  from: string
  to: string
  match_type?: ReasoningEffortMatchType
  model?: string
}

/** Translation of a group's name and description for a language; empty fields inherit the group's own name/description. */
export interface GroupLocaleText {
  name?: string
  description?: string
}

/** Group copy translations keyed by language code (en, zh…). */
export type GroupI18n = Record<string, GroupLocaleText>

// The name / description returned by user-facing APIs has already been selected by the backend according to the request language (Accept-Language)
export interface Group {
  id: number
  name: string
  description: string | null
  platform: GroupPlatform
  rate_multiplier: number
  rpm_limit?: number // Group-level RPM cap (0 = unlimited); overrides user-level rpm_limit when set
  max_reasoning_effort?: string // Anthropic/OpenAI reasoning ceiling; empty means unlimited
  max_reasoning_effort_over_limit?: string // downgrade (default) or deny when over the ceiling
  reasoning_effort_mappings?: ReasoningEffortMapping[]
  is_exclusive: boolean
  status: 'active' | 'inactive'
  subscription_type: SubscriptionType
  daily_limit_usd: number | null
  weekly_limit_usd: number | null
  monthly_limit_usd: number | null
  long_context_pricing_enabled: boolean
  // Image generation billing configuration
  allow_image_generation: boolean
  allow_batch_image_generation: boolean
  image_rate_independent: boolean
  image_rate_multiplier: number
  batch_image_discount_multiplier: number
  batch_image_hold_multiplier: number
  image_price_1k: number | null
  image_price_2k: number | null
  image_price_4k: number | null
  video_rate_independent: boolean
  video_rate_multiplier: number
  video_price_480p: number | null
  video_price_720p: number | null
  video_price_1080p: number | null
  // Optional model-family x resolution overrides for Grok video pricing.
  video_model_prices?: VideoModelPrices
  // Codex web search price per request (USD/request); null uses the default price of 0.01
  web_search_price_per_call: number | null
  // Explicit Grok Voice pricing (group level)
  search_price_per_1k: number | null
  audio_realtime_price_per_min: number | null
  audio_tts_price_per_million_chars: number | null
  audio_stt_price_per_hour: number | null
  // Peak-hour multiplier configuration
  peak_rate_enabled: boolean
  peak_start: string
  peak_end: string
  peak_rate_multiplier: number
  // Claude Code client restrictions
  claude_code_only: boolean
  fallback_group_id: number | null
  fallback_group_id_on_invalid_request: number | null
  // OpenAI Messages scheduling switch (the user interface needs this field to determine whether to show the Claude Code tutorial)
  allow_messages_dispatch?: boolean
  // OpenAI Live API switch
  allow_live: boolean
  default_mapped_model?: string
  messages_dispatch_model_config?: OpenAIMessagesDispatchModelConfig
  require_oauth_only: boolean
  require_privacy_set: boolean
  created_at: string
  updated_at: string
}

export interface AdminGroup extends Group {
  // Administration-side name / description always contain the original fields; translations for each language are stored separately in i18n
  i18n?: GroupI18n
  force_openai_fast: boolean
  free_openai_fast: boolean
  model_pricing: import('@/api/admin/channels').ChannelModelPricing[]
  // Group profit controls (available for openai/anthropic/gemini/grok/antigravity groups; margin/buffer are stored as decimals).
  // Administrator-only: multiply by rate_multiplier to derive the upstream cost ceiling; must not be exposed on Group.
  profit_control_enabled: boolean
  profit_min_margin: number
  profit_safety_buffer: number

  // Model routing configuration (administrator-only internal information)
  model_routing: Record<string, number[]> | null
  model_routing_enabled: boolean

  // MCP XML protocol injection (antigravity platform only)
  mcp_xml_inject: boolean

  // Supported model families (antigravity platform only)
  supported_model_scopes?: string[]

  // Number of accounts in the group (administrator-only)
  account_count?: number
  active_account_count?: number
  rate_limited_account_count?: number

  // OpenAI Messages scheduling configuration (openai platform only)
  default_mapped_model?: string
  messages_dispatch_model_config?: OpenAIMessagesDispatchModelConfig
  model_allowlist?: ModelAllowlist
  codex_models_manifest_config?: CodexModelsManifestConfig

  // Group sort order
  sort_order: number
}

export interface ModelAllowlist {
  enabled: boolean
  models: string[]
}

// Configuration for fetching the Codex Model Manifest through a fixed account (openai groups only)
export interface CodexModelsManifestConfig {
  enabled: boolean
  account_ids: number[]
  fallback_to_scheduler: boolean
}

export type CompositeRouteMatchType = 'exact' | 'prefix'

export type CompositeRouteEndpoint =
  | 'any'
  | 'messages'
  | 'count_tokens'
  | 'responses'
  | 'chat_completions'
  | 'embeddings'
  | 'images'
  | 'gemini'

export type CompositeRouteSource = 'route' | 'detector' | string

export interface CompositeModelRoute {
  id: number
  group_id: number
  public_model: string
  match_type: CompositeRouteMatchType
  target_platform: Exclude<GroupPlatform, 'composite'>
  upstream_model: string
  endpoint: CompositeRouteEndpoint
  priority: number
  enabled: boolean
  notes: string
  created_at?: string
  updated_at?: string
}

export interface CompositeModelRouteInput {
  public_model: string
  match_type: CompositeRouteMatchType
  target_platform: Exclude<GroupPlatform, 'composite'>
  upstream_model?: string
  endpoint: CompositeRouteEndpoint
  priority?: number
  enabled?: boolean
  notes?: string
}

export interface CompositeRoutePreviewRequest {
  model: string
  endpoint: CompositeRouteEndpoint
}

export interface CompositeRouteDecision {
  matched: boolean
  source: CompositeRouteSource
  group_id: number
  public_model: string
  target_platform: Exclude<GroupPlatform, 'composite'> | ''
  upstream_model: string
  endpoint: CompositeRouteEndpoint
  route?: CompositeModelRoute
  reason?: string
}

export interface ApiKey {
  id: number
  user_id: number
  key: string
  name: string
  group_id: number | null
  status: 'active' | 'inactive' | 'quota_exhausted' | 'expired'
  ip_whitelist: string[]
  ip_blacklist: string[]
  last_used_at: string | null
  last_used_ip: string | null
  quota: number // Quota limit in USD (0 = unlimited)
  quota_used: number // Used quota amount in USD
  expires_at: string | null // Expiration time (null = never expires)
  created_at: string
  updated_at: string
  current_concurrency: number
  group?: Group
  rate_limit_5h: number
  rate_limit_1d: number
  rate_limit_7d: number
  usage_5h: number
  usage_1d: number
  usage_7d: number
  window_5h_start: string | null
  window_1d_start: string | null
  window_7d_start: string | null
  reset_5h_at: string | null
  reset_1d_at: string | null
  reset_7d_at: string | null
}

export interface CreateApiKeyRequest {
  name: string
  group_id?: number | null
  custom_key?: string // Optional custom API Key
  ip_whitelist?: string[]
  ip_blacklist?: string[]
  quota?: number // Quota limit in USD (0 = unlimited)
  expires_in_days?: number // Days until expiry (null = never expires)
  rate_limit_5h?: number
  rate_limit_1d?: number
  rate_limit_7d?: number
}

export interface UpdateApiKeyRequest {
  name?: string
  group_id?: number | null
  status?: 'active' | 'inactive'
  ip_whitelist?: string[]
  ip_blacklist?: string[]
  quota?: number // Quota limit in USD (null = no change, 0 = unlimited)
  expires_at?: string | null // Expiration time (null = no change)
  reset_quota?: boolean // Reset quota_used to 0
  rate_limit_5h?: number
  rate_limit_1d?: number
  rate_limit_7d?: number
  reset_rate_limit_usage?: boolean
}

export interface CreateGroupRequest {
  name: string
  description?: string | null
  i18n?: GroupI18n
  platform?: GroupPlatform
  rate_multiplier?: number
  is_exclusive?: boolean
  subscription_type?: SubscriptionType
  daily_limit_usd?: number | null
  weekly_limit_usd?: number | null
  monthly_limit_usd?: number | null
  long_context_pricing_enabled?: boolean
  force_openai_fast?: boolean
  free_openai_fast?: boolean
  model_pricing?: import('@/api/admin/channels').ChannelModelPricing[]
  allow_image_generation?: boolean
  allow_batch_image_generation?: boolean
  image_rate_independent?: boolean
  image_rate_multiplier?: number
  batch_image_discount_multiplier?: number
  batch_image_hold_multiplier?: number
  image_price_1k?: number | null
  image_price_2k?: number | null
  image_price_4k?: number | null
  video_rate_independent?: boolean
  video_rate_multiplier?: number
  video_price_480p?: number | null
  video_price_720p?: number | null
  video_price_1080p?: number | null
  video_model_prices?: VideoModelPrices
  web_search_price_per_call?: number | null
  search_price_per_1k?: number | null
  audio_realtime_price_per_min?: number | null
  audio_tts_price_per_million_chars?: number | null
  audio_stt_price_per_hour?: number | null
  peak_rate_enabled?: boolean
  peak_start?: string
  peak_end?: string
  peak_rate_multiplier?: number
  // Group profit controls (five token platforms; margin/buffer are decimals)
  profit_control_enabled?: boolean
  profit_min_margin?: number
  profit_safety_buffer?: number
  claude_code_only?: boolean
  fallback_group_id?: number | null
  fallback_group_id_on_invalid_request?: number | null
  mcp_xml_inject?: boolean
  supported_model_scopes?: string[]
  model_allowlist?: ModelAllowlist
  codex_models_manifest_config?: CodexModelsManifestConfig
  allow_messages_dispatch?: boolean
  allow_live?: boolean
  default_mapped_model?: string
  messages_dispatch_model_config?: OpenAIMessagesDispatchModelConfig
  model_routing?: Record<string, number[]> | null
  model_routing_enabled?: boolean
  rpm_limit?: number
  max_reasoning_effort?: string
  max_reasoning_effort_over_limit?: string
  reasoning_effort_mappings?: ReasoningEffortMapping[]
  require_oauth_only?: boolean
  require_privacy_set?: boolean
  // Copy accounts from the specified group
  copy_accounts_from_group_ids?: number[]
}

export interface UpdateGroupRequest {
  name?: string
  description?: string | null
  i18n?: GroupI18n
  platform?: GroupPlatform
  rate_multiplier?: number
  is_exclusive?: boolean
  status?: 'active' | 'inactive'
  subscription_type?: SubscriptionType
  daily_limit_usd?: number | null
  weekly_limit_usd?: number | null
  monthly_limit_usd?: number | null
  long_context_pricing_enabled?: boolean
  force_openai_fast?: boolean
  free_openai_fast?: boolean
  model_pricing?: import('@/api/admin/channels').ChannelModelPricing[]
  allow_image_generation?: boolean
  allow_batch_image_generation?: boolean
  image_rate_independent?: boolean
  image_rate_multiplier?: number
  batch_image_discount_multiplier?: number
  batch_image_hold_multiplier?: number
  image_price_1k?: number | null
  image_price_2k?: number | null
  image_price_4k?: number | null
  video_rate_independent?: boolean
  video_rate_multiplier?: number
  video_price_480p?: number | null
  video_price_720p?: number | null
  video_price_1080p?: number | null
  video_model_prices?: VideoModelPrices
  web_search_price_per_call?: number | null
  search_price_per_1k?: number | null
  audio_realtime_price_per_min?: number | null
  audio_tts_price_per_million_chars?: number | null
  audio_stt_price_per_hour?: number | null
  peak_rate_enabled?: boolean
  peak_start?: string
  peak_end?: string
  peak_rate_multiplier?: number
  // Group profit controls (five token platforms; margin/buffer are decimals)
  profit_control_enabled?: boolean
  profit_min_margin?: number
  profit_safety_buffer?: number
  claude_code_only?: boolean
  fallback_group_id?: number | null
  fallback_group_id_on_invalid_request?: number | null
  mcp_xml_inject?: boolean
  supported_model_scopes?: string[]
  model_allowlist?: ModelAllowlist
  codex_models_manifest_config?: CodexModelsManifestConfig
  allow_messages_dispatch?: boolean
  allow_live?: boolean
  default_mapped_model?: string
  messages_dispatch_model_config?: OpenAIMessagesDispatchModelConfig
  model_routing?: Record<string, number[]> | null
  model_routing_enabled?: boolean
  rpm_limit?: number
  max_reasoning_effort?: string
  max_reasoning_effort_over_limit?: string
  reasoning_effort_mappings?: ReasoningEffortMapping[]
  require_oauth_only?: boolean
  require_privacy_set?: boolean
  copy_accounts_from_group_ids?: number[]
}

// ==================== Account & Proxy Types ====================

/** Platforms with dedicated built-in frontend interfaces (icons, colors, forms, etc.). */
export type KnownAccountPlatform = 'anthropic' | 'openai' | 'gemini' | 'antigravity' | 'grok' | 'kimi' | 'zhipu' | 'deepseek' | 'minimax' | 'opencode_go' | 'typesafe' | 'command_code' | 'cline'
/**
 * Account platform: a built-in platform or any newly registered platform from the backend platform catalog (any string).
 * `string & {}` preserves literal autocompletion for built-in platforms.
 */
export type AccountPlatform = KnownAccountPlatform | (string & {})
export type AccountType = 'oauth' | 'setup-token' | 'apikey' | 'upstream' | 'bedrock' | 'service_account'
export type OAuthAddMethod = 'oauth' | 'setup-token'
export type ProxyProtocol = 'http' | 'https' | 'socks5' | 'socks5h'

// Claude Model type (returned by /v1/models and account models API)
export interface ClaudeModel {
  id: string
  type: string
  display_name: string
  created_at: string
}

export interface Proxy {
  id: number
  name: string
  protocol: ProxyProtocol
  host: string
  port: number
  username: string | null
  password?: string | null
  status: 'active' | 'inactive' | 'expired'
  account_count?: number // Number of accounts using this proxy
  latency_ms?: number
  latency_status?: 'success' | 'failed'
  latency_message?: string
  ip_address?: string
  country?: string
  country_code?: string
  region?: string
  city?: string
  quality_status?: 'healthy' | 'warn' | 'challenge' | 'failed'
  quality_score?: number
  quality_grade?: string
  quality_summary?: string
  quality_checked?: number
  expires_at: string | null
  fallback_mode: 'none' | 'proxy' | 'direct'
  backup_proxy_id?: number | null
  expiry_warn_days: number
  created_at: string
  updated_at: string
}

export interface ProxyAccountSummary {
  id: number
  name: string
  platform: AccountPlatform
  type: AccountType
  notes?: string | null
}

export interface ProxyQualityCheckItem {
  target: string
  status: 'pass' | 'warn' | 'fail' | 'challenge'
  http_status?: number
  latency_ms?: number
  message?: string
  cf_ray?: string
}

export interface ProxyQualityCheckResult {
  proxy_id: number
  score: number
  grade: string
  summary: string
  exit_ip?: string
  country?: string
  country_code?: string
  base_latency_ms?: number
  passed_count: number
  warn_count: number
  failed_count: number
  challenge_count: number
  checked_at: number
  items: ProxyQualityCheckItem[]
}

// Gemini credentials structure for OAuth and API Key authentication
export interface GeminiCredentials {
  // API Key authentication
  api_key?: string
  base_url?: string

  // OAuth authentication
  access_token?: string
  refresh_token?: string
  oauth_type?: 'code_assist' | 'google_one' | 'ai_studio' | string
  tier_id?:
    | 'google_one_free'
    | 'google_ai_pro'
    | 'google_ai_ultra'
    | 'gcp_standard'
    | 'gcp_enterprise'
    | 'aistudio_free'
    | 'aistudio_paid'
    | 'LEGACY'
    | 'PRO'
    | 'ULTRA'
    | string
  project_id?: string
  token_type?: string
  scope?: string
  expires_at?: string
  model_mapping?: Record<string, string>
}

export type TempUnschedulableScope = 'account' | 'model'

export interface TempUnschedulableRule {
  error_code: number
  keywords: string[]
  duration_minutes: number
  description: string
  // Scope: account suspends the entire account, while model cools down only the model used by this request; by default, 401 uses account and other statuses use model.
  scope?: TempUnschedulableScope
}

export interface TempUnschedulableState {
  until_unix: number
  triggered_at_unix: number
  status_code: number
  matched_keyword: string
  scope?: TempUnschedulableScope
  model?: string
  rule_index: number
  error_message: string
  trigger_count?: number
  trigger_threshold?: number
  trigger_window_minutes?: number
}

export interface TempUnschedulableStatus {
  active: boolean
  state?: TempUnschedulableState
}

export interface UpstreamBillingData {
  object: 'sub2api.key_billing'
  schema_version: 1
  billing_scope: 'token'
  group_rate_multiplier: number
  user_rate_multiplier?: number
  resolved_rate_multiplier: number
  peak_rate_enabled: boolean
  peak_start?: string
  peak_end?: string
  peak_rate_multiplier?: number
  applied_peak_multiplier?: number
  effective_rate_multiplier: number
  timezone?: string
  observed_at: string
}

export type UpstreamBillingProbeStatus = 'ok' | 'unsupported' | 'failed'

export interface UpstreamBillingProbeSnapshot {
  status: UpstreamBillingProbeStatus
  data?: UpstreamBillingData
  received_at?: string
  fresh_until?: string
  last_attempt_at: string
  next_probe_at: string
  failure_count?: number
  http_status?: number
  last_error?: string
  // Value this probe wrote into the account rate multiplier; absent when the
  // probe did not sync a rate.
  synced_rate_multiplier?: number
}

export interface UpstreamBillingProbeSettings {
  enabled: boolean
  interval_minutes: number
}

export interface UpstreamBillingProbeResult {
  account_id: number
  snapshot?: UpstreamBillingProbeSnapshot
  error?: string
}

export interface UpstreamBillingRateSnapshotItem {
  account_id: number
  snapshot?: UpstreamBillingProbeSnapshot | null
}

export interface UpstreamBillingRatesResponse {
  items: UpstreamBillingRateSnapshotItem[]
  total: number
  page: number
  page_size: number
}

export type OllamaCloudUsageStatus = 'ok' | 'unauthorized' | 'failed'

export interface OllamaCloudUsageWindow {
  used_percent: number
  reset_at?: string
  reset_text?: string
}

export interface OllamaCloudUsageModel {
  model: string
  window: 'five_hour' | 'seven_day'
  requests: number
}

export interface OllamaCloudUsageData {
  plan?: string
  five_hour?: OllamaCloudUsageWindow
  seven_day?: OllamaCloudUsageWindow
  balance?: string
  models?: OllamaCloudUsageModel[]
}

export interface OllamaCloudUsageSnapshot {
  status: OllamaCloudUsageStatus
  data?: OllamaCloudUsageData
  fetched_at?: string
  last_attempt_at: string
  next_refresh_at: string
  failure_count?: number
  http_status?: number
  last_error?: string
}

export interface OllamaCloudUsageState {
  account_id: number
  eligible: boolean
  configured: boolean
  auto_refresh_enabled: boolean
  encryption_key_configured: boolean
  snapshot?: OllamaCloudUsageSnapshot
}

export interface OllamaCloudUsageSettings {
  enabled: boolean
  /** Max wait while model requests keep arriving (minutes). */
  interval_minutes: number
  /** Trailing quiet period after the latest model request (minutes). */
  debounce_minutes: number
}

export type OpenCodeGoUsageStatus = 'ok' | 'unauthorized' | 'failed'

export interface OpenCodeGoUsageWindow {
  status?: string
  percent: number
  resets_at?: string
}

export interface OpenCodeGoUsageData {
  rolling?: OpenCodeGoUsageWindow
  weekly?: OpenCodeGoUsageWindow
  monthly?: OpenCodeGoUsageWindow
}

export interface OpenCodeGoUsageSnapshot {
  status: OpenCodeGoUsageStatus
  data?: OpenCodeGoUsageData
  fetched_at?: string
  last_attempt_at?: string
  next_refresh_at?: string
  failure_count?: number
  http_status?: number
  last_error?: string
}

export interface OpenCodeGoUsageState {
  account_id: number
  eligible: boolean
  auto_refresh_enabled: boolean
  snapshot?: OpenCodeGoUsageSnapshot
}

export interface OpenCodeGoUsageSettings {
  enabled: boolean
  /** Max wait while model requests keep arriving (minutes). */
  interval_minutes: number
  /** Trailing quiet period after the latest model request (minutes). */
  debounce_minutes: number
}

export interface Account {
  id: number
  name: string
  notes?: string | null
  platform: AccountPlatform
  type: AccountType
  // credentials are redacted in backend responses: access_token / refresh_token / id_token /
  // api_key / session_key / cookie / aws_secret_access_key / aws_session_token /
  // service_account_json / service_account / private_key are omitted;
  // their presence is exposed through credentials_status.has_<key> instead.
  credentials?: Record<string, unknown>
  credentials_status?: Record<string, boolean>
  ollama_cloud_usage?: OllamaCloudUsageState
  opencode_go_usage?: OpenCodeGoUsageState
  // Extra fields including Codex usage, OpenAI compact capability, and model-level rate limits.
  extra?: (CodexUsageSnapshot & OpenAICompactState & {
    model_rate_limits?: Record<string, { rate_limited_at: string; rate_limit_reset_at: string }>
    antigravity_credits_overages?: Record<string, { activated_at: string; active_until: string }>
    upstream_billing_probe_enabled?: boolean
    upstream_billing_rate_sync_enabled?: boolean
    upstream_billing_probe?: UpstreamBillingProbeSnapshot
    codex_reset_credit_snapshot?: {
      available_count?: number
      credits?: { expires_at?: string }[]
    }
    codex_credits_snapshot?: {
      credits: { has_credits: boolean; unlimited: boolean; balance: string | null } | null
      fetched_at: number
    }
    codex_referral_snapshot?: import('./openaiReferrals').OpenAIReferralEligibility | null
    auto_reset_credit_enabled?: boolean
    auto_reset_credit_5h_threshold?: number
    auto_reset_credit_7d_threshold?: number
    codex_auto_reset_credit_state?: {
      status?: 'checking' | 'available' | 'resetting' | 'success' | 'no_credit' | 'failed'
      trigger_window?: string
      available_count?: number
      checked_at?: string
      last_result_at?: string
      error_code?: string
    }
  } & Record<string, unknown>)
  proxy_id: number | null
  proxy_fallback_origin_id?: number | null
  proxy_fallback_origin_name?: string | null
  concurrency: number
  load_factor?: number | null
  current_concurrency?: number // Real-time concurrency count from Redis
  scheduler_score?: {
    base_score: number
    sticky_score?: number
    sticky_score_infinity?: boolean
    sticky_weighted_enabled: boolean
  } | null
  scheduler_scores?: AccountSchedulerGroupScore[] | null
  priority: number
  rate_multiplier?: number // Account billing multiplier (>=0, 0 means free)
  status: 'active' | 'inactive' | 'error'
  error_message: string | null
  last_used_at: string | null
  expires_at: number | null
  auto_pause_on_expired: boolean
  created_at: string
  updated_at: string
  proxy?: Proxy
  group_ids?: number[] // Groups this account belongs to
  groups?: Group[] // Preloaded group objects

  // Rate limit & scheduling fields
  schedulable: boolean
  rate_limited_at: string | null
  rate_limit_reset_at: string | null
  overload_until: string | null
  temp_unschedulable_until: string | null
  temp_unschedulable_reason: string | null

  // Session window fields (5-hour window)
  session_window_start: string | null
  session_window_end: string | null
  session_window_status: 'allowed' | 'allowed_warning' | 'rejected' | null

  // 5h window cost control (Anthropic OAuth/SetupToken accounts only)
  window_cost_limit?: number | null
  window_cost_sticky_reserve?: number | null

  // Session count control (Anthropic OAuth/SetupToken accounts only)
  max_sessions?: number | null
  session_idle_timeout_minutes?: number | null

  // RPM limit (Anthropic OAuth/SetupToken accounts only)
  base_rpm?: number | null
  rpm_strategy?: string | null
  rpm_sticky_buffer?: number | null
  user_msg_queue_mode?: string | null  // "serialize" | "throttle" | null

  // TLS fingerprint spoofing (Anthropic OAuth/SetupToken accounts only)
  enable_tls_fingerprint?: boolean | null
  tls_fingerprint_profile_id?: number | null

  // Session ID spoofing (Anthropic OAuth/SetupToken accounts only)
  // When enabled, the session ID in metadata.user_id remains fixed for 15 minutes
  session_id_masking_enabled?: boolean | null

  // Force cache TTL override (Anthropic OAuth/SetupToken accounts only)
  cache_ttl_override_enabled?: boolean | null
  cache_ttl_override_target?: string | null

  // Custom Base URL relay forwarding (Anthropic OAuth/SetupToken accounts only)
  custom_base_url_enabled?: boolean | null
  custom_base_url?: string | null

  // API Key account quota limits
  quota_limit?: number | null
  quota_used?: number | null
  quota_daily_limit?: number | null
  quota_daily_used?: number | null
  quota_weekly_limit?: number | null
  quota_weekly_used?: number | null

  // Fixed-time quota reset configuration
  quota_daily_reset_mode?: 'rolling' | 'fixed' | null
  quota_daily_reset_hour?: number | null
  quota_weekly_reset_mode?: 'rolling' | 'fixed' | null
  quota_weekly_reset_day?: number | null
  quota_weekly_reset_hour?: number | null
  quota_reset_timezone?: string | null
  quota_daily_reset_at?: string | null
  quota_weekly_reset_at?: string | null

  // Runtime status (returned only when the corresponding limit is enabled)
  current_window_cost?: number | null // Current window cost
  active_sessions?: number | null // Current active session count
  current_rpm?: number | null // RPM count for the current minute

  // Shadow account relationship (spark-dimension shadow)
  parent_account_id?: number | null
  quota_dimension?: string
  // Parent account information populated for shadow accounts (only when shadow is non-empty)
  parent_email?: string
  parent_plan_type?: string
  parent_privacy_mode?: string
  parent_subscription_expires_at?: string
  parent_chatgpt_account_id?: string
}

// The admin account list may return this compact shape when lite=1. Detail
// operations still use Account from /admin/accounts/:id.
export type AccountListItem = Omit<Account, 'groups'>

export interface AccountSchedulerGroupScore {
  group_id?: number | null
  group_name?: string
  group_priority?: number | null
  base_score: number
  sticky_score?: number
  sticky_score_infinity?: boolean
  sticky_weighted_enabled: boolean
}

// Account Usage types
export interface WindowStats {
  requests: number
  tokens: number
  cost: number // Account cost (account multiplier)
  standard_cost?: number
  user_cost?: number
}

export interface UsageProgress {
  utilization: number // Percentage (0-100+, 100 = 100%)
  resets_at: string | null
  remaining_seconds: number
  window_stats?: WindowStats | null // Window statistics (usage from the start of the window to now)
  used_requests?: number
  limit_requests?: number
}

// Quota information for a single Antigravity model
export interface AntigravityModelQuota {
  utilization: number // Usage percentage 0-100
  reset_time: string  // Reset time in ISO8601
}

export interface GrokQuotaWindow {
  limit?: number | null
  remaining?: number | null
  reset_unix?: number | null
  reset_at?: string | null
}

export interface GrokBillingProductUsage {
  product: string
  usage_percent?: number | null
}

export interface GrokBillingSummary {
  period_type?: string
  usage_percent?: number | null
  period_start?: string
  period_end?: string
  product_usage?: GrokBillingProductUsage[]
  monthly_limit_cents?: number | null
  used_cents?: number | null
  included_used_cents?: number | null
  billing_period_start?: string
  billing_period_end?: string
  used_percent?: number | null
  /** Absolute USD money from billing probes */
  prepaid_balance?: number | null
  monthly_limit?: number | null
  monthly_used?: number | null
  on_demand_cap?: number | null
  on_demand_used?: number | null
  top_up_method?: string
  is_unified_billing_user?: boolean
  plan?: string
  status_code?: number
  source?: string
  fetched_at?: string
  updated_at?: string
  weekly_updated_at?: string
  monthly_updated_at?: string
  partial?: boolean
  failed_windows?: string[]
}

export interface AccountUsageInfo {
  source?: 'passive' | 'active'
  updated_at: string | null
  five_hour: UsageProgress | null
  seven_day: UsageProgress | null
  seven_day_sonnet: UsageProgress | null
  seven_day_fable?: UsageProgress | null
  thirty_day?: UsageProgress | null
  gemini_shared_daily?: UsageProgress | null
  gemini_pro_daily?: UsageProgress | null
  gemini_flash_daily?: UsageProgress | null
  gemini_shared_minute?: UsageProgress | null
  gemini_pro_minute?: UsageProgress | null
  gemini_flash_minute?: UsageProgress | null
  antigravity_quota?: Record<string, AntigravityModelQuota> | null
  grok_request_quota?: GrokQuotaWindow | null
  grok_token_quota?: GrokQuotaWindow | null
  grok_retry_after_seconds?: number | null
  grok_entitlement_status?: string
  grok_quota_snapshot_state?: string
  grok_last_quota_probe_at?: string
  grok_last_headers_seen_at?: string
  grok_last_status_code?: number
  grok_free_token_limit?: number
  grok_local_usage?: WindowStats | null
  grok_local_usage_24h?: WindowStats | null
  grok_local_usage_7d?: WindowStats | null
  grok_local_usage_monthly?: WindowStats | null
  grok_billing?: GrokBillingSummary | null
  subscription_tier?: string
  subscription_tier_raw?: string
  ai_credits?: Array<{
    credit_type?: string
    amount?: number
    minimum_balance?: number
  }> | null
  // Antigravity 403 forbidden status
  is_forbidden?: boolean
  forbidden_reason?: string
  forbidden_type?: string   // "validation" | "violation" | "forbidden"
  validation_url?: string   // Verification/appeal link

  // Status flags (automatically derived by the backend)
  needs_verify?: boolean    // Manual verification required (forbidden_type=validation)
  is_banned?: boolean       // Account banned (forbidden_type=violation)
  needs_reauth?: boolean    // token expired; reauthorization required (401)

  // Machine-readable error code: forbidden / unauthenticated / rate_limited / network_error
  error_code?: string

  error?: string            // Error message when usage retrieval fails
}

// OpenAI Codex usage snapshot (from response headers)
export interface CodexUsageSnapshot {
  // Legacy fields (kept for backwards compatibility)
  // NOTE: The naming is ambiguous - actual window type is determined by window_minutes value
  codex_primary_used_percent?: number // Usage percentage (check window_minutes for actual window type)
  codex_primary_reset_after_seconds?: number // Seconds until reset
  codex_primary_window_minutes?: number // Window in minutes
  codex_secondary_used_percent?: number // Usage percentage (check window_minutes for actual window type)
  codex_secondary_reset_after_seconds?: number // Seconds until reset
  codex_secondary_window_minutes?: number // Window in minutes
  codex_primary_over_secondary_percent?: number // Overflow ratio

  // Canonical fields (normalized by backend, use these preferentially)
  codex_5h_used_percent?: number // 5-hour window usage percentage
  codex_5h_reset_after_seconds?: number // Seconds until 5h window reset
  codex_5h_reset_at?: string // 5-hour window absolute reset time (RFC3339)
  codex_5h_window_minutes?: number // 5h window in minutes (should be ~300)
  codex_7d_used_percent?: number // 7-day window usage percentage
  codex_7d_reset_after_seconds?: number // Seconds until 7d window reset
  codex_7d_reset_at?: string // 7-day window absolute reset time (RFC3339)
  codex_7d_window_minutes?: number // 7d window in minutes (should be ~10080)

  codex_usage_updated_at?: string // Last update timestamp
}

export type OpenAICompactMode = 'auto' | 'force_on' | 'force_off'
export type OpenAIResponsesMode = 'auto' | 'force_responses' | 'force_chat_completions'
export type OpenAIEndpointCapability = 'chat_completions' | 'embeddings' | 'seedance'

export interface OpenAICompactState {
  openai_compact_mode?: OpenAICompactMode
  openai_compact_supported?: boolean
  openai_compact_checked_at?: string
  openai_compact_last_status?: number
  openai_compact_last_error?: string
}

export interface OpenAIResponsesState {
  openai_responses_mode?: OpenAIResponsesMode
  openai_responses_supported?: boolean
}

export interface CreateAccountRequest {
  name: string
  notes?: string | null
  platform: AccountPlatform
  type: AccountType
  credentials: Record<string, unknown>
  extra?: Record<string, unknown>
  proxy_id?: number | null
  concurrency?: number
  load_factor?: number | null
  priority?: number
  rate_multiplier?: number // Account billing multiplier (>=0, 0 means free)
  group_ids?: number[]
  expires_at?: number | null
  auto_pause_on_expired?: boolean
  upstream_billing_probe_enabled?: boolean
  confirm_mixed_channel_risk?: boolean
}

export interface UpdateAccountRequest {
  name?: string
  notes?: string | null
  type?: AccountType
  credentials?: Record<string, unknown>
  extra?: Record<string, unknown>
  proxy_id?: number | null
  concurrency?: number
  load_factor?: number | null
  priority?: number
  rate_multiplier?: number // Account billing multiplier (>=0, 0 means free)
  schedulable?: boolean
  status?: 'active' | 'inactive' | 'error'
  group_ids?: number[]
  expires_at?: number | null
  auto_pause_on_expired?: boolean
  upstream_billing_probe_enabled?: boolean
  upstream_billing_rate_sync_enabled?: boolean
  confirm_mixed_channel_risk?: boolean
}

export type GrokMediaEligibilityMode = 'auto' | 'enabled' | 'disabled'

export interface GrokMediaEligibilityState {
  account_id: number
  mode: GrokMediaEligibilityMode
  eligible: boolean
  reason: string
}

export interface CheckMixedChannelRequest {
  platform: AccountPlatform
  group_ids: number[]
  account_id?: number
}

export interface MixedChannelWarningDetails {
  group_id: number
  group_name: string
  current_platform: string
  other_platform: string
}

export interface CheckMixedChannelResponse {
  has_risk: boolean
  error?: string
  message?: string
  details?: MixedChannelWarningDetails
}

export interface CreateProxyRequest {
  name: string
  protocol: ProxyProtocol
  host: string
  port: number
  username?: string | null
  password?: string | null
  expires_at?: number | null   // unix seconds; null/0 = never expires
  fallback_mode?: 'none' | 'proxy' | 'direct'
  backup_proxy_id?: number | null
  expiry_warn_days?: number
}

export interface UpdateProxyRequest {
  name?: string
  protocol?: ProxyProtocol
  host?: string
  port?: number
  username?: string | null
  password?: string | null
  status?: 'active' | 'inactive'
  expires_at?: number | null   // unix seconds; null/0 = never expires
  fallback_mode?: 'none' | 'proxy' | 'direct'
  backup_proxy_id?: number | null
  expiry_warn_days?: number
}

export interface AdminDataPayload {
  type?: string
  version?: number
  exported_at: string
  proxies: AdminDataProxy[]
  accounts: AdminDataAccount[]
  // Number of spark shadow accounts excluded during export (shadows hold no credentials, and their scheduling configuration is outside the backup scope).
  skipped_shadows?: number
}

export interface AdminDataProxy {
  proxy_key: string
  name: string
  protocol: ProxyProtocol
  host: string
  port: number
  username?: string | null
  password?: string | null
  status: 'active' | 'inactive'
}

export interface AdminDataAccount {
  load_factor?: number | null
  name: string
  notes?: string | null
  platform: AccountPlatform
  type: AccountType
  credentials: Record<string, unknown>
  extra?: Record<string, unknown>
  proxy_key?: string | null
  concurrency: number
  priority: number
  rate_multiplier?: number | null
  expires_at?: number | null
  auto_pause_on_expired?: boolean
}

export interface AdminDataImportError {
  kind: 'proxy' | 'account'
  name?: string
  proxy_key?: string
  message: string
}

export interface AdminDataImportResult {
  proxy_created: number
  proxy_reused: number
  proxy_failed: number
  account_created: number
  account_failed: number
  errors?: AdminDataImportError[]
}

export interface CodexSessionImportRequest {
  content?: string
  contents?: string[]
  name?: string
  notes?: string | null
  group_ids?: number[]
  proxy_id?: number | null
  concurrency?: number
  priority?: number
  rate_multiplier?: number
  load_factor?: number | null
  expires_at?: number | null
  auto_pause_on_expired?: boolean
  credential_extras?: Record<string, unknown>
  extra?: Record<string, unknown>
  update_existing?: boolean
  skip_default_group_bind?: boolean
  confirm_mixed_channel_risk?: boolean
}

export interface OpenAICodexPATCreateRequest {
  access_token: string
  name?: string
  notes?: string | null
  group_ids?: number[]
  proxy_id?: number | null
  concurrency?: number
  priority?: number
  rate_multiplier?: number
  load_factor?: number | null
  expires_at?: number | null
  auto_pause_on_expired?: boolean
  credential_extras?: Record<string, unknown>
  extra?: Record<string, unknown>
  skip_default_group_bind?: boolean
  confirm_mixed_channel_risk?: boolean
}

export interface CodexSessionImportMessage {
  index: number
  name?: string
  message: string
}

export interface CodexSessionImportItem {
  index: number
  name?: string
  action: 'created' | 'updated' | 'skipped' | 'failed'
  account_id?: number
  message?: string
}

export interface CodexSessionImportResult {
  total: number
  created: number
  updated: number
  skipped: number
  failed: number
  items?: CodexSessionImportItem[]
  warnings?: CodexSessionImportMessage[]
  errors?: CodexSessionImportMessage[]
}

// ==================== Usage & Redeem Types ====================

export type RedeemCodeType = 'balance' | 'concurrency' | 'subscription' | 'invitation'
export type UsageRequestType = 'unknown' | 'sync' | 'stream' | 'ws_v2' | 'cyber' | 'live'
export type ImageSizeSource = 'output' | 'input' | 'default' | 'legacy'
export type ImageSizeBreakdown = Record<string, number>

export interface UsageLog {
  id: number
  user_id: number
  api_key_id: number
  account_id: number | null
  request_id: string
  model: string
  service_tier?: string | null
  reasoning_effort?: string | null
  inbound_endpoint?: string | null
  upstream_endpoint?: string | null

  group_id: number | null
  subscription_id: number | null

  input_tokens: number
  output_tokens: number
  cache_creation_tokens: number
  cache_read_tokens: number
  cache_creation_5m_tokens: number
  cache_creation_1h_tokens: number

  input_cost: number
  output_cost: number
  cache_creation_cost: number
  cache_read_cost: number
  total_cost: number
  actual_cost: number
  rate_multiplier: number
  long_context_billing_applied: boolean
  billing_type: number

  request_type?: UsageRequestType
  stream: boolean
  openai_ws_mode?: boolean
  native_compaction_v2: boolean
  duration_ms: number | null
  first_token_ms: number | null

  // Image generation fields
  image_count: number
  image_size: string | null
  image_input_size: string | null
  image_output_size: string | null
  image_size_source: ImageSizeSource | null
  image_size_breakdown: ImageSizeBreakdown | null
  image_input_tokens: number
  image_input_cost: number
  image_output_tokens: number
  image_output_cost: number

  // User-Agent
  user_agent: string | null
  ip_address?: string | null

  // Cache TTL Override
  cache_ttl_overridden: boolean

  // Billing mode
  billing_mode?: string | null

  created_at: string

  user?: User
  api_key?: ApiKey
  group?: Group
  subscription?: UserSubscription
}

export interface UsageLogAccountSummary {
  id: number
  name: string
}

export interface AdminUsageLog extends UsageLog {
  upstream_model?: string | null
  upstream_reasoning_effort?: string | null
  upstream_response_model?: string | null
  upstream_model_mismatch?: boolean | null
  model_mapping_chain?: string | null
  upstream_request_id?: string | null

  // Account billing multiplier (admins only)
  account_rate_multiplier?: number | null
  // Account statistical cost calculated by custom pricing rules (use total_cost * multiplier when nil)
  account_stats_cost?: number | null

  // Channel ID and billing tier (admins only)
  channel_id?: number | null
  billing_tier?: string | null

  // Minimal account information (returned by admin APIs only)
  account?: UsageLogAccountSummary
}

export interface UsageCleanupFilters {
  start_time: string
  end_time: string
  user_id?: number
  api_key_id?: number
  account_id?: number
  group_id?: number
  model?: string | null
  request_type?: UsageRequestType | null
  stream?: boolean | null
  billing_type?: number | null
}

export interface UsageCleanupTask {
  id: number
  status: string
  filters: UsageCleanupFilters
  created_by: number
  deleted_rows: number
  error_message?: string | null
  canceled_by?: number | null
  canceled_at?: string | null
  started_at?: string | null
  finished_at?: string | null
  created_at: string
  updated_at: string
}

export interface RedeemCode {
  id: number
  code: string
  type: RedeemCodeType
  value: number
  status: 'active' | 'used' | 'expired' | 'unused' | 'disabled'
  used_by: number | null
  used_at: string | null
  created_at: string
  expires_at?: string | null
  updated_at?: string
  notes?: string
  group_id?: number | null // Subscription type only
  validity_days?: number // Subscription type only
  user?: User
  group?: Group // Associated groups
}

export interface GenerateRedeemCodesRequest {
  count: number
  type: RedeemCodeType
  value: number
  group_id?: number | null // Subscription type only
  validity_days?: number // Subscription type only
  expires_at?: string | null
  expires_in_days?: number
}

export interface BatchUpdateRedeemCodeFields {
  status?: 'unused' | 'disabled'
  expires_at?: string | null
  notes?: string
  group_id?: number | null
}

export interface BatchUpdateRedeemCodesRequest {
  ids: number[]
  fields: BatchUpdateRedeemCodeFields
}

export interface RedeemCodeRequest {
  code: string
}

// ==================== Dashboard & Statistics ====================

export interface DashboardStats {
  // User statistics
  total_users: number
  today_new_users: number // Number of new users today
  active_users: number // Number of users with requests today
  hourly_active_users: number // Active users in the current hour (UTC)
  stats_updated_at: string // Statistics update time (UTC RFC3339)
  stats_stale: boolean // Whether the statistics are stale

  // API Key statistics
  total_api_keys: number
  active_api_keys: number // Number of API Keys with active status

  // Account statistics
  total_accounts: number
  normal_accounts: number // Number of healthy accounts
  error_accounts: number // Number of abnormal accounts
  ratelimit_accounts: number // Number of rate-limited accounts
  overload_accounts: number // Number of overloaded accounts

  // Cumulative Token usage statistics
  total_requests: number
  total_input_tokens: number
  total_output_tokens: number
  total_cache_creation_tokens: number
  total_cache_read_tokens: number
  total_tokens: number
  total_cost: number // Cumulative standard charge
  total_actual_cost: number // Cumulative actual deduction
  total_account_cost: number // Cumulative account cost

  // Today's Token usage statistics
  today_requests: number
  today_input_tokens: number
  today_output_tokens: number
  today_cache_creation_tokens: number
  today_cache_read_tokens: number
  today_tokens: number
  today_cost: number // Today's standard charge
  today_actual_cost: number // Today's actual deduction
  today_account_cost: number // Today's account cost

  // System runtime statistics
  average_duration_ms: number // Average response time
  uptime: number // System uptime (seconds)

  // Performance metrics
  rpm: number // Average requests per minute over the last 5 minutes
  tpm: number // Average Tokens per minute over the last 5 minutes
}

export interface UsageStatsResponse {
  period?: string
  total_requests: number
  total_input_tokens: number
  total_output_tokens: number
  total_cache_tokens: number
  total_cache_read_tokens: number
  total_cache_creation_tokens: number
  total_tokens: number
  total_cost: number // Standard charge
  total_actual_cost: number // Actual deduction
  average_duration_ms: number
  models?: Record<string, number>
  endpoints?: EndpointStat[]
  upstream_endpoints?: EndpointStat[]
  endpoint_paths?: EndpointStat[]
}

// ==================== Trend & Chart Types ====================

export interface TrendDataPoint {
  date: string
  requests: number
  input_tokens: number
  output_tokens: number
  cache_creation_tokens: number
  cache_read_tokens: number
  total_tokens: number
  cost: number // Standard charge
  actual_cost: number // Actual deduction
}

export interface ModelStat {
  model: string
  requests: number
  input_tokens: number
  output_tokens: number
  cache_creation_tokens: number
  cache_read_tokens: number
  total_tokens: number
  cost: number // Standard charge
  actual_cost: number // Actual deduction
  account_cost?: number // Account cost (returned by admin APIs only)
}

export interface EndpointStat {
  endpoint: string
  requests: number
  total_tokens: number
  cost: number
  actual_cost: number
}

export interface GroupStat {
  group_id: number
  group_name: string
  requests: number
  total_tokens: number
  cost: number // Standard charge
  actual_cost: number // Actual deduction
  account_cost?: number // Account cost (returned by admin APIs only)
}

export interface UserBreakdownItem {
  user_id: number
  email: string
  requests: number
  input_tokens: number
  output_tokens: number
  cache_tokens: number
  total_tokens: number
  cost: number
  actual_cost: number
  account_cost: number
}

export interface UserUsageTrendPoint {
  date: string
  user_id: number
  email: string
  username: string
  requests: number
  tokens: number
  cost: number // Standard charge
  actual_cost: number // Actual deduction
}

export interface UserSpendingRankingItem {
  user_id: number
  email: string
  username: string
  actual_cost: number
  requests: number
  tokens: number
}

export interface UserSpendingRankingResponse {
  ranking: UserSpendingRankingItem[]
  total_actual_cost: number
  total_requests: number
  total_tokens: number
  start_date: string
  end_date: string
}

export interface ApiKeyUsageTrendPoint {
  date: string
  api_key_id: number
  key_name: string
  requests: number
  tokens: number
}

// ==================== Admin User Management ====================

export interface UpdateUserRequest {
  email?: string
  password?: string
  username?: string
  notes?: string
  role?: 'admin' | 'user'
  balance?: number
  concurrency?: number
  rpm_limit?: number
  status?: 'active' | 'disabled'
  allowed_groups?: number[] | null
  restrict_public_groups?: boolean
  // User-specific group multiplier configuration (group_id -> rate_multiplier | null)
  // null means deleting the group-specific multiplier
  group_rates?: Record<number, number | null>
}

export interface ChangePasswordRequest {
  old_password: string
  new_password: string
}

// ==================== User Subscription Types ====================

export interface UserSubscription {
  id: number
  user_id: number
  group_id: number
  status: 'active' | 'expired' | 'revoked' | 'suspended'
  starts_at: string
  daily_usage_usd: number
  weekly_usage_usd: number
  monthly_usage_usd: number
  daily_window_start: string | null
  weekly_window_start: string | null
  monthly_window_start: string | null
  created_at: string
  updated_at: string
  revoked_at?: string | null
  expires_at: string | null
  user?: User
  group?: Group
}

export interface SubscriptionProgress {
  subscription_id: number
  daily: {
    used: number
    limit: number | null
    percentage: number
    reset_in_seconds: number | null
  } | null
  weekly: {
    used: number
    limit: number | null
    percentage: number
    reset_in_seconds: number | null
  } | null
  monthly: {
    used: number
    limit: number | null
    percentage: number
    reset_in_seconds: number | null
  } | null
  expires_at: string | null
  days_remaining: number | null
}

export interface AssignSubscriptionRequest {
  user_id: number
  group_id: number
  validity_days?: number
}

export interface BulkAssignSubscriptionRequest {
  user_ids: number[]
  group_id: number
  validity_days?: number
}

export interface ExtendSubscriptionRequest {
  days: number
}

// ==================== Query Parameters ====================

export interface UserErrorRequest {
  id: number
  created_at: string
  model: string
  inbound_endpoint: string
  status_code: number
  category: string
  platform: string
  message: string
  key_name: string
  key_deleted: boolean
  client_ip?: string
  group_name?: string
  request_type?: number
  stream?: boolean
  user_agent?: string
}

export interface UserErrorRequestDetail extends UserErrorRequest {
  error_body: string
  upstream_status_code?: number
}

export interface UserErrorListParams {
  page?: number
  page_size?: number
  start_date?: string
  end_date?: string
  timezone?: string
  model?: string
  status_code?: number
  category?: string
  api_key_id?: string | number
  // Server-side sorting; see backend opsErrorLogsOrderBy(created_at/model/status_code) for the column allowlist
  sort_by?: string
  sort_order?: 'asc' | 'desc'
}

export interface UsageQueryParams {
  page?: number
  page_size?: number
  api_key_id?: number
  user_id?: number
  account_id?: number
  group_id?: number
  model?: string
  request_type?: UsageRequestType
  stream?: boolean
  native_compaction_v2?: boolean | null
  billing_type?: number | null
  billing_mode?: string | null
  start_date?: string
  end_date?: string
  timezone?: string
  sort_by?: string
  sort_order?: 'asc' | 'desc'
}

// ==================== Account Usage Statistics ====================

export interface AccountUsageHistory {
  date: string
  label: string
  requests: number
  tokens: number
  cost: number
  actual_cost: number // Account cost (account multiplier)
  user_cost: number // User/API key billed cost (group multiplier)
}

export interface AccountUsageSummary {
  days: number
  actual_days_used: number
  total_cost: number // Account cost (account multiplier)
  total_user_cost: number
  total_standard_cost: number
  total_requests: number
  total_tokens: number
  avg_daily_cost: number // Account cost
  avg_daily_user_cost: number
  avg_daily_requests: number
  avg_daily_tokens: number
  avg_duration_ms: number
  today: {
    date: string
    cost: number
    user_cost: number
    requests: number
    tokens: number
  } | null
  highest_cost_day: {
    date: string
    label: string
    cost: number
    user_cost: number
    requests: number
  } | null
  highest_request_day: {
    date: string
    label: string
    requests: number
    cost: number
    user_cost: number
  } | null
}

export interface AccountUsageStatsResponse {
  history: AccountUsageHistory[]
  summary: AccountUsageSummary
  models: ModelStat[]
  endpoints: EndpointStat[]
  upstream_endpoints: EndpointStat[]
}

// ==================== User Attribute Types ====================

export type UserAttributeType = 'text' | 'textarea' | 'number' | 'email' | 'url' | 'date' | 'select' | 'multi_select'

export interface UserAttributeOption {
  value: string
  label: string
  [key: string]: unknown
}

export interface UserAttributeValidation {
  min_length?: number
  max_length?: number
  min?: number
  max?: number
  pattern?: string
  message?: string
}

export interface UserAttributeDefinition {
  id: number
  key: string
  name: string
  description: string
  type: UserAttributeType
  options: UserAttributeOption[]
  required: boolean
  validation: UserAttributeValidation
  placeholder: string
  display_order: number
  enabled: boolean
  created_at: string
  updated_at: string
}

export interface UserAttributeValue {
  id: number
  user_id: string | number
  attribute_id: number
  value: string
  created_at: string
  updated_at: string
}

export interface CreateUserAttributeRequest {
  key: string
  name: string
  description?: string
  type: UserAttributeType
  options?: UserAttributeOption[]
  required?: boolean
  validation?: UserAttributeValidation
  placeholder?: string
  display_order?: number
  enabled?: boolean
}

export interface UpdateUserAttributeRequest {
  key?: string
  name?: string
  description?: string
  type?: UserAttributeType
  options?: UserAttributeOption[]
  required?: boolean
  validation?: UserAttributeValidation
  placeholder?: string
  display_order?: number
  enabled?: boolean
}

export interface UserAttributeValuesMap {
  [attributeId: number]: string
}

// ==================== Promo Code Types ====================

export interface PromoCode {
  id: number
  code: string
  bonus_amount: number
  max_uses: number
  used_count: number
  status: 'active' | 'disabled'
  expires_at: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface PromoCodeUsage {
  id: number
  promo_code_id: number
  user_id: number
  bonus_amount: number
  used_at: string
  user?: User
}

export interface CreatePromoCodeRequest {
  code?: string
  bonus_amount: number
  max_uses?: number
  expires_at?: number | null
  notes?: string
}

export interface UpdatePromoCodeRequest {
  code?: string
  bonus_amount?: number
  max_uses?: number
  status?: 'active' | 'disabled'
  expires_at?: number | null
  notes?: string
}

// ==================== TOTP (2FA) Types ====================

export interface TotpStatus {
  enabled: boolean
  enabled_at: number | null  // Unix timestamp in seconds
  feature_enabled: boolean
}

export interface TotpSetupRequest {
  email_code?: string
  password?: string
}

export interface TotpSetupResponse {
  secret: string
  qr_code_url: string
  setup_token: string
  countdown: number
}

export interface TotpEnableRequest {
  totp_code: string
  setup_token: string
}

export interface TotpEnableResponse {
  success: boolean
}

export interface TotpDisableRequest {
  totp_code: string
  email_code?: string
  password?: string
}

export interface TotpVerificationMethod {
  method: 'email' | 'password'
}

export interface TotpLoginResponse {
  requires_2fa: boolean
  temp_token?: string
  user_email_masked?: string
}

export interface TotpLogin2FARequest {
  temp_token: string
  totp_code: string
}

// ==================== Scheduled Test Types ====================

export interface ScheduledTestPlan {
  id: number
  account_id: number
  model_id: string
  cron_expression: string
  enabled: boolean
  max_results: number
  auto_recover: boolean
  last_run_at: string | null
  next_run_at: string | null
  created_at: string
  updated_at: string
}

export interface ScheduledTestResult {
  id: number
  plan_id: number
  status: string
  response_text: string
  error_message: string
  latency_ms: number
  started_at: string
  finished_at: string
  created_at: string
}

export interface CreateScheduledTestPlanRequest {
  account_id: number
  model_id: string
  cron_expression: string
  enabled?: boolean
  max_results?: number
  auto_recover?: boolean
}

export interface UpdateScheduledTestPlanRequest {
  model_id?: string
  cron_expression?: string
  enabled?: boolean
  max_results?: number
  auto_recover?: boolean
}

// Payment types
export type { SubscriptionPlan, PaymentOrder, CheckoutInfoResponse } from './payment'

export type {
  PlatformQuotaItem,
  PlatformQuotaUpdateItem,
  PlatformQuotaPlatform,
  PlatformQuotaWindow,
  PlatformQuotasResponse,
} from '@/api/admin/users'
