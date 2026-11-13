import type { Awareness } from 'y-protocols/awareness'
import type { CommentsApi } from '~/composables/comments/useComments'

// OS-level notifications for new replies on comment threads I authored.
//
// Three guards on every fire:
//   1. The tab is hidden: the comments panel already shows the reply live,
//      so an OS notification would be duplicate noise.
//   2. The reply isn't from me.
//   3. The reply is new, i.e. its `replyId` wasn't in the previous snapshot.
//      `recompute` in `useComments` fires on every Y.js update, so without
//      this every remote keystroke would notify.
//
// Permission is requested lazily on the first notifiable reply, not at
// mount: a prompt the moment a doc opens surprises users.

export interface UseCommentNotificationsOptions {
  comments: CommentsApi['comments']
  awareness: Awareness
  /** Live doc title: appears as the notification's heading. */
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
  const { t } = useI18n()
  // `'unsupported'` (Firefox, iOS) is treated as "skip silently".
  const permission = usePermission('notifications', { controls: false })
  const visibility = useDocumentVisibility()

  const { show, ensurePermissions, isSupported } = useWebNotification({
    requestPermissions: false
  })

  // Seeded with existing replies so historical ones don't notify.
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
    if (visibility.value === 'visible') return

    // If denied, later fires short-circuit at the `denied` check above.
    if (permission.value === 'prompt') {
      try {
        await ensurePermissions()
      } catch { /* user dismissed; treat as denied for this session */ }
    }
    if (permission.value !== 'granted') return

    // Tagged by thread so the OS replaces the previous notification instead of stacking.
    const last = fresh.at(-1)
    if (!last) return
    const preview = last.body.length > 120 ? `${last.body.slice(0, 117)}…` : last.body
    void show({
      title: opts.docTitle.value || t('comments.notificationFallbackTitle'),
      body: `${last.authorName}: ${preview}`,
      tag: `comment-thread-${opts.docId}-${last.threadId}`,
      icon: '/icon-192.png'
    })
  })
}
