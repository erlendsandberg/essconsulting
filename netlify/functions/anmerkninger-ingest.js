// POST /.netlify/functions/anmerkninger-ingest
//
// Tar imot betalingsanmerkninger fra ekstern automatisert tjeneste og merger
// dem inn i Firestore-dokumentet db/main (samme dokument som klient-appen leser).
//
// Krav i Netlify miljøvariabler:
//   INGEST_TOKEN                       — shared secret som klienten må sende i X-Ingest-Token
//   GOOGLE_APPLICATION_CREDENTIALS_JSON — komplett service-account-JSON som streng
//                                        (Firebase Console → Project Settings → Service Accounts)
//   RESEND_API_KEY                     — API-nøkkel fra resend.com for utsending av e-postrapport
//                                        (valgfri — e-post hoppes over hvis ikke satt)
//                                        Krever at essc.no er verifisert som avsenderdomene i Resend.
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

async function sendEmailReport(newAlerts, allAlerts, watchedCompanies) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return; // E-post ikke konfigurert — hopp over

  const dato = new Date().toLocaleDateString('nb-NO', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const companyName = (orgNr) => {
    const w = (watchedCompanies || []).find(c => normalizeOrgNr(c.orgNr) === orgNr);
    return w?.name || orgNr;
  };

  const alertRows = newAlerts.length > 0
    ? newAlerts.map(a => `
        <tr>
          <td style="padding:7px 12px;border-bottom:1px solid #e8e6df">${companyName(a.orgNr)}</td>
          <td style="padding:7px 12px;border-bottom:1px solid #e8e6df">${a.type || '—'}</td>
          <td style="padding:7px 12px;border-bottom:1px solid #e8e6df;text-align:right">${a.amount ? 'NOK ' + a.amount.toLocaleString('nb-NO') : '—'}</td>
          <td style="padding:7px 12px;border-bottom:1px solid #e8e6df">${a.creditor || '—'}</td>
          <td style="padding:7px 12px;border-bottom:1px solid #e8e6df;color:#666">${a.regDate || '—'}</td>
        </tr>`).join('')
    : `<tr><td colspan="5" style="padding:20px;text-align:center;color:#888;font-style:italic">Ingen nye anmerkninger denne uken</td></tr>`;

  const html = `
<!DOCTYPE html><html><body style="margin:0;padding:0;font-family:'Helvetica Neue',Arial,sans-serif;background:#f5f4f0">
<div style="max-width:680px;margin:32px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
  <div style="background:#1B2A4A;padding:24px 28px">
    <div style="font-size:11px;letter-spacing:0.1em;color:rgba(255,255,255,0.6);margin-bottom:6px">ESS CONSULTING AS</div>
    <h1 style="margin:0;font-size:20px;font-weight:600;color:#fff">Betalingsanmerkninger</h1>
    <div style="font-size:13px;color:rgba(255,255,255,0.75);margin-top:4px">Ukentlig rapport · ${dato}</div>
  </div>
  <div style="padding:24px 28px">
    <div style="display:flex;gap:24px;margin-bottom:20px">
      <div style="background:#fdf6ed;border-radius:6px;padding:12px 18px;flex:1;text-align:center">
        <div style="font-size:28px;font-weight:700;color:#B8742A">${newAlerts.length}</div>
        <div style="font-size:12px;color:#666;margin-top:2px">Nye anmerkninger</div>
      </div>
      <div style="background:#f5f4f0;border-radius:6px;padding:12px 18px;flex:1;text-align:center">
        <div style="font-size:28px;font-weight:700;color:#1B2A4A">${allAlerts.length}</div>
        <div style="font-size:12px;color:#666;margin-top:2px">Totalt i basen</div>
      </div>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead>
        <tr style="background:#f5f4f0">
          <th style="padding:8px 12px;text-align:left;font-weight:600;color:#444">Selskap</th>
          <th style="padding:8px 12px;text-align:left;font-weight:600;color:#444">Type</th>
          <th style="padding:8px 12px;text-align:right;font-weight:600;color:#444">Beløp</th>
          <th style="padding:8px 12px;text-align:left;font-weight:600;color:#444">Kreditor</th>
          <th style="padding:8px 12px;text-align:left;font-weight:600;color:#444">Dato</th>
        </tr>
      </thead>
      <tbody>${alertRows}</tbody>
    </table>
  </div>
  <div style="padding:16px 28px;background:#f5f4f0;font-size:12px;color:#888;text-align:center">
    Automatisk rapport fra ESS Consulting — betalingsanmerkninger overvåkes via forvalt.no
  </div>
</div>
</body></html>`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'ESS Consulting <no-reply@essc.no>',
      to: ['erlend.sandberg@gmail.com', 'sondre@hoyen.no', 'kenneth@hoyen.no'],
      subject: newAlerts.length > 0
        ? `Betalingsanmerkninger — ${newAlerts.length} nye · ${new Date().toLocaleDateString('nb-NO')}`
        : `Betalingsanmerkninger — ingen nye · ${new Date().toLocaleDateString('nb-NO')}`,
      html,
    }),
  });
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
  const existing         = Array.isArray(data.creditAlerts)  ? data.creditAlerts  : [];
  const watchedCompanies = Array.isArray(data.watchedCompanies) ? data.watchedCompanies : [];

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

  const allAlerts = newAlerts.length ? [...existing, ...newAlerts] : existing;

  // Oppdater scraperLog (maks 50 entries)
  const existingLog = Array.isArray(data.config?.scraperLog) ? data.config.scraperLog : [];
  const logEntry = {
    ts:          ingestedAt,
    added:       newAlerts.length,
    skipped,
    total:       incoming.length,
    totalAlerts: allAlerts.length,
  };
  const updatedLog = [...existingLog, logEntry].slice(-50);

  const updatePayload = {
    _savedAt:              ingestedAt,
    'config.lastIngest':   ingestedAt,
    'config.scraperLog':   updatedLog,
  };
  if (newAlerts.length) {
    updatePayload.creditAlerts = allAlerts;
  }
  await ref.update(updatePayload);

  // Send e-postrapport (feiler stille hvis RESEND_API_KEY ikke er satt)
  try {
    await sendEmailReport(newAlerts, allAlerts, watchedCompanies);
  } catch (e) {
    console.error('E-postutsending feilet:', e.message);
  }

  return jsonResponse(200, {
    added:   newAlerts.length,
    skipped,
    total:   incoming.length,
  });
};
