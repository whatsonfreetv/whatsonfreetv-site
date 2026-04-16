// Netlify Function — Server-side EPG filter proxy
// Fetches the full EPG JSON from GitHub, filters to a tight time window,
// strips unused fields, and caps the result so the response stays well under 1 MB.
//
// Query params:
//   country  — "US" or "CA" (default "US")

const DATA_BASE   = 'https://raw.githubusercontent.com/whatsonfreetv/whatsonfreetv-data/main';
const PLACEHOLDER = 'program information currently unavailable';
const MAX_PROGRAMS = 3000;

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

  try {
    const url = `${DATA_BASE}/epg-${country.toLowerCase()}.json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}`);

    const json     = await res.json();
    const programs = json.programs || [];

    const now      = Date.now();
    const lookback = now -  15 * 60 * 1000;   // 15 min ago  — drop recently-ended shows
    const horizon  = now +   4 * 60 * 60 * 1000; // +4 hours — enough for the mobile guide

    // 1. Filter to the time window and strip placeholder titles
    // 2. Sort by start time ascending
    // 3. Hard-cap at MAX_PROGRAMS to guarantee the response fits within Netlify's 6 MB limit
    // 4. Project to the five fields the client actually uses — drop channelLogo, description, etc.
    const slimmed = programs
      .filter(p => {
        const end   = p.end   ? new Date(p.end).getTime()   : NaN;
        const start = p.start ? new Date(p.start).getTime() : NaN;
        if (isNaN(end) || isNaN(start)) return false;
        if (end <= lookback || start >= horizon) return false;
        const title = (p.title || '').trim();
        if (!title || title.toLowerCase().startsWith(PLACEHOLDER)) return false;
        return true;
      })
      .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
      .slice(0, MAX_PROGRAMS)
      .map(p => ({
        channel:  p.channel  || '',
        title:    p.title    || '',
        start:    p.start    || '',
        end:      p.end      || '',
        platform: p.platform || '',
      }));

    return {
      statusCode: 200,
      headers: {
        ...CORS_HEADERS,
        'Content-Type':  'application/json',
        'Cache-Control': 'public, max-age=300',
      },
      body: JSON.stringify({ programs: slimmed, count: slimmed.length, filtered: true }),
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
