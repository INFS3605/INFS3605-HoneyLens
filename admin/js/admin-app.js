/*
  admin/js/admin-app.js — shell, navigation, and screens for the Insights
  Portal. Mirrors the main app's single-file "state + go(Screen)" pattern
  for familiarity, but is an entirely separate app — no shared state, no
  shared functions, no import of index.html's code.
*/
(function () {
  'use strict';

  const $main = () => document.getElementById('main');
  const NAV = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'festivals', label: 'Festivals' },
    { id: 'devices', label: 'Devices' },
    { id: 'researchers', label: 'Researchers' },
    { id: 'exports', label: 'Exports' },
    { id: 'settings', label: 'Settings' },
  ];

  let state = { profile: null, active: 'dashboard' };

  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'toast'; el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return iso; }
  }

  function initials(name) {
    return (name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  }

  /* ============================ gate ============================ */
  function renderSignIn(errorMsg) {
    document.getElementById('gate-body').innerHTML = `
      <div class="gate-h1">Coordinator sign in</div>
      <div class="gate-p">This portal is for OOXii coordinators only. Testers should use the main HoneyLens app.</div>
      <div class="gate-err" id="gate-err" style="${errorMsg ? 'display:block' : ''}">${errorMsg ? AdminCharts.esc(errorMsg) : ''}</div>
      <div class="field"><label>Email</label><input id="si-email" type="email" placeholder="coordinator@ooxii.org" autocomplete="username"></div>
      <div class="field"><label>Password</label><input id="si-pass" type="password" placeholder="••••••••" autocomplete="current-password"></div>
      <button class="btn btn-primary" id="si-btn" onclick="AdminApp.doSignIn()">Sign in</button>
      <div class="gate-note">Uses the same OOXii account system as the tester app — only accounts with a coordinator or administrator role can enter.</div>
    `;
    document.getElementById('si-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSignIn(); });
  }

  function renderDenied(reason, profile) {
    const messages = {
      not_configured: ['Not configured', 'This portal has no Supabase project configured yet — see SUPABASE_SETUP.md.'],
      inactive: ['Account inactive', 'Your OOXii account has been deactivated. Contact an administrator.'],
      not_coordinator: ['Coordinator access required', `Signed in as ${profile ? AdminCharts.esc(profile.display_name) : 'this account'}, but this account is a "${profile ? profile.app_role : 'tester'}" — only coordinators and administrators can open the Insights Portal.`],
      no_profile: ['Profile not found', 'This account has no OOXii profile yet.'],
      error: ['Something went wrong', 'Could not verify your access right now. Please try again.'],
    };
    const [title, body] = messages[reason] || messages.error;
    document.getElementById('gate-body').innerHTML = `
      <div class="gate-h1">${title}</div>
      <div class="gate-p">${body}</div>
      <button class="btn btn-ghost" onclick="AdminApp.signOut()">Sign out and try a different account</button>
    `;
  }

  async function doSignIn() {
    const email = document.getElementById('si-email').value.trim();
    const pass = document.getElementById('si-pass').value;
    const btn = document.getElementById('si-btn');
    if (!email || !pass) { renderSignIn('Enter your email and password.'); return; }
    btn.disabled = true; btn.textContent = 'Signing in…';
    const r = await AdminAuth.signIn(email, pass);
    if (!r.ok) { renderSignIn(r.error); return; }
    await boot();
  }

  async function signOut() {
    await AdminAuth.signOut();
    document.getElementById('app').style.display = 'none';
    document.getElementById('gate').style.display = 'flex';
    renderSignIn();
  }

  /* ============================ shell ============================ */
  function renderShell() {
    document.getElementById('nav-avatar').textContent = initials(state.profile.display_name);
    document.getElementById('nav-name').textContent = state.profile.display_name;
    document.getElementById('nav-role').textContent = state.profile.app_role === 'administrator' ? 'Administrator' : 'Coordinator';
    document.getElementById('topnav-links').innerHTML = NAV.map((n) =>
      `<button data-id="${n.id}" class="${n.id === state.active ? 'active' : ''}" onclick="AdminApp.go('${n.id}')">${n.label}</button>`
    ).join('');
  }

  function go(id) {
    state.active = id;
    renderShell();
    const fn = SCREENS[id] || SCREENS.dashboard;
    $main().innerHTML = '<div class="loading">Loading…</div>';
    Promise.resolve(fn()).catch((e) => {
      console.error('[OOXii Admin] screen render failed', id, e);
      $main().innerHTML = `<div class="placeholder-page"><h2>Could not load this page</h2><p>${AdminCharts.esc(e.message || 'Unknown error')}</p></div>`;
    });
  }

  function placeholder(title, body) {
    return () => {
      $main().innerHTML = `<div class="placeholder-page">
        <div class="ic">🛠️</div>
        <h2>${AdminCharts.esc(title)}</h2>
        <p>${AdminCharts.esc(body)}</p>
      </div>`;
    };
  }

  /* ============================ Dashboard ============================ */
  async function ScreenDashboard() {
    const [kpis, daily, distanceOut, nearOut, funnel] = await Promise.all([
      AdminData.getKpis(), AdminData.getDailyClients(30), AdminData.getDistanceOutcomes(),
      AdminData.getNearOutcomes(), AdminData.getCompletionFunnel(),
    ]);

    const kpiDefs = [
      ['🏕️', 'Total Eye Festivals', kpis.total_festivals],
      ['👥', 'Total Clients Tested', kpis.total_clients],
      ['✅', 'Completed Sessions', kpis.completed_sessions],
      ['👓', 'Glasses Dispensed', kpis.glasses_dispensed],
      ['📏', 'Distance Tests', kpis.distance_tests],
      ['🔎', 'Near Tests', kpis.near_tests],
      ['🎡', 'Wheel Tests', kpis.wheel_tests],
      ['🕹️', 'Paddle Tests', kpis.paddle_tests],
      ['🧑‍⚕️', 'Unique Testers', kpis.unique_testers],
      ['📱', 'Unique Devices', kpis.unique_devices],
      ['📡', 'Offline Devices (>1h)', kpis.offline_devices],
      ['⚠️', 'Conflict Events', kpis.conflict_events],
    ];
    const kpiCards = kpiDefs.map(([ic, lbl, n]) =>
      `<div class="kpi-card"><div class="top"><div class="ic">${ic}</div></div>
        <div class="n">${n != null ? n : '—'}</div><div class="lbl">${lbl}</div></div>`
    ).join('') + `
      <div class="kpi-card"><div class="top"><div class="ic">📶</div></div>
        <div class="n">${kpis.sync_success_pct != null ? kpis.sync_success_pct + '%' : '—'}</div>
        <div class="lbl">Sync Success %</div></div>
      <div class="kpi-card"><div class="top"><div class="ic">⏳</div></div>
        <div class="n">—</div><div class="lbl">Pending Sync Events</div>
        <div class="na">Not visible until a device syncs</div></div>`;

    const dailyPoints = daily.map((d) => ({ x: d.day, x_label: d.day.slice(5), y: d.clients_registered }));
    const distBars = ['pass', 'fail'].map((k) => ({
      label: k === 'pass' ? 'Pass' : 'Fail', value: (distanceOut.find((r) => r.outcome === k) || {}).n || 0,
      color: k === 'pass' ? AdminCharts.COLORS.green : AdminCharts.COLORS.red,
    }));
    const nearBars = ['pass', 'fail'].map((k) => ({
      label: k === 'pass' ? 'Pass' : 'Fail', value: (nearOut.find((r) => r.outcome === k) || {}).n || 0,
      color: k === 'pass' ? AdminCharts.COLORS.green : AdminCharts.COLORS.red,
    }));
    const funnelStages = [
      { label: 'Registered', value: funnel.registered },
      { label: 'Distance', value: funnel.distance_done },
      { label: 'Wheel', value: funnel.wheel_done },
      { label: 'Paddle', value: funnel.paddle_done },
      { label: 'Dispense', value: funnel.dispensed },
      { label: 'Completed', value: funnel.completed },
    ];

    $main().innerHTML = `
      <div class="page-head"><div><h1>Dashboard</h1><p>Across every festival, all-time. Filters coming soon.</p></div></div>
      <div class="kpi-grid">${kpiCards}</div>
      <div class="grid-2">
        <div class="card"><h3>Daily clients tested</h3><p class="sub">Last 30 days, by registration date</p>
          ${dailyPoints.length ? AdminCharts.lineChart(dailyPoints) : '<div class="empty">No registrations in this window yet.</div>'}</div>
        <div class="card"><h3>Testing completion funnel</h3><p class="sub">Registration → Completed (raw counts — Wheel/Paddle are route-conditional, see Researchers page)</p>
          ${AdminCharts.funnelChart(funnelStages)}</div>
      </div>
      <div class="grid-2">
        <div class="card"><h3>Distance vision outcomes</h3><p class="sub">Pass ≥ line 7 both eyes</p>
          ${distBars.some(b=>b.value) ? AdminCharts.barChart(distBars, {height:160}) : '<div class="empty">No distance results yet.</div>'}</div>
        <div class="card"><h3>Near vision outcomes</h3><p class="sub">Pass ≥ line 9</p>
          ${nearBars.some(b=>b.value) ? AdminCharts.barChart(nearBars, {height:160}) : '<div class="empty">No near results yet.</div>'}</div>
      </div>
    `;
  }

  /* ============================ Devices ============================ */
  async function ScreenDevices() {
    const devices = await AdminData.getDeviceStatus();
    const rows = devices.map((d) => {
      const dot = d.status === 'online' ? 'green' : 'amber';
      return `<tr>
        <td>${AdminCharts.esc(d.label || d.id.slice(0, 8))}</td>
        <td>${AdminCharts.esc(d.festival_name || '—')}</td>
        <td>${AdminCharts.esc(d.tester_name || '—')}</td>
        <td>${fmtDate(d.last_seen_at)}</td>
        <td>${d.sessions_completed}</td>
        <td><span class="chip ${dot}">${d.status}</span></td>
      </tr>`;
    }).join('');
    $main().innerHTML = `
      <div class="page-head"><div><h1>Devices</h1><p>Status is a best-effort proxy from last successful sync — there is no real-time online/offline signal from a device.</p></div></div>
      <div class="card">
        ${devices.length ? `<table><thead><tr><th>Device</th><th>Festival</th><th>Tester</th><th>Last sync</th><th>Sessions</th><th>Status</th></tr></thead>
          <tbody>${rows}</tbody></table>` : '<div class="empty">No devices registered yet.</div>'}
      </div>
      <p style="color:var(--dimmer);font-size:12px;margin-top:14px">Sync conflicts cannot be attributed to a specific device with the current schema (sync_conflicts only records the session, not the device) — see README for details.</p>
    `;
  }

  /* ============================ Festivals (list only for now) ============================ */
  async function ScreenFestivals() {
    const festivals = await AdminData.getFestivals();
    const rows = festivals.map((f) => `<tr>
      <td>${AdminCharts.esc(f.name)}</td><td>${AdminCharts.esc(f.village || '—')}</td>
      <td>${f.start_date} → ${f.end_date}</td><td><span class="chip dim">${f.status}</span></td>
    </tr>`).join('');
    $main().innerHTML = `
      <div class="page-head"><div><h1>Festivals</h1><p>Per-festival drill-down (throughput, clinical stats, timeline) is coming in a follow-up pass.</p></div></div>
      <div class="card">
        ${festivals.length ? `<table><thead><tr><th>Name</th><th>Village</th><th>Dates</th><th>Status</th></tr></thead>
          <tbody>${rows}</tbody></table>` : '<div class="empty">No festivals yet.</div>'}
      </div>
    `;
  }

  /* ============================ Researchers ============================ */
  const AGE_BANDS = ['0–9', '10–19', '20–34', '35–44', '45–54', '55–64', '65+'];
  const PADDLE_POWERS = ['+0.75', '+1.00', '+1.25', '+1.50', '+1.75', '+2.00', '+2.25', '+2.50', '+3.00'];
  let researchFilters = {};
  let researchRows = [];
  let researchFestivals = [];

  function csvEscape(v) {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function downloadResearchCsv() {
    if (!researchRows.length) { toast('Nothing to export — adjust your filters.'); return; }
    const cols = ['client_id', 'festival_name', 'village', 'age_band', 'gender', 'cataract', 'status', 'route',
      'distance_outcome', 'near_outcome', 'wheel_right_lens_type', 'wheel_right_sphere', 'wheel_left_lens_type',
      'wheel_left_sphere', 'paddle_power', 'glasses_dispensed', 'registered_at', 'finalised_at'];
    const lines = [cols.join(',')].concat(researchRows.map((r) => cols.map((c) => csvEscape(r[c])).join(',')));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `ooxii-research-export-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast(`Exported ${researchRows.length} anonymised rows.`);
  }

  function readResearchFiltersFromForm() {
    const v = (id) => document.getElementById(id).value || undefined;
    researchFilters = {
      dateFrom: v('rf-from'), dateTo: v('rf-to'), festivalId: v('rf-festival'),
      village: v('rf-village'), ageBand: v('rf-age'), gender: v('rf-gender'),
      route: v('rf-route'), distanceOutcome: v('rf-distance'), nearOutcome: v('rf-near'),
      paddlePower: v('rf-paddle'),
    };
  }

  async function applyResearchFilters() {
    readResearchFiltersFromForm();
    document.getElementById('rf-results').innerHTML = '<div class="loading">Querying…</div>';
    researchRows = await AdminData.getResearchSessions(researchFilters);
    renderResearchResults();
  }

  function renderResearchResults() {
    const rows = researchRows;
    const villages = new Set(rows.map((r) => r.village).filter(Boolean));
    const festivals = new Set(rows.map((r) => r.festival_id).filter(Boolean));
    const shown = rows.slice(0, 200);
    document.getElementById('rf-results').innerHTML = `
      <div class="grid-3" style="margin-bottom:16px">
        <div class="card"><h3>Matching sessions</h3><div class="n" style="font-size:26px;font-weight:800">${rows.length}</div></div>
        <div class="card"><h3>Villages covered</h3><div class="n" style="font-size:26px;font-weight:800">${villages.size}</div></div>
        <div class="card"><h3>Festivals covered</h3><div class="n" style="font-size:26px;font-weight:800">${festivals.size}</div></div>
      </div>
      <div class="card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <div><h3 style="margin:0">Dataset explorer</h3><p class="sub" style="margin:2px 0 0">${rows.length ? `Showing ${shown.length} of ${rows.length}` : 'No matching sessions'}</p></div>
          <button class="btn btn-primary" style="width:auto" onclick="AdminApp.exportResearchCsv()">Export CSV (anonymised)</button>
        </div>
        ${rows.length ? `<div style="overflow-x:auto"><table><thead><tr>
          <th>Client</th><th>Festival</th><th>Village</th><th>Age band</th><th>Gender</th>
          <th>Route</th><th>Distance</th><th>Near</th><th>Paddle</th><th>Registered</th>
        </tr></thead><tbody>${shown.map((r) => `<tr>
          <td>${AdminCharts.esc(r.client_id)}</td><td>${AdminCharts.esc(r.festival_name || '—')}</td>
          <td>${AdminCharts.esc(r.village || '—')}</td><td>${AdminCharts.esc(r.age_band || '—')}</td>
          <td>${AdminCharts.esc(r.gender || '—')}</td><td><span class="chip dim">${AdminCharts.esc(r.route)}</span></td>
          <td>${r.distance_outcome ? `<span class="chip ${r.distance_outcome === 'pass' ? 'green' : 'red'}">${r.distance_outcome}</span>` : '—'}</td>
          <td>${r.near_outcome ? `<span class="chip ${r.near_outcome === 'pass' ? 'green' : 'red'}">${r.near_outcome}</span>` : '—'}</td>
          <td>${AdminCharts.esc(r.paddle_power || '—')}</td><td>${fmtDate(r.registered_at)}</td>
        </tr>`).join('')}</tbody></table></div>` : '<div class="empty">Try widening your filters.</div>'}
      </div>
    `;
  }

  async function ScreenResearchers() {
    researchFestivals = await AdminData.getFestivals();
    const opt = (arr, valKey, labelKey) => arr.map((x) => `<option value="${AdminCharts.esc(typeof x === 'string' ? x : x[valKey])}">${AdminCharts.esc(typeof x === 'string' ? x : x[labelKey])}</option>`).join('');
    $main().innerHTML = `
      <div class="page-head"><div><h1>Researchers</h1><p>Anonymised, session-level dataset — no names, no phone/email/address, no full date of birth. Age band, village and gender only, matching how the tester app records them.</p></div></div>
      <div class="card" style="margin-bottom:16px">
        <h3 style="margin:0 0 12px">Filters</h3>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px">
          <div class="field"><label>From</label><input type="date" id="rf-from"></div>
          <div class="field"><label>To</label><input type="date" id="rf-to"></div>
          <div class="field"><label>Festival</label><select id="rf-festival"><option value="">Any</option>${opt(researchFestivals, 'id', 'name')}</select></div>
          <div class="field"><label>Village</label><select id="rf-village"><option value="">Any</option>${opt(VILLAGES_LIST)}</select></div>
          <div class="field"><label>Age band</label><select id="rf-age"><option value="">Any</option>${opt(AGE_BANDS)}</select></div>
          <div class="field"><label>Gender</label><select id="rf-gender"><option value="">Any</option><option>Male</option><option>Female</option><option>Other</option></select></div>
          <div class="field"><label>Pathway</label><select id="rf-route"><option value="">Any</option>
            <option value="none">Distance only (no glasses)</option><option value="paddle_only">Distance + Paddle</option>
            <option value="wheel_only">Distance + Wheel</option><option value="wheel_then_paddle">Full workflow</option></select></div>
          <div class="field"><label>Distance result</label><select id="rf-distance"><option value="">Any</option><option value="pass">Pass</option><option value="fail">Fail</option></select></div>
          <div class="field"><label>Near result</label><select id="rf-near"><option value="">Any</option><option value="pass">Pass</option><option value="fail">Fail</option></select></div>
          <div class="field"><label>Paddle power</label><select id="rf-paddle"><option value="">Any</option>${opt(PADDLE_POWERS)}</select></div>
        </div>
        <button class="btn btn-primary" style="width:auto;margin-top:6px" onclick="AdminApp.applyResearchFilters()">Apply filters</button>
      </div>
      <div id="rf-results"><div class="loading">Choose filters and apply, or apply with no filters for everything (capped at 2000 rows).</div></div>
    `;
  }

  const VILLAGES_LIST = ['Port Vila', 'Mele', 'Pango', 'Lelepa', 'Erakor', 'Ifira', 'Eratap', 'Other (camp area)'];

  const SCREENS = {
    dashboard: ScreenDashboard,
    devices: ScreenDevices,
    festivals: ScreenFestivals,
    researchers: ScreenResearchers,
    exports: placeholder('Exports', 'CSV / Excel / JSON report generation — coming in a follow-up commit on this branch.'),
    settings: placeholder('Settings', 'Portal preferences — coming in a follow-up commit on this branch.'),
  };

  /* ============================ boot ============================ */
  async function boot() {
    const access = await AdminAuth.checkCoordinatorAccess();
    if (!access.ok) {
      document.getElementById('app').style.display = 'none';
      document.getElementById('gate').style.display = 'flex';
      if (access.reason === 'no_session') { renderSignIn(); return; }
      renderDenied(access.reason, access.profile);
      return;
    }
    state.profile = access.profile;
    document.getElementById('gate').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    go('dashboard');
  }

  window.AdminApp = { go, doSignIn, signOut, applyResearchFilters, exportResearchCsv: downloadResearchCsv };
  document.addEventListener('DOMContentLoaded', boot);
})();
