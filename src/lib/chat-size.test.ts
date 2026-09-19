import { describe, expect, it } from 'vitest'
import { CHAT_SIZE_MAX, CHAT_SIZE_MIN, CHAT_SIZE_PAGE_STEP, CHAT_SIZE_STEP, nextChatSize } from './chat-size'

describe('nextChatSize', () => {
  it('steps with the arrow keys in both directions', () => {
    expect(nextChatSize('ArrowUp', 400)).toBe(400 + CHAT_SIZE_STEP)
    expect(nextChatSize('ArrowRight', 400)).toBe(400 + CHAT_SIZE_STEP)
    expect(nextChatSize('ArrowDown', 400)).toBe(400 - CHAT_SIZE_STEP)
    expect(nextChatSize('ArrowLeft', 400)).toBe(400 - CHAT_SIZE_STEP)
  })

  it('steps by the larger page step', () => {
    expect(nextChatSize('PageUp', 400)).toBe(400 + CHAT_SIZE_PAGE_STEP)
    expect(nextChatSize('PageDown', 400)).toBe(400 - CHAT_SIZE_PAGE_STEP)
  })

  it('jumps to the bounds with Home/End', () => {
    expect(nextChatSize('Home', 400)).toBe(CHAT_SIZE_MIN)
    expect(nextChatSize('End', 400)).toBe(CHAT_SIZE_MAX)
  })

  it('clamps at the bounds', () => {
    expect(nextChatSize('ArrowUp', CHAT_SIZE_MAX)).toBe(CHAT_SIZE_MAX)
    expect(nextChatSize('ArrowDown', CHAT_SIZE_MIN)).toBe(CHAT_SIZE_MIN)
    expect(nextChatSize('PageDown', CHAT_SIZE_MIN)).toBe(CHAT_SIZE_MIN)
  })

  it('returns null for unhandled keys', () => {
    for (const key of ['a', 'Enter', ' ', 'Escape', 'Tab', 'Shift', 'ArrowDiagonal']) {
      expect(nextChatSize(key, 400)).toBeNull()
    }
  })
})
