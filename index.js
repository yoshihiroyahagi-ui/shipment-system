import express from 'express'
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import cors from 'cors'
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { resolveShipmentDocs } from './services/shipmentDocRelayResolver.js';
import { buildANHtmlFromPayload } from './renderers/anRenderer.js';
import { buildCustomsHtmlFromPayload } from './renderers/customsRenderer.js';
import { buildDeliveryHtmlFromPayload } from './renderers/deliveryRenderer.js';


const app = express();

// --- CORS ---
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '20mb' }));

// CSVファイルをメモリ上で受け取る設定
const upload = multer({ storage: multer.memoryStorage() });

app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  const allowed = [
    'https://n-eozr5ybvd4pc2wilbjfv6q6jxhobhcxjella7vq-0lu-script.googleusercontent.com'
  ];

  if (allowed.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }

  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.get('/api/relay/shipment-docs', async (req, res) => {
  try {
    const shipmentId = String(req.query.shipment_id || '').trim();
    if (!shipmentId) {
      return res.status(400).json({ ok: false, message: 'shipment_id is required' });
    }

    const payload = await resolveShipmentDocs(shipmentId);
    
    return res.json({ ok: true, payload });
  } catch (err) {
    console.error('[relay/shipment-docs]', err);
    return res.status(500).json({ ok: false, message: err.message || 'resolver error' });
  }
});

app.post('/api/master/import/inbound-places', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, message: 'fileがありません' });
    }

    const text = req.file.buffer.toString('utf-8');

    const rows = parse(text, {
      columns: true,
      skip_empty_lines: true,
      bom: true
    });

    console.log('CSV rows:', rows);

    const payload = rows.map(r => ({
      place_id: String(r.place_id || '').trim() || null,
      carrier_id: String(r.carrier_id || '').trim() || null,
      pod: String(r.pod || '').trim() || null,
      bonded_code: String(r.bonded_code || '').trim() || null,
      place_name: String(r.place_name || '').trim() || null,
      line1: String(r.line1 || '').trim() || null,
      line2: String(r.line2 || '').trim() || null,
      line3: String(r.line3 || '').trim() || null,
      line4: String(r.line4 || '').trim() || null,
      is_active:
        String(r.is_active || '').trim() === ''
          ? true
          : ['true', '1', 'yes', 'y'].includes(String(r.is_active).trim().toLowerCase())
    })).filter(r => r.place_id);

    console.log('UPSERT PAYLOAD:', payload);

    const { data, error } = await supabase
      .from('inbound_place_master')
      .upsert(payload, { onConflict: 'place_id' })
      .select();

    console.log('SUPABASE DATA:', data);
    console.log('SUPABASE ERROR:', error);

    if (error) {
      return res.status(500).json({
        ok: false,
        message: error.message,
        error
      });
    }

    return res.json({
      ok: true,
      count: payload.length,
      data
    });

  } catch (e) {
    console.error('import inbound places error:', e);
    return res.status(500).json({
      ok: false,
      message: e.message || String(e)
    });
  }
});
app.post('/api/master/import/charge-rate-cards', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, message: 'fileがありません' });
    }

    const text = req.file.buffer.toString('utf-8');

    const rows = parse(text, {
      columns: true,
      skip_empty_lines: true,
      bom: true
    });

    console.log('CSV rows:', rows);

    const payload = rows.map(r => ({
      carrier_id: String(r.carrier_id || '').trim() || null,
      pol: String(r.pol || '').trim() || null,
      pod: String(r.pod || '').trim() || null,
      service_type: String(r.service_type || '').trim() || null,
      container_type: String(r.container_type || '').trim() || null,
      incoterms: String(r.incoterms || '').trim() || null,
      template_name: String(r.template_name || '').trim() || null,
      charge_id: String(r.charge_id || '').trim() || null,
      charge_name: String(r.charge_name || '').trim() || null,
      unit: String(r.unit || '').trim() || null,
      rate:
        String(r.rate || '').trim() === ''
          ? null
          : Number(String(r.rate).replace(/,/g, '')),
      currency: String(r.currency || '').trim() || null,
      fx_rate:
        String(r.fx_rate || '').trim() === ''
          ? null
          : Number(String(r.fx_rate).replace(/,/g, '')),
      tax_category: String(r.tax_category || '').trim() || null,
      is_active:
        String(r.is_active || '').trim() === ''
          ? true
          : ['true', '1', 'yes', 'y'].includes(String(r.is_active).trim().toLowerCase())
    })).filter(r => r.template_name && r.charge_name);

    console.log('IMPORT PAYLOAD:', payload);

    if (!payload.length) {
      return res.status(400).json({
        ok: false,
        message: '有効な行がありません。template_name と charge_name は必須です。'
      });
    }

    // 今回CSVに含まれる template_name を抽出
    const templateNames = [...new Set(payload.map(r => r.template_name).filter(Boolean))];

    console.log('TARGET TEMPLATE NAMES:', templateNames);

    // 既存テンプレを丸ごと削除
    const { error: deleteError } = await supabase
      .from('charge_rate_card')
      .delete()
      .in('template_name', templateNames);

    console.log('DELETE ERROR:', deleteError);

    if (deleteError) {
      return res.status(500).json({
        ok: false,
        message: deleteError.message,
        error: deleteError
      });
    }

    // 新しい行を insert
    const { data, error: insertError } = await supabase
      .from('charge_rate_card')
      .insert(payload)
      .select();

    console.log('INSERT DATA:', data);
    console.log('INSERT ERROR:', insertError);

    if (insertError) {
      return res.status(500).json({
        ok: false,
        message: insertError.message,
        error: insertError
      });
    }

    return res.json({
      ok: true,
      replaced_templates: templateNames,
      count: payload.length,
      data
    });

  } catch (e) {
    console.error('import charge rate cards error:', e);
    return res.status(500).json({
      ok: false,
      message: e.message || String(e)
    });
  }
});
app.post('/api/master/import/shipment-charges', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, message: 'fileがありません' });
    }

    const text = req.file.buffer.toString('utf-8');

    const rows = parse(text, {
      columns: true,
      skip_empty_lines: true,
      bom: true
    });

    console.log('CSV rows:', rows);

    const payload = rows.map(r => ({
      shipment_charge_id: String(r.shipment_charge_id || '').trim() || null,
      shipment_id: String(r.shipment_id || '').trim() || null,
      charge_name: String(r.charge_name || '').trim() || null,
      qty:
        String(r.qty || '').trim() === ''
          ? null
          : Number(String(r.qty).replace(/,/g, '')),
      unit: String(r.unit || '').trim() || null,
      rate:
        String(r.rate || '').trim() === ''
          ? null
          : Number(String(r.rate).replace(/,/g, '')),
      amount:
        String(r.amount || '').trim() === ''
          ? null
          : Number(String(r.amount).replace(/,/g, '')),
      tax_category: String(r.tax_category || '').trim() || null,
      vendor: String(r.vendor || '').trim() || null,
      customer_code: String(r.customer_code || '').trim() || null,
      currency: String(r.currency || '').trim() || null,
      fx_rate:
        String(r.fx_rate || '').trim() === ''
          ? null
          : Number(String(r.fx_rate).replace(/,/g, '')),
      note: String(r.note || '').trim() || null,
      created_by: String(r.created_by || '').trim() || null
    })).filter(r => r.shipment_charge_id && r.shipment_id && r.charge_name);

    console.log('UPSERT PAYLOAD:', payload);

    if (!payload.length) {
      return res.status(400).json({
        ok: false,
        message: '有効な行がありません。shipment_charge_id / shipment_id / charge_name は必須です。'
      });
    }

    const { data, error } = await supabase
      .from('shipment_charges')
      .upsert(payload, { onConflict: 'shipment_charge_id' })
      .select();

    console.log('SUPABASE DATA:', data);
    console.log('SUPABASE ERROR:', error);

    if (error) {
      return res.status(500).json({
        ok: false,
        message: error.message,
        error
      });
    }

    return res.json({
      ok: true,
      count: payload.length,
      data
    });

  } catch (e) {
    console.error('import shipment charges error:', e);
    return res.status(500).json({
      ok: false,
      message: e.message || String(e)
    });
  }
});
const port = process.env.PORT || 3000;

dotenv.config()

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
)

// --- session store (今日はメモリでOK) ---
const sessions = new Map()
const SESSION_TTL_MS = 1000 * 60 * 60 * 6 // 6時間

function createSession(customer) {
  const sessionId = crypto.randomUUID()
  sessions.set(sessionId, {
    session_id: sessionId,
    customer_code: customer.customer_code,
    customer_name: customer.customer_name || customer.customer_code,
    expires_at: Date.now() + SESSION_TTL_MS
  })
  return sessions.get(sessionId)
}

function normalizeRequestDestShort(row) {
  if (!row.delivery_dest_short) return ''
  if (row.delivery_dest_short === row.delivery_dest_id) return ''
  return row.delivery_dest_short
}

