// GET /.netlify/functions/app-config
// Returnerer Supabase-konfigurasjon til klienten uten å eksponere
// nøkler i kildekoden. Verdiene leses fra Netlify miljøvariabler.
exports.handler = async () => ({
  statusCode: 200,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=3600',
  },
  body: JSON.stringify({
    url: process.env.SUPABASE_URL  || '',
    key: process.env.SUPABASE_ANON_KEY || '',
  }),
});
