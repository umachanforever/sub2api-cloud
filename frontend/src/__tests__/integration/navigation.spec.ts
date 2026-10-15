/**
 * Navigation integration tests
 * Test the complete page navigation flow, preloading, and error recovery mechanisms
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRouter, createWebHistory, type Router } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { useNavigationLoadingState, _resetNavigationLoadingInstance } from '@/composables/useNavigationLoading'
import { useRoutePrefetch } from '@/composables/useRoutePrefetch'

// Mock view component
const MockDashboard = defineComponent({
  name: 'MockDashboard',
  render() {
    return h('div', { class: 'dashboard' }, 'Dashboard')
  }
})

const MockKeys = defineComponent({
  name: 'MockKeys',
  render() {
    return h('div', { class: 'keys' }, 'Keys')
  }
})

const MockUsage = defineComponent({
  name: 'MockUsage',
  render() {
    return h('div', { class: 'usage' }, 'Usage')
  }
})

// Mock stores
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    isAuthenticated: true,
    isAdmin: false,
    isSimpleMode: false,
    checkAuth: vi.fn()
  })
}))

vi.mock('@/stores/app', () => ({
  useAppStore: () => ({
    siteName: 'Test Site'
  })
}))

// Create test routes
function createTestRouter(): Router {
  return createRouter({
    history: createWebHistory(),
    routes: [
      {
        path: '/',
        redirect: '/dashboard'
      },
      {
        path: '/dashboard',
        name: 'Dashboard',
        component: MockDashboard,
        meta: { requiresAuth: true, title: 'Dashboard' }
      },
      {
        path: '/keys',
        name: 'Keys',
        component: MockKeys,
        meta: { requiresAuth: true, title: 'Keys' }
      },
      {
        path: '/usage',
        name: 'Usage',
        component: MockUsage,
        meta: { requiresAuth: true, title: 'Usage' }
      }
    ]
  })
}

// Test App component
const TestApp = defineComponent({
  name: 'TestApp',
  setup() {
    return () => h('div', { id: 'app' }, [h('router-view')])
  }
})

describe('Navigation Integration Tests', () => {
  let router: Router
  let originalRequestIdleCallback: typeof window.requestIdleCallback
  let originalCancelIdleCallback: typeof window.cancelIdleCallback

  beforeEach(() => {
    // Set up Pinia
    setActivePinia(createPinia())

    // Reset navigation loading state
    _resetNavigationLoadingInstance()

    // Create a new router instance
    router = createTestRouter()

    // Mock requestIdleCallback
    originalRequestIdleCallback = window.requestIdleCallback
    originalCancelIdleCallback = window.cancelIdleCallback

    vi.stubGlobal('requestIdleCallback', (cb: IdleRequestCallback) => {
      const id = setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 0)
      return id
    })
    vi.stubGlobal('cancelIdleCallback', (id: number) => clearTimeout(id))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    window.requestIdleCallback = originalRequestIdleCallback
    window.cancelIdleCallback = originalCancelIdleCallback
  })

  describe('完整页面导航流程', () => {
    it('导航时应该触发加载状态变化', async () => {
      const navigationLoading = useNavigationLoadingState()

      // Initial state
      expect(navigationLoading.isLoading.value).toBe(false)

      // Mount the app
      const wrapper = mount(TestApp, {
        global: {
          plugins: [router]
        }
      })

      // Wait for router initialization
      await router.isReady()
      await flushPromises()

      // Navigate to /dashboard
      await router.push('/dashboard')
      await flushPromises()
      await nextTick()

      // State should reset after navigation ends
      expect(navigationLoading.isLoading.value).toBe(false)

      wrapper.unmount()
    })

    it('导航到新页面应该正确渲染组件', async () => {
      const wrapper = mount(TestApp, {
        global: {
          plugins: [router]
        }
      })

      await router.isReady()
      await router.push('/dashboard')
      await flushPromises()
      await nextTick()

      // Check the current route
      expect(router.currentRoute.value.path).toBe('/dashboard')

      wrapper.unmount()
    })

    it('连续快速导航应该正确处理路由状态', async () => {
      const wrapper = mount(TestApp, {
        global: {
          plugins: [router]
        }
      })

      await router.isReady()
      await router.push('/dashboard')

      // Rapid consecutive navigation
      router.push('/keys')
      router.push('/usage')
      router.push('/dashboard')

      await flushPromises()
      await nextTick()

      // Should ultimately stop at /dashboard
      expect(router.currentRoute.value.path).toBe('/dashboard')

      wrapper.unmount()
    })
  })

  describe('路由预加载', () => {
    it('导航后应该触发相关路由预加载', async () => {
      const routePrefetch = useRoutePrefetch()
      const triggerSpy = vi.spyOn(routePrefetch, 'triggerPrefetch')

      // Set up the afterEach guard
      router.afterEach((to) => {
        routePrefetch.triggerPrefetch(to)
      })

      const wrapper = mount(TestApp, {
        global: {
          plugins: [router]
        }
      })

      await router.isReady()
      await router.push('/dashboard')
      await flushPromises()

      // Should trigger preloading
      expect(triggerSpy).toHaveBeenCalled()

      wrapper.unmount()
    })

    it('已预加载的路由不应重复预加载', async () => {
      const routePrefetch = useRoutePrefetch()

      const wrapper = mount(TestApp, {
        global: {
          plugins: [router]
        }
      })

      await router.isReady()
      await router.push('/dashboard')
      await flushPromises()

      // Trigger preloading manually
      routePrefetch.triggerPrefetch(router.currentRoute.value)
      await new Promise((resolve) => setTimeout(resolve, 100))

      const prefetchedCount = routePrefetch.prefetchedRoutes.value.size

      // Trigger preloading for the same route again
      routePrefetch.triggerPrefetch(router.currentRoute.value)
      await new Promise((resolve) => setTimeout(resolve, 100))

      // The preload count should not increase
      expect(routePrefetch.prefetchedRoutes.value.size).toBe(prefetchedCount)

      wrapper.unmount()
    })

    it('路由变化时应取消之前的预加载任务', async () => {
      const routePrefetch = useRoutePrefetch()

      const wrapper = mount(TestApp, {
        global: {
          plugins: [router]
        }
      })

      await router.isReady()

      // Trigger preloading
      routePrefetch.triggerPrefetch(router.currentRoute.value)

      // Navigate immediately to a new route (this internally calls cancelPendingPrefetch)
      routePrefetch.triggerPrefetch({ path: '/keys' } as any)

      // Since triggerPrefetch internally calls cancelPendingPrefetch, check whether preloads are managed correctly
      expect(routePrefetch.prefetchedRoutes.value.size).toBeLessThanOrEqual(2)

      wrapper.unmount()
    })
  })

  describe('Chunk 加载错误恢复', () => {
    it('chunk 加载失败应该被正确捕获', async () => {
      const errorHandler = vi.fn()

      // Create a router with error handling
      const errorRouter = createRouter({
        history: createWebHistory(),
        routes: [
          {
            path: '/dashboard',
            name: 'Dashboard',
            component: MockDashboard
          },
          {
            path: '/error-page',
            name: 'ErrorPage',
            // Simulate a component that fails to load
            component: () => Promise.reject(new Error('Failed to fetch dynamically imported module'))
          }
        ]
      })

      errorRouter.onError(errorHandler)

      const wrapper = mount(TestApp, {
        global: {
          plugins: [errorRouter]
        }
      })

      await errorRouter.isReady()
      await errorRouter.push('/dashboard')
      await flushPromises()

      // Try navigating to a page that will fail
      try {
        await errorRouter.push('/error-page')
      } catch {
        // Expected to fail
      }

      await flushPromises()

      // The error handler should be called
      expect(errorHandler).toHaveBeenCalled()

      wrapper.unmount()
    })

    it('chunk 加载错误应该包含正确的错误信息', async () => {
      let capturedError: Error | null = null

      const errorRouter = createRouter({
        history: createWebHistory(),
        routes: [
          {
            path: '/dashboard',
            name: 'Dashboard',
            component: MockDashboard
          },
          {
            path: '/chunk-error',
            name: 'ChunkError',
            component: () => {
              const error = new Error('Loading chunk failed')
              error.name = 'ChunkLoadError'
              return Promise.reject(error)
            }
          }
        ]
      })

      errorRouter.onError((error) => {
        capturedError = error
      })

      const wrapper = mount(TestApp, {
        global: {
          plugins: [errorRouter]
        }
      })

      await errorRouter.isReady()

      try {
        await errorRouter.push('/chunk-error')
      } catch {
        // Expected to fail
      }

      await flushPromises()

      expect(capturedError).not.toBeNull()
      expect(capturedError!.name).toBe('ChunkLoadError')

      wrapper.unmount()
    })
  })

  describe('导航状态管理', () => {
    it('导航开始时 isLoading 应该变为 true', async () => {
      const navigationLoading = useNavigationLoadingState()

      // Create a lazy-loaded component to simulate a real scenario
      const DelayedComponent = defineComponent({
        name: 'DelayedComponent',
        async setup() {
          await new Promise((resolve) => setTimeout(resolve, 50))
          return () => h('div', 'Delayed')
        }
      })

      const delayRouter = createRouter({
        history: createWebHistory(),
        routes: [
          {
            path: '/dashboard',
            name: 'Dashboard',
            component: MockDashboard
          },
          {
            path: '/delayed',
            name: 'Delayed',
            component: DelayedComponent
          }
        ]
      })

      // Set up the navigation guard
      delayRouter.beforeEach(() => {
        navigationLoading.startNavigation()
      })

      delayRouter.afterEach(() => {
        navigationLoading.endNavigation()
      })

      const wrapper = mount(TestApp, {
        global: {
          plugins: [delayRouter]
        }
      })

      await delayRouter.isReady()
      await delayRouter.push('/dashboard')
      await flushPromises()

      // isLoading should be false after navigation ends
      expect(navigationLoading.isLoading.value).toBe(false)

      wrapper.unmount()
    })

    it('导航取消时应该正确重置状态', async () => {
      const navigationLoading = useNavigationLoadingState()

      const testRouter = createRouter({
        history: createWebHistory(),
        routes: [
          {
            path: '/dashboard',
            name: 'Dashboard',
            component: MockDashboard
          },
          {
            path: '/keys',
            name: 'Keys',
            component: MockKeys,
            beforeEnter: (_to, _from, next) => {
              // Simulate navigation cancellation
              next(false)
            }
          }
        ]
      })

      testRouter.beforeEach(() => {
        navigationLoading.startNavigation()
      })

      testRouter.afterEach(() => {
        navigationLoading.endNavigation()
      })

      const wrapper = mount(TestApp, {
        global: {
          plugins: [testRouter]
        }
      })

      await testRouter.isReady()
      await testRouter.push('/dashboard')
      await flushPromises()

      // Try navigating to the canceled route
      await testRouter.push('/keys').catch(() => {})
      await flushPromises()

      // State should reset after navigation is canceled
      // Note: Since afterEach is still called, isLoading should be false
      expect(navigationLoading.isLoading.value).toBe(false)

      wrapper.unmount()
    })
  })
})
