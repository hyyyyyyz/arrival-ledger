export interface QueuedRefresh {
  readonly running: boolean
  readonly queued: boolean
  request(task: () => Promise<void>): Promise<void>
  reset(): void
}

export function createQueuedRefresh(): QueuedRefresh {
  let running = false
  let queued = false
  let generation = 0
  let activePromise: Promise<void> | null = null

  return {
    get running() {
      return running
    },
    get queued() {
      return queued
    },
    request(task) {
      if (running) {
        queued = true
        return activePromise ?? Promise.resolve()
      }

      const activeGeneration = generation
      running = true
      activePromise = (async () => {
        let lastError: unknown
        do {
          queued = false
          try {
            await task()
            lastError = undefined
          } catch (error) {
            lastError = error
          }
        } while (generation === activeGeneration && queued)

        if (lastError !== undefined) throw lastError
      })().finally(() => {
        if (generation !== activeGeneration) return
        running = false
        queued = false
        activePromise = null
      })

      return activePromise
    },
    reset() {
      generation += 1
      running = false
      queued = false
      activePromise = null
    },
  }
}
