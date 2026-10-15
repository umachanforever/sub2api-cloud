import {beforeEach,describe,expect,it,vi} from 'vitest'
const {post}=vi.hoisted(()=>({post:vi.fn()}))
vi.mock('@/api/client',()=>({apiClient:{post}}))
import {resetOpenAIQuota} from '@/api/admin/accounts'

describe('quota reset retry keys',()=>{
 beforeEach(()=>{post.mockReset();localStorage.clear()})
 it('preserves the key through a timeout and clears it only after a known result',async()=>{
  post.mockRejectedValueOnce(new Error('timeout'))
  await expect(resetOpenAIQuota(7)).rejects.toThrow('timeout')
  const key=post.mock.calls[0][2].headers['Idempotency-Key']
  expect(localStorage.getItem('sub2api-supabase:quota-reset:7')).toBe(key)
  post.mockResolvedValueOnce({data:{code:'success',windows_reset:1}})
  await expect(resetOpenAIQuota(7)).resolves.toMatchObject({code:'success'})
  expect(post.mock.calls[1][2]).toEqual({timeout:90000,headers:{'Idempotency-Key':key}})
  expect(localStorage.getItem('sub2api-supabase:quota-reset:7')).toBeNull()
  post.mockResolvedValueOnce({data:{code:'success',windows_reset:1}})
  await resetOpenAIQuota(7)
  expect(post.mock.calls[2][2].headers['Idempotency-Key']).not.toBe(key)
 })
 it('returns the known result when storage cleanup fails after consumption',async()=>{
  post.mockResolvedValueOnce({data:{code:'success',windows_reset:1}})
  const spy=vi.spyOn(Storage.prototype,'removeItem').mockImplementation(()=>{throw new Error('storage unavailable')})
  try {await expect(resetOpenAIQuota(7)).resolves.toMatchObject({code:'success'});expect(localStorage.getItem('sub2api-supabase:quota-reset:7')).toBeTruthy()}
  finally {spy.mockRestore()}
 })
 it('refuses to consume a credit if the browser cannot retain the retry key',async()=>{
  const spy=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('storage unavailable')})
  try {await expect(resetOpenAIQuota(7)).rejects.toThrow('storage unavailable');expect(post).not.toHaveBeenCalled()}
  finally {spy.mockRestore()}
 })
})
