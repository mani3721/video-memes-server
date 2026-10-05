const TROPICAL_COUNTRIES = new Set([
  'BR', 'CO', 'CR', 'EC', 'ID', 'KE', 'LK', 'MY', 'NG', 'PA', 'PH', 'SG', 'TH', 'UG', 'VN',
])

const SOUTHERN_COUNTRIES = new Set([
  'AR', 'AU', 'BO', 'BW', 'CL', 'NA', 'NZ', 'PE', 'PY', 'UY', 'ZA', 'ZM', 'ZW',
])

const ARID_COUNTRIES = new Set(['AE', 'BH', 'DZ', 'EG', 'IL', 'JO', 'KW', 'LY', 'MA', 'OM', 'QA', 'SA', 'TN'])
const COLD_COUNTRIES = new Set(['CA', 'FI', 'GL', 'IS', 'MN', 'NO', 'SE'])

const INDIA_TROPICAL_REGIONS = new Set(['AN', 'GA', 'KL', 'LD', 'PY', 'TN'])
const INDIA_WARM_REGIONS = new Set(['GJ', 'RJ'])
const INDIA_COOL_REGIONS = new Set(['HP', 'JK', 'LA', 'UK'])
const US_WARM_REGIONS = new Set(['AZ', 'FL', 'HI', 'LA', 'NV', 'NM', 'TX'])
const US_COOL_REGIONS = new Set(['AK', 'ME', 'MI', 'MN', 'MT', 'ND', 'NH', 'VT', 'WI', 'WY'])

function seasonalTheme(isSouthern, month) {
  const winter = isSouthern ? month >= 5 && month <= 7 : month >= 10 || month <= 1
  const summer = isSouthern ? month === 11 || month <= 1 : month >= 5 && month <= 7
  if (winter) return 'cool'
  if (summer) return 'warm'
  return 'default'
}

/**
 * Returns a broad visual theme from coarse edge-location codes. It deliberately
 * avoids weather lookups, coordinates, IP persistence, and ad-personalization.
 */
export function climateThemeFor(countryCode, regionCode, date = new Date()) {
  const country = String(countryCode ?? '').trim().toUpperCase()
  const region = String(regionCode ?? '').trim().toUpperCase()
  const month = date.getUTCMonth()

  if (!country) return 'default'

  if (country === 'IN') {
    if (INDIA_TROPICAL_REGIONS.has(region)) return 'tropical'
    if (INDIA_WARM_REGIONS.has(region)) return 'warm'
    if (INDIA_COOL_REGIONS.has(region)) return 'cool'
  }

  if (country === 'US') {
    if (US_WARM_REGIONS.has(region)) return 'warm'
    if (US_COOL_REGIONS.has(region)) return 'cool'
  }

  if (TROPICAL_COUNTRIES.has(country)) return 'tropical'
  if (ARID_COUNTRIES.has(country)) return 'warm'
  if (COLD_COUNTRIES.has(country)) return 'cool'

  return seasonalTheme(SOUTHERN_COUNTRIES.has(country), month)
}

export function locationCodesFromHeaders(headers) {
  return {
    country: headers['x-vercel-ip-country'] || headers['cf-ipcountry'] || '',
    region: headers['x-vercel-ip-country-region'] || '',
  }
}
