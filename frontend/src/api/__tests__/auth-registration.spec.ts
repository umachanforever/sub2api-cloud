import {beforeEach, describe, expect, it, vi} from 'vitest'
const post=vi.hoisted(()=>vi.fn())
vi.mock('@/api/client',()=>({apiClient:{post}}))
describe('email registration',()=>{
 beforeEach(()=>{post.mockReset();localStorage.clear()})
 it('keeps confirmation responses unauthenticated',async()=>{
  post.mockResolvedValue({data:{requires_email_verification:true}})
  const {register}=await import('@/api/auth')
  await expect(register({email:'user@example.com',password:'secret-123'})).rejects.toMatchObject({code:'email_confirmation_required'})
  expect(localStorage.getItem('auth_token')).toBeNull()
  expect(localStorage.getItem('auth_user')).toBeNull()
 })
 it('rejects malformed session responses without calling them confirmations',async()=>{
  post.mockResolvedValue({data:{}})
  const {register}=await import('@/api/auth')
  await expect(register({email:'user@example.com',password:'secret-123'})).rejects.toThrow('Invalid registration response.')
  expect(localStorage.getItem('auth_user')).toBeNull()
 })
})
