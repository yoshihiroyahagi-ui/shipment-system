import { supabase } from '../lib/supabase.js';

export async function resolveAdvancedDeliveryPayload(
  shipmentId,
  transportRequestId
) {
  if (!shipmentId) {
    throw new Error('shipment_id is required');
  }

  if (!transportRequestId) {
    throw new Error('transport_request_id is required');
  }

  // =====================================================
  // Shipment
  // =====================================================
  const { data: shipment, error: shipmentErr } = await supabase
    .from('shipments')
    .select('*')
    .eq('shipment_id', shipmentId)
    .single();

  if (shipmentErr) throw shipmentErr;

  if (!shipment) {
    throw new Error(`shipment not found: ${shipmentId}`);
  }

  // =====================================================
  // Transport Request
  // =====================================================
  const { data: transportRequest, error: requestErr } = await supabase
    .from('transport_requests')
    .select('*')
    .eq('transport_request_id', transportRequestId)
    .eq('shipment_id', shipmentId)
    .single();

  if (requestErr) throw requestErr;

  if (!transportRequest) {
    throw new Error(
      `transport request not found: ${transportRequestId}`
    );
  }

  // =====================================================
  // Transport Tasks
  // =====================================================
  const { data: tasks, error: taskErr } = await supabase
    .from('transport_tasks')
    .select('*')
    .eq('transport_request_id', transportRequestId)
    .eq('shipment_id', shipmentId)
    .order('sort_no', { ascending: true });

  if (taskErr) throw taskErr;

  const transportTasks = tasks || [];

  // =====================================================
  // 対象Container / Delivery Lineを抽出
  // cargo_refs 優先、旧 cargo_type / cargo_ref もfallback
  // =====================================================
  const containerNos = new Set();
  const lineIds = new Set();

  transportTasks.forEach(task => {
    const refs =
      Array.isArray(task.cargo_refs) &&
      task.cargo_refs.length > 0
        ? task.cargo_refs
        : (
            task.cargo_type && task.cargo_ref
              ? [{
                  type: task.cargo_type,
                  id: task.cargo_ref
                }]
              : []
          );

    refs.forEach(ref => {
      const type =
        String(ref?.type || '')
          .trim()
          .toUpperCase();

      const id =
        String(ref?.id || '')
          .trim();

      if (!id) return;

      if (type === 'CONTAINER') {
        containerNos.add(id);
      }

      if (type === 'DELIVERY') {
        lineIds.add(id);
      }
    });
  });

  // =====================================================
  // shipment_containers
  // =====================================================
  let containers = [];

  if (containerNos.size > 0) {
    const { data: containerRows, error: containerErr } =
      await supabase
        .from('shipment_containers')
        .select('*')
        .eq('shipment_id', shipmentId)
        .in('container_no', [...containerNos])
        .order('sort_no', { ascending: true });

    if (containerErr) throw containerErr;

    containers = containerRows || [];
  }

  // =====================================================
// Shipment Items / 品名
// 新案件：shipment_items
// 旧案件：shipment_lines をフォールバック
// =====================================================
const { data: itemRows, error: itemErr } = await supabase
  .from('shipment_items')
  .select(`
    shipment_id,
    commodity
  `)
  .eq('shipment_id', shipmentId);

if (itemErr) throw itemErr;

let shipmentCommodities = [
  ...new Set(
    (itemRows || [])
      .map(item =>
        String(item.commodity || '').trim()
      )
      .filter(Boolean)
  )
];

// shipment_items がない旧案件は shipment_lines から取得
if (shipmentCommodities.length === 0) {
  shipmentCommodities = [
    ...new Set(
      (normalizedLines || [])
        .map(line =>
          String(line.commodity || '').trim()
        )
        .filter(Boolean)
    )
  ];
}
  // =====================================================
  // shipment_lines
  // =====================================================
  let lines = [];

  if (lineIds.size > 0) {
    const { data: lineRows, error: lineErr } =
      await supabase
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
        .in('line_id', [...lineIds])
        .order('line_id', { ascending: true });

    if (lineErr) throw lineErr;

    lines = lineRows || [];
  }

  // =====================================================
  // Master Codes
  // =====================================================
  const { data: masterCodes, error: masterErr } = await supabase
    .from('master_codes')
    .select('master_type, code, label');

  if (masterErr) throw masterErr;

  const masterMap = {};

  (masterCodes || []).forEach(m => {
    const cat =
      String(m.master_type || '')
        .toUpperCase();

    const code =
      String(m.code || '');

    if (!masterMap[cat]) {
      masterMap[cat] = {};
    }

    masterMap[cat][code] =
      m.label || code;
  });

  const carrierLabel =
    masterMap.CARRIER?.[shipment.carrier_id] ||
    shipment.carrier_id ||
    '';

  // =====================================================
  // Containers Normalize
  // =====================================================
  const normalizedContainers =
    (containers || []).map(c => ({
      ...c,

      container_type_label:
        masterMap.CONTAINER_TYPE?.[c.container_type] ||
        c.container_type ||
        ''
    }));


  // =====================================================
  // Lines Normalize
  // =====================================================
  const decodeNewlines = (v) =>
    String(v ?? '').replace(/\\n/g, '\n');

  const normalizedLines =
    (lines || []).map(line => {
      const d =
        line.dests || {};

      return {
        ...line,

        delivery_dest_name:
          d.dest_name ||
          line.delivery_dest_name ||
          line.delivery_dest_short ||
          '',

        address_official:
          decodeNewlines(
            d.d_address1 ||
            line.address_official ||
            ''
          ),

        delivery_address1:
          decodeNewlines(
            d.d_address1 ||
            line.delivery_address1 ||
            ''
          ),

        delivery_address2:
          decodeNewlines(
            d.d_address2 ||
            line.delivery_address2 ||
            ''
          ),

        delivery_tel:
          d.d_tel ||
          line.delivery_tel ||
          '',

        delivery_contact:
          d.d_contact_person ||
          line.delivery_contact ||
          '',

        commodity_display:
          [
            line.commodity,
            line.commodity_note
          ]
            .filter(Boolean)
            .join('\n')
      };
    });

  // =====================================================
  // Trucker
  // Taskごとに異なる可能性があるためmap化
  // =====================================================
  const truckerCodes = [
    ...new Set(
      transportTasks
        .map(task =>
          String(task.trucker_code || '').trim()
        )
        .filter(Boolean)
    )
  ];

  let truckerMap = {};

  if (truckerCodes.length > 0) {
    const { data: partnerRows, error: partnerErr } =
      await supabase
        .from('partners')
        .select('*')
        .in('partner_code', truckerCodes);

    if (partnerErr) throw partnerErr;

    truckerMap = (partnerRows || []).reduce(
      (acc, partner) => {
        acc[
          String(partner.partner_code || '').trim()
        ] = partner;

        return acc;
      },
      {}
    );
  }

  // =====================================================
  // Request代表Trucker
  // 現Renderer互換用
  // =====================================================
  const firstTruckerCode =
    String(
      transportTasks.find(t => t.trucker_code)?.trucker_code ||
      ''
    ).trim();

  const trucker =
    truckerMap[firstTruckerCode] || {};

  // =====================================================
  // Pickup Place
  // 最初のTaskを代表値としてRenderer互換にする
  // =====================================================
  const firstTask =
    transportTasks[0] || {};

  let pickupPlace = '';

  if (firstTask.pickup_place_name) {
    pickupPlace = [
      firstTask.pickup_place_name,
      firstTask.pickup_address
    ]
      .filter(Boolean)
      .join('\n');

  } else if (firstTask.pickup_place_id) {

    const { data: pickupPlaceData, error: pickupErr } =
      await supabase
        .from('inbound_place_master')
        .select(`
          place_name,
          line1,
          line2,
          line3,
          line4
        `)
        .eq('place_id', firstTask.pickup_place_id)
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

  // =====================================================
  // Customer
  // =====================================================
  let customer = null;

  if (shipment.customer_code) {
    const { data: customerRow, error: customerErr } =
      await supabase
        .from('customers')
        .select(`
          customer_code,
          customer_name
        `)
        .eq(
          'customer_code',
          shipment.customer_code
        )
        .maybeSingle();

    if (customerErr) throw customerErr;

    customer = customerRow;
  }

  // =====================================================
  // customs_data
  // =====================================================
  let customs = {};

  try {
    if (typeof shipment.customs_data === 'string') {
      customs =
        shipment.customs_data
          ? JSON.parse(shipment.customs_data)
          : {};

    } else if (
      shipment.customs_data &&
      typeof shipment.customs_data === 'object'
    ) {
      customs = shipment.customs_data;
    }

  } catch (e) {
    console.warn(
      '[advancedDeliveryResolver] customs_data parse failed:',
      e
    );

    customs = {};
  }

  // =====================================================
// Advanced配送ではTaskの引取日を搬出希望日として優先
// =====================================================
if (firstTask.pickup_date) {
  customs.pickupDate =
    firstTask.pickup_date;
}

  // =====================================================
  // delivery_data
  // =====================================================
  let delivery = {};

  try {
    if (typeof shipment.delivery_data === 'string') {
      delivery =
        shipment.delivery_data
          ? JSON.parse(shipment.delivery_data)
          : {};

    } else if (
      shipment.delivery_data &&
      typeof shipment.delivery_data === 'object'
    ) {
      delivery = shipment.delivery_data;
    }

  } catch (e) {
    console.warn(
      '[advancedDeliveryResolver] delivery_data parse failed:',
      e
    );

    delivery = {};
  }

  // =====================================================
  // Task Normalize
  // Renderer拡張時にも使えるよう保持
  // =====================================================
  const normalizedTasks =
    transportTasks.map(task => {

      const code =
        String(task.trucker_code || '').trim();

      return {
        ...task,

        trucker:
          truckerMap[code] || {},

        pickup_display:
          [
            task.pickup_place_name,
            task.pickup_address
          ]
            .filter(Boolean)
            .join('\n'),

        delivery_display:
          [
            task.delivery_place_name,
            task.delivery_address
          ]
            .filter(Boolean)
            .join('\n')
      };
    });

    // =====================================================
// Advanced Task → deliveryRenderer用 lines
// =====================================================
const advancedLines =
  normalizedTasks.map(task => {

    const cargoRefs =
      Array.isArray(task.cargo_refs)
        ? task.cargo_refs
        : [];

    const containerNos =
      cargoRefs
        .filter(ref =>
          String(ref?.type || '').toUpperCase() === 'CONTAINER'
        )
        .map(ref =>
          String(ref?.id || '').trim()
        )
        .filter(Boolean);

    return {
      line_id:
        task.transport_task_id,

      // 配送日時
      delivery_fixed:
        task.delivery_date || null,

      delivery_fixed_time:
        task.delivery_time || null,

      // 配送先
      delivery_dest_name:
        task.delivery_place_name || '',

      delivery_address1:
        task.delivery_address || '',

      delivery_address2:
        '',

      // 車両
      vehicle_type:
        task.vehicle_type || '',

      carrier_name:
        task.trucker?.partner_name || '',

      // 備考
      delivery_note:
        task.remarks || '',

      remarks:
        task.remarks || '',

      // 品名欄
      commodity:
        shipmentCommodities.join('\n'),

      commodity_note:
  [
    task.quantity && task.unit
      ? `数量: ${task.quantity} ${task.unit}`
      : '',
    task.remarks || ''
  ]
    .filter(Boolean)
    .join('\n')
    };
  });

  const advancedContainers =
  normalizedContainers.map(container => {

    const containerNo =
      String(container.container_no || '');

    const task =
      normalizedTasks.find(task =>
        Array.isArray(task.cargo_refs) &&
        task.cargo_refs.some(ref =>
          String(ref?.type || '').toUpperCase() === 'CONTAINER' &&
          String(ref?.id || '') === containerNo
        )
      );

    if (!task) {
      return container;
    }

    return {
      ...container,

      pcs:
        task.quantity ??
        container.pcs,

      pkg_unit:
        task.unit ||
        container.pkg_unit,

      gw:
        task.cargo_weight_kg ??
        container.gw,

      cbm:
        task.cargo_cbm ??
        container.cbm
    };
  });

  // =====================================================
  // Return
  // 既存 deliveryRenderer と互換になる形を維持
  // =====================================================
  return {
    shipment: {
      ...shipment,
      carrier_label: carrierLabel
    },

    labels: {
      carrier_label: carrierLabel
    },

    customs,

    customer:
      customer || {},

    customer_name:
      customer?.customer_name ||
      shipment.customer_code ||
      '',

    lines:
  advancedLines.length > 0
    ? advancedLines
    : normalizedLines,

    containers:
  advancedContainers,

    trucker,

    pickup_place:
      pickupPlace,

    delivery,

    request_date:
      new Date()
        .toISOString()
        .slice(0, 10),

    transport_request:
      transportRequest,

    transport_tasks:
      normalizedTasks
  };
}