function getSessionOrThrow(sessionId) {
  const s = sessions.get(String(sessionId || '').trim())
  if (!s) throw new Error('セッションが無効です')

  if (Date.now() > s.expires_at) {
    sessions.delete(s.session_id)
    throw new Error('セッションの有効期限が切れています')
  }

  return s
}
function mapLineRow(row) {
  return {
    line_id: row.line_id || '',
    shipment_id: row.shipment_id || '',
    customer_code: row.customer_code || '',
    pt: row.pt || '',
    no: row.no || '',
    commodity: row.commodity || '',
    supplier: row.shipments?.suppliers?.supplier_name || '',
    delay_info: row.shipments?.delay_info || '',

    delivery_dest_id: row.delivery_dest_id || '',
    delivery_dest_short: normalizeRequestDestShort(row),
    delivery_dest_name: row.dests?.dest_name || '',
    address_official: [row.dests?.d_address1 || '', row.dests?.d_address2 || '']
      .filter(Boolean)
      .join(' '),
    delivery_tel: row.dests?.d_tel || '',
    delivery_contact: row.dests?.d_contact_person || '',

    delivery_request_date: row.delivery_request_date || '',
    delivery_request_time: row.delivery_request_time || '',
    delivery_fixed: row.delivery_fixed || '',
    delivery_fixed_time: row.delivery_fixed_time || '',
    delivery_plan_date: row.delivery_plan_date || '',
    delivery_plan_time: row.delivery_plan_time || '',
    remarks: row.remarks || '',
    commodity_note: row.commodity_note || '',
    customer_ref_no: row.customer_ref_no || '',
    updated_at: row.updated_at || '',

    job_no: row.shipments?.job_no || '',
    status: row.shipments?.status || '',
    etd: row.shipments?.etd || '',
    eta: row.shipments?.eta || '',
    vessel: row.shipments?.vessel || '',
    voyage: row.shipments?.voyage || '',
    booking_no: row.shipments?.booking_no || '',
    bl_no: row.shipments?.bl_no || '',
    pol: row.shipments?.pol || '',
    pod: row.shipments?.pod || '',
    incoterms: row.shipments?.incoterms || '',
    tracking_url: row.shipments?.tracking_url || '',
    customer_message: row.shipments?.customer_message || '',
    customs_status: row.shipments?.customs_status || '',
    cargo_inbound: row.shipments?.cargo_inbound || '',
    cy_cut: row.shipments?.cy_cut || '',
    earliest_delivery_date: row.shipments?.earliest_delivery_date || '',
    vehicle_type: row.shipments?.vehicle_type || '',
    carrier_name: row.shipments?.carrier_name || '',
    vehicle_no: row.shipments?.vehicle_no || '',
    driver_name: row.shipments?.driver_name || '',
    driver_phone: row.shipments?.driver_phone || '',

    container_no_1: row.shipments?.container_no_1 || '',
    container_type_1: row.shipments?.container_type_1 || '',
    pcs_1: row.shipments?.pcs_1 || '',
    gw_kg_1: row.shipments?.gw_kg_1 || '',
    cbm_1: row.shipments?.cbm_1 || '',

    container_no_2: row.shipments?.container_no_2 || '',
    container_type_2: row.shipments?.container_type_2 || '',
    pcs_2: row.shipments?.pcs_2 || '',
    gw_kg_2: row.shipments?.gw_kg_2 || '',
    cbm_2: row.shipments?.cbm_2 || '',

    container_no_3: row.shipments?.container_no_3 || '',
    container_type_3: row.shipments?.container_type_3 || '',
    pcs_3: row.shipments?.pcs_3 || '',
    gw_kg_3: row.shipments?.gw_kg_3 || '',
    cbm_3: row.shipments?.cbm_3 || '',

    container_no_4: row.shipments?.container_no_4 || '',
    container_type_4: row.shipments?.container_type_4 || '',
    pcs_4: row.shipments?.pcs_4 || '',
    gw_kg_4: row.shipments?.gw_kg_4 || '',
    cbm_4: row.shipments?.cbm_4 || '',

    container_no_5: row.shipments?.container_no_5 || '',
    container_type_5: row.shipments?.container_type_5 || '',
    pcs_5: row.shipments?.pcs_5 || '',
    gw_kg_5: row.shipments?.gw_kg_5 || '',
    cbm_5: row.shipments?.cbm_5 || '',

    container_no_6: row.shipments?.container_no_6 || '',
    container_type_6: row.shipments?.container_type_6 || '',
    pcs_6: row.shipments?.pcs_6 || '',
    gw_kg_6: row.shipments?.gw_kg_6 || '',
    cbm_6: row.shipments?.cbm_6 || '',

    container_no_7: row.shipments?.container_no_7 || '',
    container_type_7: row.shipments?.container_type_7 || '',
    pcs_7: row.shipments?.pcs_7 || '',
    gw_kg_7: row.shipments?.gw_kg_7 || '',
    cbm_7: row.shipments?.cbm_7 || '',

    container_no_8: row.shipments?.container_no_8 || '',
    container_type_8: row.shipments?.container_type_8 || '',
    pcs_8: row.shipments?.pcs_8 || '',
    gw_kg_8: row.shipments?.gw_kg_8 || '',
    cbm_8: row.shipments?.cbm_8 || '',

    container_no_9: row.shipments?.container_no_9 || '',
    container_type_9: row.shipments?.container_type_9 || '',
    pcs_9: row.shipments?.pcs_9 || '',
    gw_kg_9: row.shipments?.gw_kg_9 || '',
    cbm_9: row.shipments?.cbm_9 || '',

    container_no_10: row.shipments?.container_no_10 || '',
    container_type_10: row.shipments?.container_type_10 || '',
    pcs_10: row.shipments?.pcs_10 || '',
    gw_kg_10: row.shipments?.gw_kg_10 || '',
    cbm_10: row.shipments?.cbm_10 || ''
  }
}

async function getMyLines(customerCode, filterMode = 'ACTIVE', offset = 0, limit = 15) {
  const from = Number(offset) || 0
  const size = Number(limit) || 15
  const to = from + size - 1

  const { data, error, count } = await supabase
    .from('shipment_lines')
    .select(`
      line_id,
      shipment_id,
      customer_code,
      pt,
      commodity,
      delivery_dest_id,
      delivery_dest_short,
      delivery_request_date,
      delivery_request_time,
      delivery_fixed,
      delivery_fixed_time,
      delivery_plan_date,
      delivery_plan_time,
      remarks,
      commodity_note,
      customer_ref_no,
      updated_at,
      shipments (
        shipment_id,
        job_no,
        status,
        etd,
        eta,
        vessel,
        voyage,
        customer_code,
        supplier_id,
        delay_info,
        container_no_1, container_type_1, seal_no_1, pcs_1, gw_kg_1, cbm_1,
        container_no_2, container_type_2, seal_no_2, pcs_2, gw_kg_2, cbm_2,
        container_no_3, container_type_3, seal_no_3, pcs_3, gw_kg_3, cbm_3,
        container_no_4, container_type_4, seal_no_4, pcs_4, gw_kg_4, cbm_4,
        container_no_5, container_type_5, seal_no_5, pcs_5, gw_kg_5, cbm_5,
        container_no_6, container_type_6, seal_no_6, pcs_6, gw_kg_6, cbm_6,
        container_no_7, container_type_7, seal_no_7, pcs_7, gw_kg_7, cbm_7,
        container_no_8, container_type_8, seal_no_8, pcs_8, gw_kg_8, cbm_8,
        container_no_9, container_type_9, seal_no_9, pcs_9, gw_kg_9, cbm_9,
        container_no_10, container_type_10, seal_no_10, pcs_10, gw_kg_10, cbm_10,
        suppliers (
        supplier_name
      )
      ),
      dests (
        dest_id,
        dest_name,
        d_address1,
        d_address2,
        d_tel,
        d_contact_person
      )
    `, { count: 'exact' })
    .eq('customer_code', customerCode)
    .range(from, to)

  if (error) throw error

  let rows = (data || []).map(mapLineRow)

  const doneStatuses = ['配達済み', 'キャンセル', '完了']
  if (filterMode === 'ACTIVE') {
    rows = rows.filter(r => !doneStatuses.includes(String(r.status || '').trim()))
  } else if (filterMode === 'DELIVERED') {
    rows = rows.filter(r => doneStatuses.includes(String(r.status || '').trim()))
  }

  const rowsWithBicon = applyBiconFlagsAcrossRows(rows);

  return {
    rows: rowsWithBicon,
    total: count || rows.length,
    next_offset: from + rows.length,
    has_more: (from + rows.length) < (count || 0)
  }
}

async function getLineDetail(lineId, customerCode) {
  const { data, error } = await supabase
    .from('shipment_lines')
    .select(`
      line_id,
      shipment_id,
      customer_code,
      pt,
      commodity,
      delivery_dest_id,
      delivery_dest_short,
      delivery_request_date,
      delivery_request_time,
      delivery_fixed,
      delivery_fixed_time,
      delivery_plan_date,
      delivery_plan_time,
      remarks,
      commodity_note,
      customer_ref_no,
      updated_at,
      shipments (
        shipment_id,
        suppliers (
          supplier_name
        ),
        job_no,
        status,
        etd,
        eta,
        vessel,
        voyage,
        customer_code,
        supplier_id,
        booking_no,
        bl_no,
        pol,
        pod,
        incoterms,
        tracking_url,
        customer_message,
        delay_info,
        customer_comment,
        customs_status,
        cargo_inbound,
        cy_cut,
        earliest_delivery_date,
        vehicle_type,
        carrier_name,
        vehicle_no,
        driver_name,
        driver_phone,
        container_no_1, container_type_1, seal_no_1, pcs_1, gw_kg_1, cbm_1,
        container_no_2, container_type_2, seal_no_2, pcs_2, gw_kg_2, cbm_2,
        container_no_3, container_type_3, seal_no_3, pcs_3, gw_kg_3, cbm_3,
        container_no_4, container_type_4, seal_no_4, pcs_4, gw_kg_4, cbm_4,
        container_no_5, container_type_5, seal_no_5, pcs_5, gw_kg_5, cbm_5,
        container_no_6, container_type_6, seal_no_6, pcs_6, gw_kg_6, cbm_6,
        container_no_7, container_type_7, seal_no_7, pcs_7, gw_kg_7, cbm_7,
        container_no_8, container_type_8, seal_no_8, pcs_8, gw_kg_8, cbm_8,
        container_no_9, container_type_9, seal_no_9, pcs_9, gw_kg_9, cbm_9,
        container_no_10, container_type_10, seal_no_10, pcs_10, gw_kg_10, cbm_10
      )
    `)
    .eq('line_id', lineId)
    .eq('customer_code', customerCode)
    .single();

  if (error) throw error;

  let destRec = null;

  if (data.delivery_dest_id) {
    const { data: destData, error: destError } = await supabase
      .from('dests')
      .select(`
        dest_id,
        dest_name,
        d_address1,
        d_address2,
        d_tel,
        d_contact_person
      `)
      .eq('dest_id', data.delivery_dest_id)
      .maybeSingle();

    if (!destError) {
      destRec = destData || null;
    }
  }

  const merged = {
    ...data,
    dests: destRec
  };

  return {
    line: mapLineRow(merged),
    shipment: data.shipments || {}
  };
}

async function updateLine(lineId, customerCode, payload) {
  const { data: existing, error: checkError } = await supabase
    .from('shipment_lines')
    .select('line_id, customer_code')
    .eq('line_id', lineId)
    .eq('customer_code', customerCode)
    .single()

  if (checkError || !existing) throw new Error('更新対象が見つかりません')

  const safePayload = {
    delivery_request_date: payload.delivery_request_date ?? null,
    delivery_request_time: payload.delivery_request_time ?? null,
    delivery_dest_short: payload.delivery_dest_short ?? null,
    remarks: payload.remarks ?? null,
    commodity_note: payload.commodity_note ?? null,
    customer_ref_no: payload.customer_ref_no ?? null,
    updated_at: new Date().toISOString()
  }

  const { error } = await supabase
    .from('shipment_lines')
    .update(safePayload)
    .eq('line_id', lineId)
    .eq('customer_code', customerCode)

  if (error) throw error

  return await getLineDetail(lineId, customerCode)
}

function normalizePkgUnit(unit = '') {
  const u = String(unit || '').trim().toUpperCase();

  if (!u) return '';

  if (['PCS', 'PC'].includes(u)) return 'PCS';
  if (['PKG', 'PKGS', 'PACKAGE', 'PACKAGES'].includes(u)) return 'PACKAGES';
  if (['CTN', 'CTNS', 'CARTON', 'CARTONS'].includes(u)) return 'CARTONS';
  if (['PLT', 'PLTS', 'PALLET', 'PALLETS'].includes(u)) return 'PALLETS';

  return u;
}

