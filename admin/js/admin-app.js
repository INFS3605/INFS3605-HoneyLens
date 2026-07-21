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

  /* ============================ Dashboard (impact-focused) ============================
     Metric sourcing (see admin/README.md "Dashboard metrics" table for the full version):
     - clientsTested: count of client_sessions rows (unique client+festival sessions, not
       session_events) — v_admin_kpis.total_clients when unfiltered, row count of the
       filtered v_admin_research_sessions query otherwise.
     - glassesDispensed: client_sessions where dispense->>'glassesDispensed'='true' — one
       per session, not per click/event.
     - festivalsDelivered: festivals with >=1 client session (NOT every festival row —
       v_admin_kpis.total_festivals includes festivals with zero activity, which would
       misrepresent "delivered"; this dashboard derives delivered-count from
       v_admin_festival_impact filtered to clients>0 instead).
     - communitiesReached: distinct non-null client_sessions.village values.
     - completionRatePct / dispensingRatePct: both use "all tested clients" as the
       denominator (shown explicitly in the UI next to each figure).
  */
  let dashFilters = { period: 'all', dateFrom: null, dateTo: null, festivalId: '', village: '' };
  let dashData = null;
  let dashVillageOptions = [];
  let dashFestivalOptions = [];
  let dashSeries = 'clients';

  function isoDaysAgo(n) { return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10); }

  function isDashFiltered(f) {
    return !!(f.festivalId || f.village || f.period !== 'all');
  }

  function periodToRange(f) {
    if (f.period === '30') return { dateFrom: isoDaysAgo(30), dateTo: null };
    if (f.period === '90') return { dateFrom: isoDaysAgo(90), dateTo: null };
    if (f.period === 'custom') return { dateFrom: f.dateFrom || null, dateTo: f.dateTo || null };
    return { dateFrom: null, dateTo: null };
  }

  async function loadImpactDataUnfiltered() {
    const [kpis, funnel, pathways, distanceOut, nearOut, ageDist, genderDist, villageDist, festivalImpact, dailyClients, dailyDispensed, avgCompletion] = await Promise.all([
      AdminData.getKpis(), AdminData.getCompletionFunnel(), AdminData.getPathwayFrequencies(),
      AdminData.getDistanceOutcomes(), AdminData.getNearOutcomes(), AdminData.getAgeDistribution(),
      AdminData.getGenderDistribution(), AdminData.getVillageDistribution(), AdminData.getFestivalImpact(),
      AdminData.getAllDailyClients(), AdminData.getAllDailyDispensed(), AdminData.getAvgCompletionTime(),
    ]);
    const villageClean = villageDist.filter((v) => v.village !== 'Unknown');
    const festivalsActive = festivalImpact.filter((f) => f.clients > 0);
    const pathwayMap = {}; pathways.forEach((p) => { pathwayMap[p.route] = p.n; });
    const distMap = {}; distanceOut.forEach((d) => { distMap[d.outcome] = d.n; });
    const nearMap = {}; nearOut.forEach((d) => { nearMap[d.outcome] = d.n; });
    return {
      clientsTested: kpis.total_clients,
      glassesDispensed: kpis.glasses_dispensed,
      festivalsDelivered: festivalsActive.length,
      communitiesReached: villageClean.length,
      completedSessions: funnel.completed,
      completionRatePct: kpis.total_clients ? Math.round(100 * funnel.completed / kpis.total_clients) : null,
      dispensingRatePct: kpis.total_clients ? Math.round(1000 * kpis.glasses_dispensed / kpis.total_clients) / 10 : null,
      distance: { pass: distMap.pass || 0, fail: distMap.fail || 0 },
      near: { pass: nearMap.pass || 0, fail: nearMap.fail || 0 },
      pathway: { none: pathwayMap.none || 0, paddle_only: pathwayMap.paddle_only || 0, wheel_only: pathwayMap.wheel_only || 0, wheel_then_paddle: pathwayMap.wheel_then_paddle || 0, incomplete: pathwayMap.incomplete || 0 },
      ageDist, genderDist, villageDist: villageClean,
      festivalImpact,
      dailyClients: dailyClients.map((d) => ({ day: d.day, n: d.clients_registered })),
      dailyDispensed: dailyDispensed.map((d) => ({ day: d.day, n: d.glasses_dispensed })),
      avgCompletionHours: avgCompletion.avg_hours, avgCompletionSampleSize: avgCompletion.sample_size,
      capped: false,
    };
  }

  async function loadImpactDataFiltered(filters) {
    const range = periodToRange(filters);
    const rows = await AdminData.getResearchSessions({ dateFrom: range.dateFrom, dateTo: range.dateTo, festivalId: filters.festivalId || undefined, village: filters.village || undefined });
    const clientsTested = rows.length;
    const glassesDispensed = rows.filter((r) => r.glasses_dispensed).length;
    const completedSessions = rows.filter((r) => r.status === 'Finalised').length;
    const festivalIds = new Set(rows.map((r) => r.festival_id).filter(Boolean));
    const villagesSet = new Set(rows.map((r) => r.village).filter(Boolean));
    const pathway = { none: 0, paddle_only: 0, wheel_only: 0, wheel_then_paddle: 0, incomplete: 0 };
    rows.forEach((r) => { const k = r.route || 'incomplete'; pathway[k] = (pathway[k] || 0) + 1; });
    const ageCounts = {}; rows.forEach((r) => { const k = r.age_band || 'Unknown'; ageCounts[k] = (ageCounts[k] || 0) + 1; });
    const genderCounts = {}; rows.forEach((r) => { const k = r.gender || 'Unknown'; genderCounts[k] = (genderCounts[k] || 0) + 1; });
    const villageCounts = {}; rows.forEach((r) => { if (r.village) villageCounts[r.village] = (villageCounts[r.village] || 0) + 1; });
    const festMap = {};
    rows.forEach((r) => {
      if (!r.festival_id) return;
      const f = festMap[r.festival_id] || (festMap[r.festival_id] = { festival_id: r.festival_id, festival_name: r.festival_name, clients: 0, completed_sessions: 0, glasses_dispensed: 0 });
      f.clients++;
      if (r.status === 'Finalised') f.completed_sessions++;
      if (r.glasses_dispensed) f.glasses_dispensed++;
    });
    const festivalImpact = Object.values(festMap).map((f) => ({
      ...f,
      completion_rate_pct: f.clients ? Math.round(1000 * f.completed_sessions / f.clients) / 10 : null,
      dispensing_rate_pct: f.clients ? Math.round(1000 * f.glasses_dispensed / f.clients) / 10 : null,
    })).sort((a, b) => b.clients - a.clients);
    const dailyClientsMap = {}; rows.forEach((r) => { if (!r.registered_at) return; const d = r.registered_at.slice(0, 10); dailyClientsMap[d] = (dailyClientsMap[d] || 0) + 1; });
    const dailyDispensedMap = {}; rows.forEach((r) => { if (!r.glasses_dispensed || !r.finalised_at) return; const d = r.finalised_at.slice(0, 10); dailyDispensedMap[d] = (dailyDispensedMap[d] || 0) + 1; });
    const toSeries = (m) => Object.entries(m).sort((a, b) => a[0].localeCompare(b[0])).map(([day, n]) => ({ day, n }));
    const durations = rows.filter((r) => r.status === 'Finalised' && r.registered_at && r.finalised_at)
      .map((r) => (new Date(r.finalised_at) - new Date(r.registered_at)) / 3600000);
    return {
      clientsTested, glassesDispensed,
      festivalsDelivered: festivalIds.size,
      communitiesReached: villagesSet.size,
      completedSessions,
      completionRatePct: clientsTested ? Math.round(100 * completedSessions / clientsTested) : null,
      dispensingRatePct: clientsTested ? Math.round(1000 * glassesDispensed / clientsTested) / 10 : null,
      distance: { pass: rows.filter((r) => r.distance_outcome === 'pass').length, fail: rows.filter((r) => r.distance_outcome === 'fail').length },
      near: { pass: rows.filter((r) => r.near_outcome === 'pass').length, fail: rows.filter((r) => r.near_outcome === 'fail').length },
      pathway,
      ageDist: Object.entries(ageCounts).map(([age_band, n]) => ({ age_band, n })),
      genderDist: Object.entries(genderCounts).map(([gender, n]) => ({ gender, n })),
      villageDist: Object.entries(villageCounts).map(([village, n]) => ({ village, n })).sort((a, b) => b.n - a.n),
      festivalImpact,
      dailyClients: toSeries(dailyClientsMap), dailyDispensed: toSeries(dailyDispensedMap),
      avgCompletionHours: durations.length ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10 : null,
      avgCompletionSampleSize: durations.length,
      capped: rows.length === 2000,
    };
  }

  function computeFestivalDelta(festivalImpact, festivalsMeta) {
    const active = festivalImpact.filter((f) => f.clients > 0);
    if (active.length < 2) return null;
    const withDates = active.map((f) => {
      const meta = festivalsMeta.find((m) => m.id === f.festival_id);
      return { ...f, start_date: meta ? meta.start_date : null };
    }).filter((f) => f.start_date).sort((a, b) => a.start_date.localeCompare(b.start_date));
    if (withDates.length < 2) return null;
    const last = withDates[withDates.length - 1], prev = withDates[withDates.length - 2];
    return { clientsDelta: last.clients - prev.clients, glassesDelta: last.glasses_dispensed - prev.glasses_dispensed, lastName: last.festival_name, prevName: prev.festival_name };
  }

  function ctxHtml(delta, unit) {
    if (delta == null) return '';
    const sign = delta > 0 ? '+' : '';
    const cls = delta > 0 ? 'up' : (delta < 0 ? 'down' : '');
    return `<div class="ctx ${cls}">${sign}${delta} ${unit} vs previous festival</div>`;
  }

  async function ScreenDashboard() {
    const [festivalsMeta, dq, kpisGlobal] = await Promise.all([AdminData.getFestivals(), AdminData.getDataQuality(), AdminData.getKpis()]);
    dashFestivalOptions = festivalsMeta;
    const villageDistAll = await AdminData.getVillageDistribution();
    dashVillageOptions = villageDistAll.filter((v) => v.village !== 'Unknown').map((v) => v.village);

    const filtered = isDashFiltered(dashFilters);
    dashData = filtered ? await loadImpactDataFiltered(dashFilters) : await loadImpactDataUnfiltered();
    const delta = (!dashFilters.festivalId) ? computeFestivalDelta(dashData.festivalImpact, festivalsMeta) : null;

    $main().innerHTML = renderFilterBar() + renderHero(dashData, delta) + renderOutcomes(dashData)
      + renderOverTimeSection(dashData) + renderFestivalImpactSection(dashData)
      + renderCommunitiesSection(dashData) + renderDemographicsSection(dashData)
      + renderProgramEffectiveness(dashData) + renderSystemHealth(kpisGlobal, dq);
    wireOverTimeToggle();
  }

  function renderFilterBar() {
    const festOpts = dashFestivalOptions.map((f) => `<option value="${f.id}" ${dashFilters.festivalId === f.id ? 'selected' : ''}>${AdminCharts.esc(f.name)}</option>`).join('');
    const villOpts = dashVillageOptions.map((v) => `<option value="${AdminCharts.esc(v)}" ${dashFilters.village === v ? 'selected' : ''}>${AdminCharts.esc(v)}</option>`).join('');
    const showCustom = dashFilters.period === 'custom';
    return `
      <div class="filter-bar">
        <div class="field"><label>Reporting period</label>
          <select id="df-period" onchange="AdminApp.dashFilterChanged()">
            <option value="all" ${dashFilters.period === 'all' ? 'selected' : ''}>All time</option>
            <option value="30" ${dashFilters.period === '30' ? 'selected' : ''}>Last 30 days</option>
            <option value="90" ${dashFilters.period === '90' ? 'selected' : ''}>Last 90 days</option>
            <option value="custom" ${dashFilters.period === 'custom' ? 'selected' : ''}>Custom range</option>
          </select>
        </div>
        ${showCustom ? `
        <div class="field"><label>From</label><input type="date" id="df-from" value="${dashFilters.dateFrom || ''}" onchange="AdminApp.dashFilterChanged()"></div>
        <div class="field"><label>To</label><input type="date" id="df-to" value="${dashFilters.dateTo || ''}" onchange="AdminApp.dashFilterChanged()"></div>` : ''}
        <div class="field"><label>Festival</label><select id="df-festival" onchange="AdminApp.dashFilterChanged()"><option value="">All festivals</option>${festOpts}</select></div>
        <div class="field"><label>Village</label><select id="df-village" onchange="AdminApp.dashFilterChanged()"><option value="">All villages</option>${villOpts}</select></div>
        <button class="filter-reset" onclick="AdminApp.resetDashFilters()">Reset filters</button>
      </div>
    `;
  }

  function dashFilterChanged() {
    dashFilters = {
      period: document.getElementById('df-period').value,
      dateFrom: document.getElementById('df-from') ? document.getElementById('df-from').value : null,
      dateTo: document.getElementById('df-to') ? document.getElementById('df-to').value : null,
      festivalId: document.getElementById('df-festival').value,
      village: document.getElementById('df-village').value,
    };
    go('dashboard');
  }

  function resetDashFilters() {
    dashFilters = { period: 'all', dateFrom: null, dateTo: null, festivalId: '', village: '' };
    go('dashboard');
  }

  function renderHero(d, delta) {
    return `
      <div class="hero">
        <h1>OOXii Impact Overview</h1>
        <p class="lede">A clear view of how many people, communities and eye-care needs OOXii has supported.</p>
        <div class="hero-grid">
          <div class="hero-card"><div class="lbl">Clients tested</div><div class="n">${d.clientsTested}</div>${ctxHtml(delta ? delta.clientsDelta : null, 'clients')}</div>
          <div class="hero-card"><div class="lbl">Glasses dispensed</div><div class="n">${d.glassesDispensed}</div>${ctxHtml(delta ? delta.glassesDelta : null, 'glasses')}</div>
          <div class="hero-card"><div class="lbl">Eye festivals delivered</div><div class="n">${d.festivalsDelivered}</div><div class="ctx">${d.festivalsDelivered ? `avg ${Math.round(d.clientsTested / d.festivalsDelivered)} clients / festival` : ''}</div></div>
          <div class="hero-card"><div class="lbl">Communities reached</div><div class="n">${d.communitiesReached}</div><div class="ctx">${d.capped ? 'based on most recent 2000 matching sessions' : 'unique villages with a tested client'}</div></div>
        </div>
      </div>
    `;
  }

  function renderOutcomes(d) {
    const dispPct = d.dispensingRatePct != null ? d.dispensingRatePct + '%' : '—';
    const compPct = d.completionRatePct != null ? d.completionRatePct + '%' : '—';
    const distNeed = d.distance.fail; // failed distance = needs distance correction
    const nearNeed = d.near.fail;
    const both = d.pathway.wheel_then_paddle;
    const none = d.pathway.none;
    return `
      <div class="section">
        <div class="section-head"><h2>Outcomes Delivered</h2><p>What happened after testing, out of ${d.clientsTested} clients tested</p></div>
        <div class="outcome-grid">
          <div class="outcome-card"><div class="n">${dispPct}</div><div class="lbl">Clients who received glasses</div><div class="denom">${d.glassesDispensed} of ${d.clientsTested} tested clients</div></div>
          <div class="outcome-card"><div class="n">${compPct}</div><div class="lbl">Testing pathways completed</div><div class="denom">${d.completedSessions} of ${d.clientsTested} tested clients</div></div>
          <div class="outcome-card"><div class="n">${distNeed}</div><div class="lbl">Clients with distance vision needs</div><div class="denom">of ${d.distance.pass + d.distance.fail} with a distance result</div></div>
          <div class="outcome-card"><div class="n">${nearNeed}</div><div class="lbl">Clients with near vision needs</div><div class="denom">of ${d.near.pass + d.near.fail} with a near result</div></div>
        </div>
        <p style="color:var(--dimmer);font-size:12px;margin-top:12px">${both} clients needed both distance and near correction · ${none} needed no glasses at all (see Program Effectiveness below for the full pathway breakdown).</p>
      </div>
    `;
  }

  function renderOverTimeSection(d) {
    const series = dashSeries === 'clients' ? d.dailyClients : d.dailyDispensed;
    const points = series.map((p) => ({ x: p.day, x_label: p.day.slice(5), y: p.n }));
    return `
      <div class="section">
        <div class="section-head" style="display:flex;align-items:flex-end;justify-content:space-between;flex-wrap:wrap;gap:10px">
          <div><h2>People Reached Over Time</h2><p>${dashSeries === 'clients' ? 'Clients tested' : 'Glasses dispensed'} by day, current filters applied</p></div>
          <div class="chart-toggle" id="dash-series-toggle">
            <button data-s="clients" class="${dashSeries === 'clients' ? 'on' : ''}">Clients tested</button>
            <button data-s="dispensed" class="${dashSeries === 'dispensed' ? 'on' : ''}">Glasses dispensed</button>
          </div>
        </div>
        <div class="card" id="over-time-card">
          ${points.length ? AdminCharts.lineChart(points, { width: 900, height: 220 }) : '<div class="empty">No data in this window yet.</div>'}
        </div>
      </div>
    `;
  }

  function wireOverTimeToggle() {
    const el = document.getElementById('dash-series-toggle');
    if (!el) return;
    const section = el.parentElement.parentElement; // .chart-toggle -> .section-head -> .section
    el.querySelectorAll('button').forEach((btn) => btn.addEventListener('click', () => {
      dashSeries = btn.dataset.s;
      section.outerHTML = renderOverTimeSection(dashData);
      wireOverTimeToggle();
    }));
  }

  function renderFestivalImpactSection(d) {
    const rows = d.festivalImpact.filter((f) => f.clients > 0);
    return `
      <div class="section">
        <div class="section-head"><h2>Impact by Eye Festival</h2><p>Click a festival for its full breakdown</p></div>
        <div class="card">
          ${rows.length ? `<table><thead><tr><th>Festival</th><th>Clients tested</th><th>Glasses dispensed</th><th>Completion rate</th><th>Dispensing rate</th></tr></thead>
          <tbody>${rows.map((f) => `<tr class="clickable-row" onclick="AdminApp.openFestival('${f.festival_id}')">
            <td>${AdminCharts.esc(f.festival_name)}</td><td>${f.clients}</td><td>${f.glasses_dispensed}</td>
            <td>${f.completion_rate_pct != null ? f.completion_rate_pct + '%' : '—'}</td>
            <td>${f.dispensing_rate_pct != null ? f.dispensing_rate_pct + '%' : '—'}</td>
          </tr>`).join('')}</tbody></table>` : '<div class="empty">No festivals with recorded activity in this window.</div>'}
        </div>
      </div>
    `;
  }

  function renderCommunitiesSection(d) {
    const rows = d.villageDist.slice(0, 10);
    const max = Math.max(1, ...rows.map((r) => r.n));
    return `
      <div class="section">
        <div class="section-head"><h2>Communities Reached</h2><p>${d.communitiesReached} unique communities with a tested client</p></div>
        <div class="card">
          ${rows.length ? rows.map((r) => `<div class="rank-row"><div class="name">${AdminCharts.esc(r.village)}</div>
            <div class="bar-track"><div class="bar-fill" style="width:${Math.round(100 * r.n / max)}%"></div></div>
            <div class="val">${r.n}</div></div>`).join('') : '<div class="empty">No community data yet.</div>'}
        </div>
      </div>
    `;
  }

  function renderDemographicsSection(d) {
    const ageBars = [...d.ageDist].sort((a, b) => a.age_band.localeCompare(b.age_band)).map((r) => ({ label: r.age_band, value: r.n }));
    const genderSegs = d.genderDist.map((r, i) => ({ label: r.gender, value: r.n, color: AdminCharts.PALETTE[i % AdminCharts.PALETTE.length] }));
    return `
      <div class="section">
        <div class="section-head"><h2>Who OOXii Reached</h2><p>Age, gender and community mix of tested clients</p></div>
        <div class="small-grid">
          <div class="small-card"><h4>Age</h4>${ageBars.length ? AdminCharts.barChart(ageBars, { height: 130, width: 300 }) : '<div class="empty">No data yet.</div>'}</div>
          <div class="small-card"><h4>Gender</h4><div style="display:flex;justify-content:center">${genderSegs.length ? AdminCharts.donutChart(genderSegs, { size: 110 }) : '<div class="empty">No data yet.</div>'}</div></div>
        </div>
      </div>
    `;
  }

  function renderProgramEffectiveness(d) {
    const avgClients = d.festivalsDelivered ? Math.round(d.clientsTested / d.festivalsDelivered) : null;
    const avgGlasses = d.festivalsDelivered ? Math.round(d.glassesDispensed / d.festivalsDelivered) : null;
    const compTime = (d.avgCompletionSampleSize >= 3 && d.avgCompletionHours != null) ? `${d.avgCompletionHours}h` : 'Not enough data yet';
    return `
      <div class="section">
        <div class="section-head"><h2>Program Effectiveness</h2><p>How operations translate into impact</p></div>
        <div class="small-grid">
          <div class="small-card"><h4>Pathway completion rate</h4><div style="font-size:22px;font-weight:800">${d.completionRatePct != null ? d.completionRatePct + '%' : '—'}</div></div>
          <div class="small-card"><h4>Avg. clients / festival</h4><div style="font-size:22px;font-weight:800">${avgClients != null ? avgClients : '—'}</div></div>
          <div class="small-card"><h4>Avg. glasses / festival</h4><div style="font-size:22px;font-weight:800">${avgGlasses != null ? avgGlasses : '—'}</div></div>
          <div class="small-card"><h4>Avg. registration → completion</h4><div style="font-size:22px;font-weight:800">${compTime}</div>
            <p style="font-size:11px;color:var(--dimmer);margin:6px 0 0">Measured from when each event reached the server — may run long if a device was offline before syncing.</p></div>
        </div>
      </div>
    `;
  }

  function renderSystemHealth(kpis, dq) {
    const warn = (v, threshold) => v != null && v >= threshold ? 'warn' : '';
    return `
      <div class="section">
        <details class="system-health">
          <summary>System and Data Health <span class="car">▸</span></summary>
          <div class="health-body">
            <p style="color:var(--dimmer);font-size:12.5px;margin:0 0 14px">Technical status for coordinators, reflecting the whole system regardless of the filters above. Not part of OOXii's impact.</p>
            <div class="health-grid">
              <div class="health-tile"><div class="n">${kpis.sync_success_pct != null ? kpis.sync_success_pct + '%' : '—'}</div><div class="lbl">Sync success</div></div>
              <div class="health-tile"><div class="n">—</div><div class="lbl">Pending sync events (not visible until synced)</div></div>
              <div class="health-tile ${warn(kpis.conflict_events, 1)}"><div class="n">${kpis.conflict_events}</div><div class="lbl">Sync conflicts</div></div>
              <div class="health-tile ${warn(kpis.offline_devices, 1)}"><div class="n">${kpis.offline_devices}</div><div class="lbl">Offline devices (>1h)</div></div>
              <div class="health-tile"><div class="n">${kpis.unique_devices}</div><div class="lbl">Devices registered</div></div>
              <div class="health-tile"><div class="n">${kpis.unique_testers}</div><div class="lbl">Testers active</div></div>
              <div class="health-tile"><div class="n">${kpis.distance_tests}</div><div class="lbl">Distance tests recorded</div></div>
              <div class="health-tile"><div class="n">${kpis.near_tests}</div><div class="lbl">Near tests recorded</div></div>
              <div class="health-tile"><div class="n">${kpis.wheel_tests}</div><div class="lbl">Wheel tests recorded</div></div>
              <div class="health-tile"><div class="n">${kpis.paddle_tests}</div><div class="lbl">Paddle tests recorded</div></div>
            </div>
            <table><thead><tr><th>Data quality</th><th>Count</th><th>% of ${dq.total_sessions} sessions</th></tr></thead><tbody>
              <tr><td>Missing age band</td><td>${dq.missing_age_band}</td><td>${dq.total_sessions ? Math.round(100 * dq.missing_age_band / dq.total_sessions) : 0}%</td></tr>
              <tr><td>Missing village</td><td>${dq.missing_village}</td><td>${dq.total_sessions ? Math.round(100 * dq.missing_village / dq.total_sessions) : 0}%</td></tr>
              <tr><td>Missing gender</td><td>${dq.missing_gender}</td><td>${dq.total_sessions ? Math.round(100 * dq.missing_gender / dq.total_sessions) : 0}%</td></tr>
              <tr><td>Incomplete sessions (not Finalised)</td><td>${dq.incomplete_sessions}</td><td>${dq.total_sessions ? Math.round(100 * dq.incomplete_sessions / dq.total_sessions) : 0}%</td></tr>
              <tr><td style="color:var(--dimmer);font-style:italic">Duplicate QR scans</td><td colspan="2" style="color:var(--dimmer);font-style:italic">Not tracked server-side</td></tr>
              <tr><td style="color:var(--dimmer);font-style:italic">Average sync delay</td><td colspan="2" style="color:var(--dimmer);font-style:italic">Not tracked server-side</td></tr>
              <tr><td style="color:var(--dimmer);font-style:italic">Offline queue size</td><td colspan="2" style="color:var(--dimmer);font-style:italic">Only visible on-device, until synced</td></tr>
            </tbody></table>
          </div>
        </details>
      </div>
      <div class="section" style="text-align:center">
        <button class="btn btn-primary" style="width:auto" onclick="AdminApp.generateImpactSummary()">Generate Impact Summary</button>
      </div>
    `;
  }

  function generateImpactSummary() {
    const d = dashData;
    if (!d) { toast('Dashboard data not loaded yet.'); return; }
    const periodLabels = { all: 'All time', '30': 'Last 30 days', '90': 'Last 90 days', custom: `${dashFilters.dateFrom || '…'} to ${dashFilters.dateTo || '…'}` };
    const festivalLabel = dashFilters.festivalId ? ((dashFestivalOptions.find((f) => f.id === dashFilters.festivalId) || {}).name || 'Selected festival') : 'All festivals';
    const villageLabel = dashFilters.village || 'All communities';
    const rows = d.festivalImpact.filter((f) => f.clients > 0);
    const points = (dashSeries === 'clients' ? d.dailyClients : d.dailyDispensed).map((p) => ({ x: p.day, x_label: p.day.slice(5), y: p.n }));
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>OOXii Impact Summary</title>
<style>
  body{font-family:'Segoe UI',system-ui,-apple-system,Roboto,Helvetica,Arial,sans-serif;color:#111;max-width:800px;margin:40px auto;padding:0 20px}
  h1{font-size:26px;margin-bottom:2px} .sub{color:#555;margin-top:0}
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:24px 0}
  .kpi{border:1px solid #ddd;border-radius:10px;padding:14px}
  .kpi .n{font-size:26px;font-weight:800} .kpi .l{font-size:12px;color:#555}
  .stat{margin:10px 0;font-size:15px}
  table{width:100%;border-collapse:collapse;margin:14px 0;font-size:13px}
  th,td{border-bottom:1px solid #ddd;padding:8px;text-align:left}
  @media print{ .noprint{display:none} }
</style></head><body>
<h1>OOXii Impact Summary</h1>
<p class="sub">Reporting period: ${AdminCharts.esc(periodLabels[dashFilters.period])} &middot; Festival: ${AdminCharts.esc(festivalLabel)} &middot; Village: ${AdminCharts.esc(villageLabel)}<br>Generated ${new Date().toLocaleString()}</p>
<div class="kpis">
  <div class="kpi"><div class="n">${d.clientsTested}</div><div class="l">Clients tested</div></div>
  <div class="kpi"><div class="n">${d.glassesDispensed}</div><div class="l">Glasses dispensed</div></div>
  <div class="kpi"><div class="n">${d.festivalsDelivered}</div><div class="l">Festivals delivered</div></div>
  <div class="kpi"><div class="n">${d.communitiesReached}</div><div class="l">Communities reached</div></div>
</div>
<p class="stat"><b>${d.completionRatePct != null ? d.completionRatePct + '%' : '—'}</b> of tested clients completed the full testing pathway (${d.completedSessions} of ${d.clientsTested}).</p>
<p class="stat"><b>${d.dispensingRatePct != null ? d.dispensingRatePct + '%' : '—'}</b> of tested clients received glasses (${d.glassesDispensed} of ${d.clientsTested}).</p>
<h2>People reached over time (${dashSeries === 'clients' ? 'clients tested' : 'glasses dispensed'})</h2>
${points.length ? AdminCharts.lineChart(points, { width: 720, height: 200 }) : '<p>No data in this window.</p>'}
<h2>Impact by eye festival</h2>
${rows.length ? `<table><thead><tr><th>Festival</th><th>Clients</th><th>Glasses</th><th>Completion</th><th>Dispensing</th></tr></thead>
  <tbody>${rows.map((f) => `<tr><td>${AdminCharts.esc(f.festival_name)}</td><td>${f.clients}</td><td>${f.glasses_dispensed}</td><td>${f.completion_rate_pct != null ? f.completion_rate_pct + '%' : '—'}</td><td>${f.dispensing_rate_pct != null ? f.dispensing_rate_pct + '%' : '—'}</td></tr>`).join('')}</tbody></table>`
  : '<p>No festivals with recorded activity in this window.</p>'}
<p class="noprint" style="margin-top:24px"><button onclick="window.print()">Print / Save as PDF</button></p>
</body></html>`;
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
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
    const rows = festivals.map((f) => `<tr class="clickable-row" onclick="AdminApp.openFestival('${f.id}')">
      <td>${AdminCharts.esc(f.name)}</td><td>${AdminCharts.esc(f.village || '—')}</td>
      <td>${f.start_date} → ${f.end_date}</td><td><span class="chip dim">${f.status}</span></td>
    </tr>`).join('');
    $main().innerHTML = `
      <div class="page-head"><div><h1>Festivals</h1><p>Click a festival for its own dashboard — clients, clinical outcomes, and devices scoped to that festival only.</p></div></div>
      <div class="card">
        ${festivals.length ? `<table><thead><tr><th>Name</th><th>Village</th><th>Dates</th><th>Status</th></tr></thead>
          <tbody>${rows}</tbody></table>` : '<div class="empty">No festivals yet.</div>'}
      </div>
    `;
  }

  async function openFestival(festivalId) {
    state.active = 'festivals';
    renderShell();
    $main().innerHTML = '<div class="loading">Loading…</div>';
    try {
      const [festivals, sessions, devices] = await Promise.all([
        AdminData.getFestivals(), AdminData.getResearchSessions({ festivalId }), AdminData.getDeviceStatus(),
      ]);
      const f = festivals.find((x) => x.id === festivalId);
      const fDevices = devices.filter((d) => d.festival_id === festivalId);
      renderFestivalDetail(f, sessions, fDevices);
    } catch (e) {
      console.error('[OOXii Admin] festival detail failed', e);
      $main().innerHTML = `<div class="placeholder-page"><h2>Could not load this festival</h2><p>${AdminCharts.esc(e.message || 'Unknown error')}</p></div>`;
    }
  }

  function renderFestivalDetail(f, sessions, devices) {
    if (!f) { $main().innerHTML = '<div class="placeholder-page"><h2>Festival not found</h2></div>'; return; }
    const completed = sessions.filter((s) => s.status === 'Finalised').length;
    const dispensed = sessions.filter((s) => s.glasses_dispensed).length;
    const distBars = ['pass', 'fail'].map((k) => ({ label: k === 'pass' ? 'Pass' : 'Fail', value: sessions.filter((s) => s.distance_outcome === k).length, color: k === 'pass' ? AdminCharts.COLORS.green : AdminCharts.COLORS.red }));
    const nearBars = ['pass', 'fail'].map((k) => ({ label: k === 'pass' ? 'Pass' : 'Fail', value: sessions.filter((s) => s.near_outcome === k).length, color: k === 'pass' ? AdminCharts.COLORS.green : AdminCharts.COLORS.red }));
    const villageCounts = {}; sessions.forEach((s) => { const v = s.village || 'Unknown'; villageCounts[v] = (villageCounts[v] || 0) + 1; });
    const villageBars = Object.entries(villageCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([label, value]) => ({ label, value }));
    const deviceRows = devices.map((d) => `<tr><td>${AdminCharts.esc(d.label || d.id.slice(0, 8))}</td><td>${AdminCharts.esc(d.tester_name || '—')}</td>
      <td>${fmtDate(d.last_seen_at)}</td><td><span class="chip ${d.status === 'online' ? 'green' : 'amber'}">${d.status}</span></td></tr>`).join('');

    $main().innerHTML = `
      <div class="page-head">
        <div><h1>${AdminCharts.esc(f.name)}</h1><p>${AdminCharts.esc(f.village || '—')} · ${f.start_date} → ${f.end_date} · <span class="chip dim">${f.status}</span></p></div>
        <button class="btn btn-ghost" style="width:auto" onclick="AdminApp.go('festivals')">← All festivals</button>
      </div>
      <div class="kpi-grid">
        <div class="kpi-card"><div class="n">${sessions.length}</div><div class="lbl">Clients tested</div></div>
        <div class="kpi-card"><div class="n">${completed}</div><div class="lbl">Completed sessions</div></div>
        <div class="kpi-card"><div class="n">${dispensed}</div><div class="lbl">Glasses dispensed</div></div>
        <div class="kpi-card"><div class="n">${devices.length}</div><div class="lbl">Devices used</div></div>
      </div>
      <div class="grid-2">
        <div class="card"><h3>Distance vision outcomes</h3>${distBars.some((b) => b.value) ? AdminCharts.barChart(distBars, { height: 160 }) : '<div class="empty">No distance results yet.</div>'}</div>
        <div class="card"><h3>Near vision outcomes</h3>${nearBars.some((b) => b.value) ? AdminCharts.barChart(nearBars, { height: 160 }) : '<div class="empty">No near results yet.</div>'}</div>
      </div>
      <div class="grid-2">
        <div class="card"><h3>Village distribution</h3>${villageBars.length ? AdminCharts.barChart(villageBars, { height: 170 }) : '<div class="empty">No clients yet.</div>'}</div>
        <div class="card"><h3>Devices at this festival</h3>
          ${deviceRows ? `<table><thead><tr><th>Device</th><th>Tester</th><th>Last sync</th><th>Status</th></tr></thead><tbody>${deviceRows}</tbody></table>` : '<div class="empty">No devices registered for this festival.</div>'}</div>
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

  /* ============================ Exports ============================ */
  function downloadRows(rows, filenameBase, format) {
    if (!rows.length) { toast('Nothing to export.'); return; }
    let blob, ext;
    if (format === 'json') {
      blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
      ext = 'json';
    } else {
      const cols = Object.keys(rows[0]);
      const lines = [cols.join(',')].concat(rows.map((r) => cols.map((c) => csvEscape(r[c])).join(',')));
      blob = new Blob([lines.join('\n')], { type: 'text/csv' });
      ext = 'csv';
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${filenameBase}-${new Date().toISOString().slice(0, 10)}.${ext}`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast(`Exported ${rows.length} row${rows.length === 1 ? '' : 's'} as ${ext.toUpperCase()}.`);
  }

  async function doExport(kind, format) {
    try {
      if (kind === 'festivals') {
        downloadRows(await AdminData.getFestivals(), 'ooxii-festivals', format);
      } else if (kind === 'devices') {
        downloadRows(await AdminData.getDeviceStatus(), 'ooxii-devices', format);
      } else if (kind === 'clinical') {
        const [distance, near, funnel, pathways] = await Promise.all([
          AdminData.getDistanceOutcomes(), AdminData.getNearOutcomes(),
          AdminData.getCompletionFunnel(), AdminData.getPathwayFrequencies(),
        ]);
        const rows = [
          ...distance.map((r) => ({ metric: 'distance_outcome', key: r.outcome, value: r.n })),
          ...near.map((r) => ({ metric: 'near_outcome', key: r.outcome, value: r.n })),
          ...pathways.map((r) => ({ metric: 'pathway', key: r.route, value: r.n })),
          ...Object.entries(funnel).map(([k, v]) => ({ metric: 'funnel_stage', key: k, value: v })),
        ];
        downloadRows(rows, 'ooxii-clinical-summary', format);
      } else if (kind === 'research') {
        downloadRows(await AdminData.getResearchSessions({}), 'ooxii-research-full', format);
      }
    } catch (e) {
      console.error('[OOXii Admin] export failed', kind, e);
      toast('Export failed: ' + (e.message || 'unknown error'));
    }
  }

  function ScreenExports() {
    const card = (title, desc, kind) => `
      <div class="card">
        <h3>${title}</h3><p class="sub">${desc}</p>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn btn-ghost" style="width:auto" onclick="AdminApp.doExport('${kind}','csv')">Download CSV</button>
          <button class="btn btn-ghost" style="width:auto" onclick="AdminApp.doExport('${kind}','json')">Download JSON</button>
        </div>
      </div>`;
    $main().innerHTML = `
      <div class="page-head"><div><h1>Exports</h1><p>CSV opens directly in Excel/Sheets; JSON is for programmatic use. All exports are read-only snapshots — no data is modified.</p></div></div>
      <div class="grid-2">
        ${card('Festival report', 'Every festival — name, village, dates, status.', 'festivals')}
        ${card('Device report', 'Every device — festival, tester, last sync, sessions, status.', 'devices')}
      </div>
      <div class="grid-2">
        ${card('Clinical report', 'Distance/near outcomes, completion funnel, and pathway frequencies, festival-wide.', 'clinical')}
        ${card('Research report', 'Full anonymised session dataset (up to 2000 rows) — same fields as the Researchers page, unfiltered. Use Researchers for a filtered subset.', 'research')}
      </div>
    `;
  }

  const SCREENS = {
    dashboard: ScreenDashboard,
    devices: ScreenDevices,
    festivals: ScreenFestivals,
    researchers: ScreenResearchers,
    exports: ScreenExports,
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

  window.AdminApp = {
    go, doSignIn, signOut, applyResearchFilters, exportResearchCsv: downloadResearchCsv, doExport, openFestival,
    dashFilterChanged, resetDashFilters, generateImpactSummary,
  };
  document.addEventListener('DOMContentLoaded', boot);
})();
