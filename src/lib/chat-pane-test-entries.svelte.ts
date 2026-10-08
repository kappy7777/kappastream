import type { ChatEntry } from './merged-chat'

// Reactive entries holder for ChatPane mount tests: $state fields only
// compile in .svelte.ts modules (the same constraint that shaped
// chat-session-test-stub.svelte.ts). Tests mount the pane with `holder.current`
// — the $state proxy — so in-place pushes and wholesale replaces both
// re-run the pane's effects, exactly like a live chat buffer would.
export class ChatPaneTestEntries {
  current = $state<ChatEntry[]>([])

  constructor(initial: ChatEntry[] = []) {
    this.current = initial
  }

  push(...entries: ChatEntry[]): void {
    this.current.push(...entries)
  }

  replace(next: ChatEntry[]): void {
    this.current = next
  }
}
