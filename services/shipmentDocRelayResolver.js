// server/services/shipmentDocRelayResolver.js

import { supabase } from '../lib/supabase.js';
import { getMasterLabel, getMasterLabels } from './masterCodeService.js';

export async function resolveShipmentDocs(shipmentId) {
  const shipment = await fetchShipmentBase(shipmentId);
if (!shipment) throw new Error(`shipment not found: ${shipmentId}`);

const anContainers = await fetchAnContainers(shipmentId);
const containers = anContainers;

const customer = await fetchCustomer(shipment.customer_code);
const supplier = await fetchSupplier(shipment.supplier_id);


  const anSnapshot = await fetchAnSnapshot(shipmentId);
  const shipmentLines = await fetchShipmentLines(shipmentId);
  const shipmentCharges = await fetchShipmentCharges(shipmentId);
  const customsData = normalizeCustomsData(shipment.customs_data);

  const broker = await fetchPartner(shipment.broker_code || customsData.broker_code, 'broker');
  const trucker = await fetchPartner(shipment.trucker_code, 'TRUCKER');
  const pickupPlace = await fetchInboundPlace(shipment.cargo_pickup_location_id || shipment.inbound_place_id);
  const delivery = await buildDeliveryInfo(shipmentLines);
  const labels = await buildLabels({
  shipment,
  customsData,
  anContainers
});

  const mappedAnContainers = mapAnContainers(anContainers);
  const anTotals = calcAnTotals(anSnapshot, mappedAnContainers, shipmentLines);

  return {
  shipment: buildShipmentBlock(shipment),
  labels,

  party: {
    customer,
    supplier,
    broker,
    trucker
  },
  logistics: {
    pickup_place: pickupPlace,
    delivery
  },
  an: {
  snapshot: mapAnSnapshot(anSnapshot),
  containers: mappedAnContainers,
  totals: anTotals,
  charges: mapShipmentCharges(shipmentCharges)
},
customs: {
  ...(customsData || {}),
  containers: mappedAnContainers
},
containers: mappedAnContainers,
delivery,
};
}

// 1) fetchShipmentBase を単独取得に変更
async function fetchShipmentBase(shipmentId) {
  const { data, error } = await supabase
    .from('shipments')
    .select('*')
    .eq('shipment_id', shipmentId)
    .single();

  if (error) throw error;
  return data;
}

