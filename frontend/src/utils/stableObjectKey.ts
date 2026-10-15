let globalStableObjectKeySeed = 0

/**
 * Generate a stable key for an object instance (using WeakMap without modifying business objects)
 */
export function createStableObjectKeyResolver<T extends object>(prefix = 'item') {
  const keyMap = new WeakMap<T, string>()

  return (item: T): string => {
    const cached = keyMap.get(item)
    if (cached) {
      return cached
    }

    const key = `${prefix}-${++globalStableObjectKeySeed}`
    keyMap.set(item, key)
    return key
  }
}
