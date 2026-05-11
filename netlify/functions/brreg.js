// GET /.netlify/functions/brreg?orgNr=XXXXXXXXX
// Proxy til Brønnøysund regnskapsregisteret API for å omgå CORS-begrensninger.
// Returnerer siste 3 årsregnskap for gitt org.nr som JSON-array.

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };
  }

  const orgNr = (event.queryStringParameters?.orgNr || '').replace(/\D/g, '');
  if (orgNr.length !== 9) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Ugyldig org.nr — må være 9 siffer' }),
    };
  }

  try {
    const res = await fetch(
      `https://data.brreg.no/regnskapsregisteret/regnskap/${orgNr}`,
      { headers: { Accept: 'application/json' } }
    );

    if (res.status === 404) {
      return {
        statusCode: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Ingen regnskap funnet' }),
      };
    }

    if (!res.ok) {
      return {
        statusCode: res.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: `Brreg svarte HTTP ${res.status}` }),
      };
    }

    const raw  = await res.json();
    const data = Array.isArray(raw) ? raw : (raw._embedded?.regnskap || []);

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(data.slice(0, 3)),
    };
  } catch (e) {
    return {
      statusCode: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `Nettverksfeil: ${e.message}` }),
    };
  }
};
