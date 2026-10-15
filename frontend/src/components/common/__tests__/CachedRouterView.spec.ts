import {describe,it,expect,vi,afterEach} from 'vitest'
import {mount,flushPromises} from '@vue/test-utils'
import {defineComponent,onMounted,ref} from 'vue'
import {createRouter,createMemoryHistory} from 'vue-router'
import CachedRouterView from '../CachedRouterView.vue'

afterEach(()=>vi.useRealTimers())
async function fixture(){
 const loads=vi.fn()
 const Page=()=>defineComponent({setup(){const value=ref('loading');onMounted(async()=>{loads();await Promise.resolve();value.value='ready'});return {value}},template:'<div>{{ value }}</div>'})
 const router=createRouter({history:createMemoryHistory(),routes:['/admin/dashboard','/admin/accounts','/login'].map(path=>({path,component:Page()}))})
 await router.push('/admin/dashboard');await router.isReady()
 const wrapper=mount(CachedRouterView,{props:{identity:'user-1',revision:0},global:{plugins:[router],stubs:{transition:true}}})
 await flushPromises();return {wrapper,router,loads}
}
describe('cached page navigation',()=>{
 it('restores loaded pages without remounting within one minute',async()=>{
  const {wrapper,router,loads}=await fixture()
  await router.push('/admin/accounts');await flushPromises()
  await router.push('/admin/dashboard');await flushPromises()
  expect(loads).toHaveBeenCalledTimes(2);expect(wrapper.text()).toBe('ready');wrapper.unmount()
 })
 it('reloads expired pages and invalidates inactive pages after writes',async()=>{
  vi.useFakeTimers();const {wrapper,router,loads}=await fixture()
  await router.push('/admin/accounts');await flushPromises()
  await wrapper.setProps({revision:1});expect(loads).toHaveBeenCalledTimes(2)
  await router.push('/admin/dashboard');await flushPromises();expect(loads).toHaveBeenCalledTimes(3)
  await router.push('/admin/accounts');await flushPromises()
  vi.advanceTimersByTime(60001)
  await router.push('/admin/dashboard');await flushPromises();expect(loads).toHaveBeenCalledTimes(4);wrapper.unmount()
 })
 it('discards retained pages when the signed-in identity changes',async()=>{
  const {wrapper,loads}=await fixture();await wrapper.setProps({identity:'user-2'});await flushPromises()
  expect(loads).toHaveBeenCalledTimes(2);wrapper.unmount()
 })
})

it('keeps different filters separate while restoring a previous query',async()=>{
 const {wrapper,router,loads}=await fixture()
 await router.push('/admin/accounts?page=1');await flushPromises()
 await router.push('/admin/accounts?page=2');await flushPromises()
 await router.push('/admin/accounts?page=1');await flushPromises()
 expect(loads).toHaveBeenCalledTimes(3);wrapper.unmount()
})

it('removes teleported dialogs and body scroll locks when retaining a hidden page',async()=>{
 const {default:BaseDialog}=await import('../BaseDialog.vue')
 const Page=defineComponent({components:{BaseDialog},setup(){return {show:ref(true)}},template:'<BaseDialog :show="show" title="Edit" @close="show=false">Form</BaseDialog>'})
 const router=createRouter({history:createMemoryHistory(),routes:[{path:'/admin/dashboard',component:Page},{path:'/admin/accounts',component:{template:'<div>Accounts</div>'}}]})
 await router.push('/admin/dashboard');await router.isReady()
 const wrapper=mount(CachedRouterView,{props:{identity:'user-1'},global:{plugins:[router],stubs:{transition:true}}});await flushPromises()
 expect(document.querySelector('[role="dialog"]')).not.toBeNull()
 await router.push('/admin/accounts');await flushPromises()
 expect(document.querySelector('[role="dialog"]')).toBeNull()
 expect(document.body.classList.contains('modal-open')).toBe(false)
 wrapper.unmount()
})
