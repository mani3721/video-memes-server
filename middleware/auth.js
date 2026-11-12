/**
 * Auth middleware for the Videsaur server (Appwrite Auth).
 *
 * The browser sends `Authorization: Bearer <Appwrite JWT>` (account.createJWT()).
 *
 * requireAuth  — verifies the JWT and attaches req.user = { id, email, name }
 * optionalAuth — same, but never rejects
 * requireAdmin — additionally checks profiles.role === 'admin'
 */

import { userFromJwt, getRow } from '../db/appwrite.js'

async function resolveUser(req) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (!token) return null
  try {
    const u = await userFromJwt(token)
    return { id: u.$id, email: u.email, name: u.name }
  } catch {
    return null
  }
}

export async function requireAuth(req, res, next) {
  if (!req.headers.authorization) return res.status(401).json({ error: 'Authentication required.' })
  const user = await resolveUser(req)
  if (!user) return res.status(401).json({ error: 'Invalid or expired session.' })
  req.user = user
  next()
}

export async function optionalAuth(req, _res, next) {
  req.user = await resolveUser(req)
  next()
}

/** Must be used AFTER requireAuth. */
export async function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' })

  // Local development bypass: fail-closed, requires development runtime and a
  // loopback browser Origin. Production always checks the profile role.
  let isLocalDevelopment = false
  if (process.env.NODE_ENV === 'development' && req.headers.origin) {
    try {
      isLocalDevelopment = ['localhost', '127.0.0.1', '::1'].includes(new URL(req.headers.origin).hostname)
    } catch {
      // Invalid origins are never trusted.
    }
  }
  if (isLocalDevelopment) {
    req.isAdmin = true
    return next()
  }

  try {
    const profile = await getRow('profiles', req.user.id)
    if (profile?.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' })
  } catch (err) {
    console.error('[auth/requireAdmin]', err.message)
    return res.status(403).json({ error: 'Admin access required.' })
  }

  req.isAdmin = true
  next()
}
