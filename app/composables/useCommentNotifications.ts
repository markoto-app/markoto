import type { Awareness } from 'y-protocols/awareness'
import type { CommentsApi } from '~/composables/useComments'

// OS-level notifications for new replies on comment threads I authored.
//
// Three guards on every fire:
//   1. Tab is hidden (`useDocumentVisibility() === 'hidden'`) — no
//      point notifying when the user is already looking at the page.
//      In-app, the comments panel re-renders the new reply live;
//      stacking an OS notification on top of that would feel like
//      duplicate noise.
//   2. The reply isn't from me. Self-replies don't notify.
//   3. The reply is genuinely new — i.e. its `replyId` was not in
//      our previous-pass snapshot. `recompute` in `useComments` fires
//      on every Y.js update, so we'd otherwise notify on every
//      keystroke during a remote edit unrelated to comments.
//
// Permission is requested LAZILY on the first new-reply event we'd
// notify on. We don't `ensurePermissions()` at composable-mount time
// because that surprises users with a permission prompt the moment
// they open a doc — same anti-pattern as autoplay-with-sound.

export interface UseCommentNotificationsOptions {
  comments: CommentsApi['comments']
  awareness: Awareness
  /** Live doc title — appears as the notification's heading. */
  docTitle: Ref<string>
  /** Tag key prefix so reply notifications can dedupe per-thread. */
  docId: string
}

interface ReplyKey {
  threadId: string
  replyId: string
  authorId: number | null
  authorName: string
  body: string
  threadAuthorId: number | null
}

function snapshot(comments: CommentsApi['comments']): ReplyKey[] {
  const out: ReplyKey[] = []
  for (const c of comments.value) {
    for (const r of c.replies) {
      out.push({
        threadId: c.id,
        replyId: r.id,
        authorId: r.authorId,
        authorName: r.authorName,
        body: r.body,
        threadAuthorId: c.authorId
      })
    }
  }
  return out
}

export function useCommentNotifications(opts: UseCommentNotificationsOptions) {
  // Permission state is reactive — UI can react if needed (e.g. a
  // settings toggle that flips when the user revokes in browser
  // settings). `'unsupported'` covers Firefox + iOS where Notifications
  // aren't available; we treat those as "skip silently".
  const permission = usePermission('notifications', { controls: false })
  const visibility = useDocumentVisibility()

  // `useWebNotification` returns a `show()` that dispatches when called
  // and `ensurePermissions()` for the lazy first-fire prompt.
  const { show, ensurePermissions, isSupported } = useWebNotification({
    requestPermissions: false
  })

  // Snapshot of replies we've already seen — initialized to whatever
  // exists at composable-mount time so the first observation doesn't
  // notify on every historical reply.
  const seen = new Set<string>()
  for (const r of snapshot(opts.comments)) seen.add(r.replyId)

  watch(opts.comments, async () => {
    if (!isSupported.value) return
    if (visibility.value !== 'visible' && permission.value === 'denied') return

    const localUserId = (opts.awareness.getLocalState()?.user as { id?: number } | undefined)?.id ?? null

    const fresh = snapshot(opts.comments).filter((r) => {
      if (seen.has(r.replyId)) return false
      seen.add(r.replyId)
      // Only notify on replies to MY threads, from someone else.
      if (r.threadAuthorId === null || r.threadAuthorId !== localUserId) return false
      if (r.authorId === localUserId) return false
      return true
    })

    if (fresh.length === 0) return
    // Only notify when the tab is actually hidden — collaborator who
    // is looking at the doc can already see the reply land.
    if (visibility.value === 'visible') return

    // Lazy permission ensure — first new reply that would notify is
    // the first time we ask. If denied, future fires will short-circuit
    // at the `permission === 'denied'` check above.
    if (permission.value === 'prompt') {
      try { await ensurePermissions() }
      catch { /* user dismissed; treat as denied for this session */ }
    }
    if (permission.value !== 'granted') return

    // Collapse same-thread bursts: tag by thread so the OS replaces
    // the previous notification rather than stacking. Body shows the
    // most recent reply — good enough for "you have new activity".
    const last = fresh[fresh.length - 1]
    if (!last) return
    const preview = last.body.length > 120 ? `${last.body.slice(0, 117)}…` : last.body
    show({
      title: opts.docTitle.value || 'New reply',
      body: `${last.authorName}: ${preview}`,
      tag: `comment-thread-${opts.docId}-${last.threadId}`,
      icon: '/favicon.ico'
    })
  })
}
