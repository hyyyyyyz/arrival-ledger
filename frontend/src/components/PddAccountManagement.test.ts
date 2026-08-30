// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/services/api'
import PddAccountManagement from './PddAccountManagement.vue'

const apiMocks = vi.hoisted(() => ({
  listPlatformAccounts: vi.fn(),
  createPlatformAccount: vi.fn(),
}))

vi.mock('@/services/api', async () => {
  const actual = await vi.importActual<typeof import('@/services/api')>('@/services/api')
  return { ...actual, ...apiMocks }
})

const accountBase = {
  platform: 'pdd' as const,
  source: 'WINDOWS_BROWSER',
  last_attempt_at: '2026-08-30T08:12:00Z',
  last_success_at: '2026-08-30T08:10:00Z',
  last_count: 12,
  message: null,
  order_count: 38,
}

describe('PddAccountManagement', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  it('renders account identity, counts, timestamps, and every actionable sync status', async () => {
    const statuses = [
      ['OK', '正常'],
      ['NEEDS_LOGIN', '需登录'],
      ['CAPTCHA_OR_BLOCKED', '需要验证'],
      ['SCHEMA_CHANGED', '页面变化'],
      ['NETWORK_ERROR', '网络错误'],
      ['DISABLED', '本次未执行'],
      [null, '未同步'],
    ] as const
    apiMocks.listPlatformAccounts.mockResolvedValue({
      items: statuses.map(([status], index) => ({
        ...accountBase,
        id: index + 1,
        account_key: `pdd-${index + 1}`,
        display_label: index === 0 ? '主采购账号' : `采购账号 ${index + 1}`,
        status,
      })),
      total: statuses.length,
    })

    const wrapper = mount(PddAccountManagement, { props: { online: true } })
    await flushPromises()

    expect(apiMocks.listPlatformAccounts).toHaveBeenCalledWith('pdd')
    expect(wrapper.text()).toContain('主采购账号')
    expect(wrapper.text()).toContain('pdd-1')
    expect(wrapper.text()).toContain('38')
    for (const [, label] of statuses) expect(wrapper.text()).toContain(label)
    expect(wrapper.text()).toContain('最近检查')
    expect(wrapper.text()).toContain('最近成功')
    expect(wrapper.text()).toContain('不保存密码或 Cookie')
  })

  it('registers only a label and stable key, with no credential input', async () => {
    apiMocks.listPlatformAccounts.mockResolvedValue({ items: [], total: 0 })
    apiMocks.createPlatformAccount.mockResolvedValue({
      ...accountBase,
      id: 9,
      account_key: 'pdd-main',
      display_label: '主采购账号',
      status: null,
      last_attempt_at: null,
      last_success_at: null,
      last_count: 0,
      order_count: 0,
    })
    const wrapper = mount(PddAccountManagement, {
      attachTo: document.body,
      props: { online: true },
    })
    await flushPromises()

    await wrapper.get('.pdd-account-heading-actions .primary-compact-button').trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(wrapper.get('input[placeholder="例如 主采购账号"]').element)
    expect(wrapper.find('input[type="password"]').exists()).toBe(false)
    expect(wrapper.find('input[name="cookie"]').exists()).toBe(false)

    await wrapper.get('input[placeholder="例如 主采购账号"]').setValue(' 主采购账号 ')
    await wrapper.get('input[placeholder="例如 pdd-main"]').setValue(' PDD Main ')
    await wrapper.get('.pdd-account-form').trigger('submit')
    expect(wrapper.get('[role="alert"]').text()).toContain('账号标识需为')
    expect(apiMocks.createPlatformAccount).not.toHaveBeenCalled()

    await wrapper.get('input[placeholder="例如 pdd-main"]').setValue(' PDD-Main ')
    await wrapper.get('.pdd-account-form').trigger('submit')
    await flushPromises()

    expect(apiMocks.createPlatformAccount).toHaveBeenCalledWith({
      platform: 'pdd',
      account_key: 'pdd-main',
      display_label: '主采购账号',
    })
    expect(wrapper.text()).toContain('请在同步电脑上完成首次登录')
    expect(wrapper.text()).toContain('主采购账号')
    expect(wrapper.find('.pdd-account-form').exists()).toBe(false)
  })

  it('shows an empty state and loads once connectivity returns', async () => {
    apiMocks.listPlatformAccounts.mockResolvedValue({ items: [], total: 0 })
    const wrapper = mount(PddAccountManagement, { props: { online: false } })
    await flushPromises()

    expect(apiMocks.listPlatformAccounts).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('当前离线')
    expect(wrapper.text()).toContain('还没有登记拼多多账号')
    expect(wrapper.get('.primary-compact-button').attributes('disabled')).toBeDefined()

    await wrapper.setProps({ online: true })
    await flushPromises()
    expect(apiMocks.listPlatformAccounts).toHaveBeenCalledTimes(1)
  })

  it('emits auth-required for 401 and explains permission denial for 403', async () => {
    apiMocks.listPlatformAccounts.mockRejectedValueOnce(new ApiError(401, 'expired'))
    const expired = mount(PddAccountManagement, { props: { online: true } })
    await flushPromises()
    expect(expired.emitted('authRequired')).toHaveLength(1)

    apiMocks.listPlatformAccounts.mockRejectedValueOnce(new ApiError(403, 'forbidden'))
    const forbidden = mount(PddAccountManagement, { props: { online: true } })
    await flushPromises()
    expect(forbidden.text()).toContain('仅管理员可以查看和登记')
    expect(forbidden.get('.primary-compact-button').attributes('disabled')).toBeDefined()
  })
})
