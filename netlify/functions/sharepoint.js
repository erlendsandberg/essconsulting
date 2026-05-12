// POST /.netlify/functions/sharepoint
// Oppretter mappestruktur i OneDrive via Microsoft Graph API.
//
// Struktur som opprettes:
//   Kunder/
//     └── {customerName}/          ← Opprettes hvis den ikke finnes
//           └── {dealId} {typeLabel}/  ← Alltid ny
//
// Påkrevde Netlify-miljøvariabler:
//   AZURE_TENANT_ID     — Directory (tenant) ID
//   AZURE_CLIENT_ID     — Application (client) ID
//   AZURE_CLIENT_SECRET — Client secret-verdi
//   ONEDRIVE_USER_EMAIL — E-post til OneDrive-eier (f.eks. erlend@essc.no)
//
// Request body: { customerName, dealId, typeLabel }
// Respons:      { success, customerFolder, projectFolder }

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
      body: JSON.stringify({ error: 'SharePoint-integrasjon er ikke konfigurert. Legg til AZURE_* og ONEDRIVE_USER_EMAIL i Netlify-miljøvariabler.' }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Ugyldig JSON' }) };
  }

  const { customerName, dealId, typeLabel } = body;
  if (!customerName || !dealId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Mangler customerName eller dealId' }) };
  }

  // ── Steg 1: Hent tilgangstoken ─────────────────────────────────────────────
  let accessToken;
  try {
    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token`,
      {
        method:  'POST',
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
      const msg = tokenData.error_description || tokenData.error || 'Ukjent feil';
      return {
        statusCode: 502,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: `Azure-autentisering feilet: ${msg}` }),
      };
    }
    accessToken = tokenData.access_token;
  } catch (e) {
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `Nettverksfeil mot Azure: ${e.message}` }),
    };
  }

  // ── Hjelpefunksjoner ────────────────────────────────────────────────────────
  const graphBase = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(ONEDRIVE_USER_EMAIL)}/drive`;
  const authHdr   = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };

  // Saniterer bort tegn som er ulovlige i OneDrive/Windows-mappenavn
  const sanitize = s => s
    .replace(/[\\/:*?"<>|#%{}^[\]`~]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200); // OneDrive maks mappenavn

  // Koder en OneDrive-sti korrekt: hvert segment enkodes, men / beholdes
  const encodePath = p => p.split('/').map(encodeURIComponent).join('/');

  // Sjekk om en sti finnes (returnerer item eller null)
  async function itemExists(path) {
    const res = await fetch(`${graphBase}/root:/${encodePath(path)}`, {
      headers: authHdr,
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(`Graph ${res.status}: ${d.error?.message || res.statusText}`);
    }
    return res.json();
  }

  // Opprett mappe under en gitt sti
  async function createFolder(parentPath, name) {
    const url = `${graphBase}/root:/${encodePath(parentPath)}:/children`;
    const res = await fetch(url, {
      method:  'POST',
      headers: authHdr,
      body: JSON.stringify({
        name,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'fail',
      }),
    });
    // 409 = finnes allerede — det er OK for kundemappe
    if (res.status === 409) return null;
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(`Graph ${res.status}: ${d.error?.message || res.statusText}`);
    }
    return res.json();
  }

  // ── Steg 2: Kundemappe — opprett hvis den ikke finnes ──────────────────────
  const customerFolder = sanitize(customerName);
  const customerPath   = `Kunder/${customerFolder}`;

  try {
    const exists = await itemExists(customerPath);
    if (!exists) {
      await createFolder('Kunder', customerFolder);
    }
  } catch (e) {
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `Klarte ikke opprette kundemappe «${customerFolder}»: ${e.message}` }),
    };
  }

  // ── Steg 3: Prosjektmappe — alltid ny ─────────────────────────────────────
  // Format: "DEAL-2026-0001 Salgsprosess"
  const projectFolder = sanitize(`${dealId}${typeLabel ? ' ' + typeLabel : ''}`);
  const projectPath   = `${customerPath}/${projectFolder}`;
  let projectFolderUrl = null;

  try {
    const created = await createFolder(customerPath, projectFolder);
    if (created?.webUrl) projectFolderUrl = created.webUrl;
  } catch (e) {
    if (!e.message.includes('409')) {
      return {
        statusCode: 502,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: `Klarte ikke opprette prosjektmappe «${projectFolder}»: ${e.message}` }),
      };
    }
  }

  // ── Steg 4: Undermapper — 01 Grunnlag / 02 Analyse & Leveranser / 03 Prosess & Signering
  const subfolders = [
    '01 Grunnlag',
    '02 Analyse & Leveranser',
    '03 Prosess & Signering',
  ];
  for (const sub of subfolders) {
    try {
      await createFolder(projectPath, sub);
    } catch (e) {
      // Ignorer 409 (finnes) og fortsett med neste
      if (!e.message.includes('409')) {
        console.error(`Undermappe «${sub}» feilet: ${e.message}`);
      }
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      success:           true,
      customerFolder:    customerPath,
      projectFolder:     projectPath,
      projectFolderUrl:  projectFolderUrl, // Direkte URL til mappen i OneDrive
    }),
  };
};
