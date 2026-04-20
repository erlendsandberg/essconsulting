// POST /.netlify/functions/anmerkninger-ingest
//
// Tar imot betalingsanmerkninger fra ekstern automatisert tjeneste og merger
// dem inn i Firestore-dokumentet db/main (samme dokument som klient-appen leser).
//
// Krav i Netlify miljøvariabler:
//   INGEST_TOKEN                       — shared secret som klienten må sende i X-Ingest-Token
//   GOOGLE_APPLICATION_CREDENTIALS_JSON — komplett service-account-JSON som streng
//                                        (Firebase Console → Project Settings → Service Accounts)
//
// Payload:
//   { "alerts": [
//       { "orgNr": "915137458", "regDate": "2026-03-24", "type": "Inkasso",
//         "amount": 211, "source": "SVEA FINANS AS", "refNr": "0000014620534",
//         "status": "", "creditor": "OPTIMERA AS" },
//       ...
//   ] }
//
// Dedup: samme (orgNr, refNr, regDate) hoppes over.
// Respons: { added, skipped, total }

const admin = require('firebase-admin');

// Init én gang per kald-start (Netlify gjenbruker container ved varme kall).
let _initDone = false;
function initFirebase() {
  if (_initDone) return;
  const credsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!credsJson) throw new Error('GOOGLE_APPLICATION_CREDENTIALS_JSON er ikke satt');
  const creds = JSON.parse(credsJson);
  admin.initializeApp({ credential: admin.credential.cert(creds) });
  _initDone = true;
}

function normalizeOrgNr(s) {
  if (s === null || s === undefined) return '';
  const digits = String(s).replace(/\D/g, '');
  if (digits.length < 9) return '';
  return digits.slice(-9);
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method Not Allowed' });
  }

  // Token-validering
  const expected = process.env.INGEST_TOKEN;
  if (!expected) {
    return jsonResponse(500, { error: 'INGEST_TOKEN ikke satt på serveren' });
  }
  const provided = event.headers['x-ingest-token'] || event.headers['X-Ingest-Token'];
  if (provided !== expected) {
    return jsonResponse(401, { error: 'Ugyldig eller manglende X-Ingest-Token' });
  }

  // Parse body
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return jsonResponse(400, { error: 'Ugyldig JSON-payload' });
  }
  const incoming = Array.isArray(payload.alerts) ? payload.alerts : null;
  if (!incoming) {
    return jsonResponse(400, { error: 'Forventet { alerts: [...] }' });
  }

  // Init Firebase Admin og hent dokumentet
  try {
    initFirebase();
  } catch (e) {
    return jsonResponse(500, { error: 'Firebase init feilet: ' + e.message });
  }
  const db   = admin.firestore();
  const ref  = db.collection('db').doc('main');
  const snap = await ref.get();
  const data = snap.exists ? snap.data() : {};
  const existing = Array.isArray(data.creditAlerts) ? data.creditAlerts : [];

  // Dedup-set (orgNr|refNr|regDate)
  const seen = new Set(existing.map(a => `${normalizeOrgNr(a.orgNr)}|${a.refNr || ''}|${a.regDate || ''}`));

  const ingestedAt = new Date().toISOString();
  const newAlerts = [];
  let skipped = 0;
  for (const raw of incoming) {
    const orgNr = normalizeOrgNr(raw.orgNr || raw.orgnr);
    const regDate = String(raw.regDate || raw.dato || '').slice(0, 10);
    const refNr = String(raw.refNr || raw.referansenr || '').trim();
    if (!orgNr || !regDate) { skipped++; continue; }
    const key = `${orgNr}|${refNr}|${regDate}`;
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);
    newAlerts.push({
      id:       uid(),
      orgNr,
      regDate,
      type:     String(raw.type || '').trim(),
      amount:   Number(raw.amount || raw.belop || raw.beløp) || 0,
      source:   String(raw.source || raw.kilde || '').trim(),
      refNr,
      status:   String(raw.status || '').trim(),
      creditor: String(raw.creditor || raw.kreditor || '').trim(),
      ingestedAt,
    });
  }

  if (newAlerts.length) {
    await ref.update({
      creditAlerts: [...existing, ...newAlerts],
      _savedAt: ingestedAt,
    });
  }

  return jsonResponse(200, {
    added:   newAlerts.length,
    skipped,
    total:   incoming.length,
  });
};
