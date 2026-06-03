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
import invoiceRouter from './routes/invoice.js';
import puppeteer from 'puppeteer';
import { resolveDeliveryPayload } from './services/deliveryResolver.js';

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

app.use('/api/invoice', invoiceRouter);

app.use(express.json({ limit: '20mb' }));

// =====================================================
// Invoice Helpers
// =====================================================

function toNumber(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function calcTax(net, taxType, taxRate = 0.1) {
  const amount = toNumber(net);

  if (!amount) {
    return { net: 0, tax: 0, gross: 0 };
  }

  if (taxType === 'taxable') {
    const tax = Math.round(amount * taxRate);
    return {
      net: amount,
      tax,
      gross: amount + tax
    };
  }

  return {
    net: amount,
    tax: 0,
    gross: amount
  };
}

function calcProfitRate(salesNet, profitNet) {
  const s = toNumber(salesNet);
  if (!s) return null;
  return Math.round((toNumber(profitNet) / s) * 10000) / 100;
}

function getBillingMonthFromDate(d) {
  if (!d) return null;
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
}

function parseContainerLines(an) {
  const raw = an?.container_lines_json;

  if (Array.isArray(raw)) return raw;

  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  return [];
}

function normalizeTaxType(v) {
  const s = String(v || '').trim();

  if (s === '課税' || s === 'taxable') return 'taxable';
  if (s === '非課税' || s === 'non_taxable') return 'non_taxable';
  if (s === '免税' || s === 'exempt') return 'exempt';
  if (s === '不課税' || s === 'out_of_scope') return 'out_of_scope';
  if (s === '立替' || s === 'pass_through') return 'pass_through';

  return 'taxable';
}

async function buildInvoiceHeaderFromShipment(shipment_id, base = {}) {
  const { data: s, error: sErr } = await supabase
    .from('shipments')
    .select('*')
    .eq('shipment_id', shipment_id)
    .single();

  if (sErr) throw sErr;

  let customerName = null;

  if (s.customer_code) {
    const { data: customer, error: customerErr } = await supabase
      .from('customers')
      .select('customer_name')
      .eq('customer_code', s.customer_code)
      .maybeSingle();

    if (customerErr) throw customerErr;
    customerName = customer?.customer_name || null;
  }

  const { data: an, error: anErr } = await supabase
    .from('shipment_an_snapshot')
    .select('*')
    .eq('shipment_id', shipment_id)
    .maybeSingle();

  if (anErr) {
    console.warn('[invoice] an snapshot not loaded:', anErr.message);
  }

  const containerLines = parseContainerLines(an);

  const pcsTotal = containerLines.reduce((sum, r) => {
  return sum + toNumber(r.pcs ?? r.qty ?? r.package_count ?? 0);
}, 0);

const gwTotal = containerLines.reduce((sum, r) => {
  return sum + toNumber(r.gw ?? r.gw_kg ?? r.gross_weight ?? r.weight ?? 0);
}, 0);

const cbmTotal = containerLines.reduce((sum, r) => {
  return sum + toNumber(r.cbm ?? r.m3 ?? r.measurement ?? 0);
}, 0);

console.log('[invoice totals]', {
  shipment_id,
  pcsTotal,
  gwTotal,
  cbmTotal,
  package_unit:
    containerLines[0]?.pkg_unit ||
    containerLines[0]?.package_unit ||
    containerLines[0]?.unit ||
    null
});

  const { data: firstLine, error: lineErr } = await supabase
    .from('shipment_lines')
    .select('*')
    .eq('shipment_id', shipment_id)
    .limit(1)
    .maybeSingle();

  if (lineErr) throw lineErr;

  let deliveryText = '';

  if (firstLine?.delivery_dest_id) {
  const { data: dest, error: destErr } = await supabase
    .from('dests')
    .select('dest_name')
    .eq('dest_id', firstLine.delivery_dest_id)
    .maybeSingle();

  if (destErr) throw destErr;

  const deliveryDestName = dest?.dest_name || '';

  deliveryText = [
    [
      firstLine.delivery_fixed,
      firstLine.delivery_fixed_time
    ].filter(Boolean).join(' '),

    deliveryDestName
  ]
  .filter(Boolean)
  .join(' / ');

} else if (
  firstLine?.delivery_fixed ||
  firstLine?.delivery_fixed_time
) {
  deliveryText = [
    firstLine.delivery_fixed,
    firstLine.delivery_fixed_time
  ]
  .filter(Boolean)
  .join(' ');
}

  const eta = an?.eta || s.eta || s.eta_date || null;

  const billingMonth =
    base.billing_month ||
    s.billing_month ||
    s.planned_billing_month ||
    getBillingMonthFromDate(eta) ||
    getBillingMonthFromDate(new Date());

  return {
    source_type: 'SHIPMENT',
    shipment_id,

    customer_id: s.customer_id || base.customer_id || null,
    customer_name: customerName || s.customer_name || s.client_name || base.customer_name || null,

    invoice_no: base.invoice_no || null,
    billing_month: billingMonth,
    invoice_date: base.invoice_date || new Date().toISOString().slice(0, 10),
    due_date: base.due_date || null,

    job_no: s.job_no || s.control_no || base.job_no || null,
    hbl_no: an?.hbl_no || s.hbl_no || base.hbl_no || null,
    mbl_no: an?.mbl_no || s.mbl_no || base.mbl_no || null,
    vessel: an?.vessel || s.vessel || base.vessel || null,
    voyage: an?.voyage || s.voyage || base.voyage || null,
    pol: an?.pol || s.pol || base.pol || null,
    pod: an?.pod || s.pod || base.pod || null,
    eta,

    inbound_no: s.inbound_no || an?.inbound_no || base.inbound_no || null,
    commercial_invoice_no:
      s.invoice_no ||
      s.commercial_invoice_no ||
      base.commercial_invoice_no ||
      null,

    cargo_summary:
      an?.body_description ||
      an?.body_text ||
      s.cargo_summary ||
      s.item_name ||
      base.cargo_summary ||
      null,

    pcs_total: pcsTotal || an?.pcs_total || s.pcs_total || s.total_pcs || null,
    gw_total: gwTotal || an?.gw_total || s.gw_total || s.total_gw || null,
    cbm_total: cbmTotal || an?.cbm_total || s.cbm_total || s.total_cbm || null,

    package_unit:
      containerLines[0]?.pkg_unit ||
      containerLines[0]?.package_unit ||
      containerLines[0]?.unit ||
      base.package_unit ||
      null,

    remarks: deliveryText || base.remarks || null,
    status: base.status || 'draft'
  };
}

async function buildInvoiceLinesFromShipmentCharges(invoice_id, shipment_id) {
  const { data: charges, error: chErr } = await supabase
    .from('shipment_charges')
    .select('*')
    .eq('shipment_id', shipment_id)
    .order('created_at', { ascending: true });

  if (chErr) throw chErr;

  return (charges || []).map((c, idx) => {
    const currency = c.currency || 'JPY';
    const qty = toNumber(c.qty || 1);
    const rate = toNumber(c.rate || 0);
    const fxRate = toNumber(c.fx_rate || c.exchange_rate || 1);

    const billingAmountNet =
      currency !== 'JPY'
        ? Math.round(qty * rate * fxRate)
        : Math.round(qty * rate);

    const taxType = normalizeTaxType(c.tax_category || c.tax_type || c.billing_tax_type);
    const taxRate = taxType === 'taxable' ? 0.1 : 0;
    const tax = calcTax(billingAmountNet, taxType, taxRate);

    return {
      invoice_id,
      line_no: idx + 1,

      item_name: c.charge_name || c.item_name || c.description || '未設定',
      description: c.charge_name || c.description || null,
      show_on_invoice: true,

      billing_amount_net: tax.net,
      billing_tax_type: taxType,
      billing_tax_rate: taxRate,
      billing_tax_amount: tax.tax,
      billing_amount_gross: tax.gross,

      currency,
      foreign_unit_price: currency !== 'JPY' ? rate : null,
      exchange_rate: currency !== 'JPY' ? fxRate : null,
      line_note: c.note || c.memo || null
    };
  });
}

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

app.post('/api/invoice/create-from-shipment', async (req, res) => {
  try {
    const { shipment_id } = req.body || {};

    if (!shipment_id) {
      return res.status(400).json({ ok: false, error: 'shipment_id is required' });
    }

    const { data: existing, error: exErr } = await supabase
      .from('invoice_headers')
      .select('*')
      .eq('shipment_id', shipment_id)
      .neq('status', 'cancelled')
      .maybeSingle();

    if (exErr) throw exErr;

    if (existing) {
      return res.json({
        ok: true,
        already_exists: true,
        invoice_id: existing.invoice_id,
        header: existing
      });
    }

    const headerPayload = await buildInvoiceHeaderFromShipment(shipment_id);

    const { data: header, error: hErr } = await supabase
      .from('invoice_headers')
      .insert(headerPayload)
      .select('*')
      .single();

    if (hErr) throw hErr;

    const invoiceLines = await buildInvoiceLinesFromShipmentCharges(
      header.invoice_id,
      shipment_id
    );

    let insertedLines = [];

    if (invoiceLines.length) {
      const { data: lines, error: lineErr } = await supabase
        .from('invoice_lines')
        .insert(invoiceLines)
        .select('*');

      if (lineErr) throw lineErr;
      insertedLines = lines || [];
    }

    res.json({
      ok: true,
      already_exists: false,
      invoice_id: header.invoice_id,
      header,
      lines: insertedLines
    });
  } catch (err) {
    console.error('[invoice/create-from-shipment] error:', err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});
app.post('/api/invoice/reload-from-shipment', async (req, res) => {
  try {
    const { invoice_id } = req.body || {};

    if (!invoice_id) {
      return res.status(400).json({ ok: false, error: 'invoice_id is required' });
    }

    const { data: inv, error: invErr } = await supabase
      .from('invoice_headers')
      .select('*')
      .eq('invoice_id', invoice_id)
      .single();

    if (invErr) throw invErr;

    const shipment_id = inv.shipment_id;

    if (!shipment_id) {
      return res.status(400).json({ ok: false, error: 'shipment_id is missing' });
    }

    const headerUpdate = await buildInvoiceHeaderFromShipment(shipment_id, inv);

    delete headerUpdate.invoice_id;
    delete headerUpdate.created_at;

    headerUpdate.updated_at = new Date().toISOString();

    const { data: updatedHeader, error: updErr } = await supabase
      .from('invoice_headers')
      .update(headerUpdate)
      .eq('invoice_id', invoice_id)
      .select('*')
      .single();

    if (updErr) throw updErr;

    const { error: delLineErr } = await supabase
      .from('invoice_lines')
      .delete()
      .eq('invoice_id', invoice_id);

    if (delLineErr) throw delLineErr;

    const invoiceLines = await buildInvoiceLinesFromShipmentCharges(
      invoice_id,
      shipment_id
    );

    let insertedLines = [];

    if (invoiceLines.length) {
      const { data: lines, error: insErr } = await supabase
        .from('invoice_lines')
        .insert(invoiceLines)
        .select('*');

      if (insErr) throw insErr;
      insertedLines = lines || [];
    }

    res.json({
      ok: true,
      header: updatedHeader,
      inserted_lines: insertedLines,
      lines: insertedLines
    });
  } catch (err) {
    console.error('[invoice/reload-from-shipment] error:', err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
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
// =====================================================
// Invoice APIs
// =====================================================
app.get('/api/invoice/list', async (req, res) => {
  try {
    const billingMonth = req.query.billing_month || null;
    const customerId = req.query.customer_id || null;
    const status = req.query.status || null;

    let q = supabase
      .from('invoice_headers')
      .select('*')
      .order('created_at', { ascending: false });

    if (billingMonth) q = q.eq('billing_month', billingMonth);
    if (customerId) q = q.eq('customer_id', customerId);
    if (status) q = q.eq('status', status);

    const { data, error } = await q;

    if (error) throw error;

    res.json({ ok: true, rows: data || [] });
  } catch (err) {
    console.error('[invoice/list] error:', err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});
app.get('/api/invoice/detail', async (req, res) => {
  try {
    const invoiceId = req.query.invoice_id;

    if (!invoiceId) {
      return res.status(400).json({ ok: false, error: 'invoice_id is required' });
    }

    const { data: header, error: hErr } = await supabase
      .from('invoice_headers')
      .select('*')
      .eq('invoice_id', invoiceId)
      .single();

    if (hErr) throw hErr;

    const { data: lines, error: lErr } = await supabase
      .from('invoice_lines')
      .select('*')
      .eq('invoice_id', invoiceId)
      .order('line_no', { ascending: true });

    if (lErr) throw lErr;

    const { data: payables, error: pErr } = await supabase
      .from('payable_lines')
      .select('*')
      .eq('invoice_id', invoiceId)
      .order('created_at', { ascending: true });

    if (pErr) throw pErr;

    res.json({
      ok: true,
      header,
      lines: lines || [],
      payables: payables || []
    });
  } catch (err) {
    console.error('[invoice/detail] error:', err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});
app.post('/api/invoice/create-blank', async (req, res) => {
  try {
    const body = req.body || {};

    const payload = {
      source_type: 'BLANK',
      customer_id: body.customer_id || null,
      customer_name: body.customer_name || null,
      invoice_no: body.invoice_no || null,
      billing_month: body.billing_month || getBillingMonthFromDate(new Date()),
      invoice_date: body.invoice_date || new Date().toISOString().slice(0, 10),
      due_date: body.due_date || null,
      status: 'draft',
      remarks: body.remarks || null
    };

    const { data, error } = await supabase
      .from('invoice_headers')
      .insert(payload)
      .select('*')
      .single();

    if (error) throw error;

    res.json({ ok: true, invoice_id: data.invoice_id, header: data });
  } catch (err) {
    console.error('[invoice/create-blank] error:', err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

app.post('/api/invoice/save', async (req, res) => {
  try {
    const {
      invoice_id,
      header = {},
      lines = [],
      payables = []
    } = req.body || {};

    if (!invoice_id) {
      return res.status(400).json({ ok: false, error: 'invoice_id is required' });
    }

    const normalizedLines = lines.map((line, idx) => {
      const billingTaxType = line.billing_tax_type || 'taxable';
      const billingTaxRate = billingTaxType === 'taxable'
        ? toNumber(line.billing_tax_rate || 0.1)
        : 0;

      const c = calcTax(line.billing_amount_net, billingTaxType, billingTaxRate);

      return {
        invoice_id,
        line_no: line.line_no || idx + 1,
        item_name: line.item_name || '未設定',
        description: line.description || null,
        show_on_invoice: line.show_on_invoice !== false,

        billing_amount_net: c.net,
        billing_tax_type: billingTaxType,
        billing_tax_rate: billingTaxRate,
        billing_tax_amount: c.tax,
        billing_amount_gross: c.gross,

        currency: line.currency || 'JPY',
        foreign_unit_price: line.foreign_unit_price || null,
        exchange_rate: line.exchange_rate || null,
        line_note: line.line_note || null,

        memo: line.memo || null
      };
    });

    // 既存明細を消して再作成：MVPではこれが一番安全
    const { error: delPayErr } = await supabase
      .from('payable_lines')
      .delete()
      .eq('invoice_id', invoice_id);

    if (delPayErr) throw delPayErr;

    const { error: delLineErr } = await supabase
      .from('invoice_lines')
      .delete()
      .eq('invoice_id', invoice_id);

    if (delLineErr) throw delLineErr;

    let insertedLines = [];

    if (normalizedLines.length) {
      const { data: lData, error: insLineErr } = await supabase
        .from('invoice_lines')
        .insert(normalizedLines)
        .select('*');

      if (insLineErr) throw insLineErr;
      insertedLines = lData || [];
    }

    const lineNoToId = new Map(
      insertedLines.map(l => [Number(l.line_no), l.invoice_line_id])
    );

    const normalizedPayables = payables.map((p) => {
      const payableTaxType = p.payable_tax_type || 'taxable';
      const payableTaxRate = payableTaxType === 'taxable'
        ? toNumber(p.payable_tax_rate || 0.1)
        : 0;

      const c = calcTax(p.payable_amount_net, payableTaxType, payableTaxRate);

      return {
        invoice_id,
        invoice_line_id:
          p.invoice_line_id ||
          lineNoToId.get(Number(p.line_no)) ||
          null,

        vendor_id: p.vendor_id || null,
        vendor_name: p.vendor_name || null,
        payable_item_name: p.payable_item_name || p.item_name || null,

        payable_amount_net: c.net,
        payable_tax_type: payableTaxType,
        payable_tax_rate: payableTaxRate,
        payable_tax_amount: c.tax,
        payable_amount_gross: c.gross,

        vendor_invoice_no: p.vendor_invoice_no || null,
        payment_date: p.payment_date || null,

        status: p.status || 'planned',
        payment_due_date: p.payment_due_date || null,
        memo: p.memo || null
      };
    });

    let insertedPayables = [];

    if (normalizedPayables.length) {
      const { data: pData, error: insPayErr } = await supabase
        .from('payable_lines')
        .insert(normalizedPayables)
        .select('*');

      if (insPayErr) throw insPayErr;
      insertedPayables = pData || [];
    }

    const salesNetTotal = insertedLines.reduce((sum, l) => sum + toNumber(l.billing_amount_net), 0);
    const salesTaxTotal = insertedLines.reduce((sum, l) => sum + toNumber(l.billing_tax_amount), 0);
    const salesGrossTotal = insertedLines.reduce((sum, l) => sum + toNumber(l.billing_amount_gross), 0);

    const payableNetTotal = insertedPayables.reduce((sum, p) => sum + toNumber(p.payable_amount_net), 0);
    const payableTaxTotal = insertedPayables.reduce((sum, p) => sum + toNumber(p.payable_tax_amount), 0);
    const payableGrossTotal = insertedPayables.reduce((sum, p) => sum + toNumber(p.payable_amount_gross), 0);

    const grossProfitNet = salesNetTotal - payableNetTotal;

    const headerUpdate = {
      ...header,

      sales_net_total: salesNetTotal,
      sales_tax_total: salesTaxTotal,
      sales_gross_total: salesGrossTotal,

      payable_net_total: payableNetTotal,
      payable_tax_total: payableTaxTotal,
      payable_gross_total: payableGrossTotal,

      gross_profit_net: grossProfitNet,
      gross_profit_rate: calcProfitRate(salesNetTotal, grossProfitNet),

      updated_at: new Date().toISOString()
    };

    delete headerUpdate.invoice_id;
    delete headerUpdate.created_at;

    const { data: updatedHeader, error: updErr } = await supabase
      .from('invoice_headers')
      .update(headerUpdate)
      .eq('invoice_id', invoice_id)
      .select('*')
      .single();

    if (updErr) throw updErr;

    res.json({
      ok: true,
      header: updatedHeader,
      lines: insertedLines,
      payables: insertedPayables
    });
  } catch (err) {
    console.error('[invoice/save] error:', err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});
// --- session store (今日はメモリでOK) ---
const sessions = new Map()
const SESSION_TTL_MS = 1000 * 60 * 60 * 16 // 6時間

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
      shipments!inner (
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
    .eq('shipments.customer_code', customerCode)
    .order('job_no', {
      referencedTable: 'shipments',
      ascending: true
    })
    .range(from, to)

  if (error) throw error

  let rows = (data || []).map(mapLineRow)

  rows.sort((a, b) => {
  const getNo = (v) => {
    const s = String(v || '');
    const m = s.match(/(\d{4})IM$/);
    return m ? Number(m[1]) : 0;
  };

  return getNo(a.job_no) - getNo(b.job_no);
});

  const doneStatuses = ['配達済み', 'キャンセル', '完了']
  if (filterMode === 'ACTIVE') {
    rows = rows.filter(r => !doneStatuses.includes(String(r.status || '').trim()))
  } else if (filterMode === 'DELIVERED') {
    rows = rows.filter(r => doneStatuses.includes(String(r.status || '').trim()))
  }

  const rowsWithBicon = await applyBiconFlagsAcrossRows(rows);

  const next_offset = from + size;
  const has_more = (data || []).length === size;
  const total = count || rowsWithBicon.length;

  return {
  rows: rowsWithBicon,
  next_offset,
  has_more,
  total
};
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
      shipments!inner (
        shipment_id,
        suppliers (
          supplier_name
        ),
        job_no,
        status,
        earliest_delivery_date,
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
    .eq('shipments.customer_code', customerCode)
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
      rateCardsRes,
      destsRes
    ] = await Promise.all([
      supabase.from('customers').select('*').order('customer_code'),
      supabase.from('suppliers').select('*').order('supplier_name'),
      supabase.from('partners').select('*').order('partner_name'),
      supabase.from('master_codes').select('*').order('master_type'),
      supabase.from('inbound_place_master').select('*').eq('is_active', true).order('place_name'),
      supabase.from('charge_rate_card').select('*').eq('is_active', true).order('sort_no'),
      supabase.from('dests').select('*').order('customer_code').order('dest_id')
    ]);

    const errors = [
      customersRes.error,
      suppliersRes.error,
      partnersRes.error,
      masterCodesRes.error,
      inboundPlacesRes.error,
      rateCardsRes.error,
      destsRes.error
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
      rate_cards: rateCardsRes.data || [],
      dests: destsRes.data || []
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
    const limit = Number(req.query.limit || 300);

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
        carrier_name,
        vehicle_no,
        driver_name,
        driver_phone,
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
      .order('job_no', { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    
    const rows = data || [];

    rows.sort((a, b) => {
  const getNo = (v) => {
    const s = String(v || '');

    // BL25061898IM → 1898
    const m = s.match(/(\d{4})IM$/);

    return m ? Number(m[1]) : 0;
  };

  return getNo(a.job_no) - getNo(b.job_no);
});

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
    partner_name: p.partner_name || p.partner_code || '',
    partner_type: p.partner_type || ''
  };

  if (p.partner_code) acc[String(p.partner_code).trim()] = rec;
  

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
    const mappedWithBicon = await applyBiconFlagsAcrossRows(mapped);
   
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
        carrier_name,
        driver_name,
        driver_phone,
        cargo_inbound,
        cy_cut,
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
      item_name: shipment.item_name ?? '',
      cargo_inbound: shipment.cargo_inbound || null,
      cy_cut: shipment.cy_cut || null,
      tranship_port: shipment.tranship_port || null,
      tracking_url: shipment.tracking_url || '',
      customer_message: shipment.customer_message || '',
      broker_code: shipment.broker_code || '',
      trucker_code: shipment.trucker_code || '',
      delay_info: shipment.delay_info || '',
      service_type_code: shipment.service_type_code || '',
      carrier_id: shipment.carrier_id || null,
      carrier_name: shipment.carrier_name || null,
      vehicle_no: shipment.vehicle_no || null,
      driver_name: shipment.driver_name || null,
      driver_phone: shipment.driver_phone || null,
      cargo_pickup_location_id: shipment.cargo_pickup_location_id || null,
      earliest_delivery_date: shipment.earliest_delivery_date || null,
      vehicle_type: shipment.vehicle_type || null,

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

      // ★ここから追加：bicon_groups 保存
      const { error: biconDeleteError } = await supabase
        .from('bicon_groups')
        .delete()
        .like('bicon_group_id', `${savedShipmentId}-%`);

      if (biconDeleteError) throw biconDeleteError;

      const biconRows = insertRows
        .filter(c => c.is_bicon && c.bicon_group_no && c.container_no)
        .map(c => ({
          bicon_group_id: `${savedShipmentId}-${c.bicon_group_no}-${c.container_no}`,
          bicon_label: c.bicon_group_no,
          container_no: c.container_no,
          part_of_text: c.bicon_note || null,
          master_pcs: c.pcs || null,
          master_gw: c.gw || null,
          master_cbm: c.cbm || null,
          updated_at: new Date().toISOString()
        }));

      if (biconRows.length > 0) {
        const { error: biconUpsertError } = await supabase
          .from('bicon_groups')
          .upsert(biconRows, { onConflict: 'bicon_group_id' });

        if (biconUpsertError) throw biconUpsertError;
      }
      // ★ここまで追加
    }
  }
}
    const { data: existingLines, error: existingLineError } = await supabase
  .from('shipment_lines')
  .select('line_id')
  .eq('shipment_id', savedShipmentId);

if (existingLineError) throw existingLineError;

const incomingLineIds = new Set(
  lines.map(l => String(l.line_id || '').trim()).filter(Boolean)
);

const deleteLineIds = (existingLines || [])
  .map(r => String(r.line_id || '').trim())
  .filter(id => id && !incomingLineIds.has(id));

if (deleteLineIds.length > 0) {
  const { error: lineDeleteError } = await supabase
    .from('shipment_lines')
    .delete()
    .in('line_id', deleteLineIds);

  if (lineDeleteError) throw lineDeleteError;
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
    app.get('/api/broker/shipments', async (req, res) => {
      try {
        const token = String(req.query.token || '').trim();
        const { data: broker, error: authErr } = await supabase
      .from('partners')
      .select(`
        partner_code,
        partner_name,
        partner_type
      `)
      .eq('portal_token', token)
      .eq('partner_type', 'BROKER')
      .maybeSingle();

    if (authErr) throw authErr;

    if (!broker) {
      return res.status(401).json({
        ok: false,
        error: 'Unauthorized'
      });
    }

    const brokerCode = broker.partner_code;

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
        ? supabase.from('inbound_place_master').select('place_id, place_name').in('place_id', pickupIds)
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

      const containerNos = [];

      for (let i = 1; i <= 10; i++) {
        const no = String(s[`container_no_${i}`] || '').trim();

        if (!no || no === '未定') continue;

        containerNos.push(no);
      }
     const matchedBicons = containerNos
  .map(no => biconByContainerNo[no])
  .filter(Boolean);

const biconGroupIds = [
  ...new Set(
    matchedBicons.map(b => b.bicon_group_id).filter(Boolean)
  )
];

const biconLabels = [
  ...new Set(
    matchedBicons.map(b => b.bicon_label).filter(Boolean)
  )
];

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
        bicon_count: biconGroupIds.length, bicon_label: biconLabels.join(' / '), customs_bicon_notice: biconGroupIds.length > 0 ? '搬入仕分け・個別申告が必要' : '' };
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
    CT05: '40RF'
  };

  return map[value] || value;
}

async function applyBiconFlagsAcrossRows(rows) {
  // ▼ bicon_groups を取得
  const { data: bicons, error } = await supabase
    .from('bicon_groups')
    .select(`
      bicon_group_id,
      bicon_label,
      container_no
    `);

  if (error) {
    console.error('[applyBiconFlagsAcrossRows] bicon load error:', error);
    return rows || [];
  }

  // ▼ container_no → bicon情報Map
  const biconByContainerNo = {};

  (bicons || []).forEach(b => {
    const no = String(b.container_no || '').trim();
    if (!no) return;

    biconByContainerNo[no] = {
      bicon_group_id: b.bicon_group_id || '',
      bicon_label: b.bicon_label || b.bicon_group_id || ''
    };
  });

  // ▼ 各rowへ反映
  return (rows || []).map(r => {
    const matched = [];

    for (let i = 1; i <= 10; i++) {
      const no = String(r[`container_no_${i}`] || '').trim();

      if (!no || no === '未定') continue;

      const hit = biconByContainerNo[no];
      if (!hit) continue;

      matched.push(hit);
    }

    // ▼ group単位でユニーク化
    const uniqGroups = [
      ...new Set(
        matched.map(x => x.bicon_group_id).filter(Boolean)
      )
    ];

    const uniqLabels = [
      ...new Set(
        matched.map(x => x.bicon_label).filter(Boolean)
      )
    ];

    return {
      ...r,

      // ▼ バイコン判定
      is_bicon: uniqGroups.length > 0,

      // ▼ グループ数
      bicon_count: uniqGroups.length,

      // ▼ A1 / B1 表示
      bicon_label: uniqLabels.join(' / '),

      // ▼ 通関表示用
      customs_bicon_notice:
        uniqGroups.length > 0
          ? `バイコン: ${uniqLabels.join(' / ')}`
          : ''
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
    let cleanVessel = String(vessel || '').trim();
    let cleanVoyage = String(voyage || '').trim();

    if (cleanVessel.includes('/')) {
      const parts = cleanVessel.split('/').map(s => s.trim()).filter(Boolean);

      cleanVessel = parts[0] || '';

      if (!cleanVoyage) {
        cleanVoyage = parts[1] || '';
      }
    }

    const chargeList = Array.isArray(charges) ? charges : [];

    console.log('[save-an-snapshot req.body]', {
  shipment_id,
  chargesLength: Array.isArray(charges)
    ? charges.length
    : null,
  charges
});

    // 1) snapshot保存
    const snapshotPayload = {
  shipment_id,
  hbl_no: hbl_no || null,
  mbl_no: mbl_no || null,
  shipper_name: shipper_name || null,
  consignee_name: consignee_name || null,
  notify_name: notify_name || null,
  vessel: cleanVessel || null,
  voyage: cleanVoyage || null,
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
const hasChargesKey = Object.prototype.hasOwnProperty.call(req.body || {}, 'charges');

if (hasChargesKey && chargeList.length > 0) {
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

const itemLines =
  Array.isArray(delivery.lines)
    ? delivery.lines
        .map(l => l.commodity || l.item_name || l.description || '')
        .filter(Boolean)
    : [];

const firstCommodity =
  itemLines.length
    ? itemLines[0]
    : '';

const descriptionText =
  firstCommodity ||
  customs.item_name ||
  (
    Array.isArray(customs.descriptions) && customs.descriptions.length
      ? customs.descriptions[0]
      : ''
  );

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
  item_name: descriptionText,

  descriptions: descriptionText ? [descriptionText] : [],
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
        customs_status,
        broker_code,
        incoterms,
        inbound_no,
        currency,
        declaration_amount,
        invoice_no,
        item_name,
        customs_declared_date,
        default_customs_declared_date,
        customs_data,
        an_url,
        customer_docs
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
    console.log('[save-customs-data] body.pickupDate =', req.body?.pickupDate);
    console.log('[save-customs-data] body =', req.body);
    const shipmentId = String(req.body.shipment_id || '').trim();
    if (!shipmentId) {
      return res.status(400).json({ ok: false, error: 'shipment_id is required' });
    }
    const requestData = req.body.requestData || req.body || {};
    const actionType = req.body.actionType || requestData.actionType || 'draft';
    const pickupDate =
      req.body?.pickupDate ||
      req.body?.customs_data?.pickupDate ||
      '';

    const payload = {
      broker_code: requestData.brokerId || requestData.broker_code || null,
      incoterms: requestData.incoterms || null,
      inbound_no: requestData.inboundNo || requestData.inbound_no || null,
      currency: requestData.currency || null,
      declaration_amount: requestData.declarationAmount || requestData.declaration_amount || null,
      invoice_no: requestData.invoiceNo || requestData.invoice_no || null,
      item_name: requestData.itemName || requestData.item_name || null,
      customs_declared_date: requestData.customsDeclaredDate || requestData.customs_declared_date || null,

      customs_data: JSON.stringify({
        descriptions: Array.isArray(requestData.descriptions) ? requestData.descriptions : [],
        costCover: requestData.costCover || '',
        documents: Array.isArray(requestData.documents) ? requestData.documents : [],
        requests: Array.isArray(requestData.requests) ? requestData.requests : [],
        specialInst: requestData.specialInst || '',
        workScopes: Array.isArray(requestData.workScopes) ? requestData.workScopes : [],
        declaredDate: requestData.customsDeclaredDate || requestData.customs_declared_date || '',
        pickupDate
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

    const baseUrl = 'https://portal.bizlabo-tokyo.com';

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

    let payload;
let html = '';

if (docType === 'delivery') {
  payload = await resolveDeliveryPayload(shipment_id);
  console.log('[delivery payload]', JSON.stringify(payload, null, 2));
  html = buildDeliveryHtmlFromPayload(payload);

} else {
  payload = await resolveShipmentDocs(shipment_id);

  if (docType === 'an') {
    console.log('[AN payload]', JSON.stringify(payload, null, 2));
    html = buildANHtmlFromPayload(payload);

  } else if (docType === 'customs') {
    console.log('[customs payload]', JSON.stringify(payload, null, 2));
    html = buildCustomsHtmlFromPayload(payload);
  }
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
app.get('/doc/:docType/pdf', async (req, res) => {
  let browser;

  try {
    const { docType } = req.params;

    const query = new URLSearchParams(req.query).toString();

    const baseUrl =
      `${req.protocol}://${req.get('host')}`;

    const htmlUrl =
      `${baseUrl}/doc/${docType}?${query}&pdf=1`;

    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();

    await page.goto(htmlUrl, {
      waitUntil: 'networkidle0'
    });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true
    });

    res.setHeader('Content-Type', 'application/pdf');

    res.setHeader(
      'Content-Disposition',
      `inline; filename="${docType}.pdf"`
    );

    return res.send(pdfBuffer);

  } catch (err) {
    console.error('[doc pdf] error:', err);
    return res.status(500).send(err.message);

  } finally {
    if (browser) await browser.close();
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
app.get('/api/portal/calendar', async (req, res) => {
  try {
    const month = String(req.query.month || '').trim(); // 例: 2026-05
    const basis = String(req.query.basis || 'arrival').trim();

    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ ok: false, error: 'month is required. format: YYYY-MM' });
    }
    
    const start = `${month}-01`;
    const endDate = new Date(`${month}-01T00:00:00`);
    endDate.setMonth(endDate.getMonth() + 1);
    const end = endDate.toISOString().slice(0, 10);
    const dateField =
      basis === 'departure' ? 'etd' :
      basis === 'delivery' ? null :
      'eta';

    let query = supabase
  .from('shipments')
  .select(`
    shipment_id,
    job_no,
    status,
    customs_status,
    eta,
    etd,
    pod,
    customer_code,
    broker_code,
    trucker_code,
    container_type_1,
    shipment_lines (
      delivery_fixed,
      delivery_fixed_time,
      delivery_request_date,
      delivery_request_time,
      delivery_dest_short,
      delivery_dest_id,
      dests (
        dest_name
      )
    )
  `)
      if (dateField) {
  query = query
    .gte(dateField, start)
    .lt(dateField, end)
    .order(dateField, { ascending: true });
} else if (basis === 'delivery') {
  query = query.limit(500);
}

const { data, error } = await query;

if (error) throw error;

const days = {};

(data || []).forEach(s => {
  const lines = Array.isArray(s.shipment_lines) ? s.shipment_lines : [];

  lines.forEach(line => {
    const date =
      basis === 'delivery'
        ? String(line.delivery_fixed || '').replace(/\//g, '-').slice(0, 10)
        : basis === 'departure'
          ? String(s.etd || '').replace(/\//g, '-').slice(0, 10)
          : String(s.eta || '').replace(/\//g, '-').slice(0, 10);

    if (!date) return;
    if (date < start || date >= end) return;

    if (!days[date]) {
      days[date] = { shipments: [] };
    }

    const extractCore = (code) => {
      if (!code) return '';
      return String(code).split('-')[0];
    };

    const brokerCore = extractCore(s.broker_code);
    const truckerCore = extractCore(s.trucker_code);
    const isSamePartner = brokerCore && brokerCore === truckerCore;

    days[date].shipments.push({
      shipment_id: s.shipment_id,
      job_no: s.job_no,
      status: s.status,
      customs_status: s.customs_status,
      delivery_fixed: line.delivery_fixed || '',
      delivery_fixed_time: line.delivery_fixed_time || '',
      delivery_request_date: line.delivery_request_date || '',
      delivery_request_time: line.delivery_request_time || '',

      // ▼ カレンダー用
      delivery_time:
        basis === 'delivery'
          ? (line.delivery_fixed_time || '')
          : '',
      delivery_area: line.dests?.dest_name ||
        line.delivery_dest_short ||
        line.delivery_dest_id ||
        '',
      pickup_port: s.pod || '',

      customer_name: s.customer_code || '',
      container_type: s.container_type_1 || '',

      is_broker_and_trucker: isSamePartner
    });
  });
});

    return res.json({
      ok: true,
      month,
      basis,
      days
    });
  } catch (err) {
    console.error('[portal calendar] error:', err);
    return res.status(500).json({
      ok: false,
      error: err.message || String(err)
    });
  }
});
app.post('/api/trucker/login', async (req, res) => {
  try {
    const { token } = req.body || {};

    if (!token) {
      return res.status(400).json({ ok: false, error: 'token is required' });
    }

    const { data, error } = await supabase
      .from('partners')
      .select('partner_code, partner_name, partner_type, portal_token')
      .eq('portal_token', token)
      .eq('partner_type', 'TRUCKER')
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(401).json({
        ok: false,
        error: 'Invalid trucker token'
      });
    }

    return res.json({
      ok: true,
      trucker: {
        token,
        partner_code: data.partner_code,
        partner_name: data.partner_name
      }
    });
  } catch (err) {
    console.error('[trucker login] error:', err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});
app.get('/api/trucker/calendar', async (req, res) => {
  try {
    const token = String(req.query.token || '').trim();
    const month = String(req.query.month || '').trim();

    if (!token) return res.status(400).json({ ok: false, error: 'token is required' });
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ ok: false, error: 'month is required. format: YYYY-MM' });
    }

    const { data: trucker, error: authErr } = await supabase
      .from('partners')
      .select('partner_code, partner_name, partner_type')
      .eq('portal_token', token)
      .eq('partner_type', 'TRUCKER')
      .maybeSingle();

    if (authErr) throw authErr;
    if (!trucker) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const start = `${month}-01`;
    const endDate = new Date(`${month}-01T00:00:00`);
    endDate.setMonth(endDate.getMonth() + 1);
    const end = endDate.toISOString().slice(0, 10);

    const { data, error } = await supabase
      .from('shipments')
      .select(`
        shipment_id,
        job_no,
        status,
        customs_status,
        eta,
        etd,
        pod,
        customer_code,
        broker_code,
        trucker_code,
        container_type_1,
        shipment_lines (
          delivery_fixed,
          delivery_fixed_time,
          delivery_request_date,
          delivery_request_time,
          delivery_dest_short,
          delivery_dest_id,
          dests (
            dest_name
          )
        )
      `)
      .eq('trucker_code', trucker.partner_code)
      .gte('eta', start)
      .lt('eta', end)
      .order('eta', { ascending: true });

    if (error) throw error;

    const days = {};
    
    // ▼ ここに追加（forEachの上）
function normalizeDateKey(value) {
  if (!value) return '';

  const s = String(value).trim();

  // 2026-04-08 / 2026/04/08
  const m1 = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m1) {
    return `${m1[1]}-${String(m1[2]).padStart(2, '0')}-${String(m1[3]).padStart(2, '0')}`;
  }

  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  return '';
}
const { data: slots, error: slotErr } = await supabase
  .from('truck_slots')
  .select('*')
  .eq('trucker_code', trucker.partner_code)
  .gte('target_date', start)
  .lt('target_date', end);

if (slotErr) throw slotErr;

    (data || []).forEach(s => {
      const lines = Array.isArray(s.shipment_lines) && s.shipment_lines.length
        ? s.shipment_lines
        : [{}];

      lines.forEach(line => {
        const rawDate =
          line.delivery_fixed ||
          line.delivery_request_date ||
          s.eta ||
          s.etd;
      
      const date = normalizeDateKey(rawDate);

        if (!date || date < start || date >= end) return;

        if (!rawDate) return;
        
        if (!days[date]) days[date] = { shipments: [] };

        days[date].shipments.push({
          shipment_id: s.shipment_id,
          job_no: s.job_no,
          status: s.status,
          customs_status: s.customs_status,
          delivery_time: line.delivery_fixed_time || line.delivery_request_time || '',
          delivery_area: line.dests?.dest_name ||
            line.delivery_dest_short ||
            line.delivery_dest_id ||
            '',
          pickup_port: s.pod || '',
          vehicle_type: '',
          customer_name: s.customer_code || '',
          container_type: s.container_type_1 || ''
        });
      });
    });
    (slots || []).forEach(slot => {
  const date = String(slot.target_date).slice(0, 10);

  if (!days[date]) {
    days[date] = { shipments: [] };
  }

  const cap20 = Number(slot.cap_20ft || 0);
  const cap40 = Number(slot.cap_40ft || 0);
  const capAny = Number(slot.cap_any || 0);

  days[date] = {
    ...days[date],
    capacity: cap20 + cap40 + capAny,
    cap_20ft: cap20,
    cap_40ft: cap40,
    cap_any: capAny,
    is_public: slot.is_public === true,
    slot_id: slot.slot_id || null,
    assigned_count: days[date].shipments.length
  };
});

    return res.json({
      ok: true,
      month,
      trucker_name: trucker.partner_name,
      days
    });
  } catch (err) {
    console.error('[trucker calendar] error:', err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});
app.get('/api/trucker/detail', async (req, res) => {
  try {
    const token = String(req.query.token || '').trim();
    const shipmentId = String(req.query.shipment_id || '').trim();

    if (!token) return res.status(400).json({ ok: false, error: 'token is required' });
    if (!shipmentId) return res.status(400).json({ ok: false, error: 'shipment_id is required' });

    const { data: trucker, error: authErr } = await supabase
      .from('partners')
      .select('partner_code, partner_name, partner_type')
      .eq('portal_token', token)
      .eq('partner_type', 'TRUCKER')
      .maybeSingle();

    if (authErr) throw authErr;
    if (!trucker) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const { data: shipment, error } = await supabase
      .from('shipments')
      .select(`
        *,
        shipment_lines (*)
      `)
      .eq('shipment_id', shipmentId)
      .maybeSingle();

    if (error) throw error;
    if (!shipment) return res.status(404).json({ ok: false, error: 'Shipment not found' });

    if (String(shipment.trucker_code || '') !== String(trucker.partner_code || '')) {
      return res.status(403).json({ ok: false, error: 'Access denied' });
    }
    const line0 = Array.isArray(shipment.shipment_lines) && shipment.shipment_lines.length
  ? shipment.shipment_lines[0]
  : {};

let resolvedDestName = line0.delivery_dest_short || line0.delivery_dest_id || '';
let resolvedDestAddress = line0.delivery_address_text || '';

if (line0.delivery_dest_id) {
  const { data: dest } = await supabase
    .from('dests')
    .select('dest_name, d_address1, d_address2')
    .eq('dest_id', line0.delivery_dest_id)
    .maybeSingle();

  if (dest) {
    resolvedDestName = dest.dest_name || resolvedDestName;
    resolvedDestAddress = [dest.d_address1, dest.d_address2].filter(Boolean).join(' ') || resolvedDestAddress;
  }
}

shipment.resolved_dest_name = resolvedDestName;
shipment.resolved_dest_address = resolvedDestAddress;

    return res.json({
      ok: true,
      shipment,
      lines: shipment.shipment_lines || []
    });
  } catch (err) {
    console.error('[trucker detail] error:', err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});
app.post('/api/trucker/slots/save', async (req, res) => {
  try {
    const {
      token,
      target_date,
      cap_20ft = 0,
      cap_40ft = 0,
      cap_any = 0,
      is_public = false,
      note = ''
    } = req.body || {};

    if (!token) return res.status(400).json({ ok: false, error: 'token is required' });
    if (!target_date) return res.status(400).json({ ok: false, error: 'target_date is required' });

    const { data: trucker, error: authErr } = await supabase
      .from('partners')
      .select('partner_code, partner_name, partner_type')
      .eq('portal_token', token)
      .eq('partner_type', 'TRUCKER')
      .maybeSingle();

    if (authErr) throw authErr;
    if (!trucker) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const slotId = `${trucker.partner_code}_${target_date}`;

    const payload = {
      slot_id: slotId,
      trucker_code: trucker.partner_code,
      target_date,
      cap_20ft: Number(cap_20ft || 0),
      cap_40ft: Number(cap_40ft || 0),
      cap_any: Number(cap_any || 0),
      is_public: !!is_public,
      note,
      updated_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('truck_slots')
      .upsert(payload, { onConflict: 'trucker_code,target_date' })
      .select()
      .single();

    if (error) throw error;

    return res.json({ ok: true, slot: data });
  } catch (err) {
    console.error('[trucker slots save] error:', err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});
app.get('/api/trucker/canceled', async (req, res) => {
  try {
    const token = String(req.query.token || '').trim();

    if (!token) {
      return res.status(400).json({ ok: false, error: 'token is required' });
    }

    const { data: trucker, error: authErr } = await supabase
      .from('partners')
      .select('partner_code, partner_name, partner_type')
      .eq('portal_token', token)
      .eq('partner_type', 'TRUCKER')
      .maybeSingle();

    if (authErr) throw authErr;
    if (!trucker) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const { data, error } = await supabase
      .from('shipments')
      .select(`
        shipment_id,
        job_no,
        delivery_status,
        canceled_at,
        pod,
        trucker_code,
        container_type_1,
        shipment_lines (
          delivery_dest_short,
          delivery_fixed,
          delivery_fixed_time,
          delivery_request_date,
          delivery_request_time
        )
      `)
      .eq('trucker_code', trucker.partner_code)
      .eq('delivery_status', 'CANCELED')
      .order('canceled_at', { ascending: false });

    if (error) throw error;

    const canceled_list = (data || []).map(s => {
      const line0 = Array.isArray(s.shipment_lines) && s.shipment_lines.length
        ? s.shipment_lines[0]
        : {};

      return {
        shipment_id: s.shipment_id,
        job_no: s.job_no,
        delivery_status: s.delivery_status,
        canceled_at: s.canceled_at,
        container_type: s.container_type_1 || '',
        resolved_pickup_name: s.pod || '',
        resolved_dest_name: line0.delivery_dest_short || '',
        delivery_time: line0.delivery_fixed_time || line0.delivery_request_time || ''
      };
    });

    return res.json({
      ok: true,
      canceled_list
    });
  } catch (err) {
    console.error('[trucker canceled] error:', err);
    return res.status(500).json({
      ok: false,
      error: err.message || String(err)
    });
  }
});
app.post('/api/broker/login', async (req, res) => {
  try {
    const { token } = req.body || {};

    if (!token) {
      return res.status(400).json({ ok: false, error: 'token is required' });
    }

    const { data, error } = await supabase
      .from('partners')
      .select('partner_code, partner_name, partner_type, portal_token')
      .eq('portal_token', token)
      .eq('partner_type', 'BROKER')
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(401).json({
        ok: false,
        error: 'Invalid broker token'
      });
    }

    return res.json({
      ok: true,
      broker: {
        token,
        partner_code: data.partner_code,
        partner_name: data.partner_name
      }
    });
  } catch (err) {
    console.error('[broker login] error:', err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});
app.get('/api/broker/calendar', async (req, res) => {
  try {
    const token = String(req.query.token || '').trim();
    const month = String(req.query.month || '').trim();

    if (!token) return res.status(400).json({ ok: false, error: 'token is required' });
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ ok: false, error: 'month is required. format: YYYY-MM' });
    }

    const { data: broker, error: authErr } = await supabase
      .from('partners')
      .select('partner_code, partner_name, partner_type')
      .eq('portal_token', token)
      .eq('partner_type', 'BROKER')
      .maybeSingle();

    if (authErr) throw authErr;
    if (!broker) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const start = `${month}-01`;
    const endDate = new Date(`${month}-01T00:00:00`);
    endDate.setMonth(endDate.getMonth() + 1);
    const end = endDate.toISOString().slice(0, 10);

    const { data, error } = await supabase
      .from('shipments')
      .select(`
        shipment_id,
        job_no,
        status,
        customs_status,
        eta,
        etd,
        pod,
        customer_code,
        broker_code,
        trucker_code,
        container_type_1,
        shipment_lines (
          delivery_fixed,
          delivery_fixed_time,
          delivery_request_date,
          delivery_request_time,
          delivery_dest_short,
          delivery_dest_id,
          dests (
            dest_name
          )
        )
      `)
      .eq('broker_code', broker.partner_code)
      .gte('eta', start)
      .lt('eta', end)
      .order('eta', { ascending: true });

    if (error) throw error;

    const days = {};
    
    // ▼ ここに追加（forEachの上）
function normalizeDateKey(value) {
  if (!value) return '';

  const s = String(value).trim();

  // 2026-04-08 / 2026/04/08
  const m1 = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m1) {
    return `${m1[1]}-${String(m1[2]).padStart(2, '0')}-${String(m1[3]).padStart(2, '0')}`;
  }

  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  return '';
}
    (data || []).forEach(s => {
      const lines = Array.isArray(s.shipment_lines) && s.shipment_lines.length
        ? s.shipment_lines
        : [{}];

      lines.forEach(line => {
        const rawDate =
          line.delivery_fixed ||
          line.delivery_request_date ||
          s.eta ||
          s.etd;
      
      const date = normalizeDateKey(rawDate);

        if (!date || date < start || date >= end) return;

        if (!rawDate) return;
        
        if (!days[date]) days[date] = { shipments: [] };

        days[date].shipments.push({
          shipment_id: s.shipment_id,
          job_no: s.job_no,
          status: s.status,
          customs_status: s.customs_status,
          delivery_time: line.delivery_fixed_time || line.delivery_request_time || '',
          delivery_area: line.dests?.dest_name ||
            line.delivery_dest_short ||
            line.delivery_dest_id ||
            '',
          pickup_port: s.pod || '',
          vehicle_type: '',
          customer_name: s.customer_code || '',
          container_type: s.container_type_1 || ''
        });
      });
    });

    return res.json({
      ok: true,
      month,
      broker_name: broker.partner_name,
      days
    });
  } catch (err) {
    console.error('[broker calendar] error:', err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});
app.get('/api/broker/detail', async (req, res) => {
  try {
    const token = String(req.query.token || '').trim();
    const shipmentId = String(req.query.shipment_id || '').trim();

    if (!token) {
      return res.status(400).json({ ok: false, error: 'token is required' });
    }

    if (!shipmentId) {
      return res.status(400).json({ ok: false, error: 'shipment_id is required' });
    }

    const { data: broker, error: authErr } = await supabase
      .from('partners')
      .select('partner_code, partner_name, partner_type')
      .eq('portal_token', token)
      .eq('partner_type', 'BROKER')
      .maybeSingle();

    if (authErr) throw authErr;
    if (!broker) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const { data: shipment, error } = await supabase
      .from('shipments')
      .select(`
        *,
        shipment_lines (*)
      `)
      .eq('shipment_id', shipmentId)
      .maybeSingle();

    if (error) throw error;
    if (!shipment) {
      return res.status(404).json({ ok: false, error: 'Shipment not found' });
    }

    if (String(shipment.broker_code || '') !== String(broker.partner_code || '')) {
      return res.status(403).json({ ok: false, error: 'Access denied' });
    }

    return res.json({
      ok: true,
      broker_name: broker.partner_name,
      shipment,
      lines: shipment.shipment_lines || []
    });
  } catch (err) {
    console.error('[broker detail] error:', err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});
app.post('/api/admin/customs/request', async (req, res) => {
  try {
    const { requestData, actionType = 'preview' } = req.body || {};

    if (!requestData?.shipmentId) {
      return res.status(400).json({
        success: false,
        message: 'shipmentId is required'
      });
    }

    const shipmentId = requestData.shipmentId;

    const customsJsonData = {
      descriptions: requestData.descriptions || [],
      costCover: requestData.costCover || '',
      documents: requestData.documents || [],
      requests: requestData.requests || [],
      specialInst: requestData.specialInst || '',
      workScopes: requestData.workScopes || [],
      customsDeclaredDate: requestData.customsDeclaredDate || '',
      declaredDate: requestData.customsDeclaredDate || '',
      pickupDate: requestData.pickupDate || '',
      invoiceNo: requestData.invoiceNo || '',
      itemName: requestData.itemName || '',
      declarationAmount: requestData.declarationAmount || '',
      inboundNo: requestData.inboundNo || '',
      currency: requestData.currency || '',
      incoterms: requestData.incoterms || '',
      brokerCode: requestData.brokerId || '',
      line0: requestData.line0 || {}
    };

    const updatePayload = {
      broker_code: requestData.brokerId || null,
      customs_status: actionType === 'submit' ? 'DOCS_CHECK' : undefined,
      customs_data: JSON.stringify(customsJsonData),
      inbound_no: requestData.inboundNo || null,
      customs_request_url: requestData.customsUrl || null,
      an_url: requestData.anUrl || null,
      updated_at: new Date().toISOString()
    };

    Object.keys(updatePayload).forEach(k => {
      if (updatePayload[k] === undefined) delete updatePayload[k];
    });

    const { data: shipment, error } = await supabase
      .from('shipments')
      .update(updatePayload)
      .eq('shipment_id', shipmentId)
      .select('*')
      .maybeSingle();

    if (error) throw error;

    if (!shipment) {
      return res.status(404).json({
        success: false,
        message: 'Shipment not found'
      });
    }

    if (actionType === 'draft') {
      return res.json({
        success: true,
        mode: 'draft',
        message: '一時保存が完了しました。'
      });
    }

    if (actionType === 'preview') {
      return res.json({
        success: true,
        mode: 'html_preview',
        message: '通関依頼書HTMLプレビュー用データを保存しました。'
      });
    }

    const { data: broker } = await supabase
      .from('partners')
      .select('partner_code, partner_name, email, contact_email')
      .eq('partner_code', requestData.brokerId)
      .maybeSingle();

    const { data: customer } = await supabase
      .from('customers')
      .select('customer_code, customer_name')
      .eq('customer_code', shipment.customer_code)
      .maybeSingle();

    return res.json({
      success: true,
      mode: 'submit_prepare_drive',
      message: 'DB保存が完了しました。Drive保存処理へ進みます。',
      anUrl: requestData.anUrl || shipment.an_url || '',
      customsUrl: requestData.customsUrl || shipment.customs_request_url || '',
      drivePayload: {
        shipmentId,
        jobNo: requestData.jobNo || shipment.job_no || shipmentId,
        brokerCode: requestData.brokerId || shipment.broker_code || '',
        brokerName: broker?.partner_name || '通関業者',
        brokerEmail: broker?.email || broker?.contact_email || '',
        customerName: customer?.customer_name || shipment.customer_code || '',
        customerCode: shipment.customer_code || '',
        anUrl: requestData.anUrl || shipment.an_url || '',
        customsUrl: requestData.customsUrl || shipment.customs_request_url || '',
        files: requestData.files || []
      }
    });

  } catch (err) {
    console.error('[admin customs request] error:', err);
    return res.status(500).json({
      success: false,
      message: err.message || String(err)
    });
  }
});
app.post('/api/admin/customs/drive-result', async (req, res) => {
  try {
    const { shipment_id, driveResult } = req.body || {};

    if (!shipment_id) {
      return res.status(400).json({
        ok: false,
        error: 'shipment_id is required'
      });
    }

    if (!driveResult || driveResult.ok === false || driveResult.success === false) {
      return res.status(400).json({
        ok: false,
        error: driveResult?.message || driveResult?.error || 'Drive package failed'
      });
    }

    const updatePayload = {
      customs_document_zip_url: driveResult.zipUrl || null,
      customs_document_folder_url: driveResult.folderUrl || null,
      customs_saved_file_urls: driveResult.savedFileUrls || {},
      customs_mail_sent: driveResult.mailSent === true,
      customs_mail_error: driveResult.mailError || null,
      updated_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('shipments')
      .update(updatePayload)
      .eq('shipment_id', shipment_id)
      .select('shipment_id, customs_document_zip_url, customs_document_folder_url')
      .maybeSingle();

    if (error) throw error;

    return res.json({
      ok: true,
      shipment: data
    });

  } catch (err) {
    console.error('[admin customs drive-result] error:', err);
    return res.status(500).json({
      ok: false,
      error: err.message || String(err)
    });
  }
});
app.post('/api/customer/upload-docs', async (req, res) => {
  try {
    const { shipment_id, files } = req.body || {};

    if (!shipment_id) throw new Error('shipment_id is required');
    if (!Array.isArray(files) || files.length === 0) {
      throw new Error('files is required');
    }

    const { data: shipment, error: sErr } = await supabase
      .from('shipments')
      .select('shipment_id, job_no, customer_docs')
      .eq('shipment_id', shipment_id)
      .single();

    if (sErr) throw sErr;
    if (!shipment) throw new Error('shipment not found');

    let existingDocs = {};

    if (typeof shipment.customer_docs === 'string') {
      try {
        existingDocs = JSON.parse(shipment.customer_docs || '{}');
      } catch {
        existingDocs = {};
      }
    } else if (shipment.customer_docs && typeof shipment.customer_docs === 'object') {
      existingDocs = shipment.customer_docs;
    }

    const savedDocs = {};

    for (const f of files) {
      const type = f.type;
      const url = f.url;

      if (!type || !url) continue;

      savedDocs[type] = url;
    }

    const mergedDocs = {
      ...existingDocs,
      ...savedDocs
    };

    const { error: uErr } = await supabase
      .from('shipments')
      .update({
        customer_docs: JSON.stringify(mergedDocs)
      })
      .eq('shipment_id', shipment_id);

    if (uErr) throw uErr;

    return res.json({
      ok: true,
      customer_docs: mergedDocs
    });

  } catch (err) {
    console.error('[customer upload-docs] error:', err);
    return res.status(500).json({
      ok: false,
      error: err.message || String(err)
    });
  }
});

app.get('/api/customer/docs-by-line', async (req, res) => {
  try {
    const lineId = req.query.line_id;
    if (!lineId) throw new Error('line_id is required');

    const { data: line, error: lErr } = await supabase
      .from('shipment_lines')
      .select('shipment_id')
      .eq('line_id', lineId)
      .single();

    if (lErr) throw lErr;
    if (!line?.shipment_id) throw new Error('shipment_id not found');

    const { data: shipment, error: sErr } = await supabase
      .from('shipments')
      .select('customer_docs')
      .eq('shipment_id', line.shipment_id)
      .single();

    if (sErr) throw sErr;

    return res.json({
      ok: true,
      customer_docs: shipment?.customer_docs || {}
    });

  } catch (err) {
    console.error('[docs-by-line] error:', err);
    return res.status(500).json({
      ok: false,
      error: err.message || String(err)
    });
  }
});
app.post('/api/admin/delivery/request', async (req, res) => {
  try {
    const { requestData, actionType = 'draft' } = req.body || {};

    if (!requestData?.shipmentId) {
      return res.status(400).json({
        success: false,
        message: 'shipmentId is required'
      });
    }

    const shipmentId = requestData.shipmentId;

    const deliveryJsonData = {
      truckerId: requestData.truckerId || '',
      remarks: Array.isArray(requestData.remarks) ? requestData.remarks : [],
      files: Array.isArray(requestData.files) ? requestData.files.map(f => ({
        type: f.type,
        name: f.name,
        mimeType: f.mimeType
      })) : [],
      actionType,
      savedAt: new Date().toISOString()
    };

    const updatePayload = {
      trucker_code: requestData.truckerId || null,
      delivery_data: JSON.stringify(deliveryJsonData),
      updated_at: new Date().toISOString()
    };

    if (actionType === 'submit') {
      updatePayload.status = 'DELIVERY_REQUESTED';
    }

    const { data: shipment, error } = await supabase
      .from('shipments')
      .update(updatePayload)
      .eq('shipment_id', shipmentId)
      .select('*')
      .maybeSingle();

    if (error) throw error;

    if (!shipment) {
      return res.status(404).json({
        success: false,
        message: 'Shipment not found'
      });
    }

    return res.json({
      success: true,
      mode: actionType,
      message: '配送依頼データを保存しました。'
    });

  } catch (err) {
    console.error('[admin delivery request] error:', err);
    return res.status(500).json({
      success: false,
      message: err.message || String(err)
    });
  }
});

app.get('/api/admin/dashboard-data', async (req, res) => {
  try {
    const { data: rows, error } = await supabase
      .from('shipments')
      .select('shipment_id,status,vessel,voyage,pol,pod,etd,eta');

    if (error) throw error;

    const statusCounts = {};
    const groups = {};

    (rows || []).forEach(s => {
      const st = s.status || 'Unknown';
      statusCounts[st] = (statusCounts[st] || 0) + 1;

      if (s.status === '配達済み' || s.status === 'キャンセル') return;

      const key = [
        s.vessel || '',
        s.voyage || '',
        s.pol || '',
        s.pod || ''
      ].join('||');

      if (!groups[key]) {
        groups[key] = {
          vessel: s.vessel || '',
          voyage: s.voyage || '',
          pol: s.pol || '',
          pod: s.pod || '',
          etd: s.etd || '',
          eta: s.eta || '',
          count: 0,
          ids: []
        };
      }

      groups[key].count++;
      groups[key].ids.push(s.shipment_id);
    });

    const vesselGroups = Object.values(groups).sort((a, b) =>
      String(a.eta || '9999').localeCompare(String(b.eta || '9999'))
    );

    return res.json({
      ok: true,
      statusCounts,
      vesselGroups
    });

    
  } catch (err) {
    console.error('[dashboard-data] error:', err);
    return res.status(500).json({
      ok: false,
      error: err.message || String(err)
    });
  }
});
app.get('/api/invoice/unbilled-shipments', async (req, res) => {
  try {

    // 請求済 shipment_id取得
    const { data: invoices, error: invErr } = await supabase
      .from('invoice_headers')
      .select('shipment_id')
      .neq('status', 'cancelled');

    if (invErr) throw invErr;

    const billedShipmentIds = (invoices || [])
      .map(r => r.shipment_id)
      .filter(Boolean);

    const billingMonth =
  String(req.query.billing_month || '').trim();

const customerCode =
  String(req.query.customer_code || '').trim();

let shipmentQuery = supabase
  .from('shipments')
  .select('*')
  .order('created_at', { ascending: false });

if (billingMonth) {
  shipmentQuery = shipmentQuery.eq(
    'planned_billing_month',
    billingMonth
  );
}

if (customerCode) {
  shipmentQuery = shipmentQuery.eq(
    'customer_code',
    customerCode
  );
}

if (billedShipmentIds.length > 0) {
  shipmentQuery = shipmentQuery.not(
    'shipment_id',
    'in',
    `(${billedShipmentIds.join(',')})`
  );
}

    const { data: shipments, error: shipErr } = await shipmentQuery;

    if (shipErr) throw shipErr;

    const rows = (shipments || []).map(s => ({
      shipment_id: s.shipment_id,
      job_no: s.job_no || null,
      customer_id: s.customer_id || null,
      customer_name:
        s.customer_name ||
        s.client_name ||
        null,

      eta:
        s.eta ||
        s.eta_date ||
        null,

      billing_month:
        s.billing_month ||
        s.planned_billing_month ||
        null,

      status: 'unbilled'
    }));

    res.json({
      ok: true,
      rows
    });

  } catch (err) {
    console.error('[invoice/unbilled-shipments] error:', err);

    res.status(500).json({
      ok: false,
      error: err.message || String(err)
    });
  }
});
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`)
})