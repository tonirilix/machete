import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectInspector } from '../scripts/packaged-desktop-session.mjs'

// A controlled protocol peer lets tests deliver late and out-of-order messages
// and cut the connection without relying on a packaged macOS application.
class Peer extends EventTarget {
  static current: Peer
  sent: { id: number; method: string; params: Record<string, unknown> }[] = []
  closed = false
  constructor(_url: string) {
    super()
    Peer.current = this
  }
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close() {
    this.closed = true
    this.dispatchEvent(new Event('close'))
  }
  message(data: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }))
  }
  reply(index: number, value: unknown) {
    this.message({ id: this.sent[index].id, result: { result: { value } } })
  }
}

async function connected(process?: EventEmitter) {
  const connecting = connectInspector('ws://peer', { WebSocket: Peer, timeout: 100, process })
  Peer.current.dispatchEvent(new Event('open'))
  return connecting
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('packaged desktop inspector lifetime', () => {
  it('correlates out-of-order responses and ignores notifications and late timed-out responses', async () => {
    const inspector = await connected()
    const first = inspector.evaluate('first')
    const second = inspector.evaluate('second')
    Peer.current.message({ method: 'Runtime.consoleAPICalled', params: {} })
    Peer.current.reply(1, 'second result')
    Peer.current.reply(0, 'first result')
    await expect(second).resolves.toBe('second result')
    await expect(first).resolves.toBe('first result')
    const timed = inspector.evaluate('never returns')
    const rejected = expect(timed).rejects.toThrow('inspection timed out')
    await vi.advanceTimersByTimeAsync(100)
    await rejected
    Peer.current.reply(2, 'too late')
    const next = inspector.evaluate('next')
    Peer.current.reply(3, 'next result')
    await expect(next).resolves.toBe('next result')
    inspector.close()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects every pending request and event on disconnect, including future requests', async () => {
    const inspector = await connected()
    const request = expect(inspector.evaluate('pending')).rejects.toThrow('disconnected')
    const event = expect(inspector.waitForEvent('Debugger.paused')).rejects.toThrow('disconnected')
    Peer.current.close()
    await Promise.all([request, event])
    await expect(inspector.evaluate('after close')).rejects.toThrow('disconnected')
    expect(vi.getTimerCount()).toBe(0)
    inspector.close()
  })

  it('rejects on child exit while the inspector connection remains open', async () => {
    const process = new EventEmitter()
    const inspector = await connected(process)
    const request = expect(inspector.evaluate('pending')).rejects.toThrow('process exited')
    const event = expect(inspector.waitForEvent('Debugger.paused')).rejects.toThrow(
      'process exited',
    )
    process.emit('exit', 1)
    await Promise.all([request, event])
    expect(Peer.current.closed).toBe(false)
    await expect(inspector.evaluate('after exit')).rejects.toThrow('process exited')
    inspector.close()
    expect(process.listenerCount('exit')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds connection readiness, disconnect before open and process exit before open', async () => {
    const connecting = connectInspector('ws://peer', { WebSocket: Peer, timeout: 100 })
    const rejected = expect(connecting).rejects.toThrow('connection timed out')
    await vi.advanceTimersByTimeAsync(100)
    await rejected
    expect(Peer.current.closed).toBe(true)
    const disconnected = connectInspector('ws://peer', { WebSocket: Peer })
    const closed = expect(disconnected).rejects.toThrow('disconnected')
    Peer.current.close()
    await closed
    const process = new EventEmitter()
    const exited = connectInspector('ws://peer', { WebSocket: Peer, process })
    const failed = expect(exited).rejects.toThrow('process exited')
    process.emit('exit', 1)
    await failed
    expect(process.listenerCount('exit')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects protocol and JavaScript errors and supports the paused startup seam', async () => {
    const inspector = await connected()
    const protocol = expect(inspector.evaluate('x')).rejects.toThrow('permission denied')
    Peer.current.message({ id: Peer.current.sent[0].id, error: { message: 'permission denied' } })
    await protocol
    const exception = expect(inspector.evaluate('throws')).rejects.toThrow('exceptionDetails')
    Peer.current.message({
      id: Peer.current.sent[1].id,
      result: { exceptionDetails: { text: 'exceptionDetails' } },
    })
    await exception
    const paused = inspector.waitForEvent('Debugger.paused')
    Peer.current.message({
      method: 'Debugger.paused',
      params: { callFrames: [{ callFrameId: 'frame' }] },
    })
    await expect(paused).resolves.toEqual({ callFrames: [{ callFrameId: 'frame' }] })
    const evaluation = inspector.evaluate('process.pid', 'frame')
    expect(Peer.current.sent[2]).toMatchObject({
      method: 'Debugger.evaluateOnCallFrame',
      params: { callFrameId: 'frame' },
    })
    Peer.current.reply(2, 42)
    await expect(evaluation).resolves.toBe(42)
    const neverPaused = expect(inspector.waitForEvent('Debugger.paused')).rejects.toThrow(
      'Debugger.paused timed out',
    )
    await vi.advanceTimersByTimeAsync(100)
    await neverPaused
    inspector.close()
    expect(vi.getTimerCount()).toBe(0)
  })
})
