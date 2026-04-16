// Netlify Function — Server-side EPG filter proxy
// Fetches the full EPG JSON from GitHub, filters to a time window, and returns
// a slimmed-down payload so mobile devices don't have to parse 48 k+ records.
//
// Query params:
//   country  — "US" or "CA" (default "US")
//   hours    — how many hours ahead to include (default 6)

const DATA_BASE   = 'https://raw.githubusercontent.com/whatsonfreetv/whatsonfreetv-data/main';
const PLACEHOLDER = 'program information currently unavailable';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  const params  = event.queryStringParameters || {};
  const country = (['US', 'CA'].includes((params.country || '').toUpperCase()))
    ? params.country.toUpperCase()
    : 'US';
  const hours   = Math.min(Math.max(parseInt(params.hours, 10) || 6, 1), 24);

  try {
    const url = `${DATA_BASE}/epg-${country.toLowerCase()}.json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}`);

    const json     = await res.json();
    const programs = json.programs || [];

    const now      = Date.now();
    const lookback = now - 30 * 60 * 1000;              // 30 min ago
    const horizon  = now + hours * 60 * 60 * 1000;      // hours from now

    const filtered = programs.filter(p => {
      const end   = p.end   ? new Date(p.end).getTime()   : NaN;
      const start = p.start ? new Date(p.start).getTime() : NaN;
      if (isNaN(end) || isNaN(start)) return false;
      if (end <= lookback || start >= horizon) return false;
      const title = (p.title || '').trim();
      if (!title || title.toLowerCase().startsWith(PLACEHOLDER)) return false;
      return true;
    });

    return {
      statusCode: 200,
      headers: {
        ...CORS_HEADERS,
        'Content-Type':  'application/json',
        'Cache-Control': 'public, max-age=300',
      },
      body: JSON.stringify({
        programs: filtered,
        count:    filtered.length,
        filtered: true,
      }),
    };
  } catch (err) {
    console.error('[epg function] error:', err.message);
    return {
      statusCode: 502,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to fetch EPG data', detail: err.message }),
    };
  }
};
