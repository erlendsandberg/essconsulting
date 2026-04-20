# ESS Consulting — Prosjektstyring

Intern prosjektstyringsapp for **ESS Consulting AS** (M&A og finansiell rådgivning, Hamar).
Daglig leder: Erlend Synnes-Sandberg, Autorisert finansanalytiker (AFA) | MRR, MBA.

---

## Arkitektur

**Single-file HTML-app** — all kode (HTML, CSS, JS) i `index.html`.
Ingen byggsteg, ingen npm, ingen bundler. Åpne filen i nettleser for lokal testing.

```
ess-consulting/
├── index.html                      ← hele appen (~8500+ linjer)
├── netlify.toml                    ← Netlify-konfig (functions-mappe)
├── package.json                    ← npm-deps for functions (firebase-admin)
├── netlify/
│   └── functions/
│       ├── ai.js                   ← Anthropic API-proxy
│       └── anmerkninger-ingest.js  ← betalingsanmerkninger-ingest (Firebase Admin)
└── CLAUDE.md                       ← denne filen
```

## Netlify miljøvariabler

| Variabel | Brukt av | Beskrivelse |
|---|---|---|
| `ANTHROPIC_API_KEY` | `ai.js` | Claude API-nøkkel |
| `INGEST_TOKEN` | `anmerkninger-ingest.js` | Shared secret for innsending av betalingsanmerkninger |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON` | `anmerkninger-ingest.js` | Komplett service-account-JSON fra Firebase Console (Project Settings → Service Accounts) |

**Hosting:** Netlify (deploy ved å dra mappen inn i Netlify-dashbordet)
**Database:** Google Firebase Firestore (compat SDK v10.12.0)
**AI:** Anthropic Claude via Netlify Function-proxy (`/.netlify/functions/ai`)
**Styling:** Tailwind CSS via CDN + egne CSS-variabler

---

## Firebase-konfigurasjon

```javascript
firebase.initializeApp({
  apiKey:            "AIzaSyC...",          // ikke endre
  authDomain:        "essc-246a1.firebaseapp.com",
  projectId:         "essc-246a1",
  storageBucket:     "essc-246a1.firebasestorage.app",
  appId:             "1:210538892469:web:d0a0b534f8e6f8571042fc"
});
const _fsDoc = firebase.firestore().collection('db').doc('main');
const _auth  = firebase.auth();
```

**VIKTIG:** Alt data lagres i ett enkelt Firestore-dokument (`db/main`).
Bruker Firebase compat SDK — **ikke** modular (ES modules) syntax.
Rett: `firebase.firestore()` — Feil: `import { getFirestore } from 'firebase/firestore'`

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
                          // Importeres fra Proff Forvalt-uttrekk (Excel) i Innstillinger.
                          // Adskilt fra customers — kan være leads/leverandører/konkurrenter.
  creditAlerts:     [],  // { id, orgNr, regDate (YYYY-MM-DD), type, amount, source,
                          //   refNr, status, creditor, ingestedAt }
                          // Importeres manuelt (Excel/CSV) eller via Netlify Function.
                          // Match til kunde/overvåket selskap via normalizeOrgNr().
};
```

**Status-verdier for prosjekter:**
`'ikke-startet'` | `'pagar'` | `'venter-kunde'` | `'venter-leveranse'` | `'klar-avslutning'` | `'avsluttet'`

**ActivityLog-typer:**
`'oppgave-fullfort'` | `'oppgave-gjenåpnet'` | `'notat'` | `'arbeidsnotat'` | `'status-endret'`

---

## Persistens

```javascript
function persistAll()       // debounce 800ms → skriver hele DB til Firestore
async function loadAll()    // leser DB fra Firestore ved oppstart
```

Firestore-reglene krever `request.auth != null` — brukeren må være innlogget.
Kall alltid `persistAll()` etter endringer i DB.
Kall alltid `render()` etter endringer som skal vises.

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
| `persistAll()` | 1841 | Lagrer DB til Firestore (debounce 800ms) |
| `loadAll()` | 1862 | Leser DB fra Firestore |
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
| `openProjectModal(id, prefill)` | 5805 | Opprett/rediger prosjekt (støtter prefill-objekt og inline ny kunde) |
| `saveProject(id)` | 5974 | Lagrer prosjekt fra modal |
| `openCustomerModal(id)` | 5730 | Opprett/rediger kunde |
| `toggleInlineNewCustomer()` | 5978 | Åpner inline ny-kunde-skjema i prosjektmodalen |
| `saveInlineNewCustomer()` | 5986 | Lagrer ny kunde fra inline-skjema |
| `openTaskModal(projectId, taskId)` | 6420 | Opprett/rediger oppgave |
| `toggleTask(taskId)` | 6570 | Fullfør/gjenåpne oppgave + logger aktivitet |
| `addNote(projectId)` | 6580 | Legg til notat + logger aktivitet |
| `logActivity(type, projId, tekst)` | 6555 | Skriv til aktivitetslogg |
| `getTodayLog()` | 6567 | Henter dagens loggposter |
| `saveWorkNote(projectId)` | 6608 | Lagrer rask arbeidskommentar fra I dag-siden |
| `openLoggHistorikk(dato, projId)` | 6792 | Åpner historikk-modal med datonavigasjon |
| `openDagrapportModal()` | 6939 | Vera genererer dagrapport |
| `exportDagrapportPDF(datoStr)` | 7034 | Eksporterer dagrapport som PDF |
| `handleDocUpload(event, projId)` | 6618 | Laster opp dokument, ekstraherer tekst |
| `aiSummarizeDoc(docId, projId)` | 6738 | AI-sammendrag av dokument → notat |
| `deleteDoc(docId, projId)` | 6722 | Sletter dokument |
| `openQuickEstimateModal()` | 4326 | Honorarestimering med BRREG-søk |
| `runVera(force)` | 4882 | Vera dashboard-analyse |
| `toggleVeraChat()` | 5017 | Vera chat-boble |
| `generateOppdragsPDF(projectId)` | 5302 | PDF engasjementsbrev |
| `callAI(prompt, tokens, system)` | 4002 | Kaller Anthropic API via proxy |
| `confirmDelete(type, id)` | 7058 | Slett prosjekt/kunde/oppgave + rydder relatert data |
| `showToast(msg, type)` | 7198 | Toast-notifikasjon |
| `confirmAction(title, msg, cb)` | 7180 | Bekreftelsesdialog |
| `uid()` | 1884 | Genererer unik ID |
| `now()` | 1893 | ISO-timestamp |
| `escHtml(str)` | 1962 | XSS-sikring |
| `_veraMarkdown(text)` | 5148 | Markdown → HTML (Vera-chat) |
| `_noteMarkdown(text)` | 5159 | Markdown → HTML (prosjektnotater) |

