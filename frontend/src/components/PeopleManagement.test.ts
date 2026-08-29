// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/services/api'
import PeopleManagement from './PeopleManagement.vue'

const apiMocks = vi.hoisted(() => ({
  listUsers: vi.fn(),
  createUser: vi.fn(),
  setUserActive: vi.fn(),
}))

vi.mock('@/services/api', async () => {
  const actual = await vi.importActual<typeof import('@/services/api')>('@/services/api')
  return { ...actual, ...apiMocks }
})

const admin = { id: 1, username: 'root', display_name: '管理员', role: 'ADMIN' as const, is_active: true }
const receiver = { id: 2, username: 'receiver', display_name: '收货员甲', role: 'RECEIVER' as const, is_active: true }

async function mountPeople() {
  apiMocks.listUsers.mockResolvedValue([admin, receiver])
  const wrapper = mount(PeopleManagement, {
    attachTo: document.body,
    props: { currentUser: admin, online: true },
  })
  await flushPromises()
  return wrapper
}

describe('PeopleManagement', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  it('validates and creates a person without rendering the submitted password', async () => {
    const wrapper = await mountPeople()
    const createToggle = wrapper.get('.primary-compact-button')
    await createToggle.trigger('click')
    await flushPromises()
    const username = wrapper.get('input[placeholder="例如 zhangsan"]')
    expect(document.activeElement).toBe(username.element)

    await username.setValue('zhangsan')
    await wrapper.get('input[placeholder="用于责任记录"]').setValue('张三')
    await wrapper.get('input[placeholder="至少 12 位，不会回显"]').setValue('abcdefghijkl')
    await wrapper.get('input[placeholder="再次确认，避免输错"]').setValue('abcdefghijkl')
    await wrapper.get('.person-create-form').trigger('submit')
    expect(wrapper.get('[role="alert"]').text()).toContain('至少 3 类')
    expect(apiMocks.createUser).not.toHaveBeenCalled()

    const overBcryptLimit = `Ab1!${'中'.repeat(23)}`
    await wrapper.get('input[placeholder="至少 12 位，不会回显"]').setValue(overBcryptLimit)
    await wrapper.get('input[placeholder="再次确认，避免输错"]').setValue(overBcryptLimit)
    await wrapper.get('.person-create-form').trigger('submit')
    expect(wrapper.get('[role="alert"]').text()).toContain('不能超过 72 字节')

    apiMocks.createUser.mockResolvedValue({ ...receiver, id: 3, username: 'zhangsan', display_name: '张三' })
    const validPassword = 'Strong-Pass-2026!'
    await wrapper.get('input[placeholder="至少 12 位，不会回显"]').setValue(validPassword)
    await wrapper.get('input[placeholder="再次确认，避免输错"]').setValue(validPassword)
    await wrapper.get('.person-create-form').trigger('submit')
    await flushPromises()

    expect(apiMocks.createUser).toHaveBeenCalledWith(expect.objectContaining({
      username: 'zhangsan',
      display_name: '张三',
      password: validPassword,
    }))
    expect(wrapper.text()).toContain('已创建 张三 的账号')
    expect(wrapper.html()).not.toContain(validPassword)
    expect(document.activeElement).toBe(wrapper.get('.primary-compact-button').element)
  })

  it('closes the create form and restores focus to its trigger', async () => {
    const wrapper = await mountPeople()
    const createToggle = wrapper.get('.primary-compact-button')
    await createToggle.trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(wrapper.get('input[placeholder="例如 zhangsan"]').element)

    await wrapper.get('.primary-compact-button').trigger('click')
    await flushPromises()
    expect(wrapper.find('.person-create-form').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.get('.primary-compact-button').element)
  })

  it('confirms enable/disable, keeps a failed dialog open, and returns focus to its trigger', async () => {
    const wrapper = await mountPeople()
    const toggle = wrapper.findAll('.person-toggle').find((button) => !(button.element as HTMLButtonElement).disabled)
    expect(toggle).toBeTruthy()
    await toggle!.trigger('click')
    await flushPromises()

    expect(wrapper.get('[role="dialog"]').text()).toContain('停用这个账号')
    expect(document.activeElement).toBe(wrapper.get('[role="dialog"]').element)
    await wrapper.findAll('.dialog-actions button')[0]!.trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(document.activeElement).toBe(toggle!.element)

    apiMocks.setUserActive
      .mockRejectedValueOnce(new ApiError(500, '服务器繁忙，请稍后再试'))
      .mockResolvedValueOnce({ ...receiver, is_active: false })
    await toggle!.trigger('click')
    await wrapper.get('.dialog-actions .confirm').trigger('click')
    await flushPromises()

    expect(wrapper.get('[role="dialog"]').text()).toContain('服务器繁忙，请稍后再试')
    expect(document.activeElement).toBe(wrapper.get('[role="dialog"]').element)
    expect(apiMocks.setUserActive).toHaveBeenLastCalledWith(2, false)

    await wrapper.get('.dialog-actions .confirm').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('收货员甲 已停用')
    expect(document.activeElement).toBe(toggle!.element)
  })
})
