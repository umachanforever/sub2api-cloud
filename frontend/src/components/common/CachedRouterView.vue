<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterView, useRoute } from 'vue-router'

const props = withDefaults(defineProps<{ identity: string; revision?: number }>(), { revision: 0 })
const route = useRoute()
// Retain ordinary data pages only; live monitors and payment flows keep their lifecycle.
const cacheable = computed(() => !!props.identity && /^(?:\/admin\/(?:dashboard|accounts|users|groups|usage|settings)|\/dashboard|\/usage|\/keys)$/.test(route.path))
const entries = new Map<string, { key: number; expires: number; revision: number }>()
const pageKey = ref(0)
let serial = 0
let identity = props.identity
let currentPath = ''
watch(() => [route.fullPath, props.identity, props.revision] as const, ([path, nextIdentity, revision]) => {
  if (nextIdentity !== identity) { entries.clear(); identity = nextIdentity }
  // A write on the active page already updates its local state. Inactive pages
  // must reload on their next visit, without remounting the active form.
  if (path === currentPath) {
    const active = entries.get(path)
    if (active) active.revision = revision
    return
  }
  currentPath = path
  if (!cacheable.value) return
  let entry = entries.get(path)
  if (!entry || entry.expires <= Date.now() || entry.revision !== revision) {
    entry = { key: ++serial, expires: Date.now() + 60_000, revision }
    entries.set(path, entry)
    if (entries.size > 10) entries.delete(entries.keys().next().value!)
  }
  pageKey.value = entry.key
}, { immediate: true, flush: 'sync' })
</script>

<template>
  <RouterView v-slot="{ Component }">
    <KeepAlive :key="props.identity" :max="10">
      <component :is="Component" v-if="cacheable" :key="pageKey" />
    </KeepAlive>
    <component :is="Component" v-if="!cacheable" />
  </RouterView>
</template>
