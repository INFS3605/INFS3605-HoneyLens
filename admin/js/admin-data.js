/*
  admin/js/admin-data.js — every Supabase query the Insights Portal makes.
  Read-only, always: not one function in this file ever calls .insert(),
  .update(), .delete(), or .upsert(). Queries the aggregate views from
  supabase/migrations/006_insights_portal_read_access.sql wherever
  possible instead of downloading raw rows.
*/
(function () {
  'use strict';

  function sb() { return window.OOXII_SUPABASE; }

  async function getKpis() {
    const { data, error } = await sb().from('v_admin_kpis').select('*').single();
    if (error) throw error;
    return data;
  }

  async function getDailyClients(days = 30) {
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const { data, error } = await sb().from('v_admin_daily_clients').select('*').gte('day', since).order('day');
    if (error) throw error;
    return data || [];
  }

  async function getDistanceOutcomes() {
    const { data, error } = await sb().from('v_admin_distance_outcomes').select('*');
    if (error) throw error;
    return data || [];
  }

  async function getNearOutcomes() {
    const { data, error } = await sb().from('v_admin_near_outcomes').select('*');
    if (error) throw error;
    return data || [];
  }

  async function getCompletionFunnel() {
    const { data, error } = await sb().from('v_admin_completion_funnel').select('*').single();
    if (error) throw error;
    return data;
  }

  async function getPathwayFrequencies() {
    const { data, error } = await sb().from('v_admin_pathway_frequencies').select('*');
    if (error) throw error;
    return data || [];
  }

  async function getDeviceStatus() {
    const { data, error } = await sb().from('v_admin_device_status').select('*').order('last_seen_at', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async function getFestivals() {
    const { data, error } = await sb().from('festivals').select('*').order('start_date', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async function getSyncConflicts(limit = 50) {
    const { data, error } = await sb().from('sync_conflicts').select('*').order('created_at', { ascending: false }).limit(limit);
    if (error) throw error;
    return data || [];
  }

  async function getAgeDistribution() {
    const { data, error } = await sb().from('v_admin_age_distribution').select('*');
    if (error) throw error;
    return data || [];
  }

  async function getGenderDistribution() {
    const { data, error } = await sb().from('v_admin_gender_distribution').select('*');
    if (error) throw error;
    return data || [];
  }

  async function getVillageDistribution() {
    const { data, error } = await sb().from('v_admin_village_distribution').select('*');
    if (error) throw error;
    return data || [];
  }

  async function getLensPowerDistribution() {
    const { data, error } = await sb().from('v_admin_lens_power_distribution').select('*');
    if (error) throw error;
    return data || [];
  }

  async function getFestivalThroughput() {
    const { data, error } = await sb().from('v_admin_festival_throughput').select('*');
    if (error) throw error;
    return data || [];
  }

  async function getDataQuality() {
    const { data, error } = await sb().from('v_admin_data_quality').select('*').single();
    if (error) throw error;
    return data;
  }

  async function getDailyDispensed(days = 30) {
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const { data, error } = await sb().from('v_admin_daily_dispensed').select('*').gte('day', since).order('day');
    if (error) throw error;
    return data || [];
  }

  async function getAllDailyClients() {
    const { data, error } = await sb().from('v_admin_daily_clients').select('*').order('day');
    if (error) throw error;
    return data || [];
  }

  async function getAllDailyDispensed() {
    const { data, error } = await sb().from('v_admin_daily_dispensed').select('*').order('day');
    if (error) throw error;
    return data || [];
  }

  async function getAvgCompletionTime() {
    const { data, error } = await sb().from('v_admin_avg_completion_time').select('*').single();
    if (error) throw error;
    return data;
  }

  async function getFestivalImpact() {
    const { data, error } = await sb().from('v_admin_festival_impact').select('*').order('clients', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  /**
   * Filtered, flattened research dataset (v_admin_research_sessions).
   * filters: { dateFrom, dateTo, festivalId, village, ageBand, gender,
   *            route, distanceOutcome, nearOutcome, paddlePower }
   * Any omitted/empty filter is skipped. Capped at 2000 rows per query —
   * the Researchers page is an explorer/export tool, not a full dump.
   */
  async function getResearchSessions(filters = {}) {
    let q = sb().from('v_admin_research_sessions').select('*');
    if (filters.dateFrom) q = q.gte('registered_at', filters.dateFrom);
    if (filters.dateTo) q = q.lte('registered_at', filters.dateTo);
    if (filters.festivalId) q = q.eq('festival_id', filters.festivalId);
    if (filters.village) q = q.eq('village', filters.village);
    if (filters.ageBand) q = q.eq('age_band', filters.ageBand);
    if (filters.gender) q = q.eq('gender', filters.gender);
    if (filters.route) q = q.eq('route', filters.route);
    if (filters.distanceOutcome) q = q.eq('distance_outcome', filters.distanceOutcome);
    if (filters.nearOutcome) q = q.eq('near_outcome', filters.nearOutcome);
    if (filters.paddlePower) q = q.eq('paddle_power', filters.paddlePower);
    const { data, error } = await q.order('registered_at', { ascending: false }).limit(2000);
    if (error) throw error;
    return data || [];
  }

  window.AdminData = {
    getKpis, getDailyClients, getDistanceOutcomes, getNearOutcomes,
    getCompletionFunnel, getPathwayFrequencies, getDeviceStatus,
    getFestivals, getSyncConflicts, getResearchSessions,
    getAgeDistribution, getGenderDistribution, getVillageDistribution,
    getLensPowerDistribution, getFestivalThroughput, getDataQuality,
    getDailyDispensed, getAllDailyClients, getAllDailyDispensed,
    getAvgCompletionTime, getFestivalImpact,
  };
})();
