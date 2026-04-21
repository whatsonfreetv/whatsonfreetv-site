// Cloudflare Pages Function — Airtable proxy
// Set AIRTABLE_API_KEY and AIRTABLE_BASE_ID in Cloudflare Pages → Settings → Environment Variables.

const TABLE_NAME = 'Suggestions';

export async function onRequest(context) {
  const { env, request } = context;
  const key = env.AIRTABLE_API_KEY;
  const baseId = env.AIRTABLE_BASE_ID || 'app9FL5f1eCfoL5Lx';

  if (!key) {
    return new Response(
      JSON.stringify({ error: { message: 'AIRTABLE_API_KEY environment variable is not set.' } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const method = request.method;
  if (method !== 'GET' && method !== 'POST') {
    return new Response(
      JSON.stringify({ error: { message: 'Method not allowed' } }),
      { status: 405, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const { searchParams } = new URL(request.url);
  const recordId = searchParams.get('recordId');
  const table = searchParams.get('table');
  searchParams.delete('recordId');
  searchParams.delete('table');

  const tableName = table || TABLE_NAME;
  let url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}`;
  if (recordId) url += `/${encodeURIComponent(recordId)}`;

  const qs = searchParams.toString();
  if (qs) url += `?${qs}`;

  const options = {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json'
    }
  };

  if (method === 'POST') {
    options.body = await request.text();
  }

  const res = await fetch(url, options);
  const text = await res.text();

  return new Response(text, {
    status: res.status,
    headers: { 'Content-Type': 'application/json' }
  });
}
