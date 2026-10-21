import { afterEach, expect, it, vi } from 'vitest'
import { DraftQuitDrain, type DraftDrainRequest } from '../src/main/draft-quit-drain'

afterEach(() => vi.useRealTimers())

it('quits during startup without waiting for an unregistered renderer', async () => {
  const send = vi.fn()
  await new DraftQuitDrain(send).drain()
  expect(send).not.toHaveBeenCalled()
})

it('correlates readiness and responses to the active registration and request', async () => {
  let sent!: DraftDrainRequest
  const quit = new DraftQuitDrain((request) => {
    sent = request
  })
  const registrationId = crypto.randomUUID()
  quit.register(registrationId, true)
  quit.register(crypto.randomUUID(), false)
  const drained = quit.drain()
  expect(sent.registrationId).toBe(registrationId)
  expect(() => quit.complete({ ...sent, id: crypto.randomUUID() })).toThrow('no longer current')
  expect(() => quit.complete({ ...sent, registrationId: crypto.randomUUID() })).toThrow(
    'no longer current',
  )
  quit.complete(sent)
  await drained
  expect(() => quit.complete(sent)).toThrow('no longer current')
})

it('fails the pending quit if the registered editor disconnects', async () => {
  const quit = new DraftQuitDrain(() => {})
  const registrationId = crypto.randomUUID()
  quit.register(registrationId, true)
  const drained = quit.drain()
  const failure = expect(drained).rejects.toThrow('disconnected')
  quit.register(registrationId, false)
  await failure
  await quit.drain()
})

it('bounds an unresponsive editor and allows a subsequent attempt', async () => {
  vi.useFakeTimers()
  let sent!: DraftDrainRequest
  const quit = new DraftQuitDrain((request) => {
    sent = request
  })
  quit.register(crypto.randomUUID(), true)
  const drained = quit.drain()
  const failure = expect(drained).rejects.toThrow('did not respond')
  await vi.advanceTimersByTimeAsync(10_000)
  await failure
  const retried = quit.drain()
  quit.complete(sent)
  await retried
})
