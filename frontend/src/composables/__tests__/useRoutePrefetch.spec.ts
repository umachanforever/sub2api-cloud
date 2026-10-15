/**
 * Unit tests for the useRoutePrefetch composable
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RouteLocationNormalized, Router, RouteRecordNormalized } from 'vue-router'

import { useRoutePrefetch, _adminPrefetchMap, _userPrefetchMap } from '../useRoutePrefetch'

// Mock route object
const createMockRoute = (path: string): RouteLocationNormalized => ({
  path,
  name: undefined,
  params: {},
  query: {},
  hash: '',
  fullPath: path,
  matched: [],
  meta: {},
  redirectedFrom: undefined
})

// Mock Router
const createMockRouter = (): Router => {
  const mockImportFn = vi.fn().mockResolvedValue({ default: {} })

  const routes: Partial<RouteRecordNormalized>[] = [
    { path: '/admin/dashboard', components: { default: mockImportFn } },
    { path: '/admin/accounts', components: { default: mockImportFn } },
    { path: '/admin/users', components: { default: mockImportFn } },
    { path: '/admin/groups', components: { default: mockImportFn } },
    { path: '/admin/subscriptions', components: { default: mockImportFn } },
    { path: '/admin/redeem', components: { default: mockImportFn } },
    { path: '/dashboard', components: { default: mockImportFn } },
    { path: '/keys', components: { default: mockImportFn } },
    { path: '/usage', components: { default: mockImportFn } },
    { path: '/redeem', components: { default: mockImportFn } },
    { path: '/profile', components: { default: mockImportFn } }
  ]

  return {
    getRoutes: () => routes as RouteRecordNormalized[]
  } as Router
}

describe('useRoutePrefetch', () => {
  let originalRequestIdleCallback: typeof window.requestIdleCallback
  let originalCancelIdleCallback: typeof window.cancelIdleCallback
  let mockRouter: Router

  beforeEach(() => {
    mockRouter = createMockRouter()

    // Save the original function
    originalRequestIdleCallback = window.requestIdleCallback
    originalCancelIdleCallback = window.cancelIdleCallback

    // Mock requestIdleCallback to execute immediately
    vi.stubGlobal('requestIdleCallback', (cb: IdleRequestCallback) => {
      const id = setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 0)
      return id
    })
    vi.stubGlobal('cancelIdleCallback', (id: number) => clearTimeout(id))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    // Restore the original function
    window.requestIdleCallback = originalRequestIdleCallback
    window.cancelIdleCallback = originalCancelIdleCallback
  })

  describe('_isAdminRoute', () => {
    it('应该正确识别管理员路由', () => {
      const { _isAdminRoute } = useRoutePrefetch(mockRouter)
      expect(_isAdminRoute('/admin/dashboard')).toBe(true)
      expect(_isAdminRoute('/admin/users')).toBe(true)
      expect(_isAdminRoute('/admin/accounts')).toBe(true)
    })

    it('应该正确识别非管理员路由', () => {
      const { _isAdminRoute } = useRoutePrefetch(mockRouter)
      expect(_isAdminRoute('/dashboard')).toBe(false)
      expect(_isAdminRoute('/keys')).toBe(false)
      expect(_isAdminRoute('/usage')).toBe(false)
    })
  })

  describe('_getPrefetchConfig', () => {
    it('管理员 dashboard 应该返回正确的预加载配置', () => {
      const { _getPrefetchConfig } = useRoutePrefetch(mockRouter)
      const route = createMockRoute('/admin/dashboard')
      const config = _getPrefetchConfig(route)

      expect(config).toHaveLength(2)
    })

    it('普通用户 dashboard 应该返回正确的预加载配置', () => {
      const { _getPrefetchConfig } = useRoutePrefetch(mockRouter)
      const route = createMockRoute('/dashboard')
      const config = _getPrefetchConfig(route)

      expect(config).toHaveLength(2)
    })

    it('未定义的路由应该返回空数组', () => {
      const { _getPrefetchConfig } = useRoutePrefetch(mockRouter)
      const route = createMockRoute('/unknown-route')
      const config = _getPrefetchConfig(route)

      expect(config).toHaveLength(0)
    })
  })

  describe('triggerPrefetch', () => {
    it('应该在浏览器空闲时触发预加载', async () => {
      const { triggerPrefetch, prefetchedRoutes } = useRoutePrefetch(mockRouter)
      const route = createMockRoute('/admin/dashboard')

      triggerPrefetch(route)

      // Wait for requestIdleCallback to execute
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(prefetchedRoutes.value.has('/admin/dashboard')).toBe(true)
    })

    it('应该避免重复预加载同一路由', async () => {
      const { triggerPrefetch, prefetchedRoutes } = useRoutePrefetch(mockRouter)
      const route = createMockRoute('/admin/dashboard')

      triggerPrefetch(route)
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Trigger a second time
      triggerPrefetch(route)
      await new Promise((resolve) => setTimeout(resolve, 100))

      // It should prefetch only once
      expect(prefetchedRoutes.value.size).toBe(1)
    })
  })

  describe('cancelPendingPrefetch', () => {
    it('应该取消挂起的预加载任务', () => {
      const { triggerPrefetch, cancelPendingPrefetch, prefetchedRoutes } = useRoutePrefetch(mockRouter)
      const route = createMockRoute('/admin/dashboard')

      triggerPrefetch(route)
      cancelPendingPrefetch()

      // No prefetch should have completed
      expect(prefetchedRoutes.value.size).toBe(0)
    })
  })

  describe('路由变化时取消之前的预加载', () => {
    it('应该在路由变化时取消之前的预加载任务', async () => {
      const { triggerPrefetch, prefetchedRoutes } = useRoutePrefetch(mockRouter)

      // Trigger prefetching for the first route
      triggerPrefetch(createMockRoute('/admin/dashboard'))

      // Immediately switch to another route
      triggerPrefetch(createMockRoute('/admin/users'))

      // Wait for execution
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Only the last route should be prefetched
      expect(prefetchedRoutes.value.has('/admin/users')).toBe(true)
    })
  })

  describe('resetPrefetchState', () => {
    it('应该重置所有预加载状态', async () => {
      const { triggerPrefetch, resetPrefetchState, prefetchedRoutes } = useRoutePrefetch(mockRouter)
      const route = createMockRoute('/admin/dashboard')

      triggerPrefetch(route)
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(prefetchedRoutes.value.size).toBeGreaterThan(0)

      resetPrefetchState()

      expect(prefetchedRoutes.value.size).toBe(0)
    })
  })

  describe('预加载映射表', () => {
    it('管理员预加载映射表应该包含正确的路由', () => {
      expect(_adminPrefetchMap).toHaveProperty('/admin/dashboard')
      expect(_adminPrefetchMap['/admin/dashboard']).toHaveLength(2)
    })

    it('用户预加载映射表应该包含正确的路由', () => {
      expect(_userPrefetchMap).toHaveProperty('/dashboard')
      expect(_userPrefetchMap['/dashboard']).toHaveLength(2)
    })
  })

  describe('requestIdleCallback 超时处理', () => {
    it('超时后仍能正常执行预加载', async () => {
      // Simulate a timeout
      vi.stubGlobal('requestIdleCallback', (cb: IdleRequestCallback, options?: IdleRequestOptions) => {
        const timeout = options?.timeout || 2000
        return setTimeout(() => cb({ didTimeout: true, timeRemaining: () => 0 }), timeout)
      })

      const { triggerPrefetch, prefetchedRoutes } = useRoutePrefetch(mockRouter)
      const route = createMockRoute('/dashboard')

      triggerPrefetch(route)

      // Wait for timeout execution
      await new Promise((resolve) => setTimeout(resolve, 2100))

      expect(prefetchedRoutes.value.has('/dashboard')).toBe(true)
    })
  })

  describe('预加载失败处理', () => {
    it('预加载失败时应该静默处理不影响页面功能', async () => {
      const { triggerPrefetch } = useRoutePrefetch(mockRouter)
      const route = createMockRoute('/admin/dashboard')

      // It should not throw
      expect(() => triggerPrefetch(route)).not.toThrow()
    })
  })

  describe('无 router 时的行为', () => {
    it('没有传入 router 时应该正常工作但不执行预加载', async () => {
      const { triggerPrefetch, prefetchedRoutes } = useRoutePrefetch()
      const route = createMockRoute('/admin/dashboard')

      triggerPrefetch(route)
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Without a router, the component cannot be obtained, so nothing will be prefetched
      expect(prefetchedRoutes.value.size).toBe(0)
    })
  })
})