---

## Sletting — viktig: rydd opp relaterte data

Ved sletting av kunde eller prosjekt må **alle** relaterte data ryddes:

```javascript
// Prosjekt slettes:
DB.tasks       = DB.tasks.filter(t => t.projectId !== id);
DB.notes       = DB.notes.filter(n => n.projectId !== id);
DB.activityLog = DB.activityLog.filter(e => e.projectId !== id);
DB.documents   = DB.documents.filter(d => d.projectId !== id);
DB.projects    = DB.projects.filter(p => p.id !== id);

// Kunde slettes (finn prosjekt-IDer først):
const projIds = DB.projects.filter(p => p.customerId === id).map(p => p.id);
DB.tasks       = DB.tasks.filter(t => !projIds.includes(t.projectId));
DB.notes       = DB.notes.filter(n => !projIds.includes(n.projectId));
DB.activityLog = DB.activityLog.filter(e => !projIds.includes(e.projectId));
DB.documents   = DB.documents.filter(d => !projIds.includes(d.projectId));
DB.projects    = DB.projects.filter(p => p.customerId !== id);
DB.customers   = DB.customers.filter(c => c.id !== id);
```

---

## Datavern og migrering

**All data lever i Firestore** — ikke i `localStorage` eller nettleseren.
Det betyr at:
- Data overlever enhver endring av `index.html`
- Ny deployment endrer ikke data
- Å åpne appen i ny nettleser gir samme data (så lenge man er innlogget)
- Det er **trygt å erstatte `index.html`** uten å miste noe

For å eksportere/ta backup av data: Innstillinger → Eksporter JSON.

---

## Utvikling og testing

```bash
# Lokal testing uten Netlify Functions (AI vil ikke fungere):
open index.html

# Med Netlify CLI (AI fungerer lokalt):
npm install -g netlify-cli
netlify dev
```

**Merk:** Firebase kobler til prod-databasen uansett miljø.
Det finnes ingen separat dev-database. Vær forsiktig med testdata.

### Syntakssjekk
```bash
# Trekk ut script-blokken og sjekk med node:
python3 -c "
import re, sys
content = open('index.html').read()
scripts = list(re.finditer(r'<script>(.*?)</script>', content, re.DOTALL))
open('/tmp/check.js','w').write(scripts[-1].group(1))
"
node --check /tmp/check.js
```

### Deploy til Netlify
Dra `ess-consulting/`-mappen inn i Netlify-dashbordet (ikke ZIP).
Miljøvariabel `ANTHROPIC_API_KEY` må være satt i Netlify → Site settings → Environment variables.

---

## Eksterne biblioteker (lastes dynamisk ved behov)

| Bibliotek | URL | Brukes til |
|---|---|---|
| Firebase compat 10.12.0 | gstatic.com | Database og auth (alltid lastet) |
| jsPDF 2.5.1 | cdnjs | PDF-generering (engasjementsbrev, dagrapport) |
| pdf.js 3.11.174 | cdnjs | Tekstekstraksjon fra PDF-opplastinger |
| mammoth 1.6.0 | cdnjs | Tekstekstraksjon fra DOCX-opplastinger |
| SheetJS 0.18.5 | cdnjs | Tekstekstraksjon fra Excel-opplastinger |

---

## Kjente begrensninger

- Firestore-dokumentet (`db/main`) har en grense på 1MB. Aktivitetsloggen og dokumenttekster kan vokse over tid — dersom appen begynner å feile ved lagring er dette sannsynlig årsak. Løsning: del opp i separate Firestore-dokumenter.
- Dokumentopplasting leser tekst lokalt — selve filen lagres ikke, kun ekstrahert tekst (maks 80k tegn).
- PDF-lesing fungerer ikke for skannede dokumenter (bilder i PDF).
- Ingen separat testdatabase — all utvikling skjer mot prod-Firestore.
