<template>
  <div v-if="sceneId && prefix" class="aliyun-captcha-wrapper">
    <button
      :id="buttonId"
      type="button"
      class="aliyun-captcha-button"
      :class="state === 'verified' ? 'aliyun-captcha-button--verified' : ''"
      :disabled="state === 'verified'"
    >
      <svg
        v-if="state === 'verified'"
        class="aliyun-captcha-icon"
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden="true"
      >
        <path
          fill-rule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
          clip-rule="evenodd"
        />
      </svg>
      <svg
        v-else
        class="aliyun-captcha-icon"
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden="true"
      >
        <path
          fill-rule="evenodd"
          d="M9.661 2.237a.531.531 0 01.678 0 11.947 11.947 0 007.078 2.749.5.5 0 01.479.425c.069.52.104 1.05.104 1.59 0 5.162-3.26 9.563-7.834 11.256a.48.48 0 01-.332 0C5.26 16.564 2 12.163 2 7c0-.538.035-1.069.104-1.589a.5.5 0 01.48-.425 11.947 11.947 0 007.077-2.75z"
          clip-rule="evenodd"
        />
      </svg>
      <span>{{ buttonText }}</span>
    </button>
    <div :id="elementId"></div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

interface AliyunCaptchaVerifyResult {
  captchaResult: boolean
  bizResult?: boolean
}

interface AliyunCaptchaInitOptions {
  SceneId: string
  prefix: string
  mode: 'popup' | 'embed'
  element: string
  button: string
  captchaVerifyCallback: (
    captchaVerifyParam: string
  ) => AliyunCaptchaVerifyResult | Promise<AliyunCaptchaVerifyResult>
  onBizResultCallback: (bizResult: boolean) => void
  getInstance: (instance: unknown) => void
  slideStyle?: { width: number; height: number }
  language?: string
}

declare global {
  interface Window {
    initAliyunCaptcha?: (options: AliyunCaptchaInitOptions) => void
    AliyunCaptchaConfig?: { region: string; prefix: string }
  }
}

const props = withDefaults(
  defineProps<{
    sceneId: string
    prefix: string
    region?: 'cn' | 'sgp'
  }>(),
  {
    region: 'cn'
  }
)

const emit = defineEmits<{
  (e: 'verify', param: string): void
  (e: 'expire'): void
  (e: 'error'): void
}>()

const { t, locale } = useI18n()

const uid = Math.random().toString(36).slice(2, 10)
const buttonId = `aliyun-captcha-button-${uid}`
const elementId = `aliyun-captcha-element-${uid}`

// idle: unverified and clickable; verifying: dialog opened (returns to idle after closing for retry); verified: passed
const state = ref<'idle' | 'verifying' | 'verified'>('idle')

const buttonText = computed(() => {
  switch (state.value) {
    case 'verified':
      return t('auth.captchaVerified')
    case 'verifying':
      return t('auth.captchaVerifying')
    default:
      return t('auth.captchaClickToVerify')
  }
})

const SCRIPT_SRC = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js'
const POPUP_ID = 'aliyunCaptcha-window-popup'
const MASK_ID = 'aliyunCaptcha-mask'
const POPUP_OPEN_TIMEOUT_MS = 8000
const POPUP_WATCH_INTERVAL_MS = 300

// captchaVerifyParam is a one-time parameter: cached here after verification; reset and verify again if submission fails
let cachedParam: string | null = null
let pending: { resolve: (value: string | null) => void } | null = null
let popupWatchTimer: number | null = null
let readyPromise: Promise<void> | null = null

const loadScript = (): Promise<void> => {
  return new Promise((resolve, reject) => {
    // Global configuration must be ready before the script loads (region/prefix are consistent site-wide; repeated assignment is harmless)
    window.AliyunCaptchaConfig = { region: props.region, prefix: props.prefix }

    if (window.initAliyunCaptcha) {
      resolve()
      return
    }

    const existingScript = document.querySelector<HTMLScriptElement>(
      'script[src*="aliyunCaptcha/AliyunCaptcha"]'
    )
    if (existingScript) {
      existingScript.addEventListener('load', () => resolve())
      existingScript.addEventListener('error', () =>
        reject(new Error('Failed to load Aliyun captcha script'))
      )
      return
    }

    const script = document.createElement('script')
    script.src = SCRIPT_SRC
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Failed to load Aliyun captcha script'))
    document.head.appendChild(script)
  })
}

function initCaptcha(): void {
  if (!window.initAliyunCaptcha) {
    throw new Error('Aliyun captcha script not ready')
  }
  window.initAliyunCaptcha({
    SceneId: props.sceneId,
    prefix: props.prefix,
    mode: 'popup',
    element: `#${elementId}`,
    button: `#${buttonId}`,
    // No business request is sent here; captchaVerifyParam is passed to the page as a token, then submitted with login/registration and other
    // business requests in the turnstile_token field, where the backend validates it through Alibaba Cloud within the business API.
    captchaVerifyCallback: (captchaVerifyParam: string) => {
      onCaptchaParam(captchaVerifyParam)
      return { captchaResult: true }
    },
    onBizResultCallback: () => {},
    getInstance: () => {},
    slideStyle: { width: 360, height: 40 },
    language: locale.value.toLowerCase().startsWith('zh') ? 'cn' : 'en'
  })
}

function ensureReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = loadScript().then(() => initCaptcha())
    readyPromise.catch(() => {
      // Allow the next retry after failure (for example, when the network recovers)
      readyPromise = null
    })
  }
  return readyPromise
}

function onCaptchaParam(param: string): void {
  stopPopupWatch()
  cachedParam = param
  state.value = 'verified'
  emit('verify', param)
  const current = pending
  pending = null
  current?.resolve(param)
}

function settlePending(value: string | null): void {
  const current = pending
  pending = null
  current?.resolve(value)
}

function isPopupVisible(): boolean {
  const popup = document.getElementById(POPUP_ID)
  if (!popup) return false
  return window.getComputedStyle(popup).display !== 'none'
}

function stopPopupWatch(): void {
  if (popupWatchTimer !== null) {
    window.clearInterval(popupWatchTimer)
    popupWatchTimer = null
  }
}

// The SDK has no callback for the user closing the dialog, so poll dialog visibility as a fallback:
// If the dialog appeared and then disappeared without producing a param → the user closed it; if it never appears → opening failed.
// initAliyunCaptcha binds events to the trigger button asynchronously; the first click may be missed,
// so retry triggering once on each tick before the dialog appears.
function startPopupWatch(): void {
  stopPopupWatch()
  const startedAt = Date.now()
  let seen = false
  popupWatchTimer = window.setInterval(() => {
    if (state.value === 'verified') {
      stopPopupWatch()
      return
    }
    if (isPopupVisible()) {
      seen = true
      return
    }
    if (seen || Date.now() - startedAt > POPUP_OPEN_TIMEOUT_MS) {
      stopPopupWatch()
      state.value = 'idle'
      settlePending(null)
      return
    }
    document.getElementById(buttonId)?.click()
  }, POPUP_WATCH_INTERVAL_MS)
}

// Shared by user clicks and programmatic triggers: set verifying and start dialog monitoring (idempotent; retry clicks do not reset the timer)
function handleTriggerClick(): void {
  if (state.value === 'verified') {
    return
  }
  state.value = 'verifying'
  if (popupWatchTimer === null) {
    startPopupWatch()
  }
}

// Programmatically trigger verification (OAuth startup, passkey, and form-submission fallback when not pre-verified):
// Reuse the cached captchaVerifyParam when pre-verified; otherwise show the captcha and wait for the result.
// Resolve null when the user closes it or it fails to open; reject when script loading fails.
async function verify(): Promise<string | null> {
  if (state.value === 'verified' && cachedParam) {
    return cachedParam
  }
  settlePending(null)
  await ensureReady()
  return new Promise<string | null>((resolve) => {
    pending = { resolve }
    document.getElementById(buttonId)?.click()
  })
}

// Reset to the unverified state; captchaVerifyParam is a one-time parameter and requires user re-verification after server validation fails
function reset(): void {
  stopPopupWatch()
  settlePending(null)
  cachedParam = null
  state.value = 'idle'
}

defineExpose({ verify, reset })

onMounted(async () => {
  if (!props.sceneId || !props.prefix) {
    return
  }

  document.getElementById(buttonId)?.addEventListener('click', handleTriggerClick)
  try {
    await ensureReady()
  } catch (error) {
    console.error('Failed to initialize Aliyun captcha:', error)
    emit('error')
  }
})

onUnmounted(() => {
  document.getElementById(buttonId)?.removeEventListener('click', handleTriggerClick)
  stopPopupWatch()
  settlePending(null)
  // The SDK does not automatically clean up the dialog DOM; leftovers cause callbacks to fire repeatedly on the next mount
  document.getElementById(MASK_ID)?.remove()
  document.getElementById(POPUP_ID)?.remove()
})
</script>

<style scoped>
.aliyun-captcha-wrapper {
  width: 100%;
}

.aliyun-captcha-button {
  display: flex;
  width: 100%;
  min-height: 44px;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  border-radius: 0.5rem;
  border: 1px solid rgb(209 213 219);
  background-color: rgb(249 250 251);
  padding: 0.5rem 0.75rem;
  font-size: 0.875rem;
  font-weight: 500;
  color: rgb(55 65 81);
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease,
    color 0.15s ease;
}

.aliyun-captcha-button:hover:not(:disabled) {
  border-color: rgb(156 163 175);
  background-color: rgb(243 244 246);
}

.aliyun-captcha-button--verified {
  border-color: rgb(34 197 94);
  background-color: rgb(240 253 244);
  color: rgb(21 128 61);
}

:root.dark .aliyun-captcha-button,
.dark .aliyun-captcha-button {
  border-color: rgb(55 65 81);
  background-color: rgb(31 41 55);
  color: rgb(209 213 219);
}

:root.dark .aliyun-captcha-button:hover:not(:disabled),
.dark .aliyun-captcha-button:hover:not(:disabled) {
  border-color: rgb(75 85 99);
  background-color: rgb(55 65 81);
}

:root.dark .aliyun-captcha-button--verified,
.dark .aliyun-captcha-button--verified {
  border-color: rgb(34 197 94);
  background-color: rgb(20 83 45 / 0.3);
  color: rgb(134 239 172);
}

.aliyun-captcha-icon {
  height: 1rem;
  width: 1rem;
  flex-shrink: 0;
}
</style>
