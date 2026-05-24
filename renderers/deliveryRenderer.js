export function buildDeliveryHtmlFromPayload(data = {}) {
  const esc = (v) => String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const fmtDate = (v) => {
  if (!v) return '';

  const s = String(v).trim();
  if (!s) return '';

  // 2026-05-21 / 2026/05/21 どちらも対応
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) {
    return `${m[1]}/${m[2].padStart(2, '0')}/${m[3].padStart(2, '0')}`;
  }

  return s;
};
  const s = data.shipment || {};
  const lines = data.lines || [];
  const normalizedLines = [];

for (const line of (lines || [])) {

  const hasDest =
    line.delivery_dest_id ||
    line.delivery_dest_name ||
    line.dest_name;

  // 配送先なし = 前行へマージ
  if (!hasDest && normalizedLines.length > 0) {

    const prev = normalizedLines[normalizedLines.length - 1];

    [
      line.commodity,
      line.commodity_note
    ]
      .filter(Boolean)
      .forEach(v => {

        const existing = [
          prev.commodity,
          prev.commodity_note
        ]
          .filter(Boolean)
          .join('\n');

        const merged = [existing, v]
          .filter(Boolean)
          .join('\n');

        prev.commodity_note = merged;
      });

    continue;
  }

  normalizedLines.push({
    ...line
  });
}
  const allCommodities = [];

(normalizedLines || []).forEach(line => {
  [
    line.commodity,
    line.commodity_note
  ]
    .filter(Boolean)
    .forEach(v => {
      String(v)
        .split(/\r?\n|、|,/)
        .map(s => s.trim())
        .filter(Boolean)
        .forEach(name => {
          if (!allCommodities.includes(name)) {
            allCommodities.push(name);
          }
        });
    });
});
  const normalizeKey = (v) =>
  String(v ?? '')
    .replace(/\\n/g, '\n')
    .replace(/\s+/g, '')
    .trim();

const groupedMap = new Map();

for (const line of normalizedLines) {
  const key = [
  line.delivery_dest_id || '',
  line.delivery_dest_name || line.dest_name || ''
].map(normalizeKey).join('|');

  if (!groupedMap.has(key)) {
    groupedMap.set(key, {
      ...line,
      commodities: []
    });
  }

  const addCommodity = (g, line) => {
  const values = [
    line.commodity,
    line.commodity_note
  ].filter(Boolean);

  values.forEach(v => {
    String(v)
      .split(/\r?\n|、|,/)
      .map(s => s.trim())
      .filter(Boolean)
      .forEach(name => {
        if (!g.commodities.includes(name)) {
          g.commodities.push(name);
        }
      });
  });
};

const g = groupedMap.get(key);

addCommodity(g, line);
};


