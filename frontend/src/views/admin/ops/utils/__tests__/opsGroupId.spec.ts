import { describe, expect, it } from 'vitest'
import { opsGroupId } from '../opsGroupId'

describe('operations group selection', () => {
  it('preserves UUIDs across selectors and route query strings', () => {
    const id = 'D3000000-0000-4000-8000-000000000003'
    expect(opsGroupId(id)).toBe(id.toLowerCase())
  })
  it('retains original numeric fixtures and rejects partial or unsafe identifiers', () => {
    expect(opsGroupId(7)).toBe(7)
    expect(opsGroupId('7')).toBe(7)
    for (const value of [null, '', true, 0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '123invalid', '11111111-invalid']) expect(opsGroupId(value)).toBe(null)
  })
})
