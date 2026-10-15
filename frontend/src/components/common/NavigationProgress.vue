<script setup lang="ts">
/**
 * Navigation progress bar component
 * Displays loading progress at the top of the page to provide navigation feedback
 */
import { computed } from 'vue'
import { useNavigationLoadingState } from '@/composables/useNavigationLoading'

const { isLoading } = useNavigationLoadingState()

// Progress bar visibility
const isVisible = computed(() => isLoading.value)
</script>

<template>
  <Transition name="progress-fade">
    <div
      v-show="isVisible"
      class="navigation-progress"
      role="progressbar"
      aria-label="Loading"
      aria-valuenow="0"
      aria-valuemin="0"
      aria-valuemax="100"
    >
      <div class="navigation-progress-bar" />
    </div>
  </Transition>
</template>

<style scoped>
.navigation-progress {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  z-index: 9999;
  overflow: hidden;
  background: transparent;
}

.navigation-progress-bar {
  height: 100%;
  width: 100%;
  background: linear-gradient(
    90deg,
    transparent 0%,
    theme('colors.primary.400') 20%,
    theme('colors.primary.500') 50%,
    theme('colors.primary.400') 80%,
    transparent 100%
  );
  animation: progress-slide 1.5s ease-in-out infinite;
}

/* Progress bar color in dark mode */
:root.dark .navigation-progress-bar {
  background: linear-gradient(
    90deg,
    transparent 0%,
    theme('colors.primary.500') 20%,
    theme('colors.primary.400') 50%,
    theme('colors.primary.500') 80%,
    transparent 100%
  );
}

/* Progress bar slide animation */
@keyframes progress-slide {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(100%);
  }
}

/* Fade transition */
.progress-fade-enter-active {
  transition: opacity 0.15s ease-out;
}

.progress-fade-leave-active {
  transition: opacity 0.3s ease-out;
}

.progress-fade-enter-from,
.progress-fade-leave-to {
  opacity: 0;
}

/* Reduced motion mode */
@media (prefers-reduced-motion: reduce) {
  .navigation-progress-bar {
    animation: progress-pulse 2s ease-in-out infinite;
  }

  @keyframes progress-pulse {
    0%,
    100% {
      opacity: 0.4;
    }
    50% {
      opacity: 1;
    }
  }
}
</style>
