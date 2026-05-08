// POST /.netlify/functions/ai
// Proxy til Anthropic API. Har en 22-sekunders intern timeout (under Netlify sin 26s grense).
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: { message: 'ANTHROPIC_API_KEY ikke satt i Netlify miljøvariabler' } }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: { message: 'Ugyldig JSON i forespørsel' } }) };
  }

  // Intern timeout: 22 s — gir klienten tid til å motta en ren feilmelding
  // før Netlify eventuelt dreper funksjonen etter 26 s
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 22000);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      body.model      || 'claude-sonnet-4-6',
        max_tokens: body.max_tokens || 1000,
        messages:   body.messages,
        ...(body.system ? { system: body.system } : {}),
        ...(body.tools  ? { tools:  body.tools  } : {}),
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    const data = await res.json();
    return {
      statusCode: res.status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err.name === 'AbortError';
    return {
      statusCode: isTimeout ? 504 : 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: {
          message: isTimeout
            ? 'AI-kallet tok for lang tid (>22 s). Prøv et kortere dokument eller spørsmål.'
            : err.message,
        },
      }),
    };
  }
};
