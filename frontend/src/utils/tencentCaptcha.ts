// Tencent Captcha sites: cn=China site (cloud.tencent.com), intl=international site (tencentcloud.com).
// CaptchaAppId values are not interchangeable between the two sites; SDK scripts and server-side verification endpoints must be paired.
export type TencentCaptchaRegion = 'cn' | 'intl'

export interface TencentCaptchaProof {
  ticket: string
  randstr: string
}

export interface TencentCaptchaResult {
  ret: number
  ticket?: string | null
  randstr?: string | null
  errorCode?: number
  errorMessage?: string
}

interface TencentCaptchaInstance {
  show(): void
  destroy(): void
}

type TencentCaptchaCallback = (result: TencentCaptchaResult) => void

// The constructor signatures differ between the two sites and are not interchangeable:
// - China site TJCaptcha.js: the first argument is a CaptchaAppId string (passing a DOM element uses another branch).
// - International site TJNCaptcha-global.js: the first argument must be the DOM container hosting the Robot checkbox; passing a string throws immediately
//   "The parameter of the constructor of the Captcha is passed incorrectly"。
type TencentCaptchaConstructor = {
  new (
    appId: string,
    callback: TencentCaptchaCallback,
    options?: Record<string, unknown>
  ): TencentCaptchaInstance
  new (
    element: HTMLElement,
    appId: string,
    callback: TencentCaptchaCallback,
    options?: Record<string, unknown>
  ): TencentCaptchaInstance
}

declare global {
  interface Window {
    TencentCaptcha?: TencentCaptchaConstructor
    // The international entry script sets this to true; the China site script only reads it and never writes it.
    // Used to determine which site the existing TencentCaptcha on the page belongs to.
    TCaptchaGlobal?: boolean
  }
}

const SCRIPT_SRC: Record<TencentCaptchaRegion, string> = {
  cn: 'https://turing.captcha.qcloud.com/TJCaptcha.js',
  intl: 'https://ca.turing.captcha.qcloud.com/TJNCaptcha-global.js'
}

export function normalizeTencentCaptchaRegion(value?: string | null): TencentCaptchaRegion {
  return value === 'intl' ? 'intl' : 'cn'
}

let scriptPromise: Promise<TencentCaptchaConstructor> | null = null
let loadedRegion: TencentCaptchaRegion | null = null

// existingGlobalRegion infers which site the existing global constructor on the page belongs to.
// The constructor signatures of the two sites are incompatible (the international site's first argument must be a DOM element); a mismatch throws immediately,
// so verify that the site matches before reusing an existing global.
function existingGlobalRegion(): TencentCaptchaRegion {
  return window.TCaptchaGlobal === true ? 'intl' : 'cn'
}

export function loadTencentCaptcha(
  region: TencentCaptchaRegion = 'cn'
): Promise<TencentCaptchaConstructor> {
  // Both site SDKs register the same TencentCaptcha global, so caches must be isolated by site,
  // otherwise switching sites in admin will still reuse the previous site's constructor.
  // loadedRegion being null means the global was not injected by this module (e.g. module state was reset after development HMR),
  // so use TCaptchaGlobal to determine the site and reuse it only if it matches.
  const globalRegion = window.TencentCaptcha ? existingGlobalRegion() : null
  if (window.TencentCaptcha && (loadedRegion === region || globalRegion === region)) {
    return Promise.resolve(window.TencentCaptcha)
  }
  if (window.TencentCaptcha && loadedRegion !== null && loadedRegion !== region) {
    // Both sites share the TencentCaptcha global but have incompatible constructor signatures, so a second SDK cannot be injected into the same page.
    // The deployment flow refreshes the page after an admin switches regions; failing immediately before refresh prevents contamination of the global constructor.
    return Promise.reject(new Error('Tencent Captcha region changed; reload the page to apply it'))
  }
  if (scriptPromise && loadedRegion === region) return scriptPromise

  loadedRegion = region
  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = SCRIPT_SRC[region]
    script.async = true
    script.onload = () => {
      // If the entry script is included repeatedly, Tencent throws during evaluation ("Do not include the Tencent Captcha integration JS multiple times"),
      // while onload still fires and the global remains the previous site's constructor. Verify the site to avoid
      // returning a constructor with an incompatible signature as if it belonged to the current site.
      if (window.TencentCaptcha && existingGlobalRegion() === region) {
        resolve(window.TencentCaptcha)
        return
      }
      scriptPromise = null
      loadedRegion = null
      reject(new Error('Tencent Captcha SDK is unavailable'))
    }
    script.onerror = () => {
      scriptPromise = null
      loadedRegion = null
      reject(new Error('Failed to load Tencent Captcha SDK'))
    }
    document.head.appendChild(script)
  })

  return scriptPromise
}

export function resetTencentCaptchaLoaderForTest(): void {
  scriptPromise = null
  loadedRegion = null
}
