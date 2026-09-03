// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({ changePassword: vi.fn() }))
vi.mock('@/services/api', async () => {
  const actual = await vi.importActual<typeof import('@/services/api')>('@/services/api')
  return { ...actual, ...apiMocks }
})

import ChangePassword from './ChangePassword.vue'

describe('ChangePassword', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  it('validates and submits the current and new password without rendering values', async () => {
    apiMocks.changePassword.mockResolvedValue(undefined)
    const wrapper = mount(ChangePassword, { attachTo: document.body, props: { online: true } })
    await wrapper.get('.header-action-button').trigger('click')
    await flushPromises()
    const inputs = wrapper.findAll('input')
    await inputs[0]!.setValue('old-password')
    await inputs[1]!.setValue('abcdefghijkl')
    await inputs[2]!.setValue('abcdefghijkl')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.get('[role="alert"]').text()).toContain('至少 3 类')
    expect(apiMocks.changePassword).not.toHaveBeenCalled()

    const next = 'New-Receiver-2026!'
    await inputs[1]!.setValue(next)
    await inputs[2]!.setValue(next)
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(apiMocks.changePassword).toHaveBeenCalledWith('old-password', next)
    expect(wrapper.text()).toContain('密码已更新')
    expect(wrapper.html()).not.toContain(next)
  })

  it('does not open while offline', async () => {
    const wrapper = mount(ChangePassword, { props: { online: false } })
    await wrapper.get('.header-action-button').trigger('click')
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
  })
})
