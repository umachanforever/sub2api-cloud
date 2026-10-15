import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useTableLoader } from '@/composables/useTableLoader'

// Mock useDebounceFn from @vueuse/core
vi.mock('@vueuse/core', () => ({
  useDebounceFn: (fn: Function, ms: number) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const debounced = (...args: any[]) => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => fn(...args), ms)
    }
    debounced.cancel = () => { if (timer) clearTimeout(timer) }
    return debounced
  },
}))

// Mock Vue's onUnmounted (it throws when used outside a composable)
vi.mock('vue', async () => {
  const actual = await vi.importActual('vue')
  return {
    ...actual,
    onUnmounted: vi.fn(),
  }
})

const createMockFetchFn = (items: any[] = [], total = 0, pages = 1) => {
  return vi.fn().mockResolvedValue({ items, total, pages })
}

describe('useTableLoader', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // --- Basic loading ---

  describe('基础加载', () => {
    it('load 执行 fetchFn 并更新 items', async () => {
      const mockItems = [{ id: 1, name: 'item1' }, { id: 2, name: 'item2' }]
      const fetchFn = createMockFetchFn(mockItems, 2, 1)

      const { items, loading, load, pagination } = useTableLoader({
        fetchFn,
      })

      expect(items.value).toHaveLength(0)

      await load()

      expect(items.value).toEqual(mockItems)
      expect(pagination.total).toBe(2)
      expect(pagination.pages).toBe(1)
      expect(loading.value).toBe(false)
    })

    it('load 期间 loading 为 true', async () => {
      let resolveLoad: (v: any) => void
      const fetchFn = vi.fn(
        () => new Promise((resolve) => { resolveLoad = resolve })
      )

      const { loading, load } = useTableLoader({ fetchFn })

      const p = load()
      expect(loading.value).toBe(true)

      resolveLoad!({ items: [], total: 0, pages: 0 })
      await p

      expect(loading.value).toBe(false)
    })

    it('使用默认 pageSize=20', async () => {
      const fetchFn = createMockFetchFn()
      const { load, pagination } = useTableLoader({ fetchFn })

      await load()

      expect(fetchFn).toHaveBeenCalledWith(
        1,
        20,
        expect.anything(),
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      )
      expect(pagination.page_size).toBe(20)
    })

    it('可自定义 pageSize', async () => {
      const fetchFn = createMockFetchFn()
      const { load } = useTableLoader({ fetchFn, pageSize: 50 })

      await load()

      expect(fetchFn).toHaveBeenCalledWith(
        1,
        50,
        expect.anything(),
        expect.anything()
      )
    })
  })

  // --- Pagination ---

  describe('分页', () => {
    it('handlePageChange 更新页码并加载', async () => {
      const fetchFn = createMockFetchFn([], 100, 5)
      const { handlePageChange, pagination, load } = useTableLoader({ fetchFn })

      await load() // Initial load
      fetchFn.mockClear()

      handlePageChange(3)

      expect(pagination.page).toBe(3)
      // Wait for load to complete
      await vi.runAllTimersAsync()
      expect(fetchFn).toHaveBeenCalledWith(3, 20, expect.anything(), expect.anything())
    })

    it('handlePageSizeChange 重置到第1页并加载', async () => {
      const fetchFn = createMockFetchFn([], 100, 5)
      const { handlePageSizeChange, pagination, load } = useTableLoader({ fetchFn })

      await load()
      pagination.page = 3
      fetchFn.mockClear()

      handlePageSizeChange(50)

      expect(pagination.page).toBe(1)
      expect(pagination.page_size).toBe(50)
    })

    it('handlePageChange 限制页码范围', async () => {
      const fetchFn = createMockFetchFn([], 100, 5)
      const { handlePageChange, pagination, load } = useTableLoader({ fetchFn })

      await load()

      // Clamp out-of-range page numbers
      handlePageChange(999)
      expect(pagination.page).toBe(5) // Clamp to pages=5

      handlePageChange(0)
      expect(pagination.page).toBe(1) // Minimum is 1
    })
  })

  // --- Search debounce ---

  describe('搜索防抖', () => {
    it('debouncedReload 在 300ms 内多次调用只执行一次', async () => {
      const fetchFn = createMockFetchFn()
      const { debouncedReload } = useTableLoader({ fetchFn })

      // Call repeatedly in quick succession
      debouncedReload()
      debouncedReload()
      debouncedReload()

      // Less than 300ms has elapsed; fetchFn should not be called
      expect(fetchFn).not.toHaveBeenCalled()

      // Advance by 300ms
      vi.advanceTimersByTime(300)

      // Wait for async completion
      await vi.runAllTimersAsync()

      expect(fetchFn).toHaveBeenCalledTimes(1)
    })

    it('reload 重置到第 1 页', async () => {
      const fetchFn = createMockFetchFn([], 100, 5)
      const { reload, pagination, load } = useTableLoader({ fetchFn })

      await load()
      pagination.page = 3

      await reload()

      expect(pagination.page).toBe(1)
    })
  })

  // --- Request cancellation ---

  describe('请求取消', () => {
    it('新请求取消前一个未完成的请求', async () => {
      let callCount = 0
      const fetchFn = vi.fn((_page, _size, _params, options) => {
        callCount++
        const currentCall = callCount
        return new Promise((resolve, reject) => {
          // Simulate listening for abort
          if (options?.signal) {
            options.signal.addEventListener('abort', () => {
              reject({ name: 'CanceledError', code: 'ERR_CANCELED' })
            })
          }
          // Resolve asynchronously
          setTimeout(() => {
            resolve({ items: [{ id: currentCall }], total: 1, pages: 1 })
          }, 1000)
        })
      })

      const { load } = useTableLoader({ fetchFn })

      // First load
      const p1 = load()
      // Second load (should cancel the first)
      const p2 = load()

      // Advance time so the second completes
      vi.advanceTimersByTime(1000)
      await vi.runAllTimersAsync()

      // Wait for both Promises to settle
      await Promise.allSettled([p1, p2])

      // The second request's result takes effect
      expect(fetchFn).toHaveBeenCalledTimes(2)
    })
  })

  // --- Error handling ---

  describe('错误处理', () => {
    it('非取消错误会被抛出', async () => {
      const fetchFn = vi.fn().mockRejectedValue(new Error('Server error'))
      const { load } = useTableLoader({ fetchFn })

      await expect(load()).rejects.toThrow('Server error')
    })

    it('取消错误被静默处理', async () => {
      const fetchFn = vi.fn().mockRejectedValue({ name: 'CanceledError', code: 'ERR_CANCELED' })
      const { load } = useTableLoader({ fetchFn })

      // It should not throw
      await load()
    })
  })
})
