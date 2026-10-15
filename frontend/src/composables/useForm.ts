import { ref } from 'vue'
import { useAppStore } from '@/stores/app'

interface UseFormOptions<T> {
  form: T
  submitFn: (data: T) => Promise<void>
  successMsg?: string
  errorMsg?: string
}

/**
 * Unified form submission logic
 * Manages loading state, error handling, and notifications
 */
export function useForm<T>(options: UseFormOptions<T>) {
  const { form, submitFn, successMsg, errorMsg } = options
  const loading = ref(false)
  const appStore = useAppStore()

  const submit = async () => {
    if (loading.value) return
    
    loading.value = true
    try {
      await submitFn(form)
      if (successMsg) {
        appStore.showSuccess(successMsg)
      }
    } catch (error: any) {
      const detail = error.response?.data?.detail || error.response?.data?.message || error.message
      appStore.showError(errorMsg || detail)
      // Rethrow the error so the component can handle it locally (e.g., display validation errors)
      throw error
    } finally {
      loading.value = false
    }
  }

  return {
    loading,
    submit
  }
}
