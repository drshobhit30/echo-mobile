/* ======================================================================
   ECHO NEXUS — PHONE RELAY  (r3.7, 17 Sep 2026)

   The phone apps (lite.html, admin.html) never sign in to Google. They ask
   this script instead, and this script reads the clinic folder as the
   clinic's own Google account. It writes only its own three things - a
   booking waiting to be filed, a phone's notification subscription, and the
   list of phones - and never a clinic file.

   WHO MAY READ WHAT
     lite key                 calendar, visits, patient names and age/sex,
                              prescriptions, doctors, closures.
                              NEVER phone numbers, NEVER money.
     admin key, locked        exactly what lite gets.
     admin key + right PIN    everything the admin app shows.

   THE PIN is set in Nexus (Settings → Clinic setup → Phone app PIN). Nexus
   saves only a salted SHA-256 of it, in settings/phone-admin-pin.json; this
   script hashes what the phone sends the same way and compares. Five wrong
   PINs lock admin for 15 minutes. A right PIN returns a session that lasts
   until the phone drops it (app closed, phone locked) - or six hours at the
   very most, which is as long as Google keeps a cache entry.

   THE TIMER (r2.0). Every 5 minutes warmCache reads what changed in the
   clinic folder - appointments and visits from 7 days back to 14 ahead, and
   lite's settings - into Google's fast memory. Phones are answered from it
   in about a second; anything outside it is read from Drive as before. A
   phone that pulls to refresh sends fresh=1, which sweeps for changes first
   so the answer is current without reading the fortnight again (r3.0). Run
   startTimer once to begin, stopTimer to end.

   BOOKING FROM A PHONE (r2.2). The one thing this script writes: a single
   small file per booking into booking-inbox/. It never touches the calendar
   files - Nexus on the clinic PC files each booking into the day itself, so
   the PC stays the only writer of appointments/. Existing patients only;
   a rough slot may carry a free name, as on the desk. Today onwards.

   ONE RUN, MANY FILES (r3.0). The admin money screens used to ask for a
   dozen files as a dozen requests. The 'batch' action reads them all in one
   run instead: one request's worth of overhead rather than twelve, and one
   place to look when something is slow. Finished day books are kept warm
   too, so catching up costs no Drive read at all.

   THE WARM-UP, MADE CHEAP (r3.0). It used to ask Drive about each day file
   by name to see what had changed - 44 lookups every five minutes - and the
   Executions log showed runs of 20 to 70 seconds and a 4% error rate for
   it. It now asks each folder ONE question: what changed since last time.

   THE POSTMAN (r3.4). Chrome will not let Nexus post to a push service from
   a page opened off the disk, so 'pushSend' does it for it. Nexus encrypts
   and signs; this script only forwards the sealed bytes to the address in
   that phone's own subscription file. It cannot read what it carries.

   PHONES (r3.0). Two more small things live in phones/: where to push a
   notification to (one file per handset, written when a phone asks), and
   which app and version each phone is running, which is built from ordinary
   traffic and flushed by the timer. Nexus reads both. The signing key for
   notifications is made by Nexus and kept in settings/push-keys.json, which
   NO read action here can reach - only its public half is ever handed out.

   INSTALL: see RELAY-SETUP.md. In short - paste this file into a new Apps
   Script project on the clinic's Google account, set FOLDER_ID, run
   setupEchoRelay() once, deploy as a web app (Execute as: Me; Who has
   access: Anyone), then run showSetupLinks() and send each link to the
   right phone.
   ====================================================================== */

/* ---- filled in for Echo Dental Clinic (16 Sep 2026) --------------------- */
/* The ID of the clinic folder on Google Drive - the one that contains
   settings/, visits/, appointments/ and the rest. It is the long code at the
   end of the folder's address in the browser. */
const FOLDER_ID = '1kUt_JbkP1k_S7vLK_w5dyrzpxS59AiNX';

/* Where the phone apps live (GitHub Pages). Used only to build the setup
   links; change if the apps move. */
const LITE_APP_URL  = 'https://drshobhit30.github.io/echo-mobile/lite.html';
const ADMIN_APP_URL = 'https://drshobhit30.github.io/echo-mobile/admin.html';

/* THE LIVE ADDRESS OF THIS RELAY - the one ending in /exec, copied from
   Deploy → Manage deployments → Web app URL. Needed because, run from the
   editor, Google reports the /dev TEST address instead, which only answers
   someone signed in to this Google account: a phone given it reads nothing. */
const RELAY_EXEC_URL = 'https://script.google.com/macros/s/AKfycbyKlQT1n-mO6pVktGBhs_Ivy88uDJ079TSAFkPjEtU8IswsCbh1bbsFyB97T2t0F9UG8A/exec';

/* ---- what each level may read ------------------------------------------ */
const LITE_SETTINGS = [
  'patients.json', 'patient-contacts.json', 'prescriptions-index.json',
  'doctors.json', 'calendar-blocks.json'
];
const ADMIN_SETTINGS = LITE_SETTINGS.concat([
  'bills-index.json', 'entries-index.json', 'implant-log.json', 'labcases-index.json',
  'patient-crm.json', 'patient-notes-log.json', 'followups.json', 'ortho-patients.json',
  'patient-created-at.json', 'visits-index.json'
]);
const LITE_FOLDERS  = ['visits', 'appointments', 'prescriptions'];
const ADMIN_FOLDERS = LITE_FOLDERS.concat(['data', 'bills', 'labcases']);

const PIN_FILE = 'phone-admin-pin.json';
/* Admin's two big money files, kept warm too (r2.1). The memory is only a
   copy: readSettings_ still refuses them without a session. */
const ADMIN_WARM = ['bills-index.json', 'entries-index.json', 'labcases-index.json', 'implant-log.json', 'patient-crm.json',
  'patient-notes-log.json', 'followups.json', 'ortho-patients.json', 'patient-created-at.json', 'visits-index.json'];
const PIN_MAX_TRIES = 5;
const PIN_LOCK_SECONDS = 15 * 60;
const SESSION_SECONDS = 6 * 60 * 60;   // Google's cache ceiling
const WEEK_MAX_DAYS = 21;

/* ======================================================================
   ENTRY
   ====================================================================== */
