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

  window.AdminData = {
    getKpis, getDailyClients, getDistanceOutcomes, getNearOutcomes,
    getCompletionFunnel, getPathwayFrequencies, getDeviceStatus,
    getFestivals, getSyncConflicts,
  };
})();
