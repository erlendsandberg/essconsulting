# ESS Consulting — Prosjektstyring

Intern prosjektstyringsapp for **ESS Consulting AS** (M&A og finansiell rådgivning, Hamar).
Daglig leder: Erlend Synnes-Sandberg, Autorisert finansanalytiker (AFA) | MRR, MBA.

---

## Arkitektur

**Single-file HTML-app** — all kode (HTML, CSS, JS) i `index.html`.
Ingen byggsteg, ingen npm, ingen bundler. Åpne filen i nettleser for lokal testing.

```
ess-consulting/
├── index.html                      ← hele appen (~9600+ linjer)
├── netlify.toml                    ← Netlify-konfig (functions-mappe)
├── package.json                    ← npm-deps for functions (@supabase/supabase-js)
├── netlify/
│   └── functions/
│       ├── ai.js                   ← Anthropic API-proxy
│       └── anmerkninger-ingest.js  ← betalingsanmerkninger-ingest (Supabase)
└── CLAUDE.md                       ← denne filen
```

## Netlify miljøvariabler

| Variabel | Brukt av | Beskrivelse |
|---|---|---|
| `ANTHROPIC_API_KEY` | `ai.js` | Claude API-nøkkel |
| `INGEST_TOKEN` | `anmerkninger-ingest.js` | Shared secret for innsending av betalingsanmerkninger |
| `SUPABASE_URL` | `anmerkninger-ingest.js` | Supabase prosjekt-URL (f.eks. `https://qnhdtdctxhltiwofmjmj.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | `anmerkninger-ingest.js` | Service role-nøkkel (omgår RLS — kun server-side) |
| `RESEND_API_KEY` | `anmerkninger-ingest.js` | API-nøkkel fra resend.com — sender ukentlig e-postrapport til erlend/sondre/kenneth. Krever at `essc.no` er verifisert som avsenderdomene i Resend-dashbordet. Valgfri — e-post hoppes over hvis ikke satt. |

**Hosting:** Netlify (auto-deploy fra GitHub `main`-branch)
**Database:** Supabase PostgreSQL (prosjekt: `qnhdtdctxhltiwofmjmj`)
**Auth:** Supabase Auth — magic link (OTP e-post), ingen passord
**AI:** Anthropic Claude via Netlify Function-proxy (`/.netlify/functions/ai`)
**Styling:** Tailwind CSS via CDN + egne CSS-variabler

---

## Supabase-konfigurasjon

```javascript
const _supabase = supabase.createClient(
  'https://qnhdtdctxhltiwofmjmj.supabase.co',
  'sb_publishable_zo52TmhPZaHScF2-YC9V6w_luE8LUDq'  // anon/publishable key
);
```

**Auth:** Magic link via `_supabase.auth.signInWithOtp({ email })`.
**RLS:** Alle tabeller har Row Level Security — policy: `auth.email() = 'erlend.sandberg@gmail.com'`.
**Dashboard:** https://supabase.com/dashboard/project/qnhdtdctxhltiwofmjmj

---

## Database-skjema (Supabase PostgreSQL)

Alle tabeller bruker JSONB-mønster: `{ id TEXT PRIMARY KEY, data JSONB NOT NULL }`.
Dette minimerer kodeendringer — resten av appen jobber mot det samme JS-objektet (DB).

```sql
CREATE TABLE customers        (id TEXT PRIMARY KEY, data JSONB NOT NULL);
CREATE TABLE projects         (id TEXT PRIMARY KEY, data JSONB NOT NULL);
CREATE TABLE tasks            (id TEXT PRIMARY KEY, project_id TEXT, data JSONB NOT NULL);
CREATE TABLE notes            (id TEXT PRIMARY KEY, project_id TEXT, data JSONB NOT NULL);
CREATE TABLE documents        (id TEXT PRIMARY KEY, project_id TEXT, data JSONB NOT NULL);
CREATE TABLE activity_log     (id TEXT PRIMARY KEY, ts TIMESTAMPTZ, data JSONB NOT NULL);
CREATE TABLE watched_companies(org_nr TEXT PRIMARY KEY, data JSONB NOT NULL);
CREATE TABLE credit_alerts    (
  id TEXT PRIMARY KEY, org_nr TEXT NOT NULL, ref_nr TEXT NOT NULL DEFAULT '',
  reg_date TEXT NOT NULL, data JSONB NOT NULL, ingested_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (org_nr, ref_nr, reg_date));
CREATE TABLE config (
  id INTEGER PRIMARY KEY DEFAULT 1, ingest_token TEXT DEFAULT '',
  last_ingest TIMESTAMPTZ, scraper_log JSONB DEFAULT '[]');
```

---

## Datamodell

```javascript
let DB = {
  customers:        [],  // { id, name, orgNr, contact, email, phone, notes, createdAt }
  projects:         [],  // { id, customerId, projectType, name, description, consultant,
                          //   startDate, endDate, status, progress,
                          //   honorarEstimert, honorarAvtalt, honorarFakturert,
                          //   aiEstimates: [{createdAt, description, result}],
                          //   createdAt, updatedAt }
  tasks:            [],  // { id, projectId, name, description, assignee, dueDate, status,
                          //   fase, faseName, type, obligatorisk, _manual, completedAt, createdAt }
  notes:            [],  // { id, projectId, text, createdAt }
  activityLog:      [],  // { id, ts, type, projectId, taskId, tekst }
  documents:        [],  // { id, projectId, name, type, chars, text (maks 80k tegn), createdAt }
  watchedCompanies: [],  // { orgNr, name, contactPerson, email, phone, kommune, fylke,
                          //   naceCode, naceDesc, dagligLeder, styretsLeder, revisor,
                          //   sumSalgsinntekter, importedAt, customerId? }
  creditAlerts:     [],  // { id, orgNr, regDate (YYYY-MM-DD), type, amount, source,
                          //   refNr, status, creditor, ingestedAt }
  config:           { ingestToken: '', lastIngest: '' },
};
```

**Status-verdier for prosjekter:**
`'ikke-startet'` | `'pagar'` | `'venter-kunde'` | `'venter-leveranse'` | `'klar-avslutning'` | `'avsluttet'`

**ActivityLog-typer:**
`'oppgave-fullfort'` | `'oppgave-gjenåpnet'` | `'notat'` | `'arbeidsnotat'` | `'status-endret'`

---

## Persistens

```javascript
function persistAll()       // debounce 800ms → upsert alle endrede tabeller til Supabase
async function loadAll()    // leser alle tabeller fra Supabase ved oppstart
```

Supabase RLS krever gyldig sesjon — brukeren må være innlogget.
Kall alltid `persistAll()` etter endringer i DB.
Kall alltid `render()` etter endringer som skal vises.

**Sletting:** `persistAll()` gjør kun upsert — sletter aldri rader.
Ved sletting av objekter må du kalle Supabase DELETE eksplisitt
(dette håndteres av `confirmDelete()` og `resetAllData()`).

---

## Prosjekttyper og fasmaler

```javascript
const PROJECT_TYPES = [
  { key: 'verdivurdering', label: 'Verdivurdering',      icon: '💰' },
  { key: 'omorganisering', label: 'Omorganisering',      icon: '🔀' },
  { key: 'kontrakt',       label: 'Avtale / kontrakt',   icon: '📝' },
  { key: 'radgivning',     label: 'Generell rådgivning', icon: '💼' },
];
```

`PHASE_TEMPLATES` inneholder detaljerte fasemaler per prosjekttype med oppgaver og milepæler.
`getProjectPhaseInfo(projectId, typeKey)` — beregner fremdrift og neste steg.

---

## AI-integrasjon

### Netlify Function-proxy (`netlify/functions/ai.js`)
- Leser `ANTHROPIC_API_KEY` fra Netlify miljøvariabel
- Videresender til `https://api.anthropic.com/v1/messages`
- Støtter `system`, `tools` og `mcp_servers` i request body
- Modellnavnet er sentralisert i konstanten `AI_MODEL` (over `callAI()`). Endre der hvis du skal bytte modell — ikke hardkod nytt navn.
- Standardmodell: `claude-sonnet-4-6`

### callAI-helper
```javascript
async function callAI(prompt, maxTokens = 1000, systemPrompt = null)
```
Kaller `/.netlify/functions/ai` og returnerer tekstsvaret direkte.

### Vera — AI-assistent
- **Dashboard-kort:** `renderVeraShell()` / `runVera(force)` — 5-min cache
- **Chat-boble:** `toggleVeraChat()` / `_sendToVera(fullPrompt, displayText)`
- **Ukesrapport:** `openVeraWeekReport()`
- **Møteforberedelse:** `openVeraMeetingPrep()`
- **Dagrapport:** `openDagrapportModal()` / `exportDagrapportPDF(datoStr)`
- Vera får kontekst: alle aktive prosjekter + aktivitetslogg siste 30 dager
- Markdown-rendering: `_veraMarkdown(text)` (brukes i Vera-chat)
- Notat-rendering: `_noteMarkdown(text)` (brukes i prosjektnotater — støtter **fet**, *kursiv*, linjeskift)

---

## Navigasjon og rendering

```javascript
function navigate(view, extra = {})   // bytter side, oppdaterer APP-state
function render()                      // re-rendrer current view
```

**Views:** `'dashboard'` | `'projects'` | `'project-detail'` | `'customers'` |
`'customer-detail'` | `'followup'` | `'today'` | `'calendar'` | `'okonomi'` |
`'overvakning'` | `'anmerkninger'` | `'settings'`

**APP-state:**
```javascript
let APP = {
  view: 'dashboard',
  projectDetailId: null,
  customerDetailId: null,
  calMonthOffset: 0,
  timelineOffset: 0,
};
```

---

## Viktige konvensjoner

### JavaScript
- Vanilla JS — ingen React, Vue eller annet rammeverk
- `async/await` — ikke `.then()`-chaining
- Alle funksjoner som kalles fra HTML `onclick` må eksponeres globalt
  (de lever allerede i global scope siden det er én script-blokk — ikke bruk moduler)
- Statiske variabler deklareres utenfor `initApp()` for å unngå temporal dead zone
- Norske kommentarer i koden

### HTML/CSS
- Tailwind CSS via CDN for utilities
- CSS-variabler for farger: `var(--blue)`, `var(--red)`, `var(--green-pale)`, `var(--text)`, `var(--text-muted)`, `var(--border)`, `var(--bg)`, `var(--white)`
- Egne klasser: `.card`, `.card-header`, `.card-body`, `.card-title`, `.form-control`, `.btn`, `.btn-primary`, `.btn-secondary`, `.btn-ghost`, `.btn-sm`, `.badge`, `.activity-item`, `.today-task-row`

### Generelle regler
- Kall `persistAll()` etter alle DB-endringer
- Kall `render()` etter alle tilstandsendringer som påvirker visningen
- Bruk `uid()` for alle nye ID-er
- Bruk `now()` for alle timestamps (returnerer ISO-streng)
- Bruk `escHtml(str)` ved innsetting av brukerdata i HTML (XSS-sikring)
- Bruk `fmtNOK(val)` for norsk valutaformatering
- Bruk `fmtDate(iso)` for datoformatering
- Bruk `showToast(msg, type)` for brukernotifikasjoner (`'success'` | `'error'` | `'info'`)
- Bruk `confirmAction(title, msg, callback)` for destruktive handlinger

---

## Nøkkelfunksjoner — komplett oversikt

| Funksjon | Linje (ca.) | Beskrivelse |
|---|---|---|
| `persistAll()` | 1841 | Lagrer DB til Supabase (debounce 800ms, upsert) |
| `loadAll()` | 1862 | Leser alle tabeller fra Supabase |
| `navigate(view, extra)` | 1973 | Bytter visning |
| `render()` | 2000 | Re-rendrer current view |
| `renderDashboard()` | 2020 | Dashboard med KPI, varsler, Vera |
| `renderProjects()` | 2211 | Prosjektliste |
| `renderProjectDetail(id)` | 2690 | Prosjektdetalj med oppgaver, notater, dokumenter, historikk |
| `renderCustomers()` | 2366 | Kundeoversikt |
| `renderCustomerDetail(id)` | 3177 | Kundedetalj |
| `renderFollowup()` | 2431 | Oppfølgingsside |
| `renderToday()` | 3261 | I dag-side med aktivitetslogg |
| `renderCalendar()` | 3461 | Kalender med tidslinje |
| `renderOkonomi()` | 3600 | Økonomirapport |
| `renderSettings()` | 5563 | Innstillinger |
| `openProjectModal(id, prefill)` | 5805 | Opprett/rediger prosjekt |
| `saveProject(id)` | 5974 | Lagrer prosjekt fra modal |
| `openCustomerModal(id)` | 5730 | Opprett/rediger kunde |
| `toggleTask(taskId)` | 6570 | Fullfør/gjenåpne oppgave + logger aktivitet |
| `addNote(projectId)` | 6580 | Legg til notat + logger aktivitet |
| `logActivity(type, projId, tekst)` | 6555 | Skriv til aktivitetslogg |
| `handleDocUpload(event, projId)` | 6618 | Laster opp dokument, ekstraherer tekst |
| `runVera(force)` | 4882 | Vera dashboard-analyse |
| `toggleVeraChat()` | 5017 | Vera chat-boble |
| `generateOppdragsPDF(projectId)` | 5302 | PDF engasjementsbrev |
| `callAI(prompt, tokens, system)` | 4002 | Kaller Anthropic API via proxy |
| `confirmDelete(type, id)` | 7058 | Slett prosjekt/kunde/oppgave + Supabase DELETE |
| `resetAllData()` | ~8528 | Slett alt — Supabase DELETE + nullstill DB |
| `showToast(msg, type)` | 7198 | Toast-notifikasjon |
| `confirmAction(title, msg, cb)` | 7180 | Bekreftelsesdialog |
| `uid()` | 1884 | Genererer unik ID |
| `now()` | 1893 | ISO-timestamp |
| `escHtml(str)` | 1962 | XSS-sikring |
| `doLogin()` | ~9733 | Magic link OTP via Supabase Auth |
| `doLogout()` | ~9759 | Logg ut via Supabase Auth |

---

## Sletting — viktig: rydd opp relaterte data

Ved sletting av kunde eller prosjekt må **alle** relaterte data ryddes — både i DB-minnet
og med eksplisitte Supabase DELETE-kall (håndteres av `confirmDelete()`).

```javascript
// Prosjekt slettes:
DB.tasks       = DB.tasks.filter(t => t.projectId !== id);
DB.notes       = DB.notes.filter(n => n.projectId !== id);
DB.activityLog = DB.activityLog.filter(e => e.projectId !== id);
DB.documents   = DB.documents.filter(d => d.projectId !== id);
DB.projects    = DB.projects.filter(p => p.id !== id);
// + Supabase DELETE for tasks, notes, activity_log, documents, projects

// Kunde slettes (finn prosjekt-IDer først):
const projIds = DB.projects.filter(p => p.customerId === id).map(p => p.id);
// + filter alle relaterte arrays
// + Supabase DELETE for alle relaterte tabeller + customers
```

---

## Datavern og datasikkerhet

**All data lever i Supabase PostgreSQL** — ikke i `localStorage` eller nettleseren.
- Data overlever enhver endring av `index.html`
- Ny deployment endrer ikke data
- Å åpne appen i ny nettleser gir samme data (så lenge man er innlogget)
- Det er **trygt å erstatte `index.html`** uten å miste noe

**Lokale snapshots:** Automatisk backup i `localStorage` hvert 2. minutt (maks 20 snapshots).
Gjenopprettbar fra Innstillinger → Lokale snapshot-backups.

**Manuell backup:** Innstillinger → Eksporter JSON.

**Sikkerhetsbrems:** `_safeProjectCount` / `_safeCustomerCount` forhindrer at `persistAll()`
skriver til Supabase hvis antall prosjekter/kunder plutselig faller uventet.

---

## Utvikling og testing

```bash
# Lokal testing uten Netlify Functions (AI vil ikke fungere):
open index.html

# Med Netlify CLI (AI fungerer lokalt):
npm install -g netlify-cli
netlify dev
```

**Merk:** Supabase kobler til prod-databasen uansett miljø.
Det finnes ingen separat dev-database. Vær forsiktig med testdata.

### Syntakssjekk
```bash
python3 -c "
import re, sys
content = open('index.html').read()
scripts = list(re.finditer(r'<script>(.*?)</script>', content, re.DOTALL))
open('/tmp/check.js','w').write(scripts[-1].group(1))
"
node --check /tmp/check.js
```

### Deploy til Netlify
**Auto-deploy:** push til `main` på GitHub-repoet `erlendsandberg/essconsulting` —
Netlify bygger og publiserer automatisk innen 1–2 min.

```bash
git add .
git commit -m "Beskriv endringen"
git push
```

Miljøvariabler som må være satt i Netlify → Site settings → Environment variables:
- `ANTHROPIC_API_KEY` (Claude API)
- `INGEST_TOKEN` (shared secret for anmerkninger-ingest)
- `SUPABASE_URL` (Supabase prosjekt-URL)
- `SUPABASE_SERVICE_ROLE_KEY` (service role-nøkkel for server-side DB-tilgang)

---

## Eksterne biblioteker (lastes dynamisk ved behov)

| Bibliotek | URL | Brukes til |
|---|---|---|
| Supabase JS v2 | cdn.jsdelivr.net | Database og auth (alltid lastet) |
| jsPDF 2.5.1 | cdnjs | PDF-generering (engasjementsbrev, dagrapport) |
| pdf.js 3.11.174 | cdnjs | Tekstekstraksjon fra PDF-opplastinger |
| mammoth 1.6.0 | cdnjs | Tekstekstraksjon fra DOCX-opplastinger |
| SheetJS 0.18.5 | cdnjs | Tekstekstraksjon fra Excel-opplastinger |

---

## Kjente begrensninger

- Dokumentopplasting leser tekst lokalt — selve filen lagres ikke, kun ekstrahert tekst (maks 80k tegn).
- PDF-lesing fungerer ikke for skannede dokumenter (bilder i PDF).
- Ingen separat testdatabase — all utvikling skjer mot prod-Supabase.
- `ignoreDuplicates: true` i credit_alerts upsert: Supabase returnerer kun de faktisk innsatte radene, ikke de som ble hoppet over.