function doGet(e){
  let out;
  try{
    out = handle_((e && e.parameter) || {});
  }catch(err){
    out = { ok: false, error: 'relay error: ' + (err && err.message ? err.message : String(err)) };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

function handle_(p){
  const role = roleForKey_(String(p.key || ''));
  if(!role) return { ok: false, error: 'bad key' };
  const action = String(p.action || 'ping');
  noteDevice_(p, role);

  if(action === 'ping') return { ok: true, role: role, pinSet: !!readPinRecord_() };

  if(action === 'unlock'){
    if(role !== 'admin') return { ok: false, error: 'not an admin key' };
    return unlock_(String(p.pin || ''), String(p.device || '').slice(0, 40));
  }

  /* The level this request reads at: admin only with a live session. */
  const level = (role === 'admin' && sessionIsLive_(String(p.session || ''))) ? 'admin' : 'lite';
  if(role === 'admin' && p.session && level !== 'admin'){
    /* Said, not silently downgraded: the app must drop back to lite. */
    return { ok: false, error: 'session ended', locked: true };
  }

  const since = String(p.since || '');
  const fresh = p.fresh === '1';
  /* How many years of prescriptions the phone wants in the index (r2.9).
     0 or missing means all of them, which is what an older app sends. */
  const rxYears = Math.max(0, Math.min(50, parseInt(p.rxYears || '0', 10) || 0));
  if(action === 'rxFor') return rxForPatient_(String(p.pid || ''));
  if(action === 'settingsAll') return readSettingsAll_(level, String(p.sinceMap || ''), fresh, rxYears);
  if(action === 'settings') return readSettings_(String(p.name || ''), level, since, fresh, rxYears);
  if(action === 'pushKey')  return pushKey_();
  if(action === 'pushSub')  return pushSub_(p, role);
  if(action === 'pushOff')  return pushOff_(p, role);
  if(action === 'pushSend') return pushSend_(p, role);
  if(action === 'deviceForget') return deviceForget_(p, role);
  if(action === 'deviceName')   return deviceName_(p, role);
  if(action === 'batch')    return readBatch_(String(p.items || ''), level, rxYears);
  if(action === 'day')      return readDay_(String(p.folder || ''), String(p.date || ''), level, since);
  if(action === 'week')     return readWeek_(String(p.from || ''), String(p.to || ''), level, fresh);
  if(action === 'list')     return listFolder_(String(p.folder || ''), level);
  if(action === 'file')     return readRecord_(String(p.folder || ''), String(p.name || ''), level, since);
  if(action === 'book')   return book_(String(p.booking || ''));
  if(action === 'lookup') return lookupPhone_(String(p.q || ''));
  if(action === 'bookingStatus') return bookingStatus_(String(p.ids || ''));
  if(action === 'lock'){
    if(p.session) CacheService.getScriptCache().remove('sess:' + p.session);
    return { ok: true };
  }
  return { ok: false, error: 'unknown action' };
}

/* ======================================================================
   KEYS
   ====================================================================== */
function roleForKey_(key){
  if(!key) return null;
  const props = PropertiesService.getScriptProperties();
  if(key === props.getProperty('ADMIN_KEY')) return 'admin';
  if(key === props.getProperty('LITE_KEY')) return 'lite';
  return null;
}
function newKey_(){
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

/* Run ONCE after pasting, before the first deploy. Makes both keys. Running
   it again does nothing to keys that already exist. */
function setupEchoRelay(){
  const props = PropertiesService.getScriptProperties();
  if(!props.getProperty('LITE_KEY')) props.setProperty('LITE_KEY', newKey_());
  if(!props.getProperty('ADMIN_KEY')) props.setProperty('ADMIN_KEY', newKey_());
  const root = DriveApp.getFolderById(FOLDER_ID);   // throws if FOLDER_ID is wrong
  Logger.log('Relay ready for folder: ' + root.getName());
  Logger.log('Next: Deploy → New deployment → Web app, then run showSetupLinks().');
}

/* Prints the two setup links. Send the LITE link to reception and staff
   phones, the ADMIN link only to your own. */
function showSetupLinks(){
  const props = PropertiesService.getScriptProperties();
  const url = RELAY_EXEC_URL;
  if(!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(url)){
    Logger.log('Set RELAY_EXEC_URL at the top first: Deploy → Manage deployments → copy the Web app URL (it ends in /exec).');
    return;
  }
  const link = (app, key) => app + '#relay=' + encodeURIComponent(url) + '&key=' + encodeURIComponent(key);
  Logger.log('LITE (reception / staff):\n' + link(LITE_APP_URL, props.getProperty('LITE_KEY')));
  Logger.log('ADMIN (your phones only):\n' + link(ADMIN_APP_URL, props.getProperty('ADMIN_KEY')));
}

/* A phone lost, or a link sent to the wrong person: run the matching one.
   Every phone on that app stops working until it opens the new link. */
function changeLiteKey(){
  PropertiesService.getScriptProperties().setProperty('LITE_KEY', newKey_());
  Logger.log('Lite key changed. Run showSetupLinks() and resend the lite link.');
}
function changeAdminKey(){
  PropertiesService.getScriptProperties().setProperty('ADMIN_KEY', newKey_());
  Logger.log('Admin key changed. Run showSetupLinks() and resend the admin link.');
}

/* ======================================================================
   PIN AND SESSION
   ====================================================================== */
function readPinRecord_(){
  const f = settingsFile_(PIN_FILE);
  if(!f) return null;
  try{
    const rec = JSON.parse(f.getBlob().getDataAsString());
    return (rec && rec.hash && rec.salt) ? rec : null;
  }catch(e){ return null; }
}
function sha256Hex_(text){
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytes.map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join('');
}
/* r2.8 audit: wrong tries are counted PER PHONE (the device tag it sends),
   so somebody guessing on one phone cannot lock the owner out on another;
   a wider cap across all phones still stops a slow sweep. */
function unlock_(pin, device){
  const cache = CacheService.getScriptCache();
  const failKey = 'pinfail:' + (device || 'nodevice');
  const allKey = 'pinfail:all';
  const allFails = parseInt(cache.get(allKey) || '0', 10);
  if(allFails >= PIN_MAX_TRIES * 4) return { ok: false, error: 'too many tries', lockedFor: PIN_LOCK_SECONDS };
  const fails = parseInt(cache.get(failKey) || '0', 10);
  if(fails >= PIN_MAX_TRIES){
    return { ok: false, error: 'too many tries', lockedFor: PIN_LOCK_SECONDS };
  }
  /* The PIN record from memory first (the timer keeps it); a PIN that does
     not match it is checked once more against the file itself, so a PIN
     changed in Nexus a minute ago works at once. */
  const matches = (r) => !!r && /^\d{4}$/.test(pin) && sha256Hex_(r.salt + pin) === r.hash;
  let rec = cacheGetJson_('pin');
  if(!matches(rec)){
    rec = readPinRecord_();
    if(rec) cachePutJson_('pin', rec);
  }
  if(!rec) return { ok: false, error: 'no PIN set' };
  if(!matches(rec)){
    const n = fails + 1;
    cache.put(failKey, String(n), PIN_LOCK_SECONDS);
    cache.put(allKey, String(allFails + 1), PIN_LOCK_SECONDS);
    return n >= PIN_MAX_TRIES
      ? { ok: false, error: 'too many tries', lockedFor: PIN_LOCK_SECONDS }
      : { ok: false, error: 'wrong PIN', triesLeft: PIN_MAX_TRIES - n };
  }
  cache.remove(failKey);
  const session = newKey_();
  cache.put('sess:' + session, '1', SESSION_SECONDS);
  return { ok: true, session: session };
}
function sessionIsLive_(session){
  if(!session) return false;
  return CacheService.getScriptCache().get('sess:' + session) === '1';
}

/* ======================================================================
   READING
   ====================================================================== */
function rootFolder_(){ return DriveApp.getFolderById(FOLDER_ID); }
function subFolder_(name){
  const it = rootFolder_().getFoldersByName(name);
  return it.hasNext() ? it.next() : null;
}
function settingsFile_(name){
  const s = subFolder_('settings');
  if(!s) return null;
  const it = s.getFilesByName(name);
  return it.hasNext() ? it.next() : null;
}
function parseOrNull_(file){
  if(!file) return null;
  try{ return JSON.parse(file.getBlob().getDataAsString()); }catch(e){ return null; }
}

/* Lite never sees a phone number: stripped here, not merely hidden on the
   phone, so a lite key cannot fetch them by any route. */
function stripContacts_(map){
  const out = {};
  Object.keys(map || {}).forEach(pid => {
    const r = Object.assign({}, map[pid] || {});
    delete r.numbers;
    out[pid] = r;
  });
  return out;
}
function stripBookings_(list){
  return (list || []).map(a => { const r = Object.assign({}, a); delete r.newPhone; return r; });
}

/* UNCHANGED FILES ARE NOT SENT AGAIN (r1.1). The phone says which version
   it holds; if the file has not changed since, only "not modified" goes
   back - the bills index is the clinic's largest file. */
function notModified_(f, since){
  return !!(since && f && f.getLastUpdated().toISOString() === since);
}
function readSettings_(name, level, since, fresh, rxYears){
  const allowed = level === 'admin' ? ADMIN_SETTINGS : LITE_SETTINGS;
  if(allowed.indexOf(name) === -1) return { ok: false, error: 'not allowed', locked: level !== 'admin' };
  if(!fresh && (LITE_SETTINGS.indexOf(name) !== -1 || ADMIN_WARM.indexOf(name) !== -1)){
    const held = cacheGetJson_('set:' + name);
    if(held){
      if(since && held.modified === since) return { ok: true, name: name, notModified: true, modified: since };
      let v = held.value;
      if(name === 'patient-contacts.json' && level !== 'admin') v = stripContacts_(v);
      if(name === RX_INDEX && rxYears) v = trimRxIndex_(v, rxYears);
      return { ok: true, name: name, value: v, modified: held.modified, cached: true };
    }
  }
  const f = settingsFile_(name);
  if(!f) return { ok: true, name: name, value: null, modified: null };
  if(notModified_(f, since)) return { ok: true, name: name, notModified: true, modified: since };
  let value = parseOrNull_(f);
  const modified = f.getLastUpdated().toISOString();
  if(LITE_SETTINGS.indexOf(name) !== -1 || ADMIN_WARM.indexOf(name) !== -1) cachePutJson_('set:' + name, { value: value, modified: modified });
  if(name === 'patient-contacts.json' && level !== 'admin') value = stripContacts_(value);
  if(name === RX_INDEX && rxYears) value = trimRxIndex_(value, rxYears);
  return { ok: true, name: name, value: value, modified: modified };
}

function validDate_(d){ return /^\d{4}-\d{2}-\d{2}$/.test(d); }

function readDay_(folder, date, level, since){
  const allowed = level === 'admin' ? ADMIN_FOLDERS : LITE_FOLDERS;
  if(allowed.indexOf(folder) === -1 || folder === 'prescriptions' || folder === 'bills' || folder === 'labcases'){
    return { ok: false, error: 'not allowed', locked: level !== 'admin' };
  }
  if(!validDate_(date)) return { ok: false, error: 'bad date' };
  /* A FINISHED DAY BOOK COMES FROM MEMORY (r3.0). The money screens read a
     run of past days to catch up, and those are the reads worth sparing.
     TODAY is always read live - money moves while the day is open.

     Only inside the warm window. A copy is safe to serve because the timer
     re-checks these days every five minutes and replaces any that changed at
     the desk, so a correction shows within five minutes. An older day gets
     no such check, and a six-hour-stale figure is worse than a Drive read,
     so anything before the window always goes to Drive. */
  const today0 = clinicToday_();
  const warm = (folder === 'data' && date < today0 && date >= addDaysStr_(today0, -WARM_DAYS_BACK));
  if(warm){
    const c = cacheGetJson_('dayf:data:' + date);
    if(c){
      if(since && c.modified === since) return { ok: true, folder: folder, date: date, notModified: true, modified: since };
      return { ok: true, folder: folder, date: date, value: c.value, modified: c.modified || null };
    }
  }
  const dir = subFolder_(folder);
  const it = dir ? dir.getFilesByName(date + '.json') : null;
  const f = it && it.hasNext() ? it.next() : null;
  if(notModified_(f, since)) return { ok: true, folder: folder, date: date, notModified: true, modified: since };
  let value = parseOrNull_(f);
  if(folder === 'appointments' && level !== 'admin') value = stripBookings_(value);
  const modified = f ? f.getLastUpdated().toISOString() : null;
  if(warm) cachePutJson_('dayf:data:' + date, { value: value, modified: modified });
  return { ok: true, folder: folder, date: date, value: value, modified: modified };
}

/* A WEEK IN ONE REQUEST: appointments and visits for every day from..to.
   This is what makes the phone calendar one round trip instead of fourteen. */
function readWeek_(from, to, level, fresh){
  if(!validDate_(from) || !validDate_(to) || to < from) return { ok: false, error: 'bad range' };
  const days = [];
  const start = new Date(from + 'T00:00:00Z'), end = new Date(to + 'T00:00:00Z');
  for(let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)){
    days.push(d.toISOString().slice(0, 10));
    if(days.length > WEEK_MAX_DAYS) return { ok: false, error: 'range too long' };
  }
  /* PULL TO REFRESH USED TO READ THE WHOLE FORTNIGHT (r3.0). Skipping the
     memory meant 42 Drive lookups in a single request - the 21-second run
     in the Executions log, and the one request a person actually sits and
     waits for. Asking Drive what changed costs four searches and re-reads
     only the days that moved, so the answer is exactly as fresh and arrives
     in a fraction of the time. If the sweep cannot run, the days fall
     through to being read one by one below, as before. */
  const trustMemory = fresh ? warmSweepNow_() : true;
  const out = {};
  const need = [];
  days.forEach(day => {
    const held = trustMemory ? cacheGetJson_('day:' + day) : null;
    if(held) out[day] = held; else need.push(day);
  });
  if(need.length){
    let read = {};
    try{ read = readDaysFromDrive_(need); }catch(e){ read = {}; }
    need.forEach(day => {
      const r = read[day];
      if(r && !r.failed){ out[day] = r; cachePutJson_('day:' + day, r); }
      else { const held = cacheGetJson_('day:' + day); if(held) out[day] = held; }   // Drive refused: the ready copy stands
    });
  }
  const shaped = {};
  days.forEach(day => {
    const d = out[day] || { appointments: [], visits: [], modified: null };
    shaped[day] = {
      appointments: level === 'admin' ? (d.appointments || []) : stripBookings_(d.appointments || []),
      visits: d.visits || [],
      modified: d.modified || null
    };
  });
  return { ok: true, from: from, to: to, days: shaped, cachedDays: days.length - need.length };
}

function listFolder_(folder, level){
  const allowed = level === 'admin' ? ADMIN_FOLDERS : LITE_FOLDERS;
  if(allowed.indexOf(folder) === -1) return { ok: false, error: 'not allowed', locked: level !== 'admin' };
  const dir = subFolder_(folder);
  const names = [];
  if(dir){
    const it = dir.getFiles();
    while(it.hasNext()){
      const f = it.next();
      names.push({ name: f.getName(), modified: f.getLastUpdated().toISOString() });
    }
  }
  names.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { ok: true, folder: folder, files: names };
}

function readRecord_(folder, name, level, since){
  const allowed = level === 'admin' ? ADMIN_FOLDERS : LITE_FOLDERS;
  if(allowed.indexOf(folder) === -1) return { ok: false, error: 'not allowed', locked: level !== 'admin' };
  if(!/^[A-Za-z0-9._-]+\.json$/.test(name)) return { ok: false, error: 'bad name' };
  const dir = subFolder_(folder);
  const it = dir ? dir.getFilesByName(name) : null;
  const f = it && it.hasNext() ? it.next() : null;
  if(notModified_(f, since)) return { ok: true, folder: folder, name: name, notModified: true, modified: since };
  let value = parseOrNull_(f);
  if(folder === 'appointments' && level !== 'admin') value = stripBookings_(value);
  return { ok: true, folder: folder, name: name, value: value, modified: f ? f.getLastUpdated().toISOString() : null };
}

/* ======================================================================
   PHONES (r3.0)

   Two things live here, both about the handsets rather than the clinic:
   where to push a notification to, and which app each phone is running.

   Neither is written by a phone directly. A phone asks, this script writes -
   so the same rule holds as for bookings: a phone is never a second writer
   of the clinic's own files. Everything lands in one folder, 'phones', which
   Nexus reads.

   The VAPID private key is NOT here. It sits in settings/push-keys.json,
   which no read action can reach - the settings actions work from an
   allow-list and that file is not on it. Only the public half ever leaves.
   ====================================================================== */
const PHONES = 'phones';
const PUSH_KEYS_FILE = 'push-keys.json';
const DEVICES_FILE = 'devices.json';
const DEVICE_KEEP_DAYS = 30;
const DEVICE_MAX = 40;
const DEV_RE = /^[A-Za-z0-9_-]{4,40}$/;

/* A FOLDER IN THE BIN IS STILL FOUND (r3.3).

   Drive keeps a trashed folder findable by name, so getFoldersByName hands
   one back quite happily - and then every write into it fails with "Access
   denied", which reads like a permission problem and is not one. That is
   exactly what happened the first time a phone tried to subscribe: the
   folder had been made on the PC, had gone to the bin, and the script kept
   picking it up.

   Anything in the bin is passed over, and the first live folder wins. If
   there is none, a fresh one is made here - by the script, which then owns
   it and can certainly write to it. */
function phonesFolder_(){ return liveFolder_(PHONES); }
function liveFolder_(name){
  const root = rootFolder_();
  const it = root.getFoldersByName(name);
  while(it.hasNext()){
    const f = it.next();
    let dead = false;
    try{ dead = !!f.isTrashed(); }catch(e){ dead = false; }
    if(!dead) return f;
  }
  return root.createFolder(name);
}
function phonesFile_(name){
  const it = phonesFolder_().getFilesByName(name);
  return it.hasNext() ? it.next() : null;
}
/* WRITTEN IN PLACE, NOT BINNED AND REMADE (r3.7).

   This used to trash the old file and then create a new one. Between those
   two steps the file DID NOT EXIST - and Nexus, reading the same folder
   through Drive for Desktop, would find nothing there and fall back to an
   empty list. That is the whole of the phone list flickering between three
   rows and two, and of a renamed phone reading "Admin phone" again for a
   while: the name a rename sets lives on the row in devices.json, so when
   the file is missing so is the name. Drive's own sync widened the window
   from milliseconds to seconds.

   Setting the content of the file that is already there is atomic as far as
   any reader is concerned: there is never a moment with no file. It also
   keeps one file id, so Drive's version history stays in one line instead of
   starting again on every write.

   If several copies somehow exist - an older build of this script could
   leave them - the first is updated and the rest are binned, so the folder
   converges on one. */
function writeJsonFile_(folder, name, obj){
  const text = JSON.stringify(obj);
  const it = folder.getFilesByName(name);
  let first = null;
  while(it.hasNext()){
    const f = it.next();
    if(!first){ first = f; continue; }
    f.setTrashed(true);
  }
  if(first){ first.setContent(text); return; }
  folder.createFile(name, text, MimeType.PLAIN_TEXT);
}

/* The phone needs the public key to subscribe at all. Before Nexus has made
   a pair there is nothing to give, and the phone says so rather than failing
   in a way nobody can read. */
function pushKey_(){
  const rec = parseOrNull_(settingsFile_(PUSH_KEYS_FILE));
  if(!rec || !rec.publicKey) return { ok: true, ready: false, publicKey: '' };
  return { ok: true, ready: true, publicKey: String(rec.publicKey) };
}

/* A phone hands over the subscription its browser made. Stored as one small
   file per phone so a handset can be turned off without touching any other. */
function pushSub_(p, role){
  const dev = String(p.dev || '');
  if(!DEV_RE.test(dev)) return { ok: false, error: 'bad device' };
  /* A PHONE MAY ONLY SPEAK FOR ITSELF (r3.1). Nothing tied the device tag to
     the caller, so any handset holding the staff key could overwrite the
     owner's subscription with its own address - and every notification meant
     for him would have arrived on it instead - or call pushOff on his tag and
     silence him. A subscription already claimed by the admin app can now only
     be written by an admin key; the app it belongs to is taken from the KEY,
     never from what the request says about itself. */
  const holder = phonesFile_('sub-' + dev + '.json');
  const prev = holder ? parseOrNull_(holder) : null;
  if(prev && prev.app === 'admin' && role !== 'admin') return { ok: false, error: 'that phone belongs to the admin app' };
  let sub;
  try{ sub = JSON.parse(String(p.sub || '')); }catch(e){ return { ok: false, error: 'bad subscription' }; }
  if(!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return { ok: false, error: 'bad subscription' };
  if(!/^https:\/\/[^\s"']+$/.test(String(sub.endpoint))) return { ok: false, error: 'bad subscription' };
  const mode = String(p.mode || 'on') === 'silent' ? 'silent' : 'on';
  writeJsonFile_(phonesFolder_(), 'sub-' + dev + '.json', {
    dev: dev,
    app: role === 'admin' ? 'admin' : 'lite',
    ver: String(p.ver || '').slice(0, 12),
    name: String(p.name || '').slice(0, 40),
    mode: mode,
    sub: { endpoint: String(sub.endpoint), keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } },
    at: new Date().toISOString()
  });
  return { ok: true, mode: mode };
}

/* Off means gone, not muted: the file is removed and nothing is sent to that
   phone again until it asks. */
function pushOff_(p, role){
  const dev = String(p.dev || '');
  if(!DEV_RE.test(dev)) return { ok: false, error: 'bad device' };
  const held = phonesFile_('sub-' + dev + '.json');
  const rec = held ? parseOrNull_(held) : null;
  if(rec && rec.app === 'admin' && role !== 'admin') return { ok: false, error: 'that phone belongs to the admin app' };
  const it = phonesFolder_().getFilesByName('sub-' + dev + '.json');
  let gone = false;
  while(it.hasNext()){ it.next().setTrashed(true); gone = true; }
  return { ok: true, removed: gone };
}

/* THE POSTMAN (r3.4)

   Chrome will not let Nexus post to a push service: the app is opened from
   a file on disk, so the browser treats it as having no origin at all and
   refuses before the request leaves the machine. Proved on the clinic's own
   Mac - "Failed to fetch" with nothing in any log, because nothing was sent.

   So this script posts it instead. It is only a postman: NEXUS does all the
   encryption and signing, and what arrives here is already sealed for one
   particular phone. This script cannot read a word of it, and neither can
   Google - the patient's name is encrypted end to end between the clinic's
   PC and the handset. The signing key stays in the clinic folder and never
   comes near this file.

   The address is NOT taken from the request. It is looked up from that
   phone's own subscription file, so an admin key cannot be used to post to
   somewhere else of the caller's choosing. Admin key only.
   ====================================================================== */
function pushSend_(p, role){
  if(role !== 'admin') return { ok: false, error: 'not an admin key' };
  const dev = String(p.dev || '');
  if(!DEV_RE.test(dev)) return { ok: false, error: 'bad device' };
  const f = phonesFile_('sub-' + dev + '.json');
  const rec = f ? parseOrNull_(f) : null;
  if(!rec || !rec.sub || !rec.sub.endpoint) return { ok: false, error: 'that phone is not subscribed' };

  const b64 = String(p.body || '');
  if(!/^[A-Za-z0-9_-]{16,12000}$/.test(b64)) return { ok: false, error: 'bad body' };
  const jwt = String(p.jwt || ''), pub = String(p.pub || '');
  if(!/^[A-Za-z0-9_\-.]{20,3000}$/.test(jwt)) return { ok: false, error: 'bad token' };
  if(!/^[A-Za-z0-9_-]{20,200}$/.test(pub)) return { ok: false, error: 'bad key' };
  const ttl = Math.max(0, Math.min(86400, parseInt(p.ttl || '3600', 10) || 3600));

  let res;
  try{
    res = UrlFetchApp.fetch(rec.sub.endpoint, {
      method: 'post',
      contentType: 'application/octet-stream',
      payload: Utilities.base64DecodeWebSafe(b64),
      headers: {
        'Content-Encoding': 'aes128gcm',
        'TTL': String(ttl),
        'Urgency': 'high',
        'Authorization': 'vapid t=' + jwt + ', k=' + pub
      },
      muteHttpExceptions: true,
      followRedirects: true
    });
  }catch(e){ return { ok: false, error: 'could not reach the push service: ' + ((e && e.message) || e) }; }

  const code = res.getResponseCode();
  /* A phone that has uninstalled the app, or whose subscription the browser
     has retired, answers 404 or 410. Its file goes, so nothing is sent there
     again - the same rule Nexus used when it could still post directly. */
  if(code === 404 || code === 410){
    const it = phonesFolder_().getFilesByName('sub-' + dev + '.json');
    while(it.hasNext()) it.next().setTrashed(true);
    return { ok: false, gone: true, status: code, error: 'that phone is no longer subscribed - removed from the list' };
  }
  if(code >= 200 && code < 300) return { ok: true, status: code };
  let why = '';
  try{ why = String(res.getContentText() || '').slice(0, 160); }catch(e){}
  return { ok: false, status: code, error: 'the push service answered ' + code + (why ? ': ' + why : '') };
}

/* WHICH PHONES ARE OUT THERE (r3.0).

   Every request a phone makes already carries its tag and version, so the
   list costs nothing to keep: it is written to the script's fast memory here
   and flushed to Drive by the five-minute timer. No request pays for a Drive
   write, and Nexus reads one small file.

   'app' is taken from the KEY, not from what the phone says about itself, so
   a phone cannot claim to be the admin app. */
function noteDevice_(p, role){
  const dev = String(p.dev || '');
  if(!DEV_RE.test(dev)) return;
  try{
    const cache = CacheService.getScriptCache();
    cache.put('dv:' + dev, JSON.stringify({
      dev: dev, app: role,
      ver: String(p.ver || '').slice(0, 12),
      inst: String(p.inst || '') === '1',
      at: new Date().toISOString()
    }), CACHE_SECONDS);
    let ids = [];
    try{ ids = JSON.parse(cache.get('dvlist') || '[]'); }catch(e){ ids = []; }
    if(ids.indexOf(dev) === -1){
      ids.push(dev);
      cache.put('dvlist', JSON.stringify(ids.slice(-DEVICE_MAX)), CACHE_SECONDS);
    }
  }catch(e){}
}

/* NAMING A PHONE (r3.6)

   A phone reports whatever name it is greeted by, which is right for the
   owner's own handset and no use at all for "Staff phone". The clinic can
   name one itself, and that name wins wherever both exist.

   It is kept as `label` on the row in devices.json rather than in the
   subscription, so it survives a phone turning notifications off, a
   reinstall under the same tag, and every flush - flushDevices_ merges the
   fast memory ONTO the row, and knows nothing about labels, so a label put
   here stays put. An empty name clears it and the phone's own returns. */
function deviceName_(p, role){
  if(role !== 'admin') return { ok: false, error: 'not an admin key' };
  const dev = String(p.dev || '');
  if(!DEV_RE.test(dev)) return { ok: false, error: 'bad device' };
  const label = String(p.name || '').replace(/\s+/g, ' ').trim().slice(0, 40);

  const prev = parseOrNull_(phonesFile_(DEVICES_FILE));
  const list = Array.isArray(prev) ? prev.slice() : [];
  let found = false;
  for(let i = 0; i < list.length; i++){
    if(list[i] && list[i].dev === dev){
      found = true;
      if(label) list[i].label = label; else delete list[i].label;
    }
  }
  /* A phone that has been seen but not yet flushed into the list still gets
     its name - the flush will fill the rest in around it. */
  if(!found && label) list.push({ dev: dev, label: label, at: new Date().toISOString() });
  writeJsonFile_(phonesFolder_(), DEVICES_FILE, list);
  return { ok: true, name: label };
}

/* FORGETTING A PHONE (r3.5)

   A handset that is reinstalled comes back with a new tag, so the old row
   sits in the list for its thirty days with nothing to press - the stop link
   only appears on rows that still have a subscription. This removes a row
   outright: its subscription if it has one, its place in the list, and the
   note of it in the fast memory, so the next flush does not put it straight
   back.

   A phone still in use simply reappears the next time it opens the app, and
   whoever holds it can turn its bell back on. So removing a live one is
   self-correcting, and removing a dead one is permanent. */
function deviceForget_(p, role){
  if(role !== 'admin') return { ok: false, error: 'not an admin key' };
  const dev = String(p.dev || '');
  if(!DEV_RE.test(dev)) return { ok: false, error: 'bad device' };

  const folder = phonesFolder_();
  let hadSub = false;
  const it = folder.getFilesByName('sub-' + dev + '.json');
  while(it.hasNext()){ it.next().setTrashed(true); hadSub = true; }

  /* Out of the fast memory too, or the next flush would restore the row from
     a note this script made minutes ago. */
  try{
    const cache = CacheService.getScriptCache();
    cache.remove('dv:' + dev);
    let ids = [];
    try{ ids = JSON.parse(cache.get('dvlist') || '[]'); }catch(e){ ids = []; }
    const keep = ids.filter(d => d !== dev);
    if(keep.length !== ids.length) cache.put('dvlist', JSON.stringify(keep), CACHE_SECONDS);
  }catch(e){}

  const prev = parseOrNull_(phonesFile_(DEVICES_FILE));
  const list = Array.isArray(prev) ? prev : [];
  const left = list.filter(r => !r || r.dev !== dev);
  if(left.length !== list.length) writeJsonFile_(folder, DEVICES_FILE, left);
  return { ok: true, hadSub: hadSub, removed: left.length !== list.length || hadSub };
}

/* Called by the timer. Merges what the cache has seen onto what is on file,
   drops anything unseen for a month, and writes only when something actually
   changed - a file rewritten every five minutes for no reason is noise in
   the folder and in its version history. */
function flushDevices_(){
  const cache = CacheService.getScriptCache();
  let ids = [];
  try{ ids = JSON.parse(cache.get('dvlist') || '[]'); }catch(e){ ids = []; }
  const prev = parseOrNull_(phonesFile_(DEVICES_FILE));
  const byDev = {};
  (Array.isArray(prev) ? prev : []).forEach(r => { if(r && r.dev) byDev[r.dev] = r; });
  if(ids.length){
    const got = cache.getAll(ids.map(d => 'dv:' + d));
    ids.forEach(d => {
      const text = got['dv:' + d];
      if(!text) return;
      try{ byDev[d] = Object.assign({}, byDev[d] || {}, JSON.parse(text)); }catch(e){}
    });
  }
  const cut = addDaysStr_(clinicToday_(), -DEVICE_KEEP_DAYS);
  const out = Object.keys(byDev).map(k => byDev[k])
    .filter(r => r && String(r.at || '').slice(0, 10) >= cut)
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  const text = JSON.stringify(out);
  if(text === JSON.stringify(Array.isArray(prev) ? prev : [])) return;
  writeJsonFile_(phonesFolder_(), DEVICES_FILE, out);
}

/* ======================================================================
   MANY FILES, ONE RUN (r3.0)

   This script serves one request at a time per user. Every extra request a
   phone makes is therefore not parallel work but a place in a queue, and the
   admin money screens were making a dozen of them: twelve reads of a second
   each became twelve seconds of an empty screen.

   A batch is the same reads inside a single run. The phone sends a list of
   items - {t:'set'|'day'|'file', f:folder, n:name or date, s:since} - and
   gets back one result per item, in order. Nothing here bypasses the rules:
   each item goes through the same reader the single-file actions use, so the
   allow-lists, the lite stripping and the admin session are all unchanged.
   ====================================================================== */
const BATCH_MAX_ITEMS = 24;
/* How many finished day books the timer keeps warm, and therefore how far
   back readDay_ is willing to answer from memory. */
const WARM_DAYS_BACK = 7;
/* Above this many changed files in one folder, the incremental pass gives
   up and the window is read in full - see warmChanged_. */
const SEARCH_MAX = 400;
function readBatch_(itemsJson, level, rxYears){
  let items;
  try{ items = JSON.parse(itemsJson || '[]'); }catch(e){ return { ok: false, error: 'bad items' }; }
  if(!Array.isArray(items)) return { ok: false, error: 'bad items' };
  if(!items.length) return { ok: true, results: [] };
  if(items.length > BATCH_MAX_ITEMS) return { ok: false, error: 'too many items' };
  const results = items.map(function(raw){
    const it = raw || {};
    const kind = String(it.t || '');
    const since = String(it.s || '');
    const name = String(it.n || '');
    const folder = String(it.f || '');
    /* ONE BAD READ IS ONE BAD READ (r3.1). Without this, a single Drive
       blip on the third of twelve files threw out of the map, past doGet's
       catch, and the whole answer became one error - so the phone lost the
       eleven good reads as well, and had nothing to show. Batching must
       never make a failure bigger than it was. */
    try{
      if(kind === 'set')  return readSettings_(name, level, since, false, rxYears);
      if(kind === 'day')  return readDay_(folder, name, level, since);
      if(kind === 'file') return readRecord_(folder, name, level, since);
      return { ok: false, error: 'bad item' };
    }catch(err){
      return { ok: false, error: 'relay error: ' + ((err && err.message) || String(err)) };
    }
  });
  return { ok: true, results: results };
}

/* ======================================================================
   BULK SETTINGS (r2.0): the five lite settings in one request.
   ====================================================================== */
function readSettingsAll_(level, sinceMapJson, fresh, rxYears){
  /* Pull to refresh used to read all fifteen settings files from Drive
     (r3.0). One sweep brings the memory up to date for a fraction of that,
     and the same sweep serves the week request beside it - warmSweepNow_
     will not run twice in twenty seconds. */
  if(fresh && warmSweepNow_()) fresh = false;
  let sinceMap = {};
  try{ sinceMap = sinceMapJson ? JSON.parse(sinceMapJson) : {}; }catch(e){ sinceMap = {}; }
  const values = {};
  LITE_SETTINGS.forEach(name => {
    const r = readSettings_(name, level, String(sinceMap[name] || ''), fresh, rxYears);
    values[name] = r.ok ? (r.notModified ? { notModified: true, modified: r.modified } : { value: r.value, modified: r.modified }) : { error: r.error };
  });
  return { ok: true, values: values };
}

/* ======================================================================
   FAST MEMORY (r2.0)
   Google's script cache holds up to 100 KB per entry for up to 6 hours, so a
   value is split into 90 KB pieces under one small header. Anything that
   will not fit simply is not cached and is read from Drive.
   ====================================================================== */
const CLINIC_TZ = 'Asia/Kolkata';
const CACHE_SECONDS = 6 * 60 * 60;
const PIECE = 90000;
const MAX_PIECES = 40;
function clinicToday_(){ return Utilities.formatDate(new Date(), CLINIC_TZ, 'yyyy-MM-dd'); }
function addDaysStr_(dateStr, n){
  const d = new Date(dateStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function cachePutJson_(key, obj){
  try{
    const text = JSON.stringify(obj);
    const n = Math.ceil(text.length / PIECE) || 1;
    if(n > MAX_PIECES) return false;
    const map = {};
    map['c:' + key] = String(n);
    for(let i = 0; i < n; i++) map['c:' + key + '#' + i] = text.slice(i * PIECE, (i + 1) * PIECE);
    CacheService.getScriptCache().putAll(map, CACHE_SECONDS);
    return true;
  }catch(e){ return false; }
}
function cacheGetJson_(key){
  try{
    const cache = CacheService.getScriptCache();
    const n = parseInt(cache.get('c:' + key) || '0', 10);
    if(!n) return null;
    const keys = [];
    for(let i = 0; i < n; i++) keys.push('c:' + key + '#' + i);
    const got = cache.getAll(keys);
    let text = '';
    for(let i = 0; i < n; i++){
      const part = got['c:' + key + '#' + i];
      if(part === undefined || part === null) return null;   // a piece expired: read Drive instead
      text += part;
    }
    return JSON.parse(text);
  }catch(e){ return null; }
}
/* DRIVE PUSHES BACK (r2.4). Under many quick lookups Google answers
   "Service error: Drive". One pause and one retry clears nearly all of them;
   what still fails is reported, not thrown, so one bad file cannot fail a
   whole fortnight. */
function withRetry_(fn){
  try{ return fn(); }
  catch(e){
    if(!/Service error|Drive|Timed out|Internal error/i.test(String(e && e.message))) throw e;
    Utilities.sleep(900);
    return fn();
  }
}
function readDaysFromDrive_(days){
  const out = {};
  const pick = (folderName) => {
    const dir = withRetry_(() => subFolder_(folderName));
    const byDay = {};
    if(dir){
      days.forEach(day => {
        try{
          withRetry_(() => {
            const it = dir.getFilesByName(day + '.json');
            if(it.hasNext()){
              const f = it.next();
              byDay[day] = { value: parseOrNull_(f), modified: f.getLastUpdated().toISOString() };
            }
          });
        }catch(e){ byDay[day] = { failed: true }; }
      });
    }
    return byDay;
  };
  const appts = pick('appointments'), visits = pick('visits');
  days.forEach(day => {
    const a = appts[day], v = visits[day];
    if((a && a.failed) || (v && v.failed)){ out[day] = { failed: true }; return; }
    out[day] = {
      appointments: (a && a.value) || [],
      visits: (v && v.value) || [],
      modified: [a && a.modified, v && v.modified].filter(Boolean).sort().pop() || null
    };
  });
  return out;
}

/* THE TIMER'S JOB. Reads only what changed since the last run: it compares
   each file's last-changed time with the one it remembered. */
/* WHAT CHANGED, IN ONE QUESTION PER FOLDER (r3.0).

   Until now the warm-up asked Drive about every day file BY NAME to see
   whether it had moved: 22 days across two folders, 44 lookups every five
   minutes, before a single byte was read. The Executions log showed what
   that cost - runs of 20 to 70 seconds, a fifth of this script's life spent
   asking questions whose answer was almost always "nothing changed", and a
   4% error rate where Drive tired of being asked.

   Drive can answer the whole question at once. One search per folder for
   files touched since the last run comes back with just those, and only
   those are read. A quiet five minutes now costs four searches.

   The window reaches a little further back than the last run, because
   Drive's idea of "modified" can lag a moment behind the write. The cost of
   the overlap is re-reading a file that was already read; the cost of
   missing one is a phone showing yesterday's answer, so the overlap wins. */
function isoSeconds_(d){ return d.toISOString().replace(/\.\d+Z$/, 'Z'); }
function warmOverlap_(iso){
  const t = Date.parse(iso || '');
  const from = t ? (t - 2 * 60 * 1000) : (Date.now() - 6 * 60 * 1000);
  return isoSeconds_(new Date(from));
}
function warmChanged_(sinceIso){
  const out = { days: {}, data: {}, settings: {} };
  /* trashed = false, because a file put in the bin counts as modified and
     re-reading a deleted one is pointless work. */
  const q = 'modifiedDate > "' + sinceIso + '" and trashed = false';
  const sweep = (folderName, take) => {
    const dir = subFolder_(folderName);
    if(!dir) return;
    const it = dir.searchFiles(q);
    /* A bound, so one enormous day of edits cannot turn a warm-up into a
       six-minute run. But a truncated answer is NOT a complete one: the
       first version stopped at the cap and let the window move on past
       everything it had not looked at, which loses those changes for good.
       Hitting the cap now abandons the incremental pass altogether and the
       caller falls back to reading the window in full. */
    let n = 0;
    while(it.hasNext()){
      if(n >= SEARCH_MAX) throw new Error('too many changed files to list');
      take(String(it.next().getName() || ''));
      n++;
    }
  };
  const asDay = (name) => {
    const d = name.replace(/\.json$/, '');
    return validDate_(d) ? d : '';
  };
  sweep('appointments', n => { const d = asDay(n); if(d) out.days[d] = true; });
  sweep('visits',       n => { const d = asDay(n); if(d) out.days[d] = true; });
  sweep('data',         n => { const d = asDay(n); if(d) out.data[d] = true; });
  sweep('settings',     n => { out.settings[n] = true; });
  return out;
}

function warmCache(){
  warmSweep_();
  try{ flushDevices_(); }catch(e){}
}
/* A sweep on demand, for pull-to-refresh. Bounded, so a row of impatient
   taps cannot turn into a row of sweeps. */
function warmSweepNow_(){
  const cache = CacheService.getScriptCache();
  /* One SUCCEEDED a moment ago, so the memory is already current - which is
     the answer the caller wants, not a reason to go to Drive.

     Written only after the sweep returns true (r3.1). The first version set
     it on the way in, so a failed sweep left a marker saying "just done",
     and the next phone to pull within twenty seconds was handed unswept
     data as though it were fresh. */
  if(cache.get('c:warm:just')) return true;
  let okNow = false;
  try{ okNow = warmSweep_(); }catch(e){ okNow = false; }
  if(okNow) cache.put('c:warm:just', '1', 20);
  return okNow;
}
function warmSweep_(){
  const props = PropertiesService.getScriptProperties();
  const cache = CacheService.getScriptCache();
  let seen = {};
  try{ seen = JSON.parse(props.getProperty('WARM_SEEN') || '{}'); }catch(e){ seen = {}; }
  const startedAt = new Date();
  const today = clinicToday_();
  const days = [];
  for(let i = -7; i <= 14; i++) days.push(addDaysStr_(today, i));
  const dataDays = [];
  for(let i = 1; i <= WARM_DAYS_BACK; i++) dataDays.push(addDaysStr_(today, -i));
  const setNames = LITE_SETTINGS.concat(ADMIN_WARM);

  /* The memory lasts six hours. After it has gone - or on the first run
     ever - everything is read again; in between, only what changed. The
     marker is what says the memory is still there. */
  const incremental = !!cache.get('c:warm:alive') && !!seen.sweptAt;
  let changed = null;
  if(incremental){
    /* If Drive will not take the search, fall back to filling whatever is
       missing rather than failing the run. */
    try{ changed = warmChanged_(warmOverlap_(seen.sweptAt)); }catch(e){ changed = null; }
  }
  /* ---- the day books: appointments and visits, kept as one ---- */
  /* A FULL PASS READS THE WHOLE WINDOW (r3.1). It used to read only what was
     MISSING from the memory - which meant that when the search failed, or
     the marker had been evicted while the data survived, the run refreshed
     nothing at all and then stamped a new sweptAt anyway. Every edit made in
     the meantime fell behind the next window and was never looked at again.
     A full pass is now genuinely full, and it is the only thing that earns
     the right to move the window on. */
  const dayList = changed ? days.filter(d => changed.days[d]) : days;
  if(dayList.length){
    const read = readDaysFromDrive_(dayList);
    dayList.forEach(day => { if(read[day] && !read[day].failed) cachePutJson_('day:' + day, read[day]); });
  }

  /* ---- settings ---- */
  const setList = changed ? setNames.filter(n => changed.settings[n]) : setNames;
  setList.forEach(name => {
    const f = settingsFile_(name);
    if(!f) return;
    cachePutJson_('set:' + name, { value: parseOrNull_(f), modified: f.getLastUpdated().toISOString() });
  });

  /* ---- the finished money days, so catching up costs no Drive read ---- */
  const dataList = changed ? dataDays.filter(d => changed.data[d]) : dataDays;
  if(dataList.length){
    const dir = subFolder_('data');
    if(dir) dataList.forEach(day => {
      const it = dir.getFilesByName(day + '.json');
      const f = it.hasNext() ? it.next() : null;
      if(!f) return;
      cachePutJson_('dayf:data:' + day, { value: parseOrNull_(f), modified: f.getLastUpdated().toISOString() });
    });
  }

  /* ---- the PIN ---- */
  if(!changed || changed.settings[PIN_FILE] || !cache.get('c:pin')){
    const rec = readPinRecord_();
    if(rec) cachePutJson_('pin', rec);
  }

  /* Stamped only at the end, and with the time the run BEGAN: anything
     written while it was working is then inside the next window rather than
     missed between the two. */
  cache.put('c:warm:alive', '1', CACHE_SECONDS);
  /* THE WINDOW MOVES ONLY WHEN THIS RUN COVERED IT (r3.1), and that is the
     single most important line in this file. Everything from the last
     sweptAt to this one has now been looked at - either by the search, or
     by reading the whole window - so the next run may safely start here.

     Advancing it after a run that covered nothing is how a change is lost
     for ever: it falls behind the window and no later search ever asks for
     it again. So a failed search leaves the mark where it was, and the next
     run asks for the same period over again. Re-reading a file twice costs
     a second; not reading it costs the clinic a wrong answer for six hours. */
  const covered = changed !== null || !incremental;
  if(covered) props.setProperty('WARM_SEEN', JSON.stringify({ sweptAt: isoSeconds_(startedAt) }));
  return covered;
}

/* Run ONCE to begin. Safe to run again: it never makes a second timer. */
function startTimer(){
  stopTimer();
  ScriptApp.newTrigger('warmCache').timeBased().everyMinutes(5).create();
  PropertiesService.getScriptProperties().deleteProperty('WARM_SEEN');
  warmCache();
  Logger.log('Timer started: every 5 minutes. The fast memory is filled now.');
}
function stopTimer(){
  ScriptApp.getProjectTriggers().forEach(t => { if(t.getHandlerFunction() === 'warmCache') ScriptApp.deleteTrigger(t); });
  Logger.log('Timer stopped. Phones keep working, reading Drive directly.');
}

/* ======================================================================
   BOOKING (r2.2)
   ====================================================================== */
const INBOX = 'booking-inbox';
const DAY_OPEN_MIN = 7 * 60, DAY_CLOSE_MIN = 24 * 60;
function minsOf_(t){ const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; }
function blocksOn_(list, day){
  const dow = new Date(day + 'T00:00:00Z').getUTCDay();
  return (Array.isArray(list) ? list : []).filter(b => {
    if(!b) return false;
    if(b.repeat === 'weekly'){
      if(Number(b.weekday) !== dow) return false;
      if(b.from && day < b.from) return false;
      if(b.until && day > b.until) return false;
      if(Array.isArray(b.skip) && b.skip.indexOf(day) !== -1) return false;
      return true;
    }
    return b.date === day;
  });
}
/* Same rule as phonesFolder_: a binned inbox would silently swallow every
   booking a phone made. */
function inboxFolder_(){ return liveFolder_(INBOX); }
function pendingFor_(day){
  const out = [];
  const it = inboxFolder_().getFiles();
  while(it.hasNext()){
    const f = it.next();
    if(!/\.json$/.test(f.getName())) continue;
    const b = parseOrNull_(f);
    if(b && b.date === day) out.push(b);
  }
  return out;
}
/* Mobile search without handing numbers out: the relay matches, the phone
   only ever sees the IDs. */
function lookupPhone_(q){
  const digits = q.replace(/\D/g, '');
  if(digits.length < 4) return { ok: true, ids: [] };
  const contacts = parseOrNull_(settingsFile_('patient-contacts.json')) || {};
  const ids = Object.keys(contacts).filter(pid =>
    ((contacts[pid] && contacts[pid].numbers) || []).some(n => String((n && n.e164) || '').indexOf(digits) !== -1)).slice(0, 20);
  return { ok: true, ids: ids };
}
function book_(json){
  let b;
  try{ b = JSON.parse(json); }catch(e){ return { ok: false, error: 'Booking could not be read' }; }
  const id = String(b.id || '');
  if(!/^ph-[A-Za-z0-9-]{6,60}$/.test(id)) return { ok: false, error: 'Booking has no id' };
  const folder = inboxFolder_();
  if(folder.getFilesByName(id + '.json').hasNext()) return { ok: true, id: id, already: true };   // a double tap, or a retry
  const today = clinicToday_();
  const date = String(b.date || '');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'No date' };
  if(date < today) return { ok: false, error: 'Bookings can only be made from today onwards' };
  const t = minsOf_(b.time);
  if(!Number.isFinite(t) || t < DAY_OPEN_MIN || t >= DAY_CLOSE_MIN || t % 15 !== 0) return { ok: false, error: 'Pick a time from the list' };
  const mins = Number(b.mins);
  if([15, 30, 45, 60].indexOf(mins) === -1) return { ok: false, error: 'Pick a length from the list' };
  const rough = b.rough === true;
  /* r2.7 audit: a Drive blip while reading the directory must not read as
     "patient not in the directory" - that would make the phone drop the
     booking. Retry once; if it still fails, say it is a relay fault so the
     phone keeps the booking and tries again. */
  const patients = withRetry_(() => parseOrNull_(settingsFile_('patients.json')));
  if(!patients) return { ok: false, error: 'relay error: the patient directory could not be read just now' };
  const pid = String(b.patientId || '');
  if(pid && !patients[pid]) return { ok: false, error: 'That patient is not in the directory' };
  const name = rough ? String(b.newName || '').trim().slice(0, 60) : '';
  if(!rough && !pid) return { ok: false, error: 'Choose a patient from the list \u2014 new patients are registered at the desk' };
  const doctors = parseOrNull_(settingsFile_('doctors.json')) || [];
  const docNames = (Array.isArray(doctors) ? doctors : []).map(d => (d && (d.name || d)) || '').filter(Boolean);
  const doctor = String(b.doctor || '');
  if(!rough && !doctor) return { ok: false, error: 'Choose a doctor' };
  if(doctor && docNames.indexOf(doctor) === -1) return { ok: false, error: 'That doctor is not on the list' };
  if(today === date){
    const nowMins = Number(Utilities.formatDate(new Date(), CLINIC_TZ, 'H')) * 60 + Number(Utilities.formatDate(new Date(), CLINIC_TZ, 'm'));
    if(t + mins <= nowMins) return { ok: false, error: 'That time has already passed' };
  }
  const blocks = parseOrNull_(settingsFile_('calendar-blocks.json')) || [];
  const clash = blocksOn_(blocks, date).find(x => {
    if(x.kind === 'leave'){ if(!doctor || x.doctor !== doctor) return false; }
    if(x.allDay) return true;
    const s0 = minsOf_(x.start), e0 = minsOf_(x.end);
    return Number.isFinite(s0) && Number.isFinite(e0) && t < e0 && t + mins > s0;
  });
  /* r2.5 (owner's call): a closed time or a taken slot is booked anyway -
     the phone warned before sending; the booking carries the note so the
     desk sees why. */
  const notes = [];
  if(clash && !rough) notes.push(clash.kind === 'leave' ? doctor + ' away' : 'closed time');
  if(!rough){
    const dir = subFolder_('appointments');
    const dayFile = dir ? dir.getFilesByName(date + '.json') : null;
    const booked = ((dayFile && dayFile.hasNext() ? parseOrNull_(dayFile.next()) : null) || []).concat(pendingFor_(date));
    const taken = booked.find(a => a && !a.rough && (a.status || 'scheduled') !== 'cancelled' && a.status !== 'noshow'
      && a.doctor === doctor && (() => { const s1 = minsOf_(a.time); return Number.isFinite(s1) && t < s1 + (Number(a.mins) || 15) && t + mins > s1; })());
    if(taken) notes.push('double-booked');
  }
  const rec = {
    id: id, date: date, time: String(b.time), mins: mins,
    patientId: pid, newName: pid ? '' : name, doctor: doctor,
    cameFor: String(b.cameFor || '').trim().slice(0, 120), rough: rough,
    bookedBy: String(b.bookedBy || '').trim().slice(0, 40) || 'phone',
    bookedAt: new Date().toISOString(), source: 'phone'
  };
  if(notes.length) rec.phoneWarnings = notes;
  folder.createFile(id + '.json', JSON.stringify(rec, null, 2), MimeType.PLAIN_TEXT);
  return { ok: true, id: id };
}

/* RUN THIS ONCE after pasting r2.3 (the booking relay). It writes one test
   file into booking-inbox/ and deletes it straight away. Running it from
   the editor is what makes Google ask for the permission to create files -
   the web app cannot ask on its own, it just fails with "You do not have
   permission to call DriveApp.Folder.createFile". */
/* ======================================================================
   IS THE NOTIFICATION PATH WORKING? (r3.2)

   Run this from the editor when a phone says it could not be registered.
   It walks the same three steps the phone does and says exactly which one
   fails - which the Executions list cannot show you, because doGet turns
   every error into an ordinary answer and so every row reads "Completed".

   It writes a throwaway subscription under the tag 'selftest' and removes
   it again, so nothing is left behind and no real phone is touched.
   ====================================================================== */
function testPhones(){
  const say = [];
  const line = (t) => { say.push(t); Logger.log(t); };
  try{
    const root = rootFolder_();
    line('1. clinic folder: ' + root.getName());
  }catch(e){ line('1. CANNOT OPEN THE CLINIC FOLDER: ' + e.message + '  \u2014 check FOLDER_ID'); return say.join('\n'); }

  /* Every folder of that name, live or binned, and who owns each - because
     "Access denied" on a write almost always means one of those two. */
  try{
    const all = rootFolder_().getFoldersByName(PHONES);
    let n = 0;
    while(all.hasNext()){
      const f = all.next();
      n++;
      let bin = '?', owner = '?';
      try{ bin = f.isTrashed() ? 'IN THE BIN' : 'live'; }catch(e){}
      try{ owner = f.getOwner().getEmail(); }catch(e){ owner = 'unknown (not yours?)'; }
      line('   found a phones folder: ' + bin + ', owned by ' + owner + ', id ' + f.getId());
    }
    if(!n) line('   no phones folder yet - one will be made');
  }catch(e){ line('   could not list phones folders: ' + e.message); }

  let folder;
  try{
    folder = phonesFolder_();
    line('2. phones folder: ok (' + folder.getName() + ', id ' + folder.getId() + ')');
  }catch(e){
    line('2. CANNOT CREATE OR OPEN phones/: ' + e.message);
    line('   Run testBookingInbox once and accept the prompt Google shows.');
    return say.join('\n');
  }

  try{
    writeJsonFile_(folder, 'sub-selftest.json', { dev: 'selftest', at: new Date().toISOString() });
    line('3. writing a subscription: ok');
  }catch(e){
    line('3. CANNOT WRITE INTO phones/: ' + e.message);
    line('   Writing works elsewhere if testBookingInbox passes, so this is that');
    line('   folder, not permission: it is in the bin, or somebody else owns it.');
    line('   See the "found a phones folder" lines above. Empty the bin (or move');
    line('   that folder out of the clinic folder) and run this again - the script');
    line('   will make one of its own.');
    return say.join('\n');
  }

  const key = pushKey_();
  line('4. signing key: ' + (key.ready ? 'ready' : 'NOT SET UP \u2014 open Nexus on the reception PC once, then try again'));

  const r = pushSub_({ dev: 'selftest2', ver: '0', mode: 'on',
    sub: JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/SELFTEST', keys: { p256dh: 'BPk', auth: 'aXo' } }) }, 'lite');
  line('5. the phone\u2019s own request: ' + (r.ok ? 'ok' : 'REFUSED \u2014 ' + r.error));

  try{
    pushOff_({ dev: 'selftest' }, 'admin');
    pushOff_({ dev: 'selftest2' }, 'admin');
    line('6. tidied up: ok');
  }catch(e){ line('6. could not tidy up: ' + e.message + ' (harmless, remove phones/sub-selftest*.json by hand)'); }

  /* Posting to a push service needs Google's permission to make external
     requests, and a web app can never ask for it - only a run from this
     editor can. So it is asked for here, with a harmless request. */
  try{
    UrlFetchApp.fetch('https://fcm.googleapis.com/', { muteHttpExceptions: true });
    line('8. permission to reach the push service: ok');
  }catch(e){
    line('8. NO PERMISSION TO REACH THE PUSH SERVICE: ' + e.message);
    line('   Run this again and accept the prompt Google shows.');
  }

  const subs = [];
  const it = folder.getFiles();
  while(it.hasNext()){ const n = it.next().getName(); if(/^sub-/.test(n)) subs.push(n); }
  line('7. phones subscribed right now: ' + (subs.length ? subs.join(', ') : 'none'));
  line(r.ok && key.ready ? '\nAll clear - if a phone still cannot register, the fault is on the phone.'
                         : '\nSomething above is the reason the phone could not register.');
  return say.join('\n');
}

function testBookingInbox(){
  const folder = inboxFolder_();
  const f = folder.createFile('relay-write-test.json', JSON.stringify({ test: true, at: new Date().toISOString() }), MimeType.PLAIN_TEXT);
  f.setTrashed(true);
  Logger.log('Inbox write OK: the relay can create booking files in "' + folder.getName() + '".');
  Logger.log('Now: Deploy → Manage deployments → pencil → Version: New version → Deploy.');
}

/* WHERE IS MY BOOKING? (r2.4) waiting: still in the inbox. filed: Nexus has
   taken it (it is in done/). unknown: neither. A phone uses this to drop its
   note for a booking that was filed and then deleted at the desk. */
function bookingStatus_(idsCsv){
  const ids = idsCsv.split(',').map(x => x.trim()).filter(x => /^ph-[A-Za-z0-9-]{6,60}$/.test(x)).slice(0, 20);
  const inbox = inboxFolder_();
  const doneIt = inbox.getFoldersByName('done');
  const done = doneIt.hasNext() ? doneIt.next() : null;
  const status = {};
  ids.forEach(id => {
    try{
      withRetry_(() => {
        if(inbox.getFilesByName(id + '.json').hasNext()) status[id] = 'waiting';
        else if(done && done.getFilesByName(id + '.json').hasNext()) status[id] = 'filed';
        else status[id] = 'unknown';
      });
    }catch(e){ status[id] = 'error'; }
  });
  return { ok: true, status: status };
}

/* ======================================================================
   THE PRESCRIPTION INDEX, TRIMMED (r2.9)

   Every prescription the clinic has ever written lives in one file, and a
   phone downloads the whole of it whenever it changes. It only grows. So a
   phone asks for the last N years, and gets back:
     list    those records, PLUS each patient's newest one whatever its age,
             so "last seen" and a patient's latest sheet are never missing
     counts  how many that patient has in total, so the ℞ figure on a card
             and the history screen tell the truth about what is not shown
   Anything older is one tap away: action=rxFor returns a patient's whole
   history from the same file. Nothing is deleted anywhere.
   ====================================================================== */
const RX_INDEX = 'prescriptions-index.json';
function rxDateOf_(r){ return String((r && (r.date || r.createdAt)) || '').slice(0, 10); }
function trimRxIndex_(idx, years){
  if(!idx || !Array.isArray(idx.list)) return idx;
  const cut = addDaysStr_(clinicToday_(), -Math.round(years * 365.25));
  const counts = {};
  const newestAt = {};                      // pid -> index of that patient's newest
  idx.list.forEach(function(r, i){
    const pid = String((r && r.patientId) || '');
    if(!pid) return;
    counts[pid] = (counts[pid] || 0) + 1;
    const d = rxDateOf_(r);
    if(newestAt[pid] === undefined || d > rxDateOf_(idx.list[newestAt[pid]])) newestAt[pid] = i;
  });
  const keep = {};
  Object.keys(newestAt).forEach(function(pid){ keep[newestAt[pid]] = true; });
  const list = [], keys = [];
  idx.list.forEach(function(r, i){
    if(rxDateOf_(r) >= cut || keep[i]){
      list.push(r);
      if(Array.isArray(idx.keys) && idx.keys[i] !== undefined) keys.push(idx.keys[i]);
    }
  });
  return { list: list, keys: keys.length ? keys : (idx.keys || []), counts: counts,
           rxFrom: cut, rxTotal: idx.list.length };
}
/* One patient's whole history, however old. */
function rxForPatient_(pid){
  /* A patient id may carry a slash (EDC/21048), so it is not a file name
     here - this only filters a list in memory - but a dotted path is never
     an id and is refused on sight. */
  if(!/^[A-Za-z0-9._\/-]{1,40}$/.test(pid) || pid.indexOf('..') !== -1) return { ok: false, error: 'bad patient id' };
  let idx = cacheGetJson_('set:' + RX_INDEX);
  if(idx) idx = idx.value;
  if(!idx) idx = parseOrNull_(settingsFile_(RX_INDEX));
  if(!idx || !Array.isArray(idx.list)) return { ok: true, pid: pid, list: [] };
  const mine = idx.list.filter(function(r){ return r && String(r.patientId) === pid; });
  return { ok: true, pid: pid, list: mine };
}
