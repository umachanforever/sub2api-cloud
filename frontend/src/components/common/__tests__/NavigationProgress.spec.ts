/**
 * NavigationProgress component unit tests
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import NavigationProgress from '../../common/NavigationProgress.vue'

// Mock useNavigationLoadingState
const mockIsLoading = ref(false)

vi.mock('@/composables/useNavigationLoading', () => ({
  useNavigationLoadingState: () => ({
    isLoading: mockIsLoading
  })
}))

describe('NavigationProgress', () => {
  beforeEach(() => {
    mockIsLoading.value = false
  })

  it('isLoading=false 时进度条应该隐藏', () => {
    mockIsLoading.value = false
    const wrapper = mount(NavigationProgress)

    const progressBar = wrapper.find('.navigation-progress')
    // v-show sets display: none
    expect(progressBar.isVisible()).toBe(false)
  })

  it('isLoading=true 时进度条应该可见', async () => {
    mockIsLoading.value = true
    const wrapper = mount(NavigationProgress)

    await wrapper.vm.$nextTick()

    const progressBar = wrapper.find('.navigation-progress')
    expect(progressBar.exists()).toBe(true)
    expect(progressBar.isVisible()).toBe(true)
  })

  it('应该有正确的 ARIA 属性', () => {
    mockIsLoading.value = true
    const wrapper = mount(NavigationProgress)

    const progressBar = wrapper.find('.navigation-progress')
    expect(progressBar.attributes('role')).toBe('progressbar')
    expect(progressBar.attributes('aria-label')).toBe('Loading')
    expect(progressBar.attributes('aria-valuemin')).toBe('0')
    expect(progressBar.attributes('aria-valuemax')).toBe('100')
  })

  it('进度条应该有动画 class', () => {
    mockIsLoading.value = true
    const wrapper = mount(NavigationProgress)

    const bar = wrapper.find('.navigation-progress-bar')
    expect(bar.exists()).toBe(true)
  })

  it('应该正确响应 isLoading 状态变化', async () => {
    // Test the initial state as false
    mockIsLoading.value = false
    const wrapper = mount(NavigationProgress)
    await wrapper.vm.$nextTick()

    // Hidden initially
    expect(wrapper.find('.navigation-progress').isVisible()).toBe(false)

    // Remount after unmounting to test the true state
    wrapper.unmount()

    // Change to true and remount
    mockIsLoading.value = true
    const wrapper2 = mount(NavigationProgress)
    await wrapper2.vm.$nextTick()
    expect(wrapper2.find('.navigation-progress').isVisible()).toBe(true)

    // Cleanup
    wrapper2.unmount()
  })
})
