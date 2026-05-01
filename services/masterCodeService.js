import { supabase } from '../lib/supabase.js';

let _masterLabelMap = null;
let _loadedAt = 0;
const CACHE_MS = 5 * 60 * 1000;

export async function getMasterLabelMap() {
  const now = Date.now();
  if (_masterLabelMap && now - _loadedAt < CACHE_MS) {
    return _masterLabelMap;
  }

  const { data, error } = await supabase
    .from('master_codes')
    .select('master_type, code, label')
    .order('master_type')
    .order('code');

  if (error) throw error;

  const map = {};
  for (const row of data || []) {
    const type = String(row.master_type || '').trim();
    const code = String(row.code || '').trim();
    const label = String(row.label || '').trim();

    if (!type || !code) continue;
    if (!map[type]) map[type] = {};
    map[type][code] = label || code;
  }

  _masterLabelMap = map;
  _loadedAt = now;
  return map;
}

export async function getMasterLabel(type, code) {
  if (!code) return '';
  const map = await getMasterLabelMap();
  return map?.[type]?.[code] || code;
}

export async function getMasterLabels(type, codes = []) {
  const map = await getMasterLabelMap();
  const dict = map?.[type] || {};
  return (Array.isArray(codes) ? codes : []).map(code => dict[code] || code);
}

export function clearMasterLabelCache() {
  _masterLabelMap = null;
  _loadedAt = 0;
}