import { describe, expect, it, vi } from 'vitest'

import { createQueuedRefresh } from './queuedRefresh'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

describe('queued refresh', () => {
  it('coalesces invalidations during a request into one follow-up refresh', async () => {
    const refresh = createQueuedRefresh()
    const first = deferred()
    const second = deferred()
    const task = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)

    const completed = refresh.request(task)
    refresh.request(task)
    refresh.request(task)

    expect(task).toHaveBeenCalledTimes(1)
    expect(refresh.running).toBe(true)
    expect(refresh.queued).toBe(true)

    first.resolve()
    await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(2))
    expect(refresh.running).toBe(true)
    expect(refresh.queued).toBe(false)

    second.resolve()
    await completed
    expect(refresh.running).toBe(false)
  })

  it('clears a queued follow-up when the owning session is reset', async () => {
    const refresh = createQueuedRefresh()
    const first = deferred()
    const task = vi.fn(() => first.promise)

    const completed = refresh.request(task)
    refresh.request(task)
    refresh.reset()
    first.resolve()
    await completed

    expect(task).toHaveBeenCalledTimes(1)
    expect(refresh.running).toBe(false)
    expect(refresh.queued).toBe(false)
  })
})
