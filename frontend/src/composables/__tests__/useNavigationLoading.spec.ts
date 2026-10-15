/**
 * Unit tests for the useNavigationLoading composable
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  useNavigationLoading,
  _resetNavigationLoadingInstance
} from '../useNavigationLoading'

describe('useNavigationLoading', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    _resetNavigationLoadingInstance()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('startNavigation', () => {
    it('导航开始时 isNavigating 应变为 true', () => {
      const { isNavigating, startNavigation } = useNavigationLoading()

      expect(isNavigating.value).toBe(false)

      startNavigation()

      expect(isNavigating.value).toBe(true)
    })

    it('导航开始后延迟显示加载指示器（防闪烁）', () => {
      const { isLoading, startNavigation, ANTI_FLICKER_DELAY } = useNavigationLoading()

      startNavigation()

      // Check immediately; it should not be visible
      expect(isLoading.value).toBe(false)

      // It should be visible after the anti-flicker delay
      vi.advanceTimersByTime(ANTI_FLICKER_DELAY)
      expect(isLoading.value).toBe(true)
    })
  })

  describe('endNavigation', () => {
    it('导航结束时 isLoading 应变为 false', () => {
      const { isLoading, startNavigation, endNavigation, ANTI_FLICKER_DELAY } = useNavigationLoading()

      startNavigation()
      vi.advanceTimersByTime(ANTI_FLICKER_DELAY)
      expect(isLoading.value).toBe(true)

      endNavigation()
      expect(isLoading.value).toBe(false)
    })

    it('导航结束时 isNavigating 应变为 false', () => {
      const { isNavigating, startNavigation, endNavigation } = useNavigationLoading()

      startNavigation()
      expect(isNavigating.value).toBe(true)

      endNavigation()
      expect(isNavigating.value).toBe(false)
    })
  })

  describe('快速导航（< 100ms）防闪烁', () => {
    it('快速导航不应触发显示加载指示器', () => {
      const { isLoading, startNavigation, endNavigation, ANTI_FLICKER_DELAY } = useNavigationLoading()

      startNavigation()

      // End navigation before the anti-flicker delay
      vi.advanceTimersByTime(ANTI_FLICKER_DELAY - 50)
      endNavigation()

      // The loading indicator should not be visible
      expect(isLoading.value).toBe(false)

      // It should remain hidden even after waiting longer
      vi.advanceTimersByTime(100)
      expect(isLoading.value).toBe(false)
    })
  })

  describe('cancelNavigation', () => {
    it('导航取消时应正确重置状态', () => {
      const { isLoading, startNavigation, cancelNavigation, ANTI_FLICKER_DELAY } = useNavigationLoading()

      startNavigation()
      vi.advanceTimersByTime(ANTI_FLICKER_DELAY / 2)

      cancelNavigation()

      // Display should not be triggered after cancellation
      vi.advanceTimersByTime(ANTI_FLICKER_DELAY)
      expect(isLoading.value).toBe(false)
    })
  })

  describe('getNavigationDuration', () => {
    it('应该返回正确的导航持续时间', () => {
      const { startNavigation, getNavigationDuration } = useNavigationLoading()

      expect(getNavigationDuration()).toBeNull()

      startNavigation()
      vi.advanceTimersByTime(500)

      const duration = getNavigationDuration()
      expect(duration).toBe(500)
    })

    it('导航结束后应返回 null', () => {
      const { startNavigation, endNavigation, getNavigationDuration } = useNavigationLoading()

      startNavigation()
      vi.advanceTimersByTime(500)
      endNavigation()

      expect(getNavigationDuration()).toBeNull()
    })
  })

  describe('resetState', () => {
    it('应该重置所有状态', () => {
      const { isLoading, isNavigating, startNavigation, resetState, ANTI_FLICKER_DELAY } = useNavigationLoading()

      startNavigation()
      vi.advanceTimersByTime(ANTI_FLICKER_DELAY)

      expect(isLoading.value).toBe(true)
      expect(isNavigating.value).toBe(true)

      resetState()

      expect(isLoading.value).toBe(false)
      expect(isNavigating.value).toBe(false)
    })
  })

  describe('连续导航场景', () => {
    it('连续快速导航应正确处理状态', () => {
      const { isLoading, startNavigation, cancelNavigation, endNavigation, ANTI_FLICKER_DELAY } = useNavigationLoading()

      // First navigation
      startNavigation()
      vi.advanceTimersByTime(30)

      // Second navigation (cancels the first)
      cancelNavigation()
      startNavigation()
      vi.advanceTimersByTime(30)

      // Third navigation (cancels the second)
      cancelNavigation()
      startNavigation()

      // Wait long enough this time
      vi.advanceTimersByTime(ANTI_FLICKER_DELAY)
      expect(isLoading.value).toBe(true)

      // End navigation
      endNavigation()
      expect(isLoading.value).toBe(false)
    })
  })

  describe('ANTI_FLICKER_DELAY 常量', () => {
    it('应该为 100ms', () => {
      const { ANTI_FLICKER_DELAY } = useNavigationLoading()
      expect(ANTI_FLICKER_DELAY).toBe(100)
    })
  })
})
