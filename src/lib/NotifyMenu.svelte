<script lang="ts">
  import { notifications, type NotificationRecord } from './notifications.svelte.ts'
  import { tooltip } from './tooltip.ts'

  let open = $state(false)
  let panelEl: HTMLElement | undefined = $state()
  let buttonEl: HTMLButtonElement | undefined = $state()

  const count = $derived(notifications.unreadCount)

  function toggle(): void {
    open = !open
    if (open) notifications.markAllRead()
  }

  function close(): void {
    open = false
  }

  function clearAll(): void {
    notifications.clear()
  }

  function removeItem(id: string): void {
    notifications.remove(id)
  }

  function relTime(ts: number): string {
    const diff = Date.now() - ts
    const sec = Math.floor(diff / 1000)
    if (sec < 45) return 'now'
    const min = Math.floor(sec / 60)
    if (min < 60) return min + 'm'
    const hr = Math.floor(min / 60)
    if (hr < 24) return hr + 'h'
    const day = Math.floor(hr / 24)
    if (day < 7) return day + 'd'
    const d = new Date(ts)
    return d.toLocaleDateString()
  }

  function iconFor(kind: NotificationRecord['kind']): string {
    return kind === 'live' ? 'L' : '@'
  }

  $effect(() => {
    if (!open) return
    function onDown(e: MouseEvent): void {
      const t = e.target as Node | null
      if (!t) return
      if (panelEl?.contains(t)) return
      if (buttonEl?.contains(t)) return
      open = false
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') open = false
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  })
</script>

<div class="notify-wrap">
  <button
    type="button"
    class="notify-btn"
    class:notify-btn--active={open}
    bind:this={buttonEl}
    onclick={toggle}
    aria-label={count > 0 ? `Notifications (${count} unread)` : 'Notifications'}
    aria-haspopup="dialog"
    aria-expanded={open}
    use:tooltip={'Notifications'}
  >
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22zm7-5-1.4-1.4a2 2 0 0 1-.6-1.4V10a5 5 0 0 0-4-4.9V4a1 1 0 1 0-2 0v1.1A5 5 0 0 0 7 10v4.2a2 2 0 0 1-.6 1.4L5 17h14z" fill="currentColor"/>
    </svg>
    {#if count > 0}
      <span class="notify-badge">{count > 99 ? '99+' : count}</span>
    {/if}
  </button>

  {#if open}
    <div class="panel" bind:this={panelEl} role="dialog" aria-label="Notifications">
      <div class="panel-head">
        <span class="panel-title">Notifications</span>
        {#if notifications.items.length > 0}
          <button type="button" class="clear-btn" onclick={clearAll}>Clear all</button>
        {/if}
      </div>

      {#if notifications.items.length === 0}
        <div class="empty">
          <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
            <path d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22zm7-5-1.4-1.4a2 2 0 0 1-.6-1.4V10a5 5 0 0 0-4-4.9V4a1 1 0 1 0-2 0v1.1A5 5 0 0 0 7 10v4.2a2 2 0 0 1-.6 1.4L5 17h14z" fill="currentColor" opacity="0.5"/>
          </svg>
          <span>No notifications yet</span>
        </div>
      {:else}
        <div class="notif-list">
          {#each notifications.items as item (item.id)}
            <div class="notif-item" class:notif-item--live={item.kind === 'live'} data-read={item.read}>
              <span class="notif-icon" class:notif-icon--live={item.kind === 'live'} aria-hidden="true">{iconFor(item.kind)}</span>
              <div class="notif-body">
                <div class="notif-title-row">
                  <span class="notif-title">{item.title}</span>
                  <button type="button" class="notif-dismiss" aria-label="Dismiss" onclick={() => removeItem(item.id)}>
                    <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                      <path d="M4 4 L12 12 M12 4 L4 12" />
                    </svg>
                  </button>
                </div>
                {#if item.body}
                  <p class="notif-text">{item.body}</p>
                {/if}
                <span class="notif-time">{relTime(item.timestamp)}</span>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .notify-wrap {
    position: relative;
    flex: 0 0 auto;
  }

  .notify-btn {
    position: relative;
    width: 30px;
    height: 30px;
    padding: 0;
    margin-right: 4px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 150ms, color 150ms;
  }

  .notify-btn:hover,
  .notify-btn--active {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .notify-badge {
    position: absolute;
    top: 1px;
    right: 1px;
    min-width: 14px;
    height: 14px;
    padding: 0 3px;
    border-radius: 7px;
    background: var(--live);
    color: #fff;
    font-size: 9px;
    font-weight: 700;
    line-height: 14px;
    text-align: center;
    font-variant-numeric: tabular-nums;
    box-shadow: 0 0 0 1.5px var(--bg-panel);
  }

  .panel {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    width: 320px;
    max-height: min(calc(100vh - 60px), 480px);
    display: flex;
    flex-direction: column;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: var(--shadow-menu);
    z-index: 30;
    overflow: hidden;
    transform-origin: top right;
    animation: panel-in 150ms ease-out;
  }

  @keyframes panel-in {
    from { opacity: 0; transform: scale(0.96) translateY(-4px); }
    to { opacity: 1; transform: scale(1) translateY(0); }
  }

  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    flex: 0 0 auto;
  }

  .panel-title {
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-secondary);
  }

  .clear-btn {
    border: none;
    background: transparent;
    color: var(--text-secondary);
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 3px;
    transition: background 150ms, color 150ms;
  }

  .clear-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 28px 16px;
    color: var(--text-dim);
    font-size: 12px;
  }

  .notif-list {
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .notif-item {
    display: flex;
    gap: 10px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    position: relative;
  }

  .notif-item:last-child {
    border-bottom: none;
  }

  .notif-item::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 2px;
    background: transparent;
  }

  .notif-item[data-read='false']::before {
    background: var(--accent);
  }

  .notif-icon {
    flex: 0 0 auto;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--bg-hover);
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 700;
    margin-top: 1px;
  }

  .notif-icon--live {
    background: var(--live);
    color: #fff;
  }

  .notif-body {
    flex: 1 1 auto;
    min-width: 0;
  }

  .notif-title-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 6px;
  }

  .notif-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
    word-break: break-word;
  }

  .notif-dismiss {
    flex: 0 0 auto;
    width: 18px;
    height: 18px;
    padding: 0;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    transition: background 150ms, color 150ms, opacity 150ms;
  }

  .notif-item:hover .notif-dismiss {
    opacity: 1;
  }

  .notif-dismiss:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .notif-text {
    margin: 2px 0 0;
    font-size: 12px;
    color: var(--text-secondary);
    word-break: break-word;
    line-height: 1.4;
  }

  .notif-time {
    display: block;
    margin-top: 4px;
    font-size: 10px;
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }
</style>
