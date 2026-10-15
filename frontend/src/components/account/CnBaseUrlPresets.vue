<template>
  <div class="flex flex-wrap gap-2">
    <button
      v-for="preset in presets"
      :key="preset.mode + ':' + preset.protocol + ':' + preset.url"
      type="button"
      data-testid="cn-base-url-preset"
      :class="[
        'rounded-lg px-3 py-1 text-xs transition-colors',
        isActive(preset)
          ? 'bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-300'
          : 'bg-gray-100 text-gray-700 hover:bg-primary-50 hover:text-primary-700 dark:bg-dark-600 dark:text-gray-300 dark:hover:bg-primary-900/30 dark:hover:text-primary-400'
      ]"
      @click="emit('select', preset)"
    >
      {{ preset.label }} ({{ displayUrl(preset.url) }})
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { CN_BASE_URL_PRESETS, type CnBaseUrlPreset } from './credentialsBuilder'

// Domestic provider quick endpoint: clicking fills the preset address (and corresponding account type/protocol) back into the caller.
// Consistent with the Grok preset; for quick filling only, the input still accepts any third-party relay address.
// When protocol is provided, show only presets for that protocol (protocol × account type are orthogonal tiers).
const props = defineProps<{
  platform: 'kimi' | 'zhipu' | 'deepseek' | 'minimax'
  /** Currently selected account type, used to filter and highlight matching presets */
  mode?: 'payg' | 'coding'
  /** Currently selected API protocol, used to filter and highlight matching presets */
  protocol?: 'adaptive' | 'chat_completions' | 'anthropic' | 'responses'
  /** Base URL in the current input, used to highlight exact matches */
  currentUrl?: string
}>()

const emit = defineEmits<{
  (e: 'select', preset: CnBaseUrlPreset): void
}>()

const presets = computed(() => {
  const all = CN_BASE_URL_PRESETS[props.platform] ?? []
  // Filter only by protocol: show both payg/coding tiers under the same protocol; clicking also switches the account type.
  if (props.protocol == null) return all
  return all.filter(p => p.protocol === props.protocol)
})

const isActive = (preset: CnBaseUrlPreset) =>
  (props.mode != null && preset.mode === props.mode) || preset.url === props.currentUrl

const displayUrl = (url: string) => url.replace(/^https?:\/\//i, '')
</script>
