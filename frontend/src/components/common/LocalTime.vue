<template>
  <time v-if="valid" :datetime="value!" :title="value!">{{ formatted }}</time>
  <span v-else>—</span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ value?: string | null }>()
const { locale } = useI18n()
const valid = computed(() => !!props.value && Number.isFinite(Date.parse(props.value)))
// Omitting timeZone deliberately uses the browser's local timezone.
const formatted = computed(() => valid.value
  ? new Intl.DateTimeFormat(locale.value === 'zh' ? 'zh-CN' : locale.value, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
  }).format(new Date(props.value!))
  : '—')
</script>
