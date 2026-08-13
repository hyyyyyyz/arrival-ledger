import { afterEach, describe, expect, it, vi } from 'vitest'

import { getCurrentSession } from './api'

describe('authentication mode discovery', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('keeps the backend trusted-LAN flag when bootstrapping', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            user: { id: 1, username: 'admin', display_name: '仓库', role: 'ADMIN' },
            auth_required: false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )

    await expect(getCurrentSession()).resolves.toEqual({
      user: { id: 1, username: 'admin', display_name: '仓库', role: 'ADMIN' },
      authRequired: false,
    })
  })
})
