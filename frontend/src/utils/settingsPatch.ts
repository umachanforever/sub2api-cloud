export function changedSettings<T extends object>(saved: T, current: T): Partial<T> {
  return Object.fromEntries(Object.entries(current).filter(([key, value]) =>
    JSON.stringify(value) !== JSON.stringify(saved[key as keyof T]),
  )) as Partial<T>;
}
