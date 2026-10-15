import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ post: vi.fn(), setAuthToken: vi.fn(), setRefreshToken: vi.fn(), setTokenExpiresAt: vi.fn() }))
vi.mock('../client', () => ({ apiClient: { post: mocks.post } }))
vi.mock('../auth', () => ({ setAuthToken: mocks.setAuthToken, setRefreshToken: mocks.setRefreshToken, setTokenExpiresAt: mocks.setTokenExpiresAt }))
import { disable, enable, stepUp } from '../totp'
beforeEach(() => vi.resetAllMocks())
describe('native MFA session adoption', () => {
  it.each([
    ['enable', () => enable({ setup_token: 'factor', totp_code: '123456' })],
    ['disable', () => disable({ password: 'old-password', totp_code: '123456' })],
    ['step-up', () => stepUp('123456')]
  ] as const)('persists native tokens after %s so later requests use the new assurance level', async (_name, action) => {
    mocks.post.mockResolvedValue({ data: { success: true, verified: true, access_token: 'native-jwt', refresh_token: 'native-refresh', expires_in: 3600 } })
    await action()
    expect(mocks.setAuthToken).toHaveBeenCalledWith('native-jwt')
    expect(mocks.setRefreshToken).toHaveBeenCalledWith('native-refresh')
    expect(mocks.setTokenExpiresAt).toHaveBeenCalledWith(3600)
  })
  it('keeps existing tokens if verification fails', async () => {
    mocks.post.mockRejectedValue(new Error('invalid code'))
    await expect(stepUp('123456')).rejects.toThrow('invalid code')
    expect(mocks.setAuthToken).not.toHaveBeenCalled()
    expect(mocks.setRefreshToken).not.toHaveBeenCalled()
  })
})
