// Netlify Function — Airtable proxy
// Keeps AIRTABLE_API_KEY server-side. Set it in Netlify → Site Settings → Environment Variables.

const BASE_ID    = process.env.AIRTABLE_BASE_ID    || 'app9FL5f1eCfoL5Lx';
const TABLE_NAME = 'Suggestions';

exports.handler = async (event) => {
  const key = process.env.AIRTABLE_API_KEY;

  if (!key) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: { message: 'AIRTABLE_API_KEY environment variable is not set.' } })
    };
  }

  // Only allow GET and POST
  const method = event.httpMethod;
  if (method !== 'GET' && method !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: { message: 'Method not allowed' } }) };
  }

  // Build the Airtable URL
  // `table` param lets the client target a different table (e.g. Programs).
  const { recordId, table, ...queryParams } = event.queryStringParameters || {};
  const tableName = table || TABLE_NAME;
  let url = `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(tableName)}`;
  if (recordId) url += `/${encodeURIComponent(recordId)}`;

  const qs = new URLSearchParams(queryParams).toString();
  if (qs) url += `?${qs}`;

  const options = {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json'
    }
  };

  if (method === 'POST' && event.body) {
    options.body = event.body;
  }

  const res  = await fetch(url, options);
  const text = await res.text();

  return {
    statusCode: res.status,
    headers: { 'Content-Type': 'application/json' },
    body: text
  };
};
