/**
 * Port of the old notify_new_content() SQL function.
 *
 * Fans a newly published meme out to users who have favorited at least one
 * meme in the same category (excluding the uploader). Language must agree
 * when both the meme and the user carry one. Idempotent: the notification
 * row ID is derived from (user, meme), so a re-approval cannot double-notify.
 */

import { Query, AppwriteException, getRow, createRow, listAllRows, listRows, stableId } from '../db/appwrite.js'

export async function notifyNewContent(memeId) {
  const meme = await getRow('memes', memeId)
  if (!meme?.is_published) return 0

  // Memes in this category → users who favorited any of them.
  const sameCategory = await listAllRows('memes', [
    Query.equal('category', meme.category),
    Query.select(['$id']),
  ], { cap: 5000 })
  const ids = sameCategory.map((m) => m.id)

  const users = new Set()
  for (let i = 0; i < ids.length; i += 100) {
    const favs = await listAllRows('favorites', [Query.equal('meme_id', ids.slice(i, i + 100)), Query.select(['user_id'])])
    for (const f of favs) if (f.user_id) users.add(f.user_id)
  }
  if (meme.uploader_id) users.delete(meme.uploader_id)

  let count = 0
  for (const userId of users) {
    if (meme.language) {
      const { rows } = await listRows('profiles', [Query.equal('$id', userId), Query.limit(1)])
      const lang = rows[0]?.preferred_language
      if (lang && lang !== meme.language) continue
    }
    try {
      await createRow(
        'notifications',
        {
          user_id: userId,
          type: 'new_content',
          title: `New ${meme.category} you might like`,
          message: meme.title ?? null,
          link: `${meme.category === 'sounds' ? '/sound/' : '/meme/'}${memeId}`,
          thumbnail: meme.thumbnail_url ?? null,
          dedupe_key: `new_content:${memeId}:${userId}`,
          created_at: new Date().toISOString(),
        },
        stableId('nc', userId, memeId),
      )
      count++
    } catch (err) {
      if (!(err instanceof AppwriteException && err.code === 409)) throw err
    }
  }
  return count
}