// 2) 追加
async function fetchCustomer(customerCode) {
  if (!customerCode) return null;

  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .eq('customer_code', customerCode)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function fetchSupplier(supplierId) {
  if (!supplierId) return null;

  const { data, error } = await supabase
    .from('suppliers')
    .select('*')
    .eq('supplier_id', supplierId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function fetchAnSnapshot(shipmentId) {
  const { data, error } = await supabase
    .from('shipment_an_snapshot')
    .select('*')
    .eq('shipment_id', shipmentId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function fetchAnContainers(shipmentId) {
  const { data, error } = await supabase
    .from('shipment_containers')
    .select('*')
    .eq('shipment_id', shipmentId)
    .order('sort_no', { ascending: true });

  if (error) throw error;
  return data || [];
}

async function fetchShipmentLines(shipmentId) {
  const { data, error } = await supabase
    .from('shipment_lines')
    .select('*')
    .eq('shipment_id', shipmentId)
    .order('line_id', { ascending: true });

  if (error) throw error;
  return data || [];
}

async function fetchPartner(partnerCode, partnerType) {
  const code = String(partnerCode || '').trim();
  const type = String(partnerType || '').trim().toUpperCase();

  if (!code) return null;

  const { data, error } = await supabase
    .from('partners')
    .select('*')
    .eq('partner_code', code)
    .eq('partner_type', type)
    .maybeSingle();

  if (error) {
    console.warn('[fetchPartner] error:', error);
    return null;
  }

  return data;
}

async function fetchInboundPlace(placeId) {
  if (!placeId) return null;

  const { data, error } = await supabase
    .from('inbound_place_master')
    .select('*')
    .eq('place_id', placeId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

function normalizeCustomsData(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

function buildShipmentBlock(shipment) {
  return {
    shipment_id: shipment.shipment_id,
    job_no: shipment.job_no,
    customer_code: shipment.customer_code,
    status: shipment.status,
    etd: shipment.etd,
    eta: shipment.eta,
    vessel: shipment.vessel,
    voyage: shipment.voyage,
    booking_no: shipment.booking_no,
    bl_no: shipment.bl_no,
    house_bl_no: shipment.house_bl_no,
    mbl_no: shipment.bl_no,
    hbl_no: shipment.house_bl_no,
    carrier_id: shipment.carrier_id || '',
    carrier_name: shipment.carrier_name || '',
    pol: shipment.pol,
    pod: shipment.pod,
    incoterms: shipment.incoterms,
    inbound_no: shipment.inbound_no,
    cargo_pickup_location_id: shipment.cargo_pickup_location_id || null,
    invoice_no: shipment.invoice_no || '',
    item_name: shipment.item_name || '',
    declaration_amount: shipment.declaration_amount || '',
    currency: shipment.currency || '',
    tranship_port: shipment.tranship_port || '',
  };
}


function mapAnSnapshot(row) {
  if (!row) return null;
  return {
    shipment_id: row.shipment_id,
    shipper_name: row.shipper_name,
    shipper_address_1: row.shipper_address_1,
    shipper_address_2: row.shipper_address_2,
    consignee_name: row.consignee_name,
    consignee_address_1: row.consignee_address_1,
    consignee_address_2: row.consignee_address_2,
    notify_name: row.notify_name,
    notify_address_1: row.notify_address_1,
    notify_address_2: row.notify_address_2,
    hbl_no: row.hbl_no,
    mbl_no: row.mbl_no,
    inbound_no: row.inbound_no,
    case_mark: row.case_mark || '',
    body_description: row.body_description || '',
    container_lines_json: row.container_lines_json || []
  };
}

function mapAnContainers(rows) {
  return rows.map(r => ({
    container_no: r.container_no,
    container_type: r.container_type,
    seal_no: r.seal_no,

    pcs: r.pcs ?? r.qty ?? r.pkgs ?? null,
    pkg_unit: r.pkg_unit || '',

    gw_kg: r.gw_kg ?? r.gw ?? null,
    cbm: r.cbm ?? null,

    marks: r.marks,
    description: r.description
  }));
}

function calcAnTotals(snapshot, containers, shipmentLines) {
  const pkgTotal = calcPkgTotalFromContainers(containers);
  const totalGw = sumNum(containers, 'gw_kg');
  const totalCbm = sumNum(containers, 'cbm');

  return {
    pkgs: pkgTotal.pkgs,
    pkg_unit: pkgTotal.pkg_unit,
    gw_kg: totalGw,
    cbm: totalCbm,
    line_count: shipmentLines.length
  };
}

async function buildDeliveryInfo(lines) {
  const first =
  lines.find(l =>
    l.delivery_dest_id ||
    l.delivery_dest_short ||
    l.delivery_request_date ||
    l.delivery_fixed
  ) ||
  lines[0] ||
  {};
  const destId = first.delivery_dest_id || first.delivery_dest_short || '';

  const dest = await fetchDeliveryDest(destId);

  return {
    delivery_dest_id: first.delivery_dest_id || null,
    delivery_dest_short: first.delivery_dest_short || null,

    delivery_address1:
  dest?.d_address1 ||
  first.delivery_address_text ||
  null,

delivery_address2:
  dest?.d_address2 ||
  null,

delivery_tel:
  dest?.d_tel ||
  null,

delivery_contact:
  dest?.d_contact_person ||
  null,

delivery_dest_name:
  dest?.dest_name ||
  first.delivery_dest_short ||
  null,

    delivery_request_date: first.delivery_request_date || null,
    delivery_request_time: first.delivery_request_time || null,
    delivery_fixed: first.delivery_fixed || null,
    delivery_fixed_time: first.delivery_fixed_time || null,
    delivery_plan_date: first.delivery_plan_date || null,
    delivery_plan_time: first.delivery_plan_time || null,
    remarks: first.remarks || null,
    actual_trucker_name: first.actual_trucker_name || null,
    vehicle_type: first.vehicle_type || null,
    delivery_plan_date: first.delivery_plan_date || null,
    delivery_plan_time: first.delivery_plan_time || null,

    lines: lines.map(l => ({
      line_id: l.line_id,
      pt: l.pt,
      no: l.no,
      commodity: l.commodity,
      commodity_note: l.commodity_note,
      delivery_dest_id: l.delivery_dest_id,
      delivery_dest_short: l.delivery_dest_short,
      customer_ref_no: l.customer_ref_no
    }))
  };
}

function mapCustomsData(cd) {
  return {
    broker_code: cd.broker_code || null,
    incoterms: cd.incoterms || null,
    currency: cd.currency || null,
    declaration_amount: cd.declaration_amount || null,
    invoice_no: cd.invoice_no || null,
    item_name: cd.item_name || null,
    descriptions: Array.isArray(cd.descriptions) ? cd.descriptions : [],
    documents: Array.isArray(cd.documents) ? cd.documents : [],
    cost_cover: Array.isArray(cd.cost_cover) ? cd.cost_cover : [],
    requests: Array.isArray(cd.requests) ? cd.requests : [],
    work_scopes: Array.isArray(cd.workScopes) ? cd.workScopes : [],
    special_instructions: cd.specialInst || '',
    declared_date: cd.declared_date || null,
    pickup_date: cd.pickup_date || null,
    request_date: cd.request_date || null,
    instruction_date: cd.instruction_date || null,
    broker_person: cd.broker_person || null,
    from_block: cd.from_block || '',
    greeting: cd.greeting || '',
    vehicle_type: cd.vehicle_type || ''
  };
}

async function buildLabels({ shipment, customsData, anContainers }) {
  const incotermsCode = customsData.incoterms || shipment.incoterms || '';
  const currencyCode = customsData.currency || shipment.currency || '';
  const carrierCode = shipment.carrier_id || shipment.carrier_code || '';

  const documentCodes = Array.isArray(customsData.documents)
    ? customsData.documents
    : [];

  const requestCodes = Array.isArray(customsData.requests)
    ? customsData.requests
    : [];

  const costCoverCodes = customsData.costCover
    ? [customsData.costCover]
    : Array.isArray(customsData.cost_cover)
      ? customsData.cost_cover
      : [];

  return {
    incoterms_label: await getMasterLabel('INCOTERMS', incotermsCode),
    currency_label: await getMasterLabel('CURRENCY', currencyCode),
    carrier_label: await getMasterLabel('CARRIER', shipment.carrier_id),

    documents_labels: await getMasterLabels('CUSTOMS_DOX', documentCodes),
    requests_labels: await getMasterLabels('REQUEST_BROKER', requestCodes),
    cost_cover_labels: await getMasterLabels('COST_COVER', costCoverCodes),
    container_type_labels: await Promise.all(
      (anContainers || []).map(async v => ({
        code: v.container_type,
        label: await getMasterLabel('CONTAINER_TYPE', v.container_type)
      }))
    )
  };
}
function normalizePkgUnit(unit) {
  const u = String(unit || '').toUpperCase().trim();

  if (['PLT', 'PLTS', 'PALLET', 'PALLETS'].includes(u)) return 'PALLETS';
  if (['CTN', 'CTNS', 'CARTON', 'CARTONS'].includes(u)) return 'CARTONS';
  if (['PKG', 'PKGS', 'PACKAGE', 'PACKAGES'].includes(u)) return 'PACKAGES';
  if (['PC', 'PCS'].includes(u)) return 'PCS';

  return u || 'PACKAGES';
}

function calcPkgTotalFromContainers(containers = []) {
  let totalQty = 0;
  const units = new Set();

  containers.forEach(c => {
    const pcs = String(c.pcs ?? c.qty ?? c.pkgs ?? '').trim();
    const unitRaw = String(c.pkg_unit || '').trim();
    if (!pcs) return;

    const m = pcs.match(/^([\d.]+)\s*([A-Za-z]+)?$/);

    if (m) {
      totalQty += Number(m[1]) || 0;
      units.add(normalizePkgUnit(m[2] || unitRaw));
      return;
    }

    const n = Number(pcs);
    if (!Number.isNaN(n)) {
      totalQty += n;
      units.add(normalizePkgUnit(unitRaw));
    }
  });

  return {
    pkgs: totalQty || '',
    pkg_unit: totalQty ? (units.size === 1 ? [...units][0] : 'PACKAGES') : ''
  };
}
function sumNum(rows, key) {
  return rows.reduce((s, r) => s + (Number(r?.[key]) || 0), 0);
}
async function fetchDeliveryDest(destId) {
  const id = String(destId || '').trim();
  if (!id) return null;

  const { data, error } = await supabase
    .from('dests')
    .select('*')
    .eq('dest_id', id)
    .maybeSingle();

  if (error) {
    console.warn('[fetchDeliveryDest] error:', error);
    return null;
  }

  return data;
}
async function fetchShipmentCharges(shipmentId) {
  const id = String(shipmentId || '').trim();
  if (!id) return [];

  const { data, error } = await supabase
    .from('shipment_charges')
    .select('*')
    .eq('shipment_id', id)
    .order('created_at', { ascending: true });

  if (error) {
    console.warn('[fetchShipmentCharges] error:', error);
    return [];
  }

  return data || [];
}
function mapShipmentCharges(rows = []) {
  return rows.map(r => ({
    item: r.charge_name || r.item || '',
    tax: r.tax_category || r.tax || '',
    unit: r.unit || '',
    qty: r.qty ?? '',
    unit_price: r.rate ?? r.unit_price ?? '',
    currency: r.currency || '',
    ex_rate: r.fx_rate ?? r.ex_rate ?? r.exchange_rate ?? '',
    amount: r.amount ?? '',
    note: r.note || ''
  }));
}