const groupedLines = Array.from(groupedMap.values());
  const containers = data.containers || [];
  const trucker = data.trucker || {};
  const carrierName =
  data.labels?.carrier_label ||
  s.carrier_label ||
  s.carrier_id ||
  '';
  const customs = data.customs || data.customs_data || {};
  const labelOf = (v) => {
  if (!v) return '';
  if (typeof v === 'object') {
    return v.label || v.name || v.value || v.code || '';
  }
  return String(v);
};

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>配送依頼書</title>
<style>
  body {
    margin: 0;
    background: #eee;
    font-family: Arial, "Yu Gothic", "Meiryo", sans-serif;
    color: #222;
    font-size: 12px;
  }

  .screen-toolbar {
    position: fixed;
    top: 8px;
    right: 12px;
    z-index: 9999;
  }

  .pdf-btn {
    font-size: 13px;
    padding: 6px 12px;
    border: 1px solid #999;
    border-radius: 4px;
    background: #fff;
    color: #333;
    cursor: pointer;
  }

  .page {
    width: 210mm;
    min-height: 297mm;
    margin: 12px auto;
    padding: 10mm;
    background: #fff;
    box-sizing: border-box;
  }

  .title {
    text-align: center;
    font-size: 22px;
    font-weight: bold;
    letter-spacing: 4px;
    margin-bottom: 12px;
  }

  .grid {
    display: grid;
    grid-template-columns: 32mm 1fr 32mm 1fr;
    border-top: 1px solid #333;
    border-left: 1px solid #333;
  }

  .label, .value {
    border-right: 1px solid #333;
    border-bottom: 1px solid #333;
    padding: 5px 6px;
    min-height: 22px;
  }

  .label {
    background: #f1f1f1;
    font-weight: bold;
  }

  .section {
    margin-top: 10px;
  }

  .section-head {
    background: #333;
    color: #fff;
    padding: 5px 8px;
    font-weight: bold;
  }

  table {
    width: 100%;
    border-collapse: collapse;
  }

  th, td {
    border: 1px solid #333;
    padding: 5px 6px;
    vertical-align: top;
  }

  th {
    background: #f1f1f1;
  }

  .small {
    font-size: 11px;
    white-space: pre-line;
  }

  .note-box {
    border: 1px solid #333;
    padding: 8px;
    min-height: 45px;
    white-space: pre-wrap;
  }

  @media print {
    .screen-toolbar,
    .no-print {
      display: none !important;
    }

    body {
      background: #fff;
      margin: 0;
    }

    .page {
      width: 210mm !important;
      min-height: auto !important;
      height: auto !important;
      margin: 0 !important;
      padding: 5mm !important;
      box-shadow: none !important;
      border: none !important;
    }

    * {
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    @page {
      size: A4;
      margin: 0;
    }
    
    .vendor-to {
      font-size: 28px;
      font-weight: 800;
      margin: 10px 0 16px;
      letter-spacing: .03em;
    }

    .pickup-table {
  width: 100%;
  border-collapse: collapse;
}

.pickup-table th,
.pickup-table td {
  border: 1px solid #333;
  padding: 5px 6px;
  vertical-align: top;
}

.pickup-table th {
  background: #f1f1f1;
  font-weight: bold;
}
  }
</style>
</head>

<body>
<div class="screen-toolbar no-print">
  <button class="pdf-btn" onclick="window.open(location.pathname + '/pdf' + location.search, '_blank')">
    PDFを開く
  </button>
</div>

<section class="page">
  <div class="title">配送依頼書</div>
  <div class="vendor-to" style="font-size:18px !important;font-weight:800 !important;margin:12px 0 16px !important;">
  ${esc(trucker.partner_name || trucker.name || '')} 御中
</div>
  
  <div class="grid">
    <div class="label">JOB NO</div>
    <div class="value">${esc(s.job_no || s.shipment_id)}</div>
    <div class="label">依頼日</div>
    <div class="value">${esc(data.request_date || '')}</div>

    <div class="label">顧客名</div>
    <div class="value">${esc(s.customer_name || data.customer_name || s.customer_code || '')}</div>

    <div class="label">本船 / VOY</div>
    <div class="value">${esc([s.vessel, s.voyage].filter(Boolean).join(' / '))}</div>
    <div class="label">船社</div>
    <div class="value">${esc(carrierName)}</div>
    <div class="label">搬入確認番号</div>
    <div class="value">${esc(s.inbound_no || '')}</div>
    <div class="label">B/L NO</div>
    <div class="value">${esc(s.bl_no || s.master_bl_no || '')}</div>
    <div class="label">ETA</div>
    <div class="value">${esc(s.eta || '')}</div>
  </div>

  <div class="section">
  <div class="section-head">引取情報</div>
  <table class="pickup-table">
    <tr>
      <th style="width:28mm;">引取場所</th>
      <td class="small">${esc(data.pickup_place || s.cargo_pickup_location_id || '')}</td>
      <th style="width:36mm;">搬出希望日 / 車種</th>
      <td class="small">${esc([
        customs.pickupDate ? `搬出希望日：${fmtDate(customs.pickupDate)}` : '',
        s.vehicle_type ? `車種：${s.vehicle_type}` : ''
      ].filter(Boolean).join('\n'))}</td>
    </tr>
  </table>
</div>

  <div class="section">
    <div class="section-head">配送先情報</div>
    <table>
      <thead>
        <tr>
          <th style="width:22mm;">希望日</th>
          <th style="width:18mm;">時間</th>
          <th>配送先 / 住所 / TEL / 担当</th>
          <th style="width:42mm;">品名・備考</th>
        </tr>
      </thead>
      <tbody>
        ${groupedLines.map(line => `
  <tr>
    <td>${esc(line.delivery_request_date || line.delivery_plan_date || '')}</td>
    <td>${esc(line.delivery_request_time || line.delivery_plan_time || '')}</td>
    <td class="small">${esc([
      line.delivery_dest_name || line.dest_name || '',
      line.delivery_address1 || line.address_official || '',
      line.delivery_address2 || '',
      line.delivery_tel ? 'TEL: ' + line.delivery_tel : '',
      line.delivery_contact ? '担当: ' + line.delivery_contact : ''
    ].filter(Boolean).join('\n'))}</td>
    <td class="small">${esc(allCommodities.join('\n'))}</td>
  </tr>
`).join('')}
      </tbody>
    </table>
  </div>

  ${containers.length ? `
  <div class="section">
  <div class="section-head">コンテナ情報</div>
  <table>
    <thead>
      <tr>
        <th>Container No</th>
        <th style="width:28mm;">Type</th>
        <th>Seal No</th>
      </tr>
    </thead>
    <tbody>
      ${containers.map(c => `
        <tr>
          <td>${esc(c.container_no || '')}</td>
          <td>${esc(c.container_type_label || c.container_type || '')}</td>
          <td>${esc(c.seal_no || '')}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>
</div>
  ` : ''}
  <div class="section">
  <div class="section-head">貨物情報</div>
  <table>
    <thead>
      <tr>
        <th>PCS</th>
        <th>G.W.</th>
        <th>M3</th>
      </tr>
    </thead>
    <tbody>
      ${containers.map(c => `
        <tr>
          <td>${esc([c.pcs, c.pkg_unit].filter(Boolean).join(' '))}</td>
          <td>${esc(c.gw ? `${c.gw} KG` : '')}</td>
          <td>${esc(c.cbm ? `${c.cbm} M3` : '')}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>
</div>
  <div class="section">
    <div class="section-head">備考・注意事項</div>
    <div class="note-box">${esc(s.delivery_note || s.customer_comment || s.remarks || '')}</div>
  </div>

  <div class="section small">
    株式会社ビジネスラボ / operation@bizlabo-tokyo.co.jp
  </div>
</section>
</body>
</html>`;
}