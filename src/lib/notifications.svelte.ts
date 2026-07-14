export type NotificationKind = 'live' | 'mention'

export interface NotificationRecord {
  id: string
  kind: NotificationKind
  title: string
  body: string
  channel: string | null
  timestamp: number
  read: boolean
}

const MAX_ENTRIES = 100

let idCounter = 0
function nextId(): string {
  idCounter++
  return Date.now().toString(36) + '-' + idCounter.toString(36)
}

class NotificationsStore {
  items: NotificationRecord[] = $state([])

  get unreadCount(): number {
    let n = 0
    for (const item of this.items) if (!item.read) n++
    return n
  }

  record(kind: NotificationKind, title: string, body: string, channel: string | null = null): void {
    const rec: NotificationRecord = {
      id: nextId(),
      kind,
      title,
      body,
      channel,
      timestamp: Date.now(),
      read: false,
    }
    this.items = [rec, ...this.items].slice(0, MAX_ENTRIES)
  }

  markAllRead(): void {
    if (this.items.length === 0) return
    if (this.items.every((i) => i.read)) return
    this.items = this.items.map((i) => ({ ...i, read: true }))
  }

  remove(id: string): void {
    this.items = this.items.filter((i) => i.id !== id)
  }

  clear(): void {
    if (this.items.length === 0) return
    this.items = []
  }
}

export const notifications = new NotificationsStore()
