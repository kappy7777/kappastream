// One IRC chat connection per multi-view tile. Multi-view keeps a SEPARATE
// ChatSession per open tile so switching chat tabs never loses scrollback and
// each channel's ROOMSTATE / moderation / badges are tracked independently.
//
// This mirrors the chat discipline in App.svelte (generation-coupled socket,
// exponential reconnect, channel+global emote load, parse-then-store with
// presentation gated at render time) but is a standalone class so the
// single-stream chat path in App.svelte stays byte-identical when multi-view is
// OFF. It reuses the already-factored pure helpers: parseIrcEvent /
// mergeRoomState / composeUsernoticeFallback / DELETED_MESSAGE_CLASS from
// irc.ts and the emote loaders from emotes.ts — only the socket+reconnect
// orchestration is duplicated (it is inherently per-connection state).
//
// The message buffer + roomState + badge override are Svelte `$state` so the
// Tile/MultiView render reacts live. The client-side mute list and the Tier 2
// chat toggles (notice groups / roomstate indicator / moderation / bits) are
// applied at RENDER time by the component reading `settings`, exactly as
// App.svelte does — the session always stores every event so flipping a toggle
// retroactively re-evaluates already-buffered messages.

import { parseIrcEvent, mergeRoomState, composeUsernoticeFallback, type IrcEvent, type RoomState } from './irc'
import { loadChannelEmotes, loadGlobalEmotes, buildEmoteMap, renderMessage, parseTwitchEmoteTag, type Emote, type RenderedMessagePart } from './emotes'
import { fetchChannelBadges } from './gql'
import { t } from './i18n/index.svelte'

export interface ChatMessage {
  kind: 'message' | 'notice'
  id: string
  username: string
  color: string
  raw: string
  parts: RenderedMessagePart[]
  badges: { id: string; version: string; label: string; imageUrl: string | null }[]
  isAction: boolean
  emoteOnly: boolean
  timestamp: number
  bits: number | null
  userId: string | null
  login: string | null
  deleted: boolean
  deletedReason: string | null
  systemText: string | null
  noticeMsgId: string | null
}

export type ChatConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected'

const MAX_BUFFER = 500
const IRC_URL = 'wss://irc-ws.chat.twitch.tv:443'
const MAX_RECONNECT_ATTEMPTS = 10
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000

function randomUsername(): string {
  return 'justinfan' + Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0')
}

export class ChatSession {
  readonly channel: string

  messages: ChatMessage[] = $state([])
  status: ChatConnectionStatus = $state('idle')
  emoteStatus: 'idle' | 'loading' | 'ready' | 'error' = $state('idle')
  roomState: RoomState = $state({})
  /** Per-channel custom subscriber/founder badge art (setID -> {version -> uuid}). */
  badgeOverride: Record<string, Record<string, string>> | null = $state(null)

  private socket: WebSocket | null = null
  private generation = 0
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private emoteAbort: AbortController | null = null
  // Third-party emote map for the renderer. Public + $state so the pinned-
  // message banner — which renders through renderMessage at render time —
  // re-resolves when the channel's emotes land (message parts are baked on
  // arrival and are unaffected by the reactivity).
  thirdParty = $state(new Map<string, Emote>())
  private badgeToken = 0
  private disposed = false

  constructor(channel: string) {
    this.channel = channel.toLowerCase()
  }

  start(): void {
    if (this.disposed) return
    this.generation++
    this.reconnectAttempts = 0
    this.status = 'connecting'
    const gen = this.generation
    this.emoteAbort?.abort()
    this.emoteAbort = new AbortController()
    this.emoteStatus = 'loading'
    void this.loadEmotes(gen, this.emoteAbort.signal)
    void this.loadBadges(gen)
    this.openSocket(gen, false)
  }