function parseContainerLine(line) {
  const src = String(line || '').trim();

  if (!src) {
    return {
      raw: '',
      container_no: '',
      container_type: '',
      seal_no: '',
      pcs: null,
      gw: null,
      cbm: null
    };
  }

  const normalized = src
    .replace(/[　]/g, ' ')
    .replace(/／/g, '/')
    .replace(/，/g, ',')
    .replace(/\s+/g, ' ')
    .trim();

  const containerNoMatch = normalized.match(/\b[A-Z]{4}\d{7}\b/i);
  const typeMatch = normalized.match(
  /\b(20\s*'?[\s-]*GP|20\s*'?[\s-]*DC|40\s*'?[\s-]*GP|40\s*'?[\s-]*HQ|40\s*'?[\s-]*HC|45\s*'?[\s-]*HQ|LCL)\b/i
  );
  const pcsMatch = normalized.match(
  /(\d+(?:\.\d+)?)\s*(PCS|PKGS?|PKG|PACKAGES?|PACKAGE|CTNS?|CTN|CARTONS?|CARTON|PALLETS?|PALLET|PLTS?|PLT)\b/i
  );
  
  const gwMatch = normalized.match(/(\d+(?:\.\d+)?)\s*(?:KGS?|KG|GW)\b/i);
  const cbmMatch = normalized.match(/(\d+(?:\.\d+)?)\s*(?:CBM|M3)\b/i);

  let sealNo = '';
  const tokens = normalized.split(/[\/,]/).map(s => s.trim()).filter(Boolean);
  for (const t of tokens) {
    const upper = t.toUpperCase();
    if (/^[A-Z]{4}\d{7}$/.test(upper)) continue;
    if (/^(20GP|20DC|40GP|40HQ|40HC|45HQ|LCL)$/.test(upper)) continue;
    if (/\d+(?:\.\d+)?\s*(PCS|PKGS?|PKG|PACKAGES?|PACKAGE|CTNS?|CTN|CARTONS?|CARTON|PALLETS?|PALLET|PLTS?|PLT|KGS?|KG|GW|CBM|M3)\b/i.test(upper)) continue;
    if (/^[A-Z0-9-]{5,}$/.test(upper)) {
      sealNo = upper;
      break;
    }
  }

  return {
  raw: src,
  container_no: containerNoMatch ? containerNoMatch[0].toUpperCase() : '',
  container_type: typeMatch
    ? typeMatch[1].toUpperCase().replace(/['\s-]/g, '')
    : '',
  seal_no: sealNo,
  pcs: pcsMatch ? Number(pcsMatch[1]) : null,
  pkg_unit: pcsMatch ? normalizePkgUnit(pcsMatch[2]) : '',
  gw: gwMatch ? Number(gwMatch[1]) : null,
  cbm: cbmMatch ? Number(cbmMatch[1]) : null
};
}

app.get('/', (req, res) => {
  res.send('API server is running')
})

// --- login ---
app.post('/api/login', async (req, res) => {
  try {
    const token = String(req.body.token || '').trim()

    if (!token) {
      return res.status(400).json({ ok: false, error: 'token is required' })
    }

    const { data, error } = await supabase
      .from('customers')
      .select('customer_code, customer_name, portal_token')
      .eq('portal_token', token)
      .limit(1)
      .maybeSingle()

    if (error) throw error
    if (!data) {
      return res.status(401).json({ ok: false, error: 'ログインキーが正しくありません' })
    }

    const session = createSession({
      customer_code: data.customer_code,
      customer_name: data.customer_name || data.customer_code
    })

    res.json({
      ok: true,
      session_id: session.session_id,
      customer_code: session.customer_code,
      customer_name: session.customer_name
    })
  } catch (error) {
    console.error('POST /api/login error:', error)
    res.status(500).json({ ok: false, error: error.message || 'Login failed' })
  }
})

// --- list ---
app.get('/api/my-lines', async (req, res) => {
  try {
    const sessionId = String(req.query.session_id || '').trim()
    const filterMode = String(req.query.filter_mode || 'ACTIVE').trim()
    const offset = Number(req.query.offset || 0)
    const limit = Number(req.query.limit || 15)

    const session = getSessionOrThrow(sessionId)

    const result = await getMyLines(
      session.customer_code,
      filterMode,
      offset,
      limit
    )

    res.json({ ok: true, ...result })
  } catch (error) {
    console.error('GET /api/my-lines error:', error)
    res.status(401).json({ ok: false, error: error.message || 'Internal server error' })
  }
})
app.post('/api/parse-container-lines', async (req, res) => {
  try {
    const lines = Array.isArray(req.body?.lines)
      ? req.body.lines
      : String(req.body?.text || '')
          .split('\n')
          .map(s => s.trim())
          .filter(Boolean);

    const parsedLines = lines.map((line, idx) => ({
      line_no: idx + 1,
      ...parseContainerLine(line)
    }));

    return res.json({
      ok: true,
      rows: parsedLines
    });
  } catch (err) {
    console.error('[parse-container-lines] error:', err);
    return res.status(500).json({
      ok: false,
      error: err.message || String(err)
    });
  }
});
// --- detail ---
app.get('/api/line-detail', async (req, res) => {
  try {
    const sessionId = String(req.query.session_id || '').trim()
    const lineId = String(req.query.line_id || '').trim()

    if (!lineId) {
      return res.status(400).json({ ok: false, error: 'line_id is required' })
    }

    const session = getSessionOrThrow(sessionId)
    const result = await getLineDetail(lineId, session.customer_code)

    res.json({ ok: true, line: result.line, shipment: result.shipment })
  } catch (error) {
    console.error('GET /api/line-detail error:', error)
    res.status(401).json({ ok: false, error: error.message || 'Internal server error' })
  }
})

// --- update ---
app.post('/api/update-line', async (req, res) => {
  try {
    const sessionId = String(req.body.session_id || '').trim()
    const lineId = String(req.body.line_id || '').trim()

    if (!lineId) {
      return res.status(400).json({ ok: false, error: 'line_id is required' })
    }

    const session = getSessionOrThrow(sessionId)
    const result = await updateLine(lineId, session.customer_code, req.body)

    res.json({ ok: true, line: result.line, shipment: result.shipment })
  } catch (error) {
    console.error('POST /api/update-line error:', error)
    res.status(401).json({ ok: false, error: error.message || 'Internal server error' })
  }
})

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`)
})
app.get('/api/master-codes', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('master_codes')
      .select('master_type, code, label')
      .eq('is_active', true)
      .order('master_type')
      .order('code');

    if (error) throw error;

    res.json({ ok: true, rows: data || [] });
  } catch (err) {
    console.error('GET /api/master-codes error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});
function getBiconInfoFromShipment(s) {
  const counter = {};

  for (let i = 1; i <= 10; i++) {
    const no = s[`container_no_${i}`];
    const type = s[`container_type_${i}`];

    if (!no) continue;

    const noStr = String(no).trim();
    if (!noStr || noStr === '未定') continue;

    const typeStr = String(type || '').trim();
    if (!typeStr.includes('(B)')) continue;

    if (!counter[noStr]) counter[noStr] = 0;
    counter[noStr]++;
  }

  const biconContainers = Object.entries(counter)
    .filter(([no, count]) => count >= 2)
    .map(([no]) => no);

  return {
    bicon_count: biconContainers.length,
    bicon_label: biconContainers.join(' / '),
    is_bicon: biconContainers.length > 0
  };
}

function mapAdminShipmentRow(row, customerMap = {}, supplierMap = {}, partnerMap = {}) {
  const brokerCode = String(row.broker_code || '').trim();
  const truckerCode = String(row.trucker_code || '').trim();
  const customerCode = String(row.customer_code || '').trim();
  const supplierId = String(row.supplier_id || '').trim();
  const bicon = getBiconInfoFromShipment(row);

  return {
    shipment_id: row.shipment_id || '',
    job_no: row.job_no || '',
    planned_billing_month: row.planned_billing_month || '',
    master_bl_no: row.master_bl_no || '',
    status: row.status || '',
    customer_code: customerCode,
    customer_name: customerMap[customerCode] || row.customer_name || customerCode || '',
    supplier_name: supplierMap[supplierId] || row.supplier_name || supplierId || '',
    etd: row.etd || '',
    eta: row.eta || '',
    vessel: row.vessel || '',
    voyage: row.voyage || '',
    booking_no: row.booking_no || '',
    bl_no: row.bl_no || '',
    pol: row.pol || '',
    pod: row.pod || '',
    incoterms: row.incoterms || '',
    supplier_id: supplierId,
    broker_code: brokerCode,
    trucker_code: truckerCode,
    ocean_carrier_code: String(row.ocean_carrier_code || '').trim(),
    broker_name: partnerMap[brokerCode]?.partner_name || row.broker_name || '',
    trucker_name: partnerMap[truckerCode]?.partner_name || row.trucker_name || '',
    resolved_trucker_name: partnerMap[truckerCode]?.partner_name || row.resolved_trucker_name || '',
    carrier_name: row.carrier_name || '',
    
    bicon_count: bicon.bicon_count,
    bicon_label: bicon.bicon_label,
    is_bicon: bicon.is_bicon,
    container_no_1: row.container_no_1,
    container_type_1: row.container_type_1,
    container_no_2: row.container_no_2,
    container_type_2: row.container_type_2,
    container_no_3: row.container_no_3,
    container_type_3: row.container_type_3,
    container_no_4: row.container_no_4,
    container_type_4: row.container_type_4,
    container_no_5: row.container_no_5,
    container_type_5: row.container_type_5,
    container_no_6: row.container_no_6,
    container_type_6: row.container_type_6,
    container_no_7: row.container_no_7,
    container_type_7: row.container_type_7,
    container_no_8: row.container_no_8,
    container_type_8: row.container_type_8,
    container_no_9: row.container_no_9,
    container_type_9: row.container_type_9,
    container_no_10: row.container_no_10,
    container_type_10: row.container_type_10
  };
}
app.get('/api/admin/initial-data', async (req, res) => {
  try {
    const [
      customersRes,
      suppliersRes,
      partnersRes,
      masterCodesRes,
      inboundPlacesRes,
      rateCardsRes
    ] = await Promise.all([
      supabase.from('customers').select('*').order('customer_code'),
      supabase.from('suppliers').select('*').order('supplier_name'),
      supabase.from('partners').select('*').order('partner_name'),
      supabase.from('master_codes').select('*').order('master_type'),
      supabase.from('inbound_place_master').select('*').eq('is_active', true).order('place_name'),
      supabase.from('charge_rate_card').select('*').eq('is_active', true).order('sort_no')
    ]);

    const errors = [
      customersRes.error,
      suppliersRes.error,
      partnersRes.error,
      masterCodesRes.error,
      inboundPlacesRes.error,
      rateCardsRes.error
    ].filter(Boolean);

    if (errors.length) {
      throw errors[0];
    }

    return res.json({
      ok: true,
      customers: customersRes.data || [],
      suppliers: suppliersRes.data || [],
      partners: partnersRes.data || [],
      master_codes: masterCodesRes.data || [],
      inbound_places: inboundPlacesRes.data || [],
      rate_cards: rateCardsRes.data || []
    });

  } catch (err) {
    console.error('[admin initial-data] error:', err);
    return res.status(500).json({
      ok: false,
      error: err.message || String(err)
    });
  }
});
app.get('/api/admin/shipments', async (req, res) => {
  try {
    const offset = Number(req.query.offset || 0);
    const limit = Number(req.query.limit || 30);

    const { data, error } = await supabase
      .from('shipments')
      .select(`
        shipment_id,
        job_no,
        planned_billing_month,
        master_bl_no,
        status,
        customer_code,
        etd,
        eta,
        vessel,
        voyage,
        booking_no,
        bl_no,
        pol,
        pod,
        incoterms,
        supplier_id,
        carrier_id,
        ocean_carrier_code,
        broker_code,
        trucker_code,
        customs_status,
        carrier_name,
        delivery_data,
        customs_data,
        an_url,
        delivery_request_url,
        customs_request_url,
        earliest_delivery_date,
        container_no_1, container_type_1,
        container_no_2, container_type_2,
        container_no_3, container_type_3,
        container_no_4, container_type_4,
        container_no_5, container_type_5,
        container_no_6, container_type_6,
        container_no_7, container_type_7,
        container_no_8, container_type_8,
        container_no_9, container_type_9,
        container_no_10, container_type_10
        
      `)
      .range(offset, offset + limit - 1);

    if (error) throw error;
    
    const rows = data || [];

    const customerCodes = [...new Set(
      rows.map(r => String(r.customer_code || '').trim()).filter(Boolean)
    )];

    let customerMap = {};

    if (customerCodes.length > 0) {
      const { data: customerRows, error: customerError } = await supabase
        .from('customers')
        .select('customer_code, customer_name')
        .in('customer_code', customerCodes);

      if (customerError) throw customerError;

      customerMap = (customerRows || []).reduce((acc, c) => {
        acc[String(c.customer_code).trim()] = c.customer_name || c.customer_code || '';
        return acc;
      }, {});
    }

    const supplierIds = [...new Set(
  rows.map(r => String(r.supplier_id || '').trim()).filter(Boolean)
)];
    const partnerCodes = [...new Set(
  rows.flatMap(r => [
    String(r.broker_code || '').trim(),
    String(r.trucker_code || '').trim()
  ]).filter(Boolean)
)];

let supplierMap = {};

if (supplierIds.length > 0) {
  const { data: supplierRows, error: supplierError } = await supabase
    .from('suppliers')
    .select('supplier_id, supplier_name')
    .in('supplier_id', supplierIds);

  if (supplierError) throw supplierError;

  supplierMap = (supplierRows || []).reduce((acc, s) => {
    acc[String(s.supplier_id).trim()] = s.supplier_name || s.supplier_id || '';
    return acc;
  }, {});
}
let partnerMap = {};

if (partnerCodes.length > 0) {
  const { data: partnerRows, error: partnerError } = await supabase
    .from('partners')
    .select('partner_code, partner_name, partner_type')
    .in('partner_code', partnerCodes);

  if (partnerError) throw partnerError;

  partnerMap = (partnerRows || []).reduce((acc, p) => {
  const rec = {
    partner_name: p.partner_name || p.partner_code || p.partner_id || '',
    partner_type: p.partner_type || ''
  };

  if (p.partner_code) acc[String(p.partner_code).trim()] = rec;
  if (p.partner_id) acc[String(p.partner_id).trim()] = rec;

  return acc;
}, {});
console.log('[broker debug]', {
  brokerCodesInShipments: rows.map(r => r.broker_code).filter(Boolean),
  partnerCodes,
  partnerRows,
  partnerMapKeys: Object.keys(partnerMap)
});
}

    const mapped = rows.map(row => mapAdminShipmentRow(row, customerMap, supplierMap, partnerMap));
    const mappedWithBicon = applyBiconFlagsAcrossRows(mapped);
   
    res.json({
      ok: true,
      rows: mappedWithBicon,
      next_offset: offset + mappedWithBicon.length,
      has_more: mappedWithBicon.length === limit
    });
  } catch (err) {
    console.error('GET /api/admin/shipments error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.get('/api/admin/shipment-detail', async (req, res) => {
  try {
    const shipmentId = String(req.query.shipment_id || '').trim();
    console.log('ADMIN DETAIL shipmentId=', shipmentId);
    if (!shipmentId) {
      return res.status(400).json({ ok: false, error: 'shipment_id is required' });
    }

    const { data: shipment, error: shipmentError } = await supabase
      .from('shipments')
      .select(`
        shipment_id,
        job_no,
        planned_billing_month,
        master_bl_no,
        status,
        customer_code,
        etd,
        eta,
        vessel,
        voyage,
        carrier_id,
        cargo_pickup_location_id,
        booking_no,
        bl_no,
        pol,
        pod,
        incoterms,
        tracking_url,
        customer_message,
        delay_info,
        customer_comment,
        supplier_id,
        broker_code,
        trucker_code,
        service_type_code,
        an_data,
        inbound_no,
        customs_data,
        an_url,
        customer_docs,
        currency,
        declaration_amount,
        invoice_no,
        item_name,
        customs_declared_date,
        default_customs_declared_date,
        delivery_data,
        vehicle_type,
        vehicle_no,
        driver_name,
        driver_phone,
        earliest_delivery_date,
        container_no_1, container_type_1, seal_no_1, pcs_1, gw_kg_1, cbm_1,
        container_no_2, container_type_2, seal_no_2, pcs_2, gw_kg_2, cbm_2,
        container_no_3, container_type_3, seal_no_3, pcs_3, gw_kg_3, cbm_3,
        container_no_4, container_type_4, seal_no_4, pcs_4, gw_kg_4, cbm_4,
        container_no_5, container_type_5, seal_no_5, pcs_5, gw_kg_5, cbm_5,
        container_no_6, container_type_6, seal_no_6, pcs_6, gw_kg_6, cbm_6,
        container_no_7, container_type_7, seal_no_7, pcs_7, gw_kg_7, cbm_7,
        container_no_8, container_type_8, seal_no_8, pcs_8, gw_kg_8, cbm_8,
        container_no_9, container_type_9, seal_no_9, pcs_9, gw_kg_9, cbm_9,
        container_no_10, container_type_10, seal_no_10, pcs_10, gw_kg_10, cbm_10
      `)
      .eq('shipment_id', shipmentId)
      .maybeSingle();

    if (shipmentError) throw shipmentError;

    if (!shipment) {
  return res.status(404).json({ ok: false, error: `Shipment not found: ${shipmentId}` });
}
const { data: containers, error: containerError } = await supabase
  .from('shipment_containers')
  .select('*')
  .eq('shipment_id', shipmentId)
  .order('sort_no');

if (containerError) throw containerError;

let supplier = null;
if (shipment?.supplier_id) {
  const { data: supplierRow, error: supplierError } = await supabase
    .from('suppliers')
    .select('supplier_id, supplier_name, supplier_add_1, supplier_add_2')
    .eq('supplier_id', shipment.supplier_id)
    .maybeSingle();

  if (supplierError) throw supplierError;
  supplier = supplierRow || null;
}

let customer = null;
if (shipment?.customer_code) {
  const { data: customerRow, error: customerError } = await supabase
    .from('customers')
    .select('*')
    .eq('customer_code', shipment.customer_code)
    .maybeSingle();

  if (customerError) throw customerError;
  customer = customerRow || null;
  console.log('CUSTOMER RAW', customer);
}

let pickupPlace = null;
if (shipment?.cargo_pickup_location_id) {
  const { data: placeRow, error: placeError } = await supabase
    .from('inbound_place_master')
    .select(`
      place_id,
      carrier_id,
      pod,
      bonded_code,
      place_name,
      line1,
      line2,
      line3,
      line4,
      is_active,
      updated_at
    `)
    .eq('place_id', shipment.cargo_pickup_location_id)
    .maybeSingle();

  if (placeError) throw placeError;
  pickupPlace = placeRow || null;
}

    const resultShipment = {
  ...shipment,

  customer_name: customer?.customer_name || '',
customer_billing_name: customer?.billing_name || '',
customer_zip: customer?.zip || '',
customer_add_1: customer?.address1 || '',
customer_add_2: customer?.address2 || '',
customer_contact_person: customer?.contact_person || '',
customer_email: customer?.email || '',
customer_tel: customer?.phone || '',

customer_name_e: customer?.customer_name_e || '',
customer_address1_e: customer?.address1_e || '',
customer_address2_e: customer?.address2_e || '',

customer_payment_terms: customer?.payment_terms || '',
customer_closing_day: customer?.closing_day || '',
customer_c_registration: customer?.c_registration || '',
customer_i_e_registration: customer?.i_e_registration || '',
customer_real_time: customer?.real_time || '',
customer_tax_payment: customer?.tax_payment || '',
customer_open_policy: customer?.open_policy || '',

  pickup_place_name: pickupPlace?.place_name || '',
pickup_place_line1: pickupPlace?.line1 || '',
pickup_place_line2: pickupPlace?.line2 || '',
pickup_place_line3: pickupPlace?.line3 || '',
pickup_place_line4: pickupPlace?.line4 || '',
pickup_place_bonded_code: pickupPlace?.bonded_code || '',

supplier_name: supplier?.supplier_name || '',
supplier_add_1: supplier?.supplier_add_1 || '',
supplier_add_2: supplier?.supplier_add_2 || '',
};

    const { data: lineRows, error: lineError } = await supabase
      .from('shipment_lines')
      .select(`
        line_id,
        shipment_id,
        customer_code,
        pt,
        commodity,
        delivery_dest_id,
        delivery_dest_short,
        delivery_request_date,
        delivery_request_time,
        delivery_fixed,
        delivery_fixed_time,
        delivery_plan_date,
        delivery_plan_time,
        remarks,
        commodity_note,
        customer_ref_no,
        updated_at
      `)
      .eq('shipment_id', shipmentId)
      .order('line_id');

    if (lineError) throw lineError;

    const lines = lineRows || [];

    const destIds = [...new Set(
      lines.map(l => String(l.delivery_dest_id || '').trim()).filter(Boolean)
    )];

    let destMap = {};
    if (destIds.length > 0) {
      const { data: destRows, error: destError } = await supabase
        .from('dests')
        .select('dest_id, dest_name, d_address1, d_address2, d_tel, d_contact_person')
        .in('dest_id', destIds);

      if (destError) throw destError;

      destMap = (destRows || []).reduce((acc, d) => {
        acc[String(d.dest_id).trim()] = d;
        return acc;
      }, {});
    }

    const mappedLines = lines.map(l => {
      const d = destMap[String(l.delivery_dest_id || '').trim()] || null;
      return {
        ...l,
        delivery_dest_name: d ? (d.dest_name || '') : '',
        address_official: d ? [d.d_address1 || '', d.d_address2 || ''].filter(Boolean).join(' ') : '',
        delivery_tel: d ? (d.d_tel || '') : '',
        delivery_contact: d ? (d.d_contact_person || '') : ''
      };
    });

    res.json({ 
  ok: true, 
  shipment: resultShipment, 
  lines: mappedLines, 
  containers: containers || []
});
  } catch (err) {
    console.error('GET /api/admin/shipment-detail error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});
function toNullableNumber(v) {
  if (v === '' || v === null || v === undefined) return null;

  const s = String(v).replace(/,/g, '').trim();
  const n = Number(s);

  return Number.isFinite(n) ? n : null;
}
app.post('/api/admin/save-shipment', async (req, res) => {
  try {

    function parsePcsAndUnit(v) {
  const s = String(v || '').trim();
  if (!s) return { pcs: null, pkg_unit: null };

  const m = s.match(/^(\d+(?:\.\d+)?)(.*)$/);
  if (!m) return { pcs: null, pkg_unit: s };

  return {
    pcs: Number(m[1]),
    pkg_unit: String(m[2] || '').trim() || null
  };
}
    const shipment = req.body.shipment || {};
    const lines = Array.isArray(req.body.lines) ? req.body.lines : [];

    const shipmentId = String(shipment.shipment_id || '').trim();
    const isNew = !shipmentId;

    const containers = Array.isArray(req.body?.shipment?.containers)
    ? req.body.shipment.containers
    : [];
    
    // まず shipments に実在する列だけ詰める
    const shipmentPayload = {
      shipment_id: shipmentId || null, 
      job_no: shipment.job_no || '',
      planned_billing_month: shipment.planned_billing_month || '',
      master_bl_no: shipment.master_bl_no || '',
      customer_code: shipment.customer_code || '',
      supplier_id: shipment.supplier_id || '',
      service_type_code: shipment.service_type_code || null,
      status: shipment.status || '',
      booking_no: shipment.booking_no || '',
      bl_no: shipment.bl_no || '',
      pol: shipment.pol || '',
      pod: shipment.pod || '',
      incoterms: shipment.incoterms || '',
      vessel: shipment.vessel || '',
      voyage: shipment.voyage || '',
      etd: shipment.etd || null,
      eta: shipment.eta || null,
      tranship_port: shipment.tranship_port || null,
      tracking_url: shipment.tracking_url || '',
      customer_message: shipment.customer_message || '',
      broker_code: shipment.broker_code || '',
      trucker_code: shipment.trucker_code || '',
      delay_info: shipment.delay_info || '',
      service_type_code: shipment.service_type_code || '',
      carrier_id: shipment.carrier_id || null,
      cargo_pickup_location_id: shipment.cargo_pickup_location_id || null,

      container_no_1: shipment.container_no_1 || '',
      container_type_1: shipment.container_type_1 || '',
      seal_no_1: shipment.seal_no_1 || '',
      pcs_1: shipment.pcs_1 || '',
      gw_kg_1: toNullableNumber(shipment.gw_kg_1),
      cbm_1: toNullableNumber(shipment.cbm_1),

      container_no_2: shipment.container_no_2 || '',
      container_type_2: shipment.container_type_2 || '',
      seal_no_2: shipment.seal_no_2 || '',
      pcs_2: shipment.pcs_2 || '',
      gw_kg_2: toNullableNumber(shipment.gw_kg_2),
      cbm_2: toNullableNumber(shipment.cbm_2),

      container_no_3: shipment.container_no_3 || '',
      container_type_3: shipment.container_type_3 || '',
      seal_no_3: shipment.seal_no_3 || '',
      pcs_3: shipment.pcs_3 || '',
      gw_kg_3: toNullableNumber(shipment.gw_kg_3),
      cbm_3: toNullableNumber(shipment.cbm_3),
      
      container_no_4: shipment.container_no_4 || '',
      container_type_4: shipment.container_type_4 || '',
      seal_no_4: shipment.seal_no_4 || '',
      pcs_4: shipment.pcs_4 || '',
      gw_kg_4: toNullableNumber(shipment.gw_kg_4),
      cbm_4: toNullableNumber(shipment.cbm_4),

      container_no_5: shipment.container_no_5 || '',
      container_type_5: shipment.container_type_5 || '',
      seal_no_5: shipment.seal_no_5 || '',
      pcs_5: shipment.pcs_5 || '',
      gw_kg_5: toNullableNumber(shipment.gw_kg_5),
      cbm_5: toNullableNumber(shipment.cbm_5),

      container_no_6: shipment.container_no_6 || '',
      container_type_6: shipment.container_type_6 || '',
      seal_no_6: shipment.seal_no_6 || '',
      pcs_6: shipment.pcs_6 || '',
      gw_kg_6: toNullableNumber(shipment.gw_kg_6),
      cbm_6: toNullableNumber(shipment.cbm_6),

      container_no_7: shipment.container_no_7 || '',
      container_type_7: shipment.container_type_7 || '',
      seal_no_7: shipment.seal_no_7 || '',
      pcs_7: shipment.pcs_7 || '',
      gw_kg_7: toNullableNumber(shipment.gw_kg_7),
      cbm_7: toNullableNumber(shipment.cbm_7),

      container_no_8: shipment.container_no_8 || '',
      container_type_8: shipment.container_type_8 || '',
      seal_no_8: shipment.seal_no_8 || '',
      pcs_8: shipment.pcs_8 || '',
      gw_kg_8: toNullableNumber(shipment.gw_kg_8),
      cbm_8: toNullableNumber(shipment.cbm_8),

      container_no_9: shipment.container_no_9 || '',
      container_type_9: shipment.container_type_9 || '',
      seal_no_9: shipment.seal_no_9 || '',
      pcs_9: shipment.pcs_9 || '',
      gw_kg_9: toNullableNumber(shipment.gw_kg_9),
      cbm_9: toNullableNumber(shipment.cbm_9),

      container_no_10: shipment.container_no_10 || '',
      container_type_10: shipment.container_type_10 || '',
      seal_no_10: shipment.seal_no_10 || '',
      pcs_10: shipment.pcs_10 || '',
      gw_kg_10: toNullableNumber(shipment.gw_kg_10),
      cbm_10: toNullableNumber(shipment.cbm_10)
    };

    console.log('[DEBUG shipmentPayload numeric check]', {
  pcs_1: shipmentPayload.pcs_1,
  gw_kg_1: shipmentPayload.gw_kg_1,
  cbm_1: shipmentPayload.cbm_1,
  pcs_2: shipmentPayload.pcs_2,
  gw_kg_2: shipmentPayload.gw_kg_2,
  cbm_2: shipmentPayload.cbm_2,
  pcs_3: shipmentPayload.pcs_3,
  gw_kg_3: shipmentPayload.gw_kg_3,
  cbm_3: shipmentPayload.cbm_3
});
       
    let savedShipmentId = shipmentId;
    let savedJobNo = shipment.job_no || '';

    if (isNew) {
      savedShipmentId = `SHP-${Date.now()}`;
      shipmentPayload.shipment_id = savedShipmentId;

      const { data: inserted, error: insertError } = await supabase
        .from('shipments')
        .insert(shipmentPayload)
        .select('shipment_id, job_no')
        .single();

      if (insertError) throw insertError;

      savedShipmentId = inserted.shipment_id;
      savedJobNo = inserted.job_no || '';
    } else {
      const { error: updateError } = await supabase
        .from('shipments')
        .update(shipmentPayload)
        .eq('shipment_id', savedShipmentId);

      if (updateError) throw updateError;

      const { data: updatedRow, error: readError } = await supabase
        .from('shipments')
        .select('shipment_id, job_no')
        .eq('shipment_id', savedShipmentId)
        .maybeSingle();

      if (readError) throw readError;

      savedJobNo = (updatedRow && updatedRow.job_no) || savedJobNo || '';
    }
    // containers 保存
if (Array.isArray(containers)) {
  const { error: containerDeleteError } = await supabase
    .from('shipment_containers')
    .delete()
    .eq('shipment_id', savedShipmentId);

  if (containerDeleteError) throw containerDeleteError;

  if (containers.length > 0) {
    const insertRows = containers
  .map((c, idx) => {
    const parsedPcs = parsePcsAndUnit(c.pcs);

    return {
      shipment_id: savedShipmentId,
      sort_no: Number.isFinite(Number(c.sort_no)) ? Number(c.sort_no) : idx + 1,
      container_no: c.container_no || null,
      container_type: c.container_type || null,
      seal_no: c.seal_no || null,
      pcs: parsedPcs.pcs,
      pkg_unit: c.pkg_unit || parsedPcs.pkg_unit,
      gw: toNullableNumber(c.gw),
      cbm: toNullableNumber(c.cbm),
      is_bicon: !!c.is_bicon,
      bicon_group_no: c.bicon_group_no || null,
      bicon_note: c.bicon_note || null,
      source: 'admin'
    };
  })
      .filter(c =>
        c.container_no ||
        c.container_type ||
        c.seal_no ||
        c.pcs ||
        c.gw !== null ||
        c.cbm !== null
      );
console.log('[DEBUG container insertRows]', JSON.stringify(insertRows, null, 2));
    if (insertRows.length > 0) {
      const { error: containerInsertError } = await supabase
        .from('shipment_containers')
        .insert(insertRows);

      if (containerInsertError) throw containerInsertError;
    }
  }
}

    // lines 保存
    for (const line of lines) {
      const lineId = String(line.line_id || '').trim();
      const clean = (v) => {
       if (v === "" || v === undefined || v === null) return null;
       return v;
      };

      const destId = clean(line.delivery_dest_id);

      const linePayload = {
        shipment_id: savedShipmentId,
        customer_code: shipment.customer_code || line.customer_code || '',
        pt: line.pt || '',
        commodity: line.commodity || '',
        delivery_dest_id: destId ? destId : null,
        delivery_dest_short: line.delivery_dest_short || '',
        delivery_request_date: line.delivery_request_date || null,
        delivery_request_time: line.delivery_request_time || null,
        delivery_fixed: line.delivery_fixed || null,
        delivery_fixed_time: line.delivery_fixed_time || null,
        delivery_plan_date: line.delivery_plan_date || null,
        delivery_plan_time: line.delivery_plan_time || null,
        remarks: line.remarks || '',
        commodity_note: line.commodity_note || '',
        customer_ref_no: line.customer_ref_no || ''
      };

      console.log('[save-shipment] linePayload:', linePayload);

      const destIdRaw = String(linePayload.delivery_dest_id || '').trim();

      linePayload.delivery_dest_id =
       !destIdRaw || destIdRaw === '-' || destIdRaw === 'undefined'
         ? null
         : destIdRaw;

      if (lineId) {
        const { error: lineUpdateError } = await supabase
          .from('shipment_lines')
          .update(linePayload)
          .eq('line_id', lineId);

        if (lineUpdateError) throw lineUpdateError;
      } else {
        linePayload.line_id = `LIN-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        const { error: lineInsertError } = await supabase
          .from('shipment_lines')
          .insert(linePayload);

        if (lineInsertError) throw lineInsertError;
      }
    }

    res.json({
      ok: true,
      shipment_id: savedShipmentId,
      job_no: savedJobNo
    });
  } catch (err) {
    console.error('POST /api/admin/save-shipment error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.post('/api/broker/shipments', async (req, res) => {
  try {
    const { token } = req.body || {};
    const session = sessions.get(token);

    if (!session) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const brokerCode = session.partner_code || session.broker_code || session.code;
    if (!brokerCode) {
      return res.status(400).json({ ok: false, error: 'broker_code not found in session' });
    }
console.log('[DEBUG shipment payload]', payload);
    const { data: shipments, error: shipErr } = await supabase
      .from('shipments')
      .select(`
        shipment_id,
        job_no,
        customer_code,
        broker_code,
        status,
        customs_status,
        inbound_no,
        pol,
        pod,
        vessel,
        voyage,
        eta,
        cargo_pickup_location_id
      `)
      .eq('broker_code', brokerCode)
      .order('eta', { ascending: true });

    if (shipErr) throw shipErr;

    const shipmentIds = (shipments || []).map(r => r.shipment_id);
    if (shipmentIds.length === 0) {
      return res.json({ ok: true, list: [] });
    }

    const { data: lines, error: lineErr } = await supabase
      .from('shipment_lines')
      .select(`
        shipment_id,
        line_id,
        commodity,
        container_no,
        delivery_dest_id,
        delivery_dest_short
      `)
      .in('shipment_id', shipmentIds);

    if (lineErr) throw lineErr;

    const customerCodes = [...new Set((shipments || []).map(r => r.customer_code).filter(Boolean))];
    const destIds = [...new Set((lines || []).map(r => r.delivery_dest_id).filter(Boolean))];
    const pickupIds = [...new Set((shipments || []).map(r => r.cargo_pickup_location_id).filter(Boolean))];

    const [{ data: customers }, { data: dests }, { data: places }] = await Promise.all([
      customerCodes.length
        ? supabase.from('customers').select('customer_code, customer_name').in('customer_code', customerCodes)
        : Promise.resolve({ data: [] }),
      destIds.length
        ? supabase.from('dests').select('dest_id, dest_name, d_address1, d_address2').in('dest_id', destIds)
        : Promise.resolve({ data: [] }),
      pickupIds.length
        ? supabase.from('places').select('place_id, place_name').in('place_id', pickupIds)
        : Promise.resolve({ data: [] })
    ]);

    const customerMap = Object.fromEntries((customers || []).map(r => [r.customer_code, r]));
    const destMap = Object.fromEntries((dests || []).map(r => [r.dest_id, r]));
    const placeMap = Object.fromEntries((places || []).map(r => [r.place_id, r]));

    const linesByShipment = {};
    (lines || []).forEach(r => {
      if (!linesByShipment[r.shipment_id]) linesByShipment[r.shipment_id] = [];
      linesByShipment[r.shipment_id].push(r);
    });

    const list = (shipments || []).map(s => {
      const lineRows = linesByShipment[s.shipment_id] || [];
      const firstLine = lineRows[0] || {};

      const containerSet = new Set();
      lineRows.forEach(r => {
        const no = String(r.container_no || '').trim();
        if (!no || no === '未定') return;
        containerSet.add(no);
      });
      const bicon = getBiconInfoFromShipment(s);

      const dest = destMap[firstLine.delivery_dest_id] || null;
      const pickup = placeMap[s.cargo_pickup_location_id] || null;
      const customer = customerMap[s.customer_code] || null;

      const resolvedDestAddress = [
        dest && dest.d_address1 ? dest.d_address1 : '',
        dest && dest.d_address2 ? dest.d_address2 : ''
      ].filter(Boolean).join(' ');

      return {
        shipment_id: s.shipment_id,
        job_no: s.job_no,
        customs_status: s.customs_status || 'NOT_STARTED',
        resolved_customer_name: (customer && customer.customer_name) || '',
        customer_name: (customer && customer.customer_name) || '',
        commodity: firstLine.commodity || '',
        inbound_no: s.inbound_no || '',
        resolved_pickup_name: (pickup && pickup.place_name) || '',
        pol: s.pol || '',
        resolved_dest_name: (dest && dest.dest_name) || firstLine.delivery_dest_short || '',
        resolved_dest_address: resolvedDestAddress,
        pod: s.pod || '',
        vessel: s.vessel || '',
        voyage: s.voyage || '',
        eta: s.eta || null,
        bicon_count: bicon.bicon_count, customs_bicon_notice: bicon.is_bicon ? '搬入仕分け・個別申告が必要' : '' };
    });

    return res.json({ ok: true, list });
  } catch (err) {
    console.error('broker shipments error', err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});
function resolveContainerTypeLabel(v) {
  const value = String(v || '').trim();
  if (!value) return '';

  const map = {
    CT01: '20GP',
    CT02: '40GP',
    CT03: '40HQ',
    CT04: '20RF',
    CT05: '40RF',
    CT06: '20GP(B)',
    CT07: '40HQ(B)'
  };

  return map[value] || value;
}

function applyBiconFlagsAcrossRows(rows) {
  const counter = {};

  // まず一覧全体で (B)付きコンテナ番号を集計
  (rows || []).forEach(r => {
    for (let i = 1; i <= 10; i++) {
      const no = String(r[`container_no_${i}`] || '').trim();
      if (!no || no === '未定') continue;

      const typeLabel = resolveContainerTypeLabel(r[`container_type_${i}`]);
      if (!typeLabel.includes('(B)')) continue;

      counter[no] = (counter[no] || 0) + 1;
    }
  });

  // 各rowに反映
  return (rows || []).map(r => {
    const matched = [];

    for (let i = 1; i <= 10; i++) {
      const no = String(r[`container_no_${i}`] || '').trim();
      if (!no || no === '未定') continue;

      const typeLabel = resolveContainerTypeLabel(r[`container_type_${i}`]);
      if (!typeLabel.includes('(B)')) continue;

      if ((counter[no] || 0) >= 2) {
        matched.push(no);
      }
    }

    const uniq = [...new Set(matched)];

    return {
      ...r,
      is_bicon: uniq.length > 0,
      bicon_count: uniq.length,
      bicon_label: uniq.join(' / ')
    };
  });
}
app.post('/api/customer/save-comment', async (req, res) => {
  try {
    const { session_id, shipment_id, customer_comment } = req.body;

    const session = getSessionOrThrow(session_id);

    const { error } = await supabase
      .from('shipments')
      .update({ customer_comment })
      .eq('shipment_id', shipment_id)
      .eq('customer_code', session.customer_code);

    if (error) throw error;

    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});
app.get('/api/master/inbound-places', async (req, res) => {
  try {
    const pod = String(req.query.pod || '').trim();
    const carrierId = String(req.query.carrier_id || '').trim();

    let query = supabase
      .from('inbound_place_master')
      .select('*')
      .eq('is_active', true)
      .order('place_name', { ascending: true });

    if (pod) {
      query = query.eq('pod', pod);
    }

    if (carrierId) {
      query = query.eq('carrier_id', carrierId);
    }

    const { data, error } = await query;

    if (error) {
      return res.status(500).json({
        ok: false,
        message: error.message,
        error
      });
    }

    return res.json({
      ok: true,
      rows: data || []
    });

  } catch (e) {
    console.error('get inbound places error:', e);
    return res.status(500).json({
      ok: false,
      message: e.message || String(e)
    });
  }
});
app.post('/api/admin/expand-shipment-charges', async (req, res) => {
  try {
    const shipmentId = String(req.body.shipment_id || '').trim();
    if (!shipmentId) {
      return res.status(400).json({ ok: false, message: 'shipment_id is required' });
    }

    // 1. shipment取得
    const { data: shipment, error: shipmentError } = await supabase
      .from('shipments')
      .select(`
        shipment_id,
        customer_code,
        carrier_id,
        pol,
        pod,
        service_type_code,
        incoterms,
        container_type_1
      `)
      .eq('shipment_id', shipmentId)
      .maybeSingle();

    console.log('EXPAND shipment:', shipment);
    console.log('EXPAND shipmentError:', shipmentError);

    if (shipmentError) {
      return res.status(500).json({ ok: false, message: shipmentError.message, error: shipmentError });
    }
    if (!shipment) {
      return res.status(404).json({ ok: false, message: 'shipment not found' });
    }

    // 2. マッチ条件
    const carrierId = String(shipment.carrier_id || '').trim();
    const pol = String(shipment.pol || '').trim();
    const pod = String(shipment.pod || '').trim();
    const serviceType = String(shipment.service_type_code || '').trim();
    const containerType = String(shipment.container_type_1 || '').trim();
    const incoterms = String(shipment.incoterms || '').trim();

    let query = supabase
      .from('charge_rate_card')
      .select('*')
      .eq('is_active', true);

    if (carrierId) query = query.eq('carrier_id', carrierId);
    if (pol) query = query.eq('pol', pol);
    if (pod) query = query.eq('pod', pod);
    if (serviceType) query = query.eq('service_type', serviceType);
    if (containerType) query = query.eq('container_type', containerType);
    if (incoterms) query = query.eq('incoterms', incoterms);

    const { data: rates, error: rateError } = await query.order('template_name', { ascending: true });

    console.log('EXPAND rates:', rates);
    console.log('EXPAND rateError:', rateError);

    if (rateError) {
      return res.status(500).json({ ok: false, message: rateError.message, error: rateError });
    }
    if (!rates || !rates.length) {
      return res.status(404).json({ ok: false, message: 'matching charge template not found' });
    }

    // 3. shipment_charges作成
    const nowBase = Date.now();

    const chargeRows = rates.map((r, idx) => ({
      shipment_charge_id: `SC-${shipmentId}-${nowBase}-${idx + 1}`,
      shipment_id: shipmentId,
      charge_name: r.charge_name || '',
      qty: 1,
      unit: r.unit || null,
      rate: r.rate ?? null,
      amount: r.rate ?? null, // まずは qty=1 前提
      tax_category: r.tax_category || null,
      vendor: r.carrier_id || null,
      customer_code: shipment.customer_code || null,
      currency: r.currency || null,
      fx_rate: r.fx_rate ?? null,
      note: r.template_name ? `template:${r.template_name}` : null,
      created_by: 'system'
    })).filter(r => r.shipment_id && r.charge_name);

    console.log('EXPAND chargeRows:', chargeRows);

    const { data: inserted, error: insertError } = await supabase
      .from('shipment_charges')
      .insert(chargeRows)
      .select();

    console.log('EXPAND inserted:', inserted);
    console.log('EXPAND insertError:', insertError);

    if (insertError) {
      return res.status(500).json({ ok: false, message: insertError.message, error: insertError });
    }

    return res.json({
      ok: true,
      shipment_id: shipmentId,
      count: inserted?.length || 0,
      data: inserted || []
    });

  } catch (e) {
    console.error('expand shipment charges error:', e);
    return res.status(500).json({
      ok: false,
      message: e.message || String(e)
    });
  }
});
app.get('/api/admin/shipment-charges', async (req, res) => {
  try {
    const shipment_id = req.query.shipment_id;

    if (!shipment_id) {
      return res.status(400).json({ ok: false, error: 'shipment_id is required' });
    }

    const { data, error } = await supabase
      .from('shipment_charges')
      .select('*')
      .eq('shipment_id', shipment_id)
      .order('shipment_charge_id', { ascending: true });

    if (error) throw error;

    return res.json({
      ok: true,
      charges: data || []
    });
  } catch (err) {
    console.error('[shipment-charges] error:', err);
    return res.status(500).json({
      ok: false,
      error: err.message || String(err)
    });
  }
});
app.post('/api/admin/save-an-data', async (req, res) => {
  try {
    const shipmentId = String(req.body.shipment_id || '').trim();
    if (!shipmentId) {
      return res.status(400).json({ ok: false, error: 'shipment_id is required' });
    }

    const bodyText = req.body.body_text || '';
    const caseMark = req.body.case_mark || '';
    const inboundNo = req.body.inbound_no || '';

    const shipmentPayload = {
      an_data: JSON.stringify({
        body_text: bodyText,
        case_mark: caseMark
      }),
      inbound_no: inboundNo
    };

    const { error: shipmentError } = await supabase
      .from('shipments')
      .update(shipmentPayload)
      .eq('shipment_id', shipmentId);

    if (shipmentError) throw shipmentError;

    const snapshotPayload = {
      shipment_id: shipmentId,
      body_description: bodyText,
      case_mark: caseMark,
      updated_at: new Date().toISOString()
    };

    const { error: snapshotError } = await supabase
      .from('shipment_an_snapshot')
      .upsert(snapshotPayload, { onConflict: 'shipment_id' });

    if (snapshotError) throw snapshotError;

    return res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/admin/save-an-data error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/save-an-snapshot', async (req, res) => {
  try {
    const {
      shipment_id,
      hbl_no,
      mbl_no,
      shipper_name,
      consignee_name,
      notify_name,
      vessel,
      voyage,
      pol,
      pod,
      eta,
      atd,
      inbound_no,
      on_board_date,
      case_mark,
      body_description,
      container_lines,
      gw_total,
      cbm_total,
      charges
    } = req.body || {};

    if (!shipment_id) {
      return res.status(400).json({
        ok: false,
        error: 'shipment_id is required'
      });
    }

    const containers = Array.isArray(container_lines) ? container_lines : [];

    const chargeList = Array.isArray(charges) ? charges : [];

    // 1) snapshot保存
    const snapshotPayload = {
  shipment_id,
  hbl_no: hbl_no || null,
  mbl_no: mbl_no || null,
  shipper_name: shipper_name || null,
  consignee_name: consignee_name || null,
  notify_name: notify_name || null,
  vessel: vessel || null,
  voyage: voyage || null,
  pol: pol || null,
  pod: pod || null,
  eta: eta || null,
  atd: atd || null,
  on_board_date: on_board_date || null,
  case_mark: case_mark || null,
  body_description: body_description || null,
  container_lines_json: containers,
  gw_total: gw_total ?? null,
  cbm_total: cbm_total ?? null,
  updated_at: new Date().toISOString()
};
    const { error: shipmentUpdateError } = await supabase
  .from('shipments')
  .update({
    inbound_no: inbound_no || null
  })
  .eq('shipment_id', shipment_id);

if (shipmentUpdateError) throw shipmentUpdateError;

    const { error: snapshotError } = await supabase
      .from('shipment_an_snapshot')
      .upsert(snapshotPayload, { onConflict: 'shipment_id' });

    if (snapshotError) throw snapshotError;

    // 2) 既存container削除
    const { error: deleteError } = await supabase
      .from('shipment_containers')
      .delete()
      .eq('shipment_id', shipment_id);

    if (deleteError) throw deleteError;

   const toNumberOrNull = (v) => {
  if (v === '' || v == null) return null;

  const m = String(v).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

const splitPcsAndUnit = (v, fallbackUnit = '') => {
  const s = String(v || '').trim();

  const m = s.match(/^([\d,]+(?:\.\d+)?)(.*)$/);

  return {
    pcs: m ? Number(m[1].replace(/,/g, '')) : null,
    pkg_unit: m ? String(m[2] || fallbackUnit || '').trim() : fallbackUnit || null
  };
};

// 3) container再insert
if (containers.length > 0) {
  const rows = containers.map((c, idx) => ({
    shipment_id,
    container_no: c.container_no || null,
    container_type: c.container_type || null,
    seal_no: c.seal_no || null,
    pcs: splitPcsAndUnit(c.pcs, c.pkg_unit).pcs,
    pkg_unit: splitPcsAndUnit(c.pcs, c.pkg_unit).pkg_unit,
    gw: toNumberOrNull(c.gw),
    cbm: toNumberOrNull(c.cbm),
    source: 'manual',
    sort_no: idx + 1,
    updated_at: new Date().toISOString()
  }));

  // 4) charges保存
const { error: deleteChargeError } = await supabase
  .from('shipment_charges')
  .delete()
  .eq('shipment_id', shipment_id);

if (deleteChargeError) throw deleteChargeError;

if (chargeList.length > 0) {
  const getRate = (c) =>
    c.ex_rate ??
    c.fx_rate ??
    c.exchange_rate ??
    c.exRate ??
    c.fxRate ??
    '';

  const chargeRows = chargeList.map((c, idx) => {
    const rateValue = getRate(c);

    return {
      shipment_charge_id: 'CHG-' + shipment_id + '-' + Date.now() + '-' + idx,
      shipment_id,
      charge_name: c.item || c.charge_name || '',
      tax_category: c.tax || c.tax_category || '',
      unit: c.unit || '',
      qty: c.qty === '' || c.qty == null ? null : Number(c.qty),
      rate: c.unit_price === '' || c.unit_price == null ? null : Number(c.unit_price),
      currency: c.currency || '',
      fx_rate: rateValue === '' || rateValue == null ? null : Number(rateValue),
      amount: c.amount === '' || c.amount == null ? null : Number(c.amount),
      note: c.note || ''
    };
  });

  const { error: insertChargeError } = await supabase
    .from('shipment_charges')
    .insert(chargeRows);

  if (insertChargeError) throw insertChargeError;
}

  const { error: insertError } = await supabase
    .from('shipment_containers')
    .insert(rows);

  if (insertError) throw insertError;
}

const getRateValue = (c) =>
  c.unit_price ??
  c.rate ??
  c.unitPrice ??
  c.unit_price_jpy ??
  '';

const getFxRate = (c) =>
  c.ex_rate ??
  c.fx_rate ??
  c.exchange_rate ??
  c.exRate ??
  c.fxRate ??
  '';

const { error: chargeDeleteError } = await supabase
  .from('shipment_charges')
  .delete()
  .eq('shipment_id', shipment_id);

if (chargeDeleteError) throw chargeDeleteError;

if (chargeList.length > 0) {
  const now = Date.now();

  const chargeRows = chargeList.map((c, idx) => {
    const rateValue = getRateValue(c);
    const fxRateValue = getFxRate(c);

    return {
      shipment_charge_id: 'CHG-' + shipment_id + '-' + now + '-' + idx,
      shipment_id,
      charge_name: c.charge_name || c.item || '',
      tax_category: c.tax_category || c.tax || '',
      unit: c.unit || '',
      qty: c.qty === '' || c.qty == null ? null : Number(c.qty),
      rate: rateValue === '' || rateValue == null ? null : Number(rateValue),
      currency: c.currency || '',
      fx_rate: fxRateValue === '' || fxRateValue == null ? null : Number(fxRateValue),
      amount: c.amount === '' || c.amount == null ? null : Number(c.amount),
      note: c.note || ''
    };
  });

  console.log('[save-an-snapshot chargeRows]', chargeRows);

  const { error: chargeInsertError } = await supabase
    .from('shipment_charges')
    .insert(chargeRows);

  if (chargeInsertError) throw chargeInsertError;
}
    return res.json({
      ok: true,
      shipment_id,
      container_count: containers.length,
      charge_count: chargeList.length
    });
  } catch (err) {
    console.error('[save-an-snapshot] error:', err);
    return res.status(500).json({
      ok: false,
      error: err.message || String(err)
    });
  }
});

app.post('/api/customs/render', async (req, res) => {
  try {
    const p = req.body || {};

const shipment = p.shipment || {};
const party = p.party || {};
const logistics = p.logistics || {};
const an = p.an || {};
const customs = p.customs || {};
const labels = p.labels || {};

const customer = party.customer || {};
const supplier = party.supplier || {};
const broker = party.broker || {};
const trucker = party.trucker || {};

const pickupPlace = logistics.pickup_place || {};
const delivery = logistics.delivery || {};

const snapshot = an.snapshot || {};
const containers = Array.isArray(an.containers) ? an.containers : [];

const totalPkgs = totals.pkgs || containers.reduce((sum, c) => sum + Number(c.pcs || 0), 0);
const totalGw = totals.gw_kg || containers.reduce((sum, c) => sum + Number(c.gw_kg || 0), 0);
const totalCbm = totals.cbm || containers.reduce((sum, c) => sum + Number(c.cbm || 0), 0);
const totalUnit = totals.pkg_unit || containers.find(c => c.pkg_unit)?.pkg_unit || '';

const pkgsText = totalPkgs ? `${totalPkgs}${totalUnit}` : '';
const gwText = totalGw ? `${totalGw}KGS` : '';
const cbmText = totalCbm ? `${totalCbm}CBM` : '';
console.log('[customsRenderer totals]', totals);
const firstContainer = containers[0] || {};
const firstLine = Array.isArray(delivery.lines) ? (delivery.lines[0] || {}) : {};

const shipperBlock = [
  snapshot.shipper_name || supplier.supplier_name || '',
  snapshot.shipper_address_1 || supplier.supplier_add_1 || '',
  snapshot.shipper_address_2 || supplier.supplier_add_2 || ''
].filter(Boolean).join('\n');

const customerAddress = [
  customer.address1 || customer.customer_address1 || '',
  customer.address2 || customer.customer_address2 || ''
].filter(Boolean).join(' ');

const vesselVoyage = [shipment.vessel || '', shipment.voyage || '']
  .filter(Boolean)
  .join(' / ');

  const templatePath = path.join(process.cwd(), 'templates', 'customs_request_template.html');
    let template = fs.readFileSync(templatePath, 'utf-8');


const data = {
  request_date: customs.request_date || '',
  request_no: shipment.job_no || '',
  job_no: shipment.job_no || '',

  broker_name: broker.partner_name || '',
  broker_person: customs.broker_person || 'ご担当者様',

  from_block: customs.from_block || '',
  greeting: customs.greeting || '',

  instruction_date: customs.instruction_date || customs.request_date || '',
  customs_declared_date: customs.declared_date || '',

  inbound_no: snapshot.inbound_no || shipment.inbound_no || '',
  pod: shipment.pod || '',

  pkgs: totals.pkgs || '',
  gw: totals.gw_kg || '',
  cbm: totals.cbm || '',

  incoterms: labels.incoterms_label || customs.incoterms || shipment.incoterms || '',
  currency: labels.currency_label || customs.currency || '',
  decl_amount: customs.declaration_amount || '',

  customer_name_e:
    customer.customer_name_e ||
    customer.customer_name ||
    '',

  customer_address: customerAddress,
  customer_phone: customer.tel || customer.phone || '',
  customer_c_registration: customer.c_registration || '',
  customer_ie_registration: customer.ie_registration || '',
  customer_real_time: customer.real_time || '',
  customer_tax_payment: customer.tax_payment || '',
  customer_open_policy: customer.open_policy || '',

  shipper_block: shipperBlock,

  vessel_voyage: vesselVoyage,
  eta: shipment.eta || '',

  pickup_place:
    pickupPlace.place_name ||
    pickupPlace.inbound_place_name ||
    '',

  pickup_date: customs.pickup_date || '',

  delivery_date:
    delivery.delivery_fixed ||
    delivery.delivery_request_date ||
    '',

  delivery_time:
    delivery.delivery_fixed_time ||
    delivery.delivery_request_time ||
    '',

  delivery_name:
    delivery.delivery_dest_short ||
    firstLine.delivery_dest_short ||
    '',

  delivery_address1: delivery.address1 || '',
  delivery_address2: delivery.address2 || '',
  delivery_tel: delivery.tel || '',
  delivery_contact: delivery.contact_person || '',

  trucker_name: trucker.partner_name || '',
  vehicle_type: customs.vehicle_type || '',

  invoice_no: customs.invoice_no || '',
  item_name: customs.item_name || '',

  descriptions: Array.isArray(customs.descriptions) ? customs.descriptions : [],
  documents: Array.isArray(labels.documents_labels) ? labels.documents_labels : [],
  cost_cover: Array.isArray(labels.cost_cover_labels) ? labels.cost_cover_labels : [],
  work_scopes: Array.isArray(customs.work_scopes) ? customs.work_scopes : [],
  requests: Array.isArray(labels.requests_labels) ? labels.requests_labels : [],

  special_inst: customs.special_instructions || ''
};

    template = template.replace(
      /const data = \{[\s\S]*?\};/,
      `const data = ${JSON.stringify(data, null, 2)};`
    );

    return res.json({ ok: true, html: template });
  } catch (e) {
    console.error('/api/customs/render error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});
app.get('/api/an-input', async (req, res) => {
  try {
    const shipment_id = String(req.query.shipment_id || '').trim();
    if (!shipment_id) {
      return res.status(400).json({ ok: false, error: 'shipment_id is required' });
    }

    const { data: shipment, error: shipmentError } = await supabase
      .from('shipments')
      .select(`
        shipment_id,
        job_no,
        customer_code,
        supplier_id,
        carrier_id,
        cargo_pickup_location_id,
        service_type_code,
        pol,
        pod,
        vessel,
        voyage,
        eta,
        etd,
        bl_no,
        master_bl_no,
        inbound_no,
        an_data
      `)
      .eq('shipment_id', shipment_id)
      .single();

    if (shipmentError) throw shipmentError;

    const { data: snapshot, error: snapshotError } = await supabase
      .from('shipment_an_snapshot')
      .select(`
        shipment_id,
        hbl_no,
        mbl_no,
        shipper_name,
        consignee_name,
        notify_name,
        vessel,
        voyage,
        pol,
        pod,
        eta,
        atd,
        on_board_date,
        case_mark,
        body_description,
        container_lines_json,
        gw_total,
        cbm_total,
        created_at,
        updated_at
      `)
      .eq('shipment_id', shipment_id)
      .maybeSingle();

    if (snapshotError) throw snapshotError;

    const { data: containers, error: containerError } = await supabase
      .from('shipment_containers')
      .select(`
        id,
        shipment_id,
        container_no,
        container_type,
        seal_no,
        pcs,
        pkg_unit,
        gw,
        cbm,
        source,
        sort_no,
        created_at,
        updated_at
      `)
      .eq('shipment_id', shipment_id)
      .order('sort_no', { ascending: true });

    if (containerError) throw containerError;

    let supplier = null;
    if (shipment?.supplier_id) {
      const { data: supplierRow, error: supplierError } = await supabase
        .from('suppliers')
        .select(`
          supplier_id,
          supplier_name,
          supplier_add_1,
          supplier_add_2
        `)
        .eq('supplier_id', shipment.supplier_id)
        .maybeSingle();

      if (supplierError) throw supplierError;
      supplier = supplierRow || null;
    }

    let customer = null;
    if (shipment?.customer_code) {
      const { data: customerRow, error: customerError } = await supabase
        .from('customers')
        .select(`
          customer_code,
          customer_name,
          customer_name_e,
          address1_e,
          address2_e,
          billing_name,
          zip,
          address1,
          address2,
          contact_person,
          email,
          phone,
          payment_terms,
          closing_day,
          c_registration,
          i_e_registration,
          real_time,
          tax_payment,
          open_policy
        `)
        .eq('customer_code', shipment.customer_code)
        .maybeSingle();

      if (customerError) throw customerError;
      customer = customerRow || null;
    }

    let pickupPlace = null;
    if (shipment?.cargo_pickup_location_id) {
      const { data: placeRow, error: placeError } = await supabase
        .from('inbound_place_master')
        .select(`
          place_id,
          carrier_id,
          pod,
          bonded_code,
          place_name,
          line1,
          line2,
          line3,
          line4,
          is_active,
          updated_at
        `)
        .eq('place_id', shipment.cargo_pickup_location_id)
        .maybeSingle();

      if (placeError) throw placeError;
      pickupPlace = placeRow || null;
    }

    let legacyAnData = {};
    if (shipment?.an_data) {
      try {
        legacyAnData = JSON.parse(shipment.an_data);
      } catch (_) {
        legacyAnData = {};
      }
    }

    const resolved = {
      shipment_id: shipment.shipment_id,
      inbound_no: shipment.inbound_no || '',

      hbl_no: snapshot?.hbl_no || shipment.bl_no || '',
      mbl_no: snapshot?.mbl_no || shipment.master_bl_no || '',

      shipper_name: snapshot?.shipper_name || [
        supplier?.supplier_name || '',
        supplier?.supplier_add_1 || '',
        supplier?.supplier_add_2 || ''
      ].filter(Boolean).join('\n'),

      consignee_name: snapshot?.consignee_name || [
        customer?.customer_name_e || '',
        customer?.address1_e || '',
        customer?.address2_e || '',
        customer?.phone ? `TEL:${customer.phone}` : ''
      ].filter(Boolean).join('\n'),

      notify_name: snapshot?.notify_name || 'SAME AS CONSIGNEE',

      location_name: [
        snapshot?.location_name || '',
        pickupPlace?.place_name || '',
        pickupPlace?.line1 || '',
        pickupPlace?.line2 || '',
        pickupPlace?.line3 || '',
        pickupPlace?.line4 || '',
        pickupPlace?.bonded_code ? `BONDED CODE: ${pickupPlace.bonded_code}` : ''
      ].filter(Boolean).join('\n'),

      vessel: snapshot?.vessel || shipment.vessel || '',
      voyage: snapshot?.voyage || shipment.voyage || '',
      pol: snapshot?.pol || shipment.pol || '',
      pod: snapshot?.pod || shipment.pod || '',
      eta: snapshot?.eta || shipment.eta || '',
      atd: snapshot?.atd || '',
      on_board_date: snapshot?.on_board_date || '',
      case_mark: snapshot?.case_mark || legacyAnData.case_mark || '',
      body_description: snapshot?.body_description || legacyAnData.body_text || '',
      gw_total: snapshot?.gw_total ?? null,
      cbm_total: snapshot?.cbm_total ?? null
    };

    if (!resolved.case_mark && legacyAnData.case_mark) {
      resolved.case_mark = legacyAnData.case_mark;
    }

    return res.json({
      ok: true,
      shipment,
      supplier,
      customer,
      pickup_place: pickupPlace,
      snapshot: snapshot || null,
      containers: containers || [],
      resolved
    });
  } catch (err) {
    console.error('[an-input] error:', err);
    return res.status(500).json({
      ok: false,
      error: err.message || String(err)
    });
  }
});
app.get('/api/customs/pending', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('shipments')
      .select(`
        shipment_id,
        job_no,
        customer_code,
        vessel,
        etd,
        eta,
        customs_status
      `)
      .or('customs_status.is.null,customs_status.eq.')
      .order('created_at', { ascending: false });

    if (error) throw error;

    let customerMap = {};

    if (data.length > 0) {
      const codes = [...new Set(data.map(s => s.customer_code).filter(Boolean))];

      const { data: custRows } = await supabase
        .from('customers')
        .select('customer_code, customer_name')
        .in('customer_code', codes);

      customerMap = (custRows || []).reduce((acc, c) => {
        acc[c.customer_code] = c.customer_name;
        return acc;
      }, {});
    }

    const rows = data.map(s => ({
      ...s,
      customer_name: customerMap[s.customer_code] || '',
      customs_status_name: s.customs_status || '未手配'
    }));

    res.json({ ok: true, rows });

  } catch (err) {
    console.error('[customs/pending]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/admin/save-customs-data', async (req, res) => {
  try {
    const shipmentId = String(req.body.shipment_id || '').trim();
    if (!shipmentId) {
      return res.status(400).json({ ok: false, error: 'shipment_id is required' });
    }

    const payload = {
      broker_code: req.body.broker_code || null,
      incoterms: req.body.incoterms || null,
      inbound_no: req.body.inbound_no || null,
      currency: req.body.currency || null,
      declaration_amount: req.body.declaration_amount || null,
      invoice_no: req.body.invoice_no || null,
      item_name: req.body.item_name || null,
      customs_declared_date: req.body.customs_declared_date || null,
      customs_data: JSON.stringify({
        descriptions: Array.isArray(req.body.descriptions) ? req.body.descriptions : [],
        costCover: req.body.costCover || '',
        documents: Array.isArray(req.body.documents) ? req.body.documents : [],
        requests: Array.isArray(req.body.requests) ? req.body.requests : [],
        specialInst: req.body.specialInst || '',
        workScopes: Array.isArray(req.body.workScopes) ? req.body.workScopes : [],
        declaredDate: req.body.customs_declared_date || '',
        pickupDate: req.body.pickupDate || ''
      })
    };

    const { error } = await supabase
      .from('shipments')
      .update(payload)
      .eq('shipment_id', shipmentId);

    if (error) throw error;

    return res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/admin/save-customs-data error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/doc-token', async (req, res) => {
  try {
    const { shipment_id, doc_type } = req.body || {};

    if (!shipment_id) {
      return res.status(400).json({ ok: false, error: 'shipment_id is required' });
    }

    if (!['an', 'customs', 'delivery'].includes(doc_type)) {
      return res.status(400).json({ ok: false, error: 'invalid doc_type' });
    }

    const token = crypto.randomBytes(24).toString('hex');

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    const { error } = await supabase
      .from('document_access_tokens')
      .insert({
        token,
        shipment_id,
        doc_type,
        expires_at: expiresAt.toISOString()
      });

    if (error) throw error;

    const baseUrl = 'https://matrix-distances-joke-col.trycloudflare.com';

    return res.json({
      ok: true,
      url: `${baseUrl}/doc/${doc_type}?shipment_id=${encodeURIComponent(shipment_id)}&token=${encodeURIComponent(token)}`
    });
  } catch (err) {
    console.error('[doc-token] error:', err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

app.get('/doc/:docType', async (req, res) => {
  try {
    const docType = req.params.docType;
    const { shipment_id, token } = req.query || {};

    if (!['an', 'customs', 'delivery'].includes(docType)) {
      return res.status(404).send('Invalid document type');
    }

    if (!shipment_id || !token) {
      return res.status(400).send('Missing shipment_id or token');
    }

    const { data: access, error: accessErr } = await supabase
      .from('document_access_tokens')
      .select('*')
      .eq('token', token)
      .eq('shipment_id', shipment_id)
      .eq('doc_type', docType)
      .maybeSingle();

    if (accessErr) throw accessErr;
    if (!access) return res.status(403).send('Invalid or expired link');

    if (access.expires_at && new Date(access.expires_at) < new Date()) {
      return res.status(403).send('This link has expired');
    }

    await supabase
      .from('document_access_tokens')
      .update({
        view_count: (access.view_count || 0) + 1,
        last_viewed_at: new Date().toISOString()
      })
      .eq('token', token);

    const payload = await resolveShipmentDocs(shipment_id);

    if (docType === 'an') {
      console.log('[AN payload]', JSON.stringify(payload, null, 2));
    }

   
    let html = '';

    if (docType === 'an') {
      html = buildANHtmlFromPayload(payload);
    } else if (docType === 'customs') {
      console.log('[customs payload]', JSON.stringify(payload, null, 2));
      html = buildCustomsHtmlFromPayload(payload);
    } else if (docType === 'delivery') {
      html = buildDeliveryHtmlFromPayload(payload);
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch (err) {
  console.error('[doc view] error:', err);
  return res.status(500).send(`
    <pre style="white-space:pre-wrap;">
Document render error

${String(err.stack || err.message || err)}
    </pre>
  `);
}
});
app.get('/api/admin/charge-master', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('charge_rate_card')
      .select('*')
      .eq('is_active', true)
      .order('sort_no');

    if (error) throw error;

    const rows = data || [];

    const templates = [...new Set(
      rows
        .map(r => String(r.template_name || '').trim())
        .filter(Boolean)
    )];

    return res.json({
      ok: true,
      list: rows,
      templates
    });
  } catch (err) {
    console.error('[charge-master] error:', err);
    return res.status(500).json({
      ok: false,
      error: err.message || String(err)
    });
  }
});
