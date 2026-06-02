// Scheduled function: kjøres automatisk hver 5. dag kl. 08:00 UTC
// Gjør en enkel spørring mot Supabase for å forhindre at prosjektet
// pauses på grunn av inaktivitet (Supabase Free-plan pauser etter 7 dager).

exports.handler = async () => {
  const url  = process.env.SUPABASE_URL;
  const key  = process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    console.error('keepalive: SUPABASE_URL eller SUPABASE_ANON_KEY mangler');
    return { statusCode: 500, body: 'Mangler miljøvariabler' };
  }

  try {
    const res = await fetch(`${url}/rest/v1/config?select=id&limit=1`, {
      headers: {
        apikey:        key,
        Authorization: `Bearer ${key}`,
      },
    });

    const msg = `Supabase ping: HTTP ${res.status} — ${new Date().toISOString()}`;
    console.log(msg);
    return { statusCode: 200, body: msg };
  } catch (e) {
    console.error('keepalive feilet:', e.message);
    return { statusCode: 502, body: `Feil: ${e.message}` };
  }
};
