/**
 * Navigation loading state composable
 * Manages loading state during route changes with anti-flicker logic
 */
import { ref, readonly, computed } from 'vue'

/**
 * Navigation loading state management
 *
 * Features:
 * 1. Show the loading state during route changes
 * 2. Do not show the loading indicator for fast navigation (< 100ms) to prevent flicker
 * 3. Reset state correctly when navigation is canceled
 */
export function useNavigationLoading() {
  // Internal loading state
  const _isLoading = ref(false)

  // Navigation start time (used for anti-flicker calculation)
  let navigationStartTime: number | null = null

  // Anti-flicker delay timer
  let showLoadingTimer: ReturnType<typeof setTimeout> | null = null

  // Whether the loading indicator should be shown (accounting for anti-flicker logic)
  const shouldShowLoading = ref(false)

  // Anti-flicker delay (milliseconds)
  const ANTI_FLICKER_DELAY = 100

  /**
   * Clear the timer
   */
  const clearTimer = (): void => {
    if (showLoadingTimer !== null) {
      clearTimeout(showLoadingTimer)
      showLoadingTimer = null
    }
  }

  /**
   * Called when navigation starts
   */
  const startNavigation = (): void => {
    navigationStartTime = Date.now()
    _isLoading.value = true

    // Delay showing the loading indicator to prevent flicker
    clearTimer()
    showLoadingTimer = setTimeout(() => {
      if (_isLoading.value) {
        shouldShowLoading.value = true
      }
    }, ANTI_FLICKER_DELAY)
  }

  /**
   * Called when navigation ends
   */
  const endNavigation = (): void => {
    clearTimer()
    _isLoading.value = false
    shouldShowLoading.value = false
    navigationStartTime = null
  }

  /**
   * Called when navigation is canceled (e.g., rapidly clicking different links)
   */
  const cancelNavigation = (): void => {
    clearTimer()
    // Preserve the loading state because new navigation will start immediately
    // But reset the navigation start time
    navigationStartTime = null
  }

  /**
   * Reset all state (for testing)
   */
  const resetState = (): void => {
    clearTimer()
    _isLoading.value = false
    shouldShowLoading.value = false
    navigationStartTime = null
  }

  /**
   * Get navigation duration (milliseconds)
   */
  const getNavigationDuration = (): number | null => {
    if (navigationStartTime === null) {
      return null
    }
    return Date.now() - navigationStartTime
  }

  // Public loading state (read-only)
  const isLoading = computed(() => shouldShowLoading.value)

  // Internal loading state (for testing, without anti-flicker logic)
  const isNavigating = readonly(_isLoading)

  return {
    isLoading,
    isNavigating,
    startNavigation,
    endNavigation,
    cancelNavigation,
    resetState,
    getNavigationDuration,
    // Export the constant for testing
    ANTI_FLICKER_DELAY
  }
}

// Create a singleton instance for global use
let navigationLoadingInstance: ReturnType<typeof useNavigationLoading> | null = null

export function useNavigationLoadingState() {
  if (!navigationLoadingInstance) {
    navigationLoadingInstance = useNavigationLoading()
  }
  return navigationLoadingInstance
}

// Export the reset function (for testing)
export function _resetNavigationLoadingInstance(): void {
  if (navigationLoadingInstance) {
    navigationLoadingInstance.resetState()
  }
  navigationLoadingInstance = null
}
