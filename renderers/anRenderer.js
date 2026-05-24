export function buildANHtmlFromPayload(payload = {}) {
  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const fmtMoney = (v) => {
    const n = Number(v || 0);
    if (!Number.isFinite(n)) return '0';
    return Math.round(n).toLocaleString('ja-JP');
  };

  const shipment = payload.shipment || {};
  const party = payload.party || {};
  const customer = party.customer || {};
  const supplier = party.supplier || {};
  const logistics = payload.logistics || {};
  const pickup = logistics.pickup_place || {};
  const an = payload.an || {};
  const snapshot = an.snapshot || {};
  const containers = Array.isArray(an.containers) ? an.containers : [];
  const totals = an.totals || {};
  const labels = payload.labels || {};
  const carrierName =
  labels?.carrier_label ||
  shipment.carrier_id ||
  '';

  const charges = Array.isArray(an.charges)
    ? an.charges
    : Array.isArray(payload.charges)
      ? payload.charges
      : [];

  const consigneeFullBlock = [
    customer.customer_name_e || snapshot.consignee_name || customer.customer_name || '',
    customer.address1_e || '',
    customer.address2_e || ''
  ].filter(Boolean).join('\n');

  const sendToName =
    customer.customer_name ||
    snapshot.consignee_name ||
    '';

  const shipperBlock = [
    supplier.supplier_name || snapshot.shipper_name || '',
    supplier.supplier_add_1 || '',
    supplier.supplier_add_2 || ''
  ].filter(Boolean).join('\n');

  const notifyBlock =
    snapshot.notify_name ||
    'Same as Consignee';

  const locationBlock = [
    pickup.place_name || '',
    pickup.line1 || '',
    pickup.line2 || '',
    pickup.line3 || '',
    pickup.line4 || ''
  ].filter(Boolean).join('\n');
  
  const getContainerTypeLabel = (code) => {
  const hit = (labels.container_type_labels || []).find(x =>
    String(x.code || '').trim() === String(code || '').trim()
  );

  return hit?.label || code || '';
};
const displayContainerType = (v) => {
  const s = String(v || '').trim().toUpperCase();

  const map = {
    CT01: '20GP',
    CT02: '40GP',
    CT03: '40HQ',
    CT04: '20RF',
    CT05: '40RF'
  };

  return map[s] || s;
};
  const containerLines = containers.map(c => {
    const parts = [];
    if (c.container_no) parts.push(c.container_no);
    if (c.container_type) {parts.push(displayContainerType(c.container_type));}
    if (c.seal_no) parts.push(c.seal_no);
    const pcsVal = c.pcs ?? c.qty ?? c.pkgs ?? '';
const unitVal = c.pkg_unit ?? c.qty_unit ?? '';

if (pcsVal || unitVal) {
  parts.push(`${pcsVal || ''}${unitVal ? ' ' + unitVal : ''}`);
}
    if (c.gw_kg) parts.push(`${c.gw_kg}KGS`);
    if (c.cbm) parts.push(`${c.cbm}CBM`);
    return parts.join('/');
  }).filter(Boolean);

  const leftLines = [];
  const rightLines = [];

  containerLines.forEach((line, idx) => {
    if (idx % 2 === 0) leftLines.push(line);
    else rightLines.push(line);
  });

    const normalizePkgUnit = (unit) => {
    const u = String(unit || '').toUpperCase().trim();

    if (['PLT', 'PLTS', 'PALLET', 'PALLETS'].includes(u)) return 'PALLETS';
    if (['CTN', 'CTNS', 'CARTON', 'CARTONS'].includes(u)) return 'CARTONS';
    if (['PKG', 'PKGS', 'PACKAGE', 'PACKAGES'].includes(u)) return 'PACKAGES';
    if (['PC', 'PCS'].includes(u)) return 'PCS';

    return u || 'PACKAGES';
  };

  const buildTotalPkgs = (rows = []) => {
    let totalQty = 0;
    const units = new Set();

    rows.forEach(c => {
      const pcs = String(c.pcs ?? '').trim();
      const unitRaw = String(c.pkg_unit || c.unit || '').trim();

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

    if (!totalQty) return '';

    const unit = units.size === 1 ? [...units][0] : 'PACKAGES';
    return `${totalQty}${unit}`;
  };

    const totalPkgs = buildTotalPkgs(containers);

  const totalWgt = totals.gw_kg
    ? `${totals.gw_kg}KGS`
    : containers.reduce((sum, c) => sum + Number(c.gw_kg || 0), 0)
      ? `${containers.reduce((sum, c) => sum + Number(c.gw_kg || 0), 0)}KGS`
      : '';

  const totalM3 = totals.cbm
    ? `${totals.cbm}CBM`
    : containers.reduce((sum, c) => sum + Number(c.cbm || 0), 0)
      ? `${containers.reduce((sum, c) => sum + Number(c.cbm || 0), 0)}CBM`
      : '';

  const marks =
  snapshot.case_mark ||
  snapshot.marks ||
  an.case_mark ||
  an.marks ||
  '';

  const description =
  snapshot.body_description ||
  snapshot.body_text ||
  snapshot.description ||
  an.body_description ||
  an.body_text ||
  an.description ||
  '';

  const hblNo =
    snapshot.hbl_no ||
    shipment.bl_no ||
    shipment.hbl_no ||
    '';

  const mblNo =
    snapshot.mbl_no ||
    shipment.mbl_no ||
    shipment.master_bl_no ||
    '';

  const vesselDisplay = [
    shipment.vessel || '',
    shipment.voyage || ''
  ].filter(Boolean).join(' / ');

  const rateInfo = Array.from(
  new Map(
    charges
      .filter(c =>
        c.currency &&
        String(c.currency).toUpperCase() !== 'JPY' &&
        c.ex_rate &&
        String(c.ex_rate).trim()
      )
      .map(c => [
        String(c.currency).toUpperCase(),
        `${String(c.currency).toUpperCase()} 1 = JPY ${c.ex_rate}`
      ])
  ).values()
).join('\n');

  const totalAmount = charges.reduce((sum, c) => {
    const amount = Number(c.amount || 0);
    return sum + (Number.isFinite(amount) ? amount : 0);
  }, 0);

  const chargeRows = charges.map(c => `
    <tr>
      <td>${esc(c.item || c.charge_name || '')}</td>
      <td class="center">${esc(c.tax || c.tax_category || '')}</td>
      <td class="center">${esc(c.unit || '')}</td>
      <td class="num">${esc(c.qty || '')}</td>
      <td class="num">${esc(c.unit_price || c.rate || '')}</td>
      <td class="center">${esc(c.currency || '')}</td>
      <td class="num">${esc(c.ex_rate || '')}</td>
      <td class="num">${esc(c.amount || '')}</td>
      <td>${esc(c.note || '')}</td>
    </tr>
  `).join('');

  return `
<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Arrival Notice</title>
<link rel="stylesheet"
href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined" />
<style>
  :root{
    --ink:#1f2937; --line:#d7dde5; --bg:#eef2f6;
    --brand:#204e78; --soft:#eef5fb;
  }
  *{box-sizing:border-box}
  body{margin:0;font-family:Arial,"Yu Gothic",Meiryo,sans-serif;color:var(--ink);background:var(--bg)}
  .screen-toolbar{display:flex;justify-content:flex-end;gap:8px;width:210mm;margin:12px auto}
  .btn{border:1px solid #cbd5e1;background:#fff;border-radius:10px;padding:8px 12px;cursor:pointer;font-size:11px}
  .page{width:210mm;min-height:297mm;margin:0 auto 14px;background:#fff;box-shadow:0 8px 24px rgba(0,0,0,.12);padding:8mm 8mm 7mm 8mm}
  .brand{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:7px}
  .brand-left{display:flex;align-items:center;gap:10px}
  .brand-mark{width:40px;height:40px;border-radius:8px;background:linear-gradient(135deg,#9aa3ad,#d7dde5)}
  .brand-title{font-size:16pt;font-weight:700;color:var(--brand);line-height:1.08}
  .brand-sub{margin-top:2px;font-size:9pt;color:#334155}
  .brand-right{text-align:right;font-size:8.2pt;line-height:1.3}
  .hero{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-bottom:8px}
  .hero-box{border:1px solid var(--line);border-radius:9px;overflow:hidden;background:#fff}
  .hero-head{background:var(--brand);color:#fff;padding:5px 8px;font-size:7.4pt;font-weight:700}
  .hero-body{padding:7px 8px;font-size:9pt;min-height:36px;line-height:1.2;white-space:pre-wrap}
  .triplet{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-bottom:8px}
  .card,.section{border:1px solid var(--line);border-radius:9px;overflow:hidden;background:#fff}
  .card-head{background:var(--soft);color:var(--brand);padding:5px 8px;font-size:7.4pt;font-weight:700;border-bottom:1px solid var(--line)}
  .card-body{padding:7px 8px;min-height:78px;white-space:pre-wrap;line-height:1.28;font-size:8.2pt}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-bottom:8px}
  .section-head{background:var(--brand);color:#fff;padding:6px 8px;font-size:7.4pt;font-weight:700}
  .section-body{padding:7px 8px}
  .kv{display:grid;grid-template-columns:115px 1fr;gap:5px 7px;font-size:7.9pt;line-height:1.28}
  .k{font-weight:700;color:#475569}.v{font-weight:600}
  .small{font-size:7.1pt;line-height:1.34;white-space:pre-wrap}
  .container-wrap{border:1px solid var(--line);border-radius:9px;overflow:hidden;background:#fff;margin-top:8px}
  .container-head{background:var(--brand);color:#fff;padding:6px 8px;font-size:7.4pt;font-weight:700}
  .container-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:8px}
  .container-col{font-size:8pt;line-height:1.35;min-height:58px;white-space:pre-wrap}
  .container-total{border-top:1px solid var(--line);padding:7px 8px;font-size:8.2pt;text-align:right;font-weight:700}
  table{width:100%;border-collapse:collapse}
  .charge-table th,.charge-table td{border:1px solid var(--line);padding:4px 4px;vertical-align:top}
  .charge-table th{background:#f8fafc;color:#334155;text-align:left;font-size:6.9pt;line-height:1.05}
  .charge-table td{font-size:7.6pt;line-height:1.12}
  .split{display:grid;grid-template-columns:.52fr 1.48fr;gap:7px;margin-top:8px}
  .footer2{display:grid;grid-template-columns:1fr 240px;gap:7px;margin-top:8px}
  .num{text-align:right}.center{text-align:center}
  @media print {
  @page {
    size: A4 portrait;
    margin: 0;
  }

  html,
  body {
    margin: 0 !important;
    padding: 0 !important;
    background: #fff !important;
    width: 210mm;
    min-height: 297mm;
    overflow: hidden;
  }

  .screen-toolbar,
  .print-toolbar,
  .doc-tools,
  .no-print {
    display: none !important;
    visibility: hidden !important;
  }

  .page {
    width: 210mm !important;
    min-height: auto !important;
    height: auto !important;
    margin: 0 !important;
    padding: 5mm !important;
    box-shadow: none !important;
    border: none !important;
    page-break-after: avoid !important;
    break-after: avoid !important;
  }

  .brand,
  .hero,
  .triplet,
  .grid2,
  .container-wrap,
  .split,
  .footer2,
  .section {
    page-break-inside: avoid;
    break-inside: avoid;
  }

  * {
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
}
  body,
.page,
.page * {
  user-select: text !important;
  -webkit-user-select: text !important;
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
  line-height: 1.2;
  border: 1px solid #999;
  border-radius: 4px;
  background: #fff;
  color: #333;
  cursor: pointer;
  min-width: 90px;
  height: auto;
}

@media print {
  .screen-toolbar,
  .no-print {
    display: none !important;
  }
}
.doc-tools {
  position: fixed;
  top: 14px;
  right: 18px;
  display: flex !important;
  flex-direction: row !important;
  align-items: center;
  gap: 10px;
  z-index: 9999;
}

.doc-tools-divider {
  width: 1px;
  height: 34px;
  background: rgba(0,0,0,.10);
}

.doc-tool {
  all: unset;
  box-sizing: border-box;

  height: 34px;
  min-width: 88px;
  padding: 0 14px;

  display: flex !important;
  align-items: center;
  justify-content: center;
  gap: 6px;

  border: 1px solid rgba(17, 24, 39, .55);
  border-radius: 999px;

  background: rgba(255,255,255,.92);
  color: #006bb6;

  font-family: "Helvetica Neue", Arial, sans-serif;
  font-size: 12px;
  font-weight: 500;

  cursor: pointer;

  box-shadow:
    0 1px 3px rgba(0,0,0,.04);

  transition:
    background .15s ease,
    box-shadow .15s ease,
    border-color .15s ease;
}

.doc-tool:hover {
  background: #fff;

  border-color:
    rgba(0, 107, 182, .8);

  box-shadow:
    0 3px 8px rgba(0,0,0,.06);
}

.doc-tool .material-symbols-outlined {
  font-size: 18px;

  line-height: 1;

  color: #0072bc;

  font-variation-settings:
    'FILL' 0,
    'wght' 400,
    'GRAD' 0,
    'opsz' 20;
}

@media print {
  .doc-tools,
  .no-print {
    display: none !important;
  }
}
.doc-tools-divider {
  height: 18px;
}
}
</style>
</head>

<body>
<!-- BODY内 -->
<div class="doc-tools no-print">

  <button class="doc-tool"
  onclick="window.open(location.pathname + '/pdf' + location.search, '_blank')">
  <span class="material-symbols-outlined">description</span>
  <span>AN</span>
</button>

  <div class="doc-tools-divider"></div>

  <button class="doc-tool" onclick="copyDocUrl(this)">
  <span class="material-symbols-outlined">link</span>
  <span class="tool-label">URL</span>
</button>

</div>

<main class="page">
  <div class="brand">
    <div class="brand-left">
      <div>
        <div class="brand-title">BUSINESS LABO CO., LTD.</div>
        <div class="brand-sub">Arrival Notice / 入港案内</div>
      </div>
    </div>
    <div class="brand-right">
    <div><strong>管理番号:</strong> ${esc(shipment.job_no || '')}</div>
      <div><strong>Carrier:</strong> ${esc(carrierName)}</div>
      <div><strong>DO LESS / SURRENDER BL</strong></div>
    </div>
  </div>

  <div class="hero">
    <div class="hero-box">
      <div class="hero-head">HBL No.</div>
      <div class="hero-body">${esc(hblNo)}</div>
    </div>
    <div class="hero-box">
      <div class="hero-head">Vessel / Voy.</div>
      <div class="hero-body">${esc(vesselDisplay)}</div>
    </div>
    <div class="hero-box">
      <div class="hero-head">MBL No.</div>
      <div class="hero-body">${esc(mblNo)}</div>
    </div>
  </div>

  <div class="hero" style="margin-top:-1px;">
    <div class="hero-box">
      <div class="hero-head">搬入確認番号</div>
      <div class="hero-body">${esc(shipment.inbound_no || '')}</div>
    </div>
    <div class="hero-box">
      <div class="hero-head">ETA</div>
      <div class="hero-body">${esc(shipment.eta || '')}</div>
    </div>
    <div class="hero-box">
      <div class="hero-head">送付先</div>
      <div class="hero-body">${esc(sendToName)}</div>
    </div>
  </div>

  <div class="triplet">
    <div class="card">
      <div class="card-head">Shipper</div>
      <div class="card-body">${esc(shipperBlock)}</div>
    </div>
    <div class="card">
      <div class="card-head">Consignee</div>
      <div class="card-body">${esc(consigneeFullBlock)}</div>
    </div>
    <div class="card">
      <div class="card-head">Notify</div>
      <div class="card-body">${esc(notifyBlock)}</div>
    </div>
  </div>

  <div class="grid2">
    <div class="section">
      <div class="section-head">船積み情報</div>
      <div class="section-body">
        <div class="kv">
          <div class="k">PLACE OF RECEIPT</div><div class="v">${esc(shipment.pol || '')}</div>
          <div class="k">PORT OF LOADING</div><div class="v">${esc(shipment.pol || '')}</div>
          <div class="k">PORT OF DISCHARGE</div><div class="v">${esc(shipment.pod || '')}</div>
          <div class="k">PLACE OF DELIVERY</div><div class="v">${esc(shipment.pod || '')}</div>
          <div class="k">TRANSHIP PORT</div><div class="v">${esc(shipment.tranship_port || '')}</div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-head">貨物搬入先</div>
      <div class="section-body small">${esc(locationBlock)}</div>
    </div>
  </div>

  <div class="container-wrap">
    <div class="container-head">コンテナ詳細</div>
    <div class="container-grid">
      <div class="container-col">${esc(leftLines.join('\n'))}</div>
      <div class="container-col">${esc(rightLines.join('\n'))}</div>
    </div>
    <div class="container-total">TOTAL: ${esc(totalPkgs)} / ${esc(totalWgt)} / ${esc(totalM3)}</div>
  </div>

  <div class="split">
    <div class="section">
      <div class="section-head">Marks</div>
      <div class="section-body" style="min-height:94px;white-space:pre-wrap;font-size:8.2pt;">${esc(marks)}</div>
    </div>
    <div class="section">
      <div class="section-head">Description</div>
      <div class="section-body" style="min-height:94px;white-space:pre-wrap;font-size:8.2pt;">${esc(description)}</div>
    </div>
  </div>

  <div class="section" style="margin-top:8px;">
    <div class="section-head">Charges</div>
    <div class="section-body" style="padding:0;">
      <table class="charge-table">
        <thead>
          <tr>
            <th style="width:24%">ITEM</th>
            <th style="width:8%" class="center">TAX</th>
            <th style="width:8%" class="center">UNIT</th>
            <th style="width:8%" class="num">QTY</th>
            <th style="width:12%" class="num">U.PRICE</th>
            <th style="width:8%" class="center">CUR</th>
            <th style="width:10%" class="num">EX RATE</th>
            <th style="width:12%" class="num">AMOUNT</th>
            <th style="width:10%">NOTE</th>
          </tr>
        </thead>
        <tbody>
          ${chargeRows || `<tr><td colspan="9" style="text-align:center;">No charges</td></tr>`}
        </tbody>
      </table>
    </div>
  </div>

  <div class="footer2">
    <div class="section">
      <div class="section-head">Bank / Payment Info</div>
      <div class="section-body small">御支払は振込にてお願い致します。また振込手数料は貴社にてご負担の上、振込明細を弊社宛にファックスください。
振込先
三井住友銀行　日本橋東支店　普通 7828377　名義：株式会社ビジネスラボ
GMOあおぞらネット銀行　法人営業部　普通1218798　名義：株式会社ビジネスラボ</div>
    </div>
    <div class="section">
      <div class="section-head">Total</div>
      <div class="section-body">
        <div style="font-size:7.8pt;color:#475569;margin-bottom:4px;white-space:pre-line;">
  <strong>RATE:</strong><br>${esc(rateInfo)}
</div>
        <div style="font-size:17pt;font-weight:700;">¥ ${fmtMoney(totalAmount)}</div>
      </div>
    </div>
  </div>

  <div class="section" style="margin-top:8px;">
    <div class="section-head">Notes / Contact</div>
    <div class="section-body small">注:D/Oレス貨物に関しては、必ず貨物引取り時に、ヤード又はナックスで事前にご確認ください。
注:実際の本船入港日は航行状況により変動することがございますので、ご了承下さい。
お問合せ：株式会社ビジネスラボ / operation@bizlabo-tokyo.co.jp</div>
  </div>
</main>

<script>
function copyDocUrl(btn) {

  navigator.clipboard.writeText(location.href).then(() => {

    const label = btn.querySelector('.tool-label');

    if (!label) return;

    const oldText = label.textContent;

    label.textContent = 'コピーしました';

    btn.classList.add('copied');

    setTimeout(() => {
      label.textContent = oldText;
      btn.classList.remove('copied');
    }, 1200);

  });

}
</script>

</body>
</html>
`;
}