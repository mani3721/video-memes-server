/**
 * Auth middleware for the Videsaur server.
 *
 * requireAuth  — verifies the Supabase JWT and attaches req.user
 * requireAdmin — additionally checks profiles.role === 'admin'
 * optionalAuth — same as requireAuth but doesn't reject on missing token
 */

import { supabase } from '../supabaseClient.js'

/**
 * Extract and verify the Bearer token from the Authorization header.
 * On success, attaches req.user (Supabase User object).
 */
export async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (!token) return res.status(401).json({ error: 'Authentication required.' })

  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) return res.status(401).json({ error: 'Invalid or expired session.' })

  req.user = user
  next()
}

/**
 * Like requireAuth but resolves with req.user = null instead of rejecting
 * when no token is present. Useful for upload (anon uploads are blocked at
 * the route level, but we still want to know who the uploader is).
 */
export async function optionalAuth(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (!token) return next()

  const { data: { user } } = await supabase.auth.getUser(token)
  req.user = user ?? null
  next()
}

/**
 * Must be used AFTER requireAuth.
 * Looks up the profiles table to confirm the user has role = 'admin'.
 */
export async function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' })

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', req.user.id)
    .single()

  if (error || profile?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' })
  }

  req.isAdmin = true
  next()
}
