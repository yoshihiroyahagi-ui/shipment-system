export function buildCustomsHtmlFromPayload(payload = {}) {
  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const shipment = payload.shipment || {};
  const party = payload.party || {};
  const customer = party.customer || {};
  const supplier = party.supplier || {};
  const trucker = party.trucker || {};
  const logistics = payload.logistics || {};
  const pickup = logistics.pickup_place || {};
  const delivery = payload.delivery || payload.logistics?.delivery || {};
  const an = payload.an || {};
  const totals = an.totals || {};
  const customs = payload.customs || {};
  const labels = payload.labels || {};

  const itemLines = (delivery.lines || [])
    .map(l => l.commodity)
    .filter(Boolean);

  const costCoverMap = {
  CC01: 'AN立替のみお願い致します。',
  CC02: '関税・消費税のみ立替をお願い致します。',
  CC03: '立替は一切不要です。',
  CC04: 'AN・関税・消費税の立替をお願い致します。'
};
  const documentMap = {
  CD01: 'A/N',
  CD02: 'INV',
  CD03: 'P/L',
  CD04: '船社AN',
  CD05: 'サインAN',
  CD06: '資料',
  CD07: 'RCEP'
};

const requestMap = {
  REQ1: 'ANの立替不要。(顧客支払い)',
  REQ2: 'ANの立替をお願いします。(末締め翌月末支払い)',
  REQ3: 'MPN納付書を配達日前日朝一までに送付ください。',
  REQ4: 'RCEP/FTAを利用して申告して下さい。',
  REQ5: '貴社にて通関実績があります。',
  REQ6: '許可書を送付頂く際に必ずリアルタイム納付書も送付ください。',
  REQ7: '空港でパレットを外して配達してください。',
  REQ8: '検査の場合は最短での手配を進めて下さい。',
  REQ9: '個別搬入依頼中です。個別の可否は追ってご連絡致します。',
  REQ10: '資金移動の関係で入力控えの事前送信が必須です。ご注意ください。',
  REQ11: '事前に入力控えを送付して申告は進めてください。',
  REQ12: '車両情報/路線便の送り状を配達日前日16時を目途にご連絡ください。',
  REQ13: '上記リアルタイム口座番号を確認の上、顧客リアルタイム口座を使用して申告をして下さい。',
  REQ14: '製品詳細は追って資料ご連絡致します。',
  REQ15: '製品詳細は展開済みです。（営業担当者様へご確認ください）',
  REQ16: '製品詳細は別紙資料通り。',
  REQ17: '本件は必ず通関希望日朝一番での許可としてください。',
  REQ18: '通関日は必ず守ってください。',
  REQ19: 'ディスパッチ/搬出書類を配達前日午前中を目途に送付願います。',
  REQ20: '入力控えを申告予定日前日午前中を目途に送って下さい。',
  REQ21: '搬出手配は弊社委託先の配送会社が行います。',
  REQ22: '搬入日や本船遅延の場合は弊社宛に至急ご連絡下さい。',
  REQ23: '評価あり。加算金額は評価資料をご確認ください。',
  REQ24: '優先搬入手配をお願い致します。',
  REQ25: '予備申告不要',
  REQ26: '予備申告を行って下さい。',
  REQ27: '顧客から送付される関割を使用して下さい。',
  REQ28: '搬入仕分をお願い致します。',
  REQ29: 'ドレージは最終決定ではありませんので仮押さえをお願い致します。',
  REQ30: 'D/O LESS済みです。',
  REQ31: '納品は納品先と時間調整して下さい。',
  REQ32: '当日配送の為車両情報は入手次第ご連絡ください。',
  REQ33: 'DAPにつきフォワーダーに許可連絡をお願い致します。',
  REQ34: '食品申請該当商品です。提供書類に不足があればご指摘ください。'
};

const incotermsMap = {
  IT01: 'EXW',
  IT02: 'FOB',
  IT03: 'C&F',
  IT04: 'CIF',
  IT05: 'DDU',
  IT06: 'DDP',
  IT07: 'DAP'
};

const currencyMap = {
  CR01: 'USD',
  CR02: 'JPY',
  CR03: 'EUR',
  CR04: 'KRW',
  CR05: 'CNY',
  CR06: 'TWD',
  CR07: 'AUD',
  CR08: 'GBP'
};

  let containers = [];

if (Array.isArray(an.containers)) {
  containers = an.containers;
} else if (Array.isArray(an.container_lines_json)) {
  containers = an.container_lines_json;
} else if (typeof an.container_lines_json === 'string') {
  try {
    containers = JSON.parse(an.container_lines_json);
  } catch (e) {
    containers = [];
  }
}

function toNumLoose(v) {
  const m = String(v || '').replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : 0;
}

function getPkgUnit(row = {}) {
  return (
    row.pkg_unit ||
    row.package_unit ||
    row.packages_unit ||
    row.unit ||
    row.packing_unit ||
    ''
  );
}

const unitRow = containers.find(c => getPkgUnit(c)) || {};

const totalPkgs =
  containers.reduce((sum, c) => {
    return sum + toNumLoose(c.pcs || c.qty || c.pkgs);
  }, 0);

const totalUnit =
  containers.find(c =>
    c.pkg_unit || c.qty_unit
  )?.pkg_unit ||
  containers.find(c =>
    c.pkg_unit || c.qty_unit
  )?.qty_unit ||
  '';

const totalGw =
  toNumLoose(totals.gw_kg) ||
  containers.reduce((sum, c) => {
    return sum + toNumLoose(c.gw_kg || c.gw);
  }, 0);

const totalCbm = Number((
  toNumLoose(totals.cbm) ||
  containers.reduce((sum, c) => {
    return sum + toNumLoose(c.cbm || c.m3);
  }, 0)
).toFixed(3));

const pkgsText =
  totalPkgs
    ? `${totalPkgs}${totalUnit ? ' ' + totalUnit : ''}`
    : '';

const gwText = totalGw ? `${totalGw} KGS` : '';
const cbmText = totalCbm ? `${totalCbm} CBM` : '';

  const shipperBlock = [
    supplier.supplier_name,
    supplier.supplier_add_1,
    supplier.supplier_add_2
  ].filter(Boolean).join('\n');

  const pickupBlock = [
    pickup.place_name,
    pickup.line1,
    pickup.line2,
    pickup.line3,
    pickup.line4
  ].filter(Boolean).join('\n');

  const customerNameEn = customer.customer_name_e || customer.customer_name || '';
  const customerAddressEn = [
    customer.address1_e,
    customer.address2_e
  ].filter(Boolean).join('\n');

  const firstCommodity =
  Array.isArray(itemLines) && itemLines.length
    ? itemLines[0]
    : '';


let customsData = {};

try {
  if (typeof shipment.customs_data === 'string') {
    customsData = JSON.parse(shipment.customs_data || '{}');
  } else {
    customsData = shipment.customs_data || {};
  }
} catch (e) {
  customsData = {};
}

const descriptionText =
  firstCommodity ||
  (
    customs.descriptions &&
    customs.descriptions.length
      ? customs.descriptions[0]
      : ''
  );

  const docsText = (customs.documents || [])
  .map(code => documentMap[code] || code)
  .join('\n');

  const costCoverText =
    (labels.cost_cover_labels || []).join('\n') ||
    costCoverMap[customs.costCover] ||
    customs.costCover ||
    '';

  const workScopesText = (customs.workScopes || []).join('\n');
  const requestsText = (customs.requests || [])
  .map(code => requestMap[code] || code)
  .join('\n');

  console.log(
  '[customsData]',
  customsData
);

console.log(
  '[descriptions]',
  customsData.descriptions
);

  const productInfo =
  Array.isArray(customsData.descriptions)
    ? customsData.descriptions.join('\n')
    : '';

  const declarationAmount =
    shipment.declaration_amount ||
    customs.declaration_amount ||
    '';
  const fmtDate = (v) => {
  const s = String(v || '').trim();
  if (!s) return '';

  // 2026-04-30 → 2026/04/30
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return s.replace(/-/g, '/');
  }

  // すでに 2026/04/30 ならそのまま
  return s;
};

  return `
<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<title>通関依頼書</title>
<style>
  :root{
    --border:#222;
    --soft:#f5f7fb;
    --accent:#163b72;
  }

  *{ box-sizing:border-box; }

  body{
    margin:0;
    padding:18px;
    font-family: Arial, "Hiragino Kaku Gothic ProN", "Yu Gothic", Meiryo, sans-serif;
    color:#111;
    background:#f1f3f6;
    font-size:11px;
  }

  .print-toolbar{
    width:1100px;
    margin:0 auto 8px;
  }

  .page{
    width:1100px;
    margin:0 auto;
    background:#fff;
    padding:24px 28px 30px;
    box-shadow:0 2px 10px rgba(0,0,0,.08);
  }

  .topbar{
    display:flex;
    justify-content:space-between;
    align-items:flex-start;
    margin-bottom:14px;
  }

  .title{
    font-size:24px;
    font-weight:700;
    color:var(--accent);
  }

  .meta{
    text-align:right;
    font-size:12px;
    line-height:1.6;
    min-width:260px;
  }

  table{
    border-collapse:collapse;
    width:100%;
  }

  th, td{
    border:1px solid var(--border);
    padding:5px 6px;
    vertical-align:top;
    font-size:11px;
    line-height:1.35;
  }

  th{
    background:var(--soft);
    font-weight:700;
    text-align:center;
    white-space:nowrap;
  }

  .center{text-align:center;}
  .nowrap{white-space:nowrap;}
  .pre{white-space:pre-line;}

  .section{
    margin-top:14px;
  }

  .section-title{
    font-size:12px;
    font-weight:700;
    margin:0 0 6px;
    padding:5px 8px;
    background:var(--accent);
    color:#fff;
  }

  .label{
    background:var(--soft);
    font-weight:700;
    width:135px;
    white-space:nowrap;
  }

  .wide-label{
    background:var(--soft);
    font-weight:700;
    width:110px;
    white-space:nowrap;
  }

  .block{
    border:1px solid var(--border);
    min-height:70px;
    padding:8px 10px;
    font-size:11px;
    line-height:1.45;
    white-space:pre-line;
  }

  .list-lines{
    border:1px solid var(--border);
    padding:8px 10px;
    min-height:76px;
    white-space:pre-line;
    line-height:1.55;
    font-size:11px;
  }

  .three-col{
    display:grid;
    grid-template-columns:1fr 1fr 1fr;
    gap:12px;
  }

  .chips{
    border:1px solid var(--border);
    min-height:72px;
    padding:8px 10px;
    white-space:pre-line;
    line-height:1.55;
    font-size:11px;
  }

  .footer-note{
    margin-top:12px;
    font-size:10px;
    color:#555;
  }
    
  .two-col {
   display: grid;
   grid-template-columns: 1fr 1fr;
   gap: 12px;
  }

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

  .print-toolbar,
  .screen-toolbar,
  .btn,
  button {
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

  .section,
  table,
  .block,
  .list-lines,
  .chips {
    page-break-inside: avoid;
    break-inside: avoid;
  }
  @media print {
  .screen-toolbar,
  .no-print {
    display:none !important;
  }
}
}
</style>
</head>

<div class="screen-toolbar no-print">
  <button class="pdf-btn"
    onclick="window.open(location.pathname + '/pdf' + location.search, '_blank')">
    PDFを開く
  </button>
</div>

<div class="page">

  <div class="topbar">
    <div class="title">通関依頼書</div>
    <div class="meta">
      <div><strong>依頼日：</strong>${esc(fmtDate(customs.declaredDate || customs.customs_declared_date || ''))}</div>
      <div><strong>依頼書番号：</strong>${esc(shipment.shipment_id || '')}</div>
      <div><strong>案件番号：</strong>${esc(shipment.job_no || '')}</div>
    </div>
  </div>

  <table>
    <tr>
      <th>通関希望</th>
      <th>搬入確認番号</th>
      <th>到着地</th>
      <th>個数</th>
      <th>重量</th>
      <th>M3</th>
      <th>建値</th>
      <th>通貨</th>
      <th>申告金額</th>
    </tr>
    <tr class="center">
      <td class="nowrap">${esc(fmtDate(customs.customs_declared_date || customs.declaredDate || ''))}</td>
      <td class="nowrap">${esc(shipment.inbound_no || customs.inbound_no || '')}</td>
      <td class="nowrap">${esc(shipment.pod || '')}</td>
      <td class="nowrap">${esc(pkgsText)}</td>
      <td class="nowrap">${esc(gwText)}</td>
      <td class="nowrap">${esc(cbmText)}</td>
      <td class="nowrap">${esc(
  incotermsMap[customs.incoterms] ||
  incotermsMap[shipment.incoterms] ||
  labels.incoterms_label ||
  customs.incoterms ||
  shipment.incoterms ||
  ''
)}</td>
      <td class="nowrap">${esc(
  currencyMap[customs.currency] ||
  currencyMap[shipment.currency] ||
  labels.currency_label ||
  customs.currency ||
  shipment.currency ||
  ''
)}</td>
      <td class="nowrap">${esc(declarationAmount)}</td>
    </tr>
  </table>

  <div class="section">
    <div class="section-title">輸入者情報</div>
    <table>
      <tr>
        <td class="label">輸入者</td>
        <td colspan="5" class="nowrap">${esc(customerNameEn)}</td>
      </tr>
      <tr>
        <td class="label">輸入者住所</td>
        <td colspan="5" class="pre">${esc(customerAddressEn)}</td>
      </tr>
      <tr>
        <td class="label">電話番号</td>
        <td>${esc(customer.phone || '')}</td>
        <td class="label">法人番号</td>
        <td>${esc(customer.c_registration || '')}</td>
        <td class="label">輸入者符号</td>
        <td>${esc(customer.i_e_registration || '')}</td>
      </tr>
      <tr>
        <td class="label">包括保険番号</td>
        <td>${esc(customer.open_policy || '')}</td>
        <td class="label">納税方法</td>
        <td>${esc(customer.tax_payment || '')}</td>
        <td class="label">リアルタイム口座番号</td>
        <td>${esc(customer.real_time || '')}</td>
      </tr>
    </table>
  </div>

  <div class="section">
    <div class="section-title">SHIPPER NAME AND ADDRESS</div>
    <div class="block">${esc(shipperBlock)}</div>
  </div>

  <div class="section">
    <div class="section-title">本船到着情報</div>
    <table>
      <tr>
        <td class="wide-label">本船名</td>
        <td class="nowrap">${esc([shipment.vessel, shipment.voyage].filter(Boolean).join(' / '))}</td>
        <td class="wide-label">ETA</td>
        <td class="nowrap">${esc(fmtDate(shipment.eta || ''))}</td>
      </tr>
      <tr>
        <td class="wide-label">搬入先</td>
        <td colspan="3" class="pre">${esc(pickupBlock)}</td>
      </tr>
    </table>
  </div>

  <div class="section">
  <div class="section-title">配送情報</div>

  <div class="two-col">
    <div class="block">
${esc([
  customs.pickupDate ? `搬出希望日：${fmtDate(customs.pickupDate)}` : '',
  (delivery.delivery_fixed || delivery.delivery_request_date)
    ? `納品日：${fmtDate(delivery.delivery_fixed || delivery.delivery_request_date)}` : '',
  (delivery.delivery_fixed_time || delivery.delivery_request_time)
    ? `納品時間：${delivery.delivery_fixed_time || delivery.delivery_request_time}` : ''
].filter(Boolean).join('\n'))}
    </div>

    <div class="block">
${esc([
  delivery.delivery_dest_name || delivery.delivery_dest_short
    ? `納品先：${delivery.delivery_dest_name || delivery.delivery_dest_short}` : '',
  delivery.address_official || delivery.delivery_address1
    ? `住所：${delivery.address_official || delivery.delivery_address1}` : '',
  delivery.delivery_address2
    ? `住所2：${delivery.delivery_address2}` : '',
  (delivery.delivery_tel || delivery.delivery_contact)
    ? `TEL/担当：${[delivery.delivery_tel, delivery.delivery_contact].filter(Boolean).join(' / ')}` : '',
  (delivery.delivery_fixed || delivery.delivery_request_date)
    ? `配送日：${delivery.delivery_fixed || delivery.delivery_request_date}` : '',
  (delivery.delivery_fixed_time || delivery.delivery_request_time)
    ? `配送時間：${delivery.delivery_fixed_time || delivery.delivery_request_time}` : ''
].filter(Boolean).join('\n'))}
</div>
  </div>

  <div class="block" style="margin-top:10px;">
${esc([
  (trucker && (trucker.partner_name || trucker.trucker_name)) || shipment.trucker_code
    ? `引取業者：${(trucker && (trucker.partner_name || trucker.trucker_name)) || shipment.trucker_code}` : '',
  shipment.vehicle_type
    ? `希望車種：${shipment.vehicle_type}` : ''
].filter(Boolean).join('\n'))}
  </div>
</div>

  <div class="section">
  <div class="section-title">Invoice / Item</div>
  <table>
    <tr>
      <td class="label">INVOICE NO.</td>
      <td>${esc(shipment.invoice_no || customs.invoice_no || '')}</td>
      <td class="label">ITEM(品名)</td>
      <td>${esc(itemName)}</td>
    </tr>
  </table>
</div>

<div class="section">
  <div class="section-title">商品情報</div>
  <div class="list-lines">${esc(productInfo)}</div>
</div>

  <div class="section">
    <div class="section-title">送付書類 / 立替 / 作業範囲</div>
    <div class="three-col">
      <div>
        <div style="font-weight:700;margin-bottom:5px">送付書類</div>
        <div class="chips">${esc(docsText)}</div>
      </div>
      <div>
        <div style="font-weight:700;margin-bottom:5px">立替</div>
        <div class="chips">${esc(costCoverText)}</div>
      </div>
      <div>
        <div style="font-weight:700;margin-bottom:5px">作業範囲</div>
        <div class="chips">${esc(workScopesText)}</div>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">通関リクエスト</div>
    <div class="list-lines">${esc(requestsText)}</div>
  </div>

  <div class="section">
    <div class="section-title">備考 / Special Instructions</div>
    <div class="list-lines">${esc(customs.specialInst || '')}</div>
  </div>

  <div class="footer-note">
    このHTMLは、通関依頼内容をHTML帳票として表示するテンプレートです。
  </div>

</div>
</body>
</html>
`;
}
