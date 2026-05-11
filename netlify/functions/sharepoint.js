// POST /.netlify/functions/sharepoint
// Oppretter mappestruktur i OneDrive/SharePoint via Microsoft Graph API.
//
// Påkrevde Netlify-miljøvariabler:
//   AZURE_TENANT_ID     — Directory (tenant) ID fra Azure App Registration
//   AZURE_CLIENT_ID     — Application (client) ID fra Azure App Registration
//   AZURE_CLIENT_SECRET — Client secret fra Azure App Registration
//   ONEDRIVE_USER_EMAIL — E-post til brukeren hvis OneDrive skal brukes (f.eks. erlend@essc.no)
//
// Request body (JSON):
//   { projectName: string, dealId: string, folders: string[] }
//
// Returnerer:
//   { success: true, folderPath: string }  — ved suksess
//   { error: string }                       — ved feil

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const {
    AZURE_TENANT_ID,
    AZURE_CLIENT_ID,
    AZURE_CLIENT_SECRET,
    ONEDRIVE_USER_EMAIL,
  } = process.env;

  if (!AZURE_TENANT_ID || !AZURE_CLIENT_ID || !AZURE_CLIENT_SECRET || !ONEDRIVE_USER_EMAIL) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'SharePoint-integrasjon er ikke konfigurert. Sett AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET og ONEDRIVE_USER_EMAIL i Netlify-miljøvariabler.',
      }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Ugyldig JSON' }) };
  }

  const { projectName, dealId, folders } = body;
  if (!projectName || !dealId || !Array.isArray(folders)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Mangler projectName, dealId eller folders' }) };
  }

  // ── Steg 1: Hent tilgangstoken fra Microsoft ────────────────────────────────
  let accessToken;
  try {
    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type:    'client_credentials',
          client_id:     AZURE_CLIENT_ID,
          client_secret: AZURE_CLIENT_SECRET,
          scope:         'https://graph.microsoft.com/.default',
        }),
      }
    );
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      const msg = tokenData.error_description || tokenData.error || 'Ukjent feil ved token-henting';
      return { statusCode: 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: `Azure-autentisering feilet: ${msg}` }) };
    }
    accessToken = tokenData.access_token;
  } catch (e) {
    return { statusCode: 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: `Nettverksfeil mot Azure: ${e.message}` }) };
  }

  // ── Steg 2: Bygg mappenavn og API-basis ────────────────────────────────────
  // Mappenavn: "DEAL-2026-0001 – Salgsprosess – Optimera AS"
  // Saniterer bort tegn som er ulovlige i Windows/SharePoint-mappenavn
  const sanitize = s => s.replace(/[\\/:*?"<>|#%{}^[\]`]/g, '-').trim();
  const clientFolderName = sanitize(`${dealId} – ${projectName}`);

  const graphBase = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(ONEDRIVE_USER_EMAIL)}/drive`;
  const headers   = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };

  // Helper: opprett én mappe (ignorerer feil hvis den allerede finnes)
  async function createFolder(parentPath, name) {
    const url = `${graphBase}/root:/${parentPath}:/children`;
    const res = await fetch(url, {
      method:  'POST',
      headers,
      body: JSON.stringify({
        name,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'fail', // ikke overskriv eksisterende
      }),
    });
    const data = await res.json();
    // 409 Conflict = mappen finnes allerede — det er OK
    if (!res.ok && res.status !== 409) {
      throw new Error(`Graph API ${res.status}: ${data.error?.message || JSON.stringify(data)}`);
    }
    return data;
  }

  // ── Steg 3: Opprett klientmappe under Kunder/ ──────────────────────────────
  try {
    await createFolder('Kunder', clientFolderName);
  } catch (e) {
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `Klarte ikke opprette klientmappe: ${e.message}` }),
    };
  }

  // ── Steg 4: Opprett undermapper ────────────────────────────────────────────
  const errors = [];
  for (const folder of folders) {
    try {
      await createFolder(`Kunder/${clientFolderName}`, sanitize(folder));
    } catch (e) {
      errors.push(`${folder}: ${e.message}`);
    }
  }

  const folderPath = `Kunder/${clientFolderName}`;

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      success: true,
      folderPath,
      warnings: errors.length ? errors : undefined,
    }),
  };
};
