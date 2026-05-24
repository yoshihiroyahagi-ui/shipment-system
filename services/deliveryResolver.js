import { supabase } from '../lib/supabase.js';

export async function resolveDeliveryPayload(shipmentId) {
  if (!shipmentId) {
    throw new Error('shipment_id is required');
  }

  const { data: shipment, error: shipmentErr } = await supabase
    .from('shipments')
    .select('*')
    .eq('shipment_id', shipmentId)
    .single();

  if (shipmentErr) throw shipmentErr;
  if (!shipment) throw new Error(`shipment not found: ${shipmentId}`);

  const { data: lines, error: linesErr } = await supabase
    .from('shipment_lines')
    .select(`
      *,
      dests:delivery_dest_id (
        dest_id,
        dest_name,
        d_address1,
        d_address2,
        d_contact_person,
        d_tel,
        remark
        )
    `)
    .eq('shipment_id', shipmentId)
    .order('line_id', { ascending: true });

  if (linesErr) throw linesErr;

  const { data: containers, error: containersErr } = await supabase
    .from('shipment_containers')
    .select('*')
    .eq('shipment_id', shipmentId)
    .order('sort_no', { ascending: true });

  if (containersErr) throw containersErr;

  const { data: masterCodes, error: masterErr } = await supabase
  .from('master_codes')
  .select('master_type, code, label');

if (masterErr) throw masterErr;

const masterMap = {};
(masterCodes || []).forEach(m => {
  const cat = String(m.master_type || '').toUpperCase();
  const code = String(m.code || '');
  if (!masterMap[cat]) masterMap[cat] = {};
  masterMap[cat][code] = m.label || code;
});

const carrierLabel =
  masterMap.CARRIER?.[shipment.carrier_id] ||
  shipment.carrier_id ||
  '';

const normalizedContainers = (containers || []).map(c => ({
  ...c,
  container_type_label:
    masterMap.CONTAINER_TYPE?.[c.container_type] ||
    c.container_type ||
    ''
}));

  let trucker = null;

  if (shipment.trucker_code) {
    const { data: t, error: truckerErr } = await supabase
      .from('partners')
      .select('*')
      .eq('partner_code', shipment.trucker_code)
      .maybeSingle();

    if (truckerErr) throw truckerErr;
    trucker = t;
  }

  const normalizedLines = (lines || []).map((line) => {
    const d = line.dests || {};

    return {
      ...line,

      delivery_dest_name:
        d.dest_name ||
        line.delivery_dest_name ||
        '',

    address_official:
        d.d_address1 ||
  line.address_official ||
  '',

delivery_address1:
  d.d_address1 ||
  line.delivery_address1 ||
  '',

delivery_address2:
  d.d_address2 ||
  line.delivery_address2 ||
  '',

delivery_tel:
  d.d_tel ||
  line.delivery_tel ||
  '',

delivery_contact:
  d.d_contact_person ||
  line.delivery_contact ||
  ''
    };
  });

  const decodeNewlines = (v) =>
  String(v ?? '').replace(/\\n/g, '\n');

const displayLines = normalizedLines.map(line => ({
  ...line,
  delivery_address1: decodeNewlines(line.delivery_address1),
  delivery_address2: decodeNewlines(line.delivery_address2),
  address_official: decodeNewlines(line.address_official),
  commodity_display: [
    line.commodity,
    line.commodity_note
  ].filter(Boolean).join('\n')
}));

let customs = {};

try {
  if (typeof shipment.customs_data === 'string') {
    customs = shipment.customs_data ? JSON.parse(shipment.customs_data) : {};
  } else if (shipment.customs_data && typeof shipment.customs_data === 'object') {
    customs = shipment.customs_data;
  }
} catch (e) {
  console.warn('[deliveryResolver] customs_data parse failed:', e);
  customs = {};
}

let customer = null;

if (shipment.customer_code) {
  const { data: c, error: customerErr } = await supabase
    .from('customers')
    .select('customer_code, customer_name')
    .eq('customer_code', shipment.customer_code)
    .maybeSingle();

  if (customerErr) throw customerErr;
  customer = c;
}

let pickupPlace = '';

if (shipment.cargo_pickup_location_id) {
  const { data: pickupPlaceData, error: pickupErr } = await supabase
    .from('inbound_place_master')
    .select(`
      place_name,
      line1,
      line2,
      line3,
      line4
    `)
    .eq('place_id', shipment.cargo_pickup_location_id)
    .maybeSingle();

  if (pickupErr) throw pickupErr;

  if (pickupPlaceData) {
    pickupPlace = [
      pickupPlaceData.place_name,
      pickupPlaceData.line1,
      pickupPlaceData.line2,
      pickupPlaceData.line3,
      pickupPlaceData.line4
    ]
      .filter(Boolean)
      .join('\n');
  }
}

  return {
  shipment: {
    ...shipment,
    carrier_label: carrierLabel
  },
  labels: {
    carrier_label: carrierLabel
  },
  customs,
  customer: customer || {},
  customer_name: customer?.customer_name || shipment.customer_code || '',
  lines: displayLines,
  containers: normalizedContainers,
  trucker: trucker || {},
  pickup_place: pickupPlace,
  request_date: new Date().toISOString().slice(0, 10)
};
}