  dispose(): void {
    this.disposed = true
    this.generation++ // invalidate any in-flight callback
    this.emoteAbort?.abort()
    this.emoteAbort = null
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.socket) {
      this.socket.onclose = null
      this.socket.onerror = null
      this.socket.onmessage = null
      this.socket.onopen = null
      try { this.socket.close() } catch { /* ignore */ }
      this.socket = null
    }
    this.status = 'idle'
  }

  private scheduleReconnect(gen: number): void {
    if (gen !== this.generation || this.disposed) return
    if (this.reconnectTimer) return
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.status = 'disconnected'
      return
    }
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempts)
    this.reconnectAttempts++
    this.status = 'connecting'
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (gen !== this.generation || this.disposed) return
      this.openSocket(gen, true)
    }, delay)
  }

  private openSocket(gen: number, isReconnect: boolean): void {
    if (gen !== this.generation || this.disposed) return
    let ws: WebSocket
    try {
      ws = new WebSocket(IRC_URL)
    } catch {
      this.scheduleReconnect(gen)
      return
    }
    this.socket = ws
    const nick = randomUsername()

    ws.onopen = () => {
      if (gen !== this.generation || this.socket !== ws || this.disposed) {
        try { ws.close() } catch { /* ignore */ }
        return
      }
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands')
      ws.send('NICK ' + nick)
      ws.send('JOIN #' + this.channel)
      this.reconnectAttempts = 0
      this.status = 'connected'
    }
    ws.onmessage = (ev) => {
      if (gen === this.generation && this.socket === ws && !this.disposed) {
        this.handleRaw(ev.data as string, ws)
      }
    }
    ws.onerror = () => { /* let onclose drive reconnect */ }
    ws.onclose = () => {
      if (gen !== this.generation || this.socket !== ws || this.disposed) return
      this.socket = null
      this.scheduleReconnect(gen)
    }
    void isReconnect
  }

  private async loadEmotes(gen: number, signal: AbortSignal): Promise<void> {
    try {
      const [channelEmotes, globalEmotes] = await Promise.all([
        loadChannelEmotes(this.channel, signal),
        loadGlobalEmotes(signal),
      ])
      if (signal.aborted || gen !== this.generation || this.disposed) return
      this.thirdParty = buildEmoteMap([...channelEmotes, ...globalEmotes])
      this.emoteStatus = 'ready'
    } catch {
      if (!signal.aborted && gen === this.generation && !this.disposed) this.emoteStatus = 'error'
    }
  }

  private async loadBadges(gen: number): Promise<void> {
    // Clear immediately so a previous channel's custom badges never bleed in
    // (a ChatSession is per-channel so this is mostly defensive, but the fetch
    // is async and the tile could be replaced before it lands).
    this.badgeOverride = null
    const myToken = ++this.badgeToken
    try {
      const override = await fetchChannelBadges(this.channel)
      if (myToken !== this.badgeToken || gen !== this.generation || this.disposed) return
      this.badgeOverride = override
    } catch {
      /* leave null -> global default badges */
    }
  }

  private handleRaw(raw: string, ws: WebSocket): void {
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line) continue
      if (line.startsWith('PING ')) {
        try { ws.send('PONG ' + line.slice(5)) } catch { /* ignore */ }
        continue
      }
      const ev: IrcEvent | null = parseIrcEvent(line)
      if (!ev) continue
      if (ev.channel !== this.channel) continue
      switch (ev.type) {
        case 'PRIVMSG': this.onPrivmsg(ev); break
        case 'USERNOTICE': this.onUsernotice(ev); break
        case 'ROOMSTATE': this.roomState = mergeRoomState(this.roomState, ev); break
        case 'CLEARMSG': this.markDeleted(ev.targetMsgId, t('mod_messageDeleted')); break
        case 'CLEARCHAT': this.onClearchat(ev); break
      }
    }
  }

  private onPrivmsg(ev: Extract<IrcEvent, { type: 'PRIVMSG' }>): void {
    const parts = renderMessage({ message: ev.message, thirdParty: this.thirdParty, twitchRanges: ev.twitchEmotes })
    const emoteOnly = parts.some((p) => p.type === 'emote') && parts.every((p) => p.type === 'emote' || p.text.trim() === '')
    this.push({
      kind: 'message',
      id: ev.id || crypto.randomUUID(),
      username: ev.displayName,
      color: ev.color,
      raw: ev.message,
      parts,
      badges: ev.badges,
      isAction: ev.isAction,
      emoteOnly,
      timestamp: ev.timestamp,
      bits: ev.bits,
      userId: ev.userId,
      login: ev.username,
      deleted: false,
      deletedReason: null,
      systemText: null,
      noticeMsgId: null,
    })
  }

  private onUsernotice(ev: Extract<IrcEvent, { type: 'USERNOTICE' }>): void {
    const systemText = ev.systemMsg || composeUsernoticeFallback(ev.msgId, ev.tags)
    let parts: RenderedMessagePart[] = []
    if (ev.message) {
      parts = renderMessage({
        message: ev.message,
        thirdParty: this.thirdParty,
        twitchRanges: parseTwitchEmoteTag(ev.emotes, ev.message),
      })
    }
    this.push({
      kind: 'notice',
      id: crypto.randomUUID(),
      username: ev.login ?? '',
      color: '#ffffff',
      raw: ev.message ?? '',
      parts,
      badges: [],
      isAction: false,
      emoteOnly: false,
      timestamp: Date.now(),
      bits: null,
      userId: null,
      login: ev.login,
      deleted: false,
      deletedReason: null,
      systemText,
      noticeMsgId: ev.msgId,
    })
  }

  private onClearchat(ev: Extract<IrcEvent, { type: 'CLEARCHAT' }>): void {
    if (ev.targetUserId === null) {
      for (const m of this.messages) if (m.kind === 'message') this.markEntryDeleted(m, t('mod_chatCleared'))
      return
    }
    const reason = ev.banDuration !== null ? t('mod_timedOut', { n: ev.banDuration }) : t('mod_banned')
    for (const m of this.messages) if (m.kind === 'message' && m.userId === ev.targetUserId) this.markEntryDeleted(m, reason)
  }

  private markDeleted(targetMsgId: string, reason: string): void {
    if (!targetMsgId) return
    for (const m of this.messages) if (m.kind === 'message' && m.id === targetMsgId) this.markEntryDeleted(m, reason)
  }

  private markEntryDeleted(m: ChatMessage, reason: string): void {
    if (m.deleted) return
    m.deleted = true
    m.deletedReason = reason
  }

  private push(m: ChatMessage): void {
    this.messages.push(m)
    if (this.messages.length > MAX_BUFFER) this.messages.splice(0, this.messages.length - MAX_BUFFER)
  }
}
