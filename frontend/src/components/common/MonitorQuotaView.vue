<template>
  <div v-if="snapshot" class="space-y-1" data-testid="monitor-quota-view">
    <!-- Plan-tier badge (e.g., Zhipu plan level / Claude subscription tier) -->
    <div v-if="snapshot.plan_level" class="flex flex-wrap items-center gap-1.5">
      <span class="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-dark-600 dark:text-gray-300">
        {{ snapshot.plan_level }}
      </span>
    </div>

    <!-- Usage-window bar chart (reuses UsageProgressBar from the accounts page with identical threshold colors and countdown formatting) -->
    <div v-if="snapshot.success && tierRows.length" class="space-y-1">
      <UsageProgressBar
        v-for="row in tierRows"
        :key="row.key"
        data-testid="monitor-quota-tier"
        :label="row.label"
        :title="row.title"
        label-width="auto"
        :color="row.color"
        :utilization="row.tier.used_percent"
        :resets-at="row.tier.reset_at ?? null"
      />
    </div>

    <!-- Balance (domestic-provider payg; supports multiple currencies) -->
    <div v-if="snapshot.success && balanceRows.length" class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px]">
      <span
        v-for="b in balanceRows"
        :key="b.currency"
        :class="['font-medium', b.balance <= 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-600 dark:text-gray-300']"
      >
        {{ b.balance.toFixed(2) }} {{ b.currency }}
      </span>
    </div>

    <div v-if="!snapshot.success" class="truncate text-[10px] text-red-600 dark:text-red-400" :title="snapshot.error" data-testid="monitor-quota-error">
      {{ truncatedError }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { MonitorQuotaSnapshot, MonitorQuotaTier } from '@/api/admin/channelMonitor'
import UsageProgressBar from '@/components/account/UsageProgressBar.vue'

/**
 * Quota snapshot rendering (shared by the admin monitoring list/run results and user monitoring cards).
 * Usage bars directly reuse UsageProgressBar from the accounts page (the same component used by CNProviderQuotaCell and
 * AccountUsageCell, with identical threshold colors and countdown formatting); tier
 * Window/Label values are backend-defined machine tokens. Known tokens use i18n, while unknown tokens
 * are displayed unchanged for forward compatibility.
 */
const props = defineProps<{
  snapshot?: MonitorQuotaSnapshot | null
}>()

const { t, te } = useI18n()

type TierColor = 'indigo' | 'emerald' | 'purple' | 'amber'

interface QuotaTierRow {
  key: string
  label: string
  title: string
  color: TierColor
  tier: MonitorQuotaTier
}

// Known window/label machine tokens → i18n keys (monitorCommon.quota.*).
const windowI18nKeys: Record<string, string> = {
  '5h': 'monitorCommon.quota.windows.5h',
  '7d': 'monitorCommon.quota.windows.7d',
  '7d-sonnet': 'monitorCommon.quota.windows.7dSonnet',
  '7d-fable': 'monitorCommon.quota.windows.7dFable',
  weekly: 'monitorCommon.quota.windows.weekly',
  daily: 'monitorCommon.quota.windows.daily',
  '30d': 'monitorCommon.quota.windows.30d',
  total: 'monitorCommon.quota.windows.total',
}

const labelI18nKeys: Record<string, string> = {
  requests: 'monitorCommon.quota.labels.requests',
  tokens: 'monitorCommon.quota.labels.tokens',
  shared: 'monitorCommon.quota.labels.shared',
  pro: 'monitorCommon.quota.labels.pro',
  flash: 'monitorCommon.quota.labels.flash',
}

function windowLabel(window: string): string {
  const key = windowI18nKeys[window]
  return key && te(key) ? t(key) : window
}

function tierLabel(tier: MonitorQuotaTier): string {
  const window = windowLabel(tier.window)
  if (!tier.label) return window
  const labelKey = labelI18nKeys[tier.label]
  const label = labelKey && te(labelKey) ? t(labelKey) : tier.label
  return `${label}/${window}`
}

// Rotate tier colors by array order (palette supported by UsageProgressBar).
const tierColors: TierColor[] = ['indigo', 'emerald', 'purple', 'amber']

const tierRows = computed<QuotaTierRow[]>(() =>
  (props.snapshot?.tiers || []).map((tier, idx) => ({
    key: `${tier.window}-${tier.label || ''}-${idx}`,
    label: tierLabel(tier),
    title: tierLabel(tier),
    color: tierColors[idx % tierColors.length],
    tier,
  })),
)

const balanceRows = computed(() => {
  const snapshot = props.snapshot
  if (!snapshot) return []
  if (snapshot.balances?.length) return snapshot.balances
  if (snapshot.balance != null) {
    return [{ currency: snapshot.currency || '?', balance: snapshot.balance }]
  }
  return []
})

const truncatedError = computed(() => {
  const error = props.snapshot?.error || t('monitorCommon.quota.unavailable')
  return error.length > 48 ? `${error.slice(0, 48)}…` : error
})
</script>
