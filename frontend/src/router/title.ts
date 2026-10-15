import { i18n } from '@/i18n'
import type { RouteLocationNormalizedLoaded } from 'vue-router'
import type { CustomMenuItem } from '@/types'
import type { SiteBillingMode } from '@/utils/siteBillingMode'

/**
 * Generate page titles centrally to prevent conflicting document.title writes.
 * Prefer translating titleKey via i18n, falling back to the static routeTitle.
 */
export function resolveDocumentTitle(routeTitle: unknown, siteName?: string, titleKey?: string): string {
  const normalizedSiteName = typeof siteName === 'string' && siteName.trim() ? siteName.trim() : 'sub2api-cloud'

  if (typeof titleKey === 'string' && titleKey.trim()) {
    const translated = i18n.global.t(titleKey)
    if (translated && translated !== titleKey) {
      return `${translated} - ${normalizedSiteName}`
    }
  }

  if (typeof routeTitle === 'string' && routeTitle.trim()) {
    return `${routeTitle.trim()} - ${normalizedSiteName}`
  }

  return normalizedSiteName
}

export interface RouteTitleOptions {
  /**
   * Site billing mode (see utils/billingMode.ts). The /purchase title and description change accordingly:
   * Recharge only → “Recharge”; subscription only → “Subscription”; default/both → “Recharge/Subscription”.
   */
  billingMode?: SiteBillingMode
}

export interface RouteMetaKeys {
  titleKey?: string
  descriptionKey?: string
}

/** /purchase route name, kept consistent with its declaration in router/index.ts. */
export const PURCHASE_ROUTE_NAME = 'PurchaseSubscription'

/**
 * Resolve the route's i18n title/description key. Most routes read it directly from meta;
 * /purchase changes its copy based on the site billing mode, sharing this logic between AppHeader and document.title.
 */
export function resolveRouteMetaKeys(
  route: Pick<RouteLocationNormalizedLoaded, 'name' | 'meta'>,
  options: RouteTitleOptions = {},
): RouteMetaKeys {
  if (route.name === PURCHASE_ROUTE_NAME) {
    if (options.billingMode === 'recharge_only') {
      return { titleKey: 'nav.recharge', descriptionKey: 'purchase.rechargeDescription' }
    }
    if (options.billingMode === 'subscription_only') {
      return { titleKey: 'nav.subscribe', descriptionKey: 'purchase.subscriptionDescription' }
    }
  }
  return {
    titleKey: typeof route.meta.titleKey === 'string' ? route.meta.titleKey : undefined,
    descriptionKey: typeof route.meta.descriptionKey === 'string' ? route.meta.descriptionKey : undefined,
  }
}

export function resolveRouteDocumentTitle(
  route: Pick<RouteLocationNormalizedLoaded, 'name' | 'params' | 'meta'>,
  siteName: string | undefined,
  customMenuItems: CustomMenuItem[] = [],
  options: RouteTitleOptions = {},
): string {
  const id = typeof route.params.id === 'string' ? route.params.id : ''
  const menuItem = route.name === 'CustomPage' && id
    ? customMenuItems.find((item) => item.id === id)
    : undefined
  const menuTitle = menuItem?.label.trim()
  const { titleKey } = resolveRouteMetaKeys(route, options)

  return resolveDocumentTitle(menuTitle || route.meta.title, siteName, menuTitle ? undefined : titleKey)
}
