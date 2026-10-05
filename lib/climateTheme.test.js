import test from 'node:test'
import assert from 'node:assert/strict'
import { climateThemeFor, locationCodesFromHeaders } from './climateTheme.js'

test('returns a safe default without a location', () => {
  assert.equal(climateThemeFor('', '', new Date('2026-07-01')), 'default')
})

test('uses broad Indian region classifications', () => {
  assert.equal(climateThemeFor('IN', 'KL'), 'tropical')
  assert.equal(climateThemeFor('IN', 'RJ'), 'warm')
  assert.equal(climateThemeFor('IN', 'HP'), 'cool')
})

test('accounts for seasons in both hemispheres', () => {
  assert.equal(climateThemeFor('GB', '', new Date('2026-01-15')), 'cool')
  assert.equal(climateThemeFor('GB', '', new Date('2026-07-15')), 'warm')
  assert.equal(climateThemeFor('NZ', '', new Date('2026-01-15')), 'warm')
  assert.equal(climateThemeFor('NZ', '', new Date('2026-07-15')), 'cool')
})

test('prefers Vercel coarse location headers', () => {
  assert.deepEqual(locationCodesFromHeaders({
    'x-vercel-ip-country': 'IN',
    'x-vercel-ip-country-region': 'KL',
    'cf-ipcountry': 'US',
  }), { country: 'IN', region: 'KL' })
})
