import { describe, expect, it } from 'vitest'
import { closeSession, publish, subscribe } from '../src/stream-channel'

class MockResponse {
  writes: string[] = []
  ended = false
  write(chunk: string): boolean {
    this.writes.push(chunk)
    return true
  }
  end(): void {
    this.ended = true
  }
  on(): void {}
}

function mockRes(): MockResponse {
  return new MockResponse()
}

describe('stream-channel replay/resync', () => {
  it('sends resync when the client boot id does not match the server boot', () => {
    const res = mockRes()
    subscribe('test-restart', res as never, 0, 'old-boot-id')
    expect(res.writes.some((line) => line.startsWith('event: resync'))).toBe(true)
    closeSession('test-restart')
  })

  it('replays buffered frames after the last event id without resync', () => {
    publish('test-replay', { advisorId: 'a', contentDelta: 'x' })
    publish('test-replay', { advisorId: 'a', contentDelta: 'y' })

    const res = mockRes()
    subscribe('test-replay', res as never, 1, undefined)
    const joined = res.writes.join('')
    expect(joined).not.toContain('event: resync')
    expect(joined).toContain('"contentDelta":"y"')
    expect(joined).not.toContain('"contentDelta":"x"')
    closeSession('test-replay')
  })

  it('sends resync when the replay buffer cannot cover the requested gap', () => {
    // Exceed the replay limit so the first buffered id is greater than 1.
    for (let i = 0; i < 503; i++) {
      publish('test-gap', { advisorId: 'a', contentDelta: String(i) })
    }

    const res = mockRes()
    subscribe('test-gap', res as never, 1, undefined)
    expect(res.writes.some((line) => line.startsWith('event: resync'))).toBe(true)
    closeSession('test-gap')
  })
})
