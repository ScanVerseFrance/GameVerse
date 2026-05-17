/**
 * Bounded-concurrency semaphore. `acquire()` returns a release function;
 * the caller MUST invoke it (typically in a `finally`) to free the slot.
 *
 * Used to throttle outbound HTTP calls to third-party rate-limited APIs
 * like SteamGridDB — without this, mounting Discover with 500 tiles fires
 * 500 simultaneous SGDB calls and most come back as 429.
 */
export class Semaphore {
  private active = 0
  private waiters: Array<() => void> = []

  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++
      return () => this.release()
    }
    return new Promise<() => void>((resolve) => {
      this.waiters.push(() => {
        this.active++
        resolve(() => this.release())
      })
    })
  }

  private release() {
    this.active--
    const next = this.waiters.shift()
    if (next) next()
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms))
