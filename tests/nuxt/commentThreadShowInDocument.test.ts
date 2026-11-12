// @vitest-environment nuxt
import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { CommentsCommentThread } from '#components'
import type { DerivedComment } from '~/composables/comments/useComments'

// The comment card's click focuses the comment's range in the editor; the
// "Show in document" button is its keyboard equivalent (the card itself is
// not focusable).

function comment(anchor: DerivedComment['anchor']): DerivedComment {
  return {
    id: 'c1',
    anchor,
    body: 'Check this figure',
    authorId: 7,
    authorName: 'Maya',
    authorAvatarSeed: null,
    createdAt: 0,
    updatedAt: 0,
    resolved: false,
    replies: []
  }
}

describe('comment thread — Show in document', () => {
  it('is a button that focuses the comment, like the card click', async () => {
    const wrapper = await mountSuspended(CommentsCommentThread, { props: { comment: comment({ from: 3, to: 9 }), readOnly: true } })
    const button = wrapper.find('[data-testid="comment-show-in-document"]')
    expect(button.element.tagName).toBe('BUTTON')
    expect(button.text()).toBe('Show in document')
    await button.trigger('click')
    // Once: the card's own click handler ignores clicks from buttons inside it.
    expect(wrapper.emitted('focus')).toEqual([['c1']])

    await wrapper.find('[data-testid="comment-thread"]').trigger('click')
    expect(wrapper.emitted('focus')).toEqual([['c1'], ['c1']])
  })

  it('is not offered for a comment whose text was deleted', async () => {
    const wrapper = await mountSuspended(CommentsCommentThread, { props: { comment: comment(null), readOnly: true } })
    expect(wrapper.find('[data-testid="comment-show-in-document"]').exists()).toBe(false)
  })
})
