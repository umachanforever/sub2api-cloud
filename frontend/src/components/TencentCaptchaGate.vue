<template>
  <div
    v-if="isInternational"
    ref="internationalContainerRef"
    data-testid="tencent-captcha-international-container"
    :class="
      internationalContainerVisible
        ? 'flex min-h-[60px] w-full justify-center'
        : 'pointer-events-none fixed left-1/2 top-0 flex h-[60px] w-[302px] -translate-x-1/2 scale-[0.01] opacity-0'
    "
  />
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  loadTencentCaptcha,
  normalizeTencentCaptchaRegion,
  type TencentCaptchaProof,
  type TencentCaptchaResult
} from '@/utils/tencentCaptcha'

const { locale } = useI18n()
const props = withDefaults(defineProps<{ appId: string; region?: string }>(), { region: 'cn' })
const isInternational = computed(
  () => normalizeTencentCaptchaRegion(props.region) === 'intl'
)
const internationalContainerRef = ref<HTMLDivElement | null>(null)
const internationalContainerVisible = ref<boolean>(isInternational.value)

let instance: { show(): void; destroy(): void } | null = null
let pending: Promise<TencentCaptchaProof | null> | null = null
let cancelPending: (() => void) | null = null
let cachedProof: TencentCaptchaProof | null = null
let cachedProofCreatedAt = 0
let isMounted = false

// Tencent international-site tickets are officially valid for 5 minutes; discard the cache 1 minute early to avoid expiration during submission.
const cachedProofMaxAgeMs = 4 * 60 * 1000

function createVerificationPromise(revealInternational: boolean = true): Promise<TencentCaptchaProof | null> {
  return new Promise((resolve, reject) => {
    let settled = false

    const finish = (callback: () => void, keepInternationalContainer: boolean = false): void => {
      if (settled) return
      settled = true
      if (cancelPending === cancel) cancelPending = null
      if (!keepInternationalContainer) {
        instance?.destroy()
        instance = null
        internationalContainerVisible.value = false
      }
      callback()
    }
    const cancel = (): void => finish(() => resolve(null))

    cancelPending = cancel
    const region = normalizeTencentCaptchaRegion(props.region)
    if (region === 'intl' && revealInternational) {
      internationalContainerVisible.value = true
    }

    void nextTick()
      .then(() => loadTencentCaptcha(region))
      .then((TencentCaptcha) => {
        if (cancelPending !== cancel) return

        const userLanguage = locale.value.toLowerCase().startsWith('zh') ? 'zh-cn' : 'en'
        const handleResult = (result: TencentCaptchaResult): void => {
          if (result.ret === 2) {
            finish(() => resolve(null))
            return
          }

          const ticket = result.ticket?.trim() || ''
          const randstr = result.randstr?.trim() || ''
          if (!ticket || !randstr || ticket.startsWith('trerror_') || result.errorCode !== undefined) {
            finish(() => reject(new Error('Tencent Captcha verification failed')))
            return
          }

          // Keep selected controls on the international site to prevent layout shifts after the success callback; reset clears them when the login flow ends.
          finish(() => resolve({ ticket, randstr }), region === 'intl')
        }

        if (region === 'intl') {
          // The new international site first displays the Robot checkbox in the specified container; the challenge appears only after the user clicks it.
          // document.body appends the checkbox to the end of the entire page, which usually places it outside the viewport on the login page,
          // making the SDK appear successfully initialized while no visible component appears on the page.
          const container = internationalContainerRef.value
          if (!container) {
            throw new Error('Tencent Captcha international container is unavailable')
          }
          instance = new TencentCaptcha(container, props.appId, handleResult, {
            // Keep the international and domestic sites consistent: display the Robot checkbox after page load for the user to confirm explicitly.
            enableAutoCheck: false,
            userLanguage,
            type: 'popup'
          })
        } else {
          instance = new TencentCaptcha(props.appId, handleResult, { userLanguage })
        }
        instance.show()
      })
      .catch((error: unknown) => finish(() => reject(error)))
  })
}

function verify(): Promise<TencentCaptchaProof | null> {
  if (cachedProof) {
    if (Date.now() - cachedProofCreatedAt >= cachedProofMaxAgeMs) {
      // Expired tickets cannot be submitted again; destroy the old instance synchronously first, then create a new verification in this call.
      reset(false)
    } else {
      const proof = cachedProof
      cachedProof = null
      cachedProofCreatedAt = 0
      // The preload promise has completed; clear the reference synchronously when consuming the cache to prevent concurrent reuse of the same ticket.
      pending = null
      return Promise.resolve(proof)
    }
  }

  if (pending) {
    const verification = pending
    internationalContainerVisible.value = true
    // During preloading, the SDK may defer rendering because the container is not visible; retrigger the same instance at submission after showing the container.
    void nextTick().then(() => {
      if (pending === verification) instance?.show()
    })
    return verification.then((proof) => {
      if (cachedProof === proof) {
        cachedProof = null
        cachedProofCreatedAt = 0
      }
      return proof
    })
  }

  internationalContainerVisible.value = true
  const verification = createVerificationPromise(true)
  pending = verification
  void verification.then(
    () => {
      if (pending === verification) pending = null
    },
    () => {
      if (pending === verification) pending = null
    }
  )
  return verification
}

function preload(): void {
  if (!isInternational.value || pending || cachedProof) return

  // The international site requires the checkbox to be displayed immediately on the initial screen, preventing the captcha from appearing only after the user clicks login.
  const verification = createVerificationPromise(true)
  pending = verification
  void verification
    .then((proof) => {
      if (proof) {
        cachedProof = proof
        cachedProofCreatedAt = Date.now()
      }
    })
    .catch(() => undefined)
    .finally(() => {
      if (pending === verification) pending = null
    })
}

function reset(reinitialize: boolean = true): void {
  instance?.destroy()
  instance = null
  cancelPending?.()
  cancelPending = null
  pending = null
  cachedProof = null
  cachedProofCreatedAt = 0
  internationalContainerVisible.value = isInternational.value

  // International-site tickets are single-use; create a new checkbox immediately after login failure,
  // rather than waiting for the next login click to reinitialize. Do not start preloading during unmount.
  if (reinitialize && isMounted && isInternational.value) {
    void nextTick().then(() => {
      if (isMounted) preload()
    })
  }
}

onMounted(() => {
  isMounted = true
  preload()
})
onBeforeUnmount(() => {
  isMounted = false
  reset()
})
defineExpose({ verify, reset })
</script>
