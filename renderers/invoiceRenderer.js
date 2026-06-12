function toNumber(v) {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function yen(v) {
  return Math.round(toNumber(v)).toLocaleString('ja-JP');
}

function esc(v) {
  return String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function taxLabel(v) {
  if (v === 'taxable') return '課税10%';
  if (v === 'non_taxable') return '非課税';
  if (v === 'exempt') return '免税';
  if (v === 'out_of_scope') return '不課税';
  if (v === 'pass_through') return '立替';
  return v || '';
}

function getNextMonthEnd(dateValue) {
  const d = dateValue ? new Date(dateValue) : new Date();

  if (Number.isNaN(d.getTime())) return '';

  const y = d.getFullYear();
  const m = d.getMonth();

  const end = new Date(y, m + 2, 0);

  return end.toISOString().slice(0, 10);
}

function formatJaDate(value) {
  if (!value) return '';

  const d = new Date(value);

  if (Number.isNaN(d.getTime())) {
    return value;
  }

  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');

  return `${yyyy}年${mm}月${dd}日`;
}

export function renderInvoiceHtml(payload) {
  const { header, invoiceLines, firstShipmentLine } = payload;

  const dueDate =
  header.payment_due_date ||
  header.due_date ||
  getNextMonthEnd(header.invoice_date);

  const linesNetTotal = invoiceLines.reduce((sum, l) => {
    return sum + toNumber(l.billing_amount_net);
}, 0);

const linesTaxTotal = invoiceLines.reduce((sum, l) => {
  return sum + toNumber(l.billing_tax_amount);
}, 0);

const salesNet =
  toNumber(header.sales_net_total) || linesNetTotal;

const salesTax =
  toNumber(header.sales_tax_total) || linesTaxTotal;

const salesGross =
  toNumber(header.sales_gross_total) ||
  salesNet + salesTax;

  const qtyText = [
  header.pcs_total
    ? `${Number(header.pcs_total).toLocaleString()} ${header.package_unit || ''}`
    : '',

  header.gw_total
    ? `${Number(header.gw_total).toFixed(3)} KG`
    : '',

  header.cbm_total
    ? `${Number(header.cbm_total).toFixed(3)} M3`
    : ''
].filter(Boolean).join('　　');

  const displayInvoiceNo =
    header.job_no ||
    header.invoice_no ||
    header.commercial_invoice_no ||
    '';

  const workName =
    header.free_title ||
    header.cargo_summary ||
    '';

  const cargoName =
  firstShipmentLine?.commodity ||
  firstShipmentLine?.commodity_note ||
  header.cargo_summary ||
  '';

  const etd =
    header.etd ||
    header.atd ||
    header.on_board_date ||
    '';

  const taxableTotal = invoiceLines
    .filter(l => l.billing_tax_type === 'taxable')
    .reduce((sum, l) => sum + toNumber(l.billing_amount_net), 0);

  const nonTaxableTotal = invoiceLines
    .filter(l => l.billing_tax_type === 'non_taxable' || l.billing_tax_type === 'out_of_scope')
    .reduce((sum, l) => sum + toNumber(l.billing_amount_net), 0);

  const exemptTotal = invoiceLines
    .filter(l => l.billing_tax_type === 'exempt')
    .reduce((sum, l) => sum + toNumber(l.billing_amount_net), 0);

  const rowsHtml = invoiceLines.map((l, idx) => {
  const qty =
    Number(l.quantity || 1);

  const unitPrice =
    l.foreign_unit_price ||
    (
      qty
        ? Math.round(Number(l.billing_amount_net || 0) / qty)
        : l.billing_amount_net
    );

  const unitPriceText =
    unitPrice
      ? `${unitPrice}${l.currency ? ' ' + l.currency : ''}`
      : '';

  return `
  <tr>
    <td class="no">${idx + 1}</td>
    <td>${esc(l.item_name || '')}</td>
    <td class="center">${esc(taxLabel(l.billing_tax_type))}</td>
    <td class="num">${esc(l.quantity || '')}</td>
    <td>${esc(l.quantity_unit || '')}</td>
    <td class="num">${esc(unitPriceText)}</td>
    <td class="num">${yen(l.billing_amount_net)}</td>
    <td>${esc(l.line_note || l.memo || '')}</td>
  </tr>`;
}).join('');

  const blankRows = Math.max(0, 22 - invoiceLines.length);

const blankRowsHtml = Array.from({ length: blankRows }).map(() => `
  <tr class="blank-row">
    <td>&nbsp;</td>
    <td></td>
    <td></td>
    <td></td>
    <td></td>
    <td></td>
    <td></td>
    <td></td>
  </tr>
`).join('');

    return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>請求書 ${esc(displayInvoiceNo)}</title>
<style>
@page{
  size:A4;
  margin:0;
}
*{box-sizing:border-box}
body{
  margin:0;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans JP",sans-serif;
  color:#111;
  background:#eee;
}

/* 共通：印刷時の色飛び防止 */
*{
  -webkit-print-color-adjust:exact;
  print-color-adjust:exact;
}

:root{
  --brand:#E0CDC6;
  --brand-dark:#8A6F66;
  --brand-soft:#F4ECE8;
  --line:#D8C6BE;
}
.topbar{
  height:48px;
  background:white;
  border-bottom:1px solid #ddd;
  display:flex;
  align-items:center;
  justify-content:space-between;
  padding:0 16px;
}
.btn{
  border:none;
  border-radius:999px;
  padding:8px 14px;
  font-weight:700;
  cursor:pointer;
}
.btn.primary{
  background:var(--brand-dark);
  color:white;
}
.sheet{
  width:210mm;
  min-height:297mm;
  margin:8px auto;
  background:white;
  padding:8mm 10mm;
  display:flex;
  flex-direction:column;
}
.header{
  display:grid;
  grid-template-columns:1fr 96mm;
  gap:8mm;
  align-items:start;
  border-bottom:2px solid #111;
  padding-top:3mm;
  padding-bottom:4mm;
}
.title{
  font-size:30px;
  font-weight:900;
  letter-spacing:.35em;
  margin-top:6mm;
}
.title-sub{
  margin-top:4mm;
  font-size:11px;
  letter-spacing:0;
  font-weight:700;
}
th{
  background:var(--brand-soft);
  color:#3d2c26;
  padding:1.6mm 1.4mm;
  border-top:1px solid #111;
  border-bottom:1px solid #111;
  text-align:center;
}
.company-main{
  display:grid;
  grid-template-columns:14mm 1fr;
  gap:10mm;
  align-items:start;
  position:relative;
  z-index:1;
}
.logo-img{
  width:20mm;
  height:auto;
  margin-top:1mm;
}
.company-name{
  font-size:16px;
  font-weight:900;
  white-space:nowrap;
  line-height:1.2;
}
.company-detail{
  grid-column:2;
  font-size:9.5px;
  line-height:1.35;
  margin-top:1mm;
  white-space:nowrap;
}
.company-box{
  position:relative;
  margin-left:-6mm;
  padding-right:14mm;
  min-height:24mm;
  overflow:visible;
}
.company-stamp{
  position:absolute;
  right:25mm;
  top:5mm;
  width:20mm;
  opacity:.68;
  transform:rotate(0deg);
  z-index:2;
}

.bill-area{
  display:grid;
  grid-template-columns:1fr 58mm;
  gap:8mm;
  margin-top:7mm;
}
.billto-name{
  font-size:18px;
  font-weight:900;
  border-bottom:1px solid #111;
  padding-bottom:3mm;
  line-height:1.35;
}
.greeting{
  font-size:11.5px;
  line-height:1.8;
  margin-top:4mm;
}
.meta-table{
  border:1px solid #111;
  border-radius:4px;
  overflow:hidden;
  font-size:10.5px;
}

.meta-table .meta-row:last-child{
  border-bottom:none;
}

.meta-table{
  align-self:start;
}

.meta-row{
  display:grid;
  grid-template-columns:22mm 1fr;
  border-bottom:1px solid #111;
}
.meta-label,
.meta-value{
  padding:1.8mm 2.2mm;
}
.meta-label{
  background:#D8B8A8;

  border-left:none;
  font-weight:800;

  -webkit-print-color-adjust:exact;
  print-color-adjust:exact;
}
/* ご請求金額：幅を2/3程度にして縦中央 */
.amount-tax{
  margin-top:4mm;
  display:grid;
  grid-template-columns:2fr 3fr;
  gap:5mm;
  align-items:start;
}

.amount-box{
  border:2px solid #111;
  display:grid;
  grid-template-columns:32mm 1fr;
  height:10mm;
  align-items:stretch;
}

.amount-label{
  display:flex;
  align-items:center;
  justify-content:center;
  padding:0 2mm;
  font-weight:900;
}

.amount-value{
  font-size:19px;
  padding:0 4mm;
  display:flex;
  align-items:center;
  justify-content:flex-start;
  font-weight:900;
}
  
.tax-summary{
  font-size:9.5px;
}
/* tax box：少し大きく、罫線を太め */
.tax-summary{
  border:1.5px solid #B78D78;
  border-radius:5px;
  overflow:hidden;
  font-size:9.8px;
}

.tax-grid{
  display:grid;
  grid-template-columns:1fr 1fr;
}

.tax-cell{
  display:grid;
  grid-template-columns:24mm 1fr;
  align-items:stretch;
  padding:0;
  white-space:nowrap;
  border-bottom:1.5px solid #B78D78;
}

.tax-cell:nth-child(odd){
  border-right:1.5px solid #B78D78;
}

.tax-cell:nth-last-child(-n+2){
  border-bottom:none;
}

.tax-label{
  display:flex;
  align-items:center;
  padding:1.5mm 2mm;
  font-weight:800;
}

.tax-value{
  display:flex;
  align-items:center;
  justify-content:flex-end;
  padding:1.5mm 2mm;
  text-align:right;
  font-weight:900;
}

.cargo{
  margin-top:4mm;
  border:1px solid var(--line);
  border-radius:6px;
  padding:2mm 3mm;
  background:#fff;
  font-size:9.8px;
}
.cargo-title{
  font-weight:900;
  color:#6A4D40;
  margin-bottom:2mm;
}
.cargo-grid{
  display:grid;
  grid-template-columns:1fr 1fr 1fr;
  gap:2.5mm 5mm;
}
.cargo-item{
  min-width:0;
  line-height:1.35;
}
.cargo-label{
  color:#666;
  font-size:9.5px;
  font-weight:700;
}
.cargo-value{
  font-weight:700;
  white-space:nowrap;
}
.invoice-frame{
  margin-top:4mm;
  border:1px solid var(--line);
  border-radius:6px;
  overflow:hidden;
}

.invoice-table{
  margin-top:0;
}

table{
  width:100%;
  border-collapse:collapse;
  font-size:9.6px;
}

/* 明細ヘッダー：罫線色を他と統一 */
th{
  background:#D8B8A8;
  color:#3d2c26;
  padding:1.6mm 1.4mm;
  border-top:1px solid #B78D78;
  border-bottom:1px solid #B78D78;
  text-align:center;
  -webkit-print-color-adjust:exact;
  print-color-adjust:exact;
}

td{
  padding:1.15mm 1.4mm;
  border-bottom:1px solid #eee;
  vertical-align:middle;
}
td.no,td.num{
  text-align:right;
  font-variant-numeric:tabular-nums;
}
td.center{text-align:center}
tbody tr.blank td{
  color:transparent;
}
.total-row td{
  border-bottom:none;
  padding:1.9mm 1.8mm;
  font-weight:900;
}
.total-label{
  text-align:right;
}
.total-amount{
  text-align:right;
  border-top:1px solid #111;
}

.blank-row td{
  height:5.2mm;
  color:transparent;
}

.bank{
  margin-top:0;
  border:none;
  border-top:1px solid var(--line);
  border-radius:0;
  padding:2mm 3mm;
  font-size:10.5px;
  line-height:1.6;
  background:#fff;
}

.note{
  margin-top:2mm;
  font-size:9.5px;
  color:#555;
}

@media print{
  html,
  body{
    margin:0;
    padding:0;
    background:white;
  }

  .topbar{
    display:none !important;
  }

  .sheet{
    margin:0;
    width:210mm;
    min-height:auto;
    padding:5mm 7mm;
    box-shadow:none;
  }
}

</style>
</head>
<body>
<header class="topbar">
  <strong>請求書プレビュー</strong>
  <div>
    <button class="btn" onclick="history.back()">戻る</button>
    <button class="btn primary" onclick="window.print()">印刷</button>
  </div>
</header>

<section class="sheet">
  <div class="header">
    <div>
      <div class="title">請 求 書</div>
    </div>

    <div class="company-box">
      <div class="company-main">
        <img
            class="logo-img"
            src="https://portal.bizlabo-tokyo.com/assets/bizlabo-logo.png">
      <div>
        <div class="company-name">株式会社ビジネスラボ</div>
        <div class="company-detail">
          〒103-0026 東京都中央区日本橋兜町2-13<br>
          兜町第6葉山ビル4階<br>
          TEL: 03-6555-4496 FAX: 03-4496-4103<br>
          登録番号: T7010003027314
        </div>
      </div>
     </div>
      <img
        class="company-stamp"
        src="https://portal.bizlabo-tokyo.com/assets/bizlabo-stamp.png">
    </div>
  </div>

  <div class="bill-area">
  <div>
    <div class="billto-name">${esc(header.customer_name || '')} 御中</div>
    <div class="greeting">
      いつも御利用頂き、誠に有難う御座います。下記の通り御請求申し上げます。<br>
      お支払期限：${formatJaDate(dueDate)}
    </div>
  </div>

  <div class="meta-table">
    <div class="meta-row">
      <div class="meta-label">請求日</div>
      <div class="meta-value">${formatJaDate(header.invoice_date)}</div>
    </div>

    <div class="meta-row">
      <div class="meta-label">請求書番号</div>
      <div class="meta-value">${esc(displayInvoiceNo)}</div>
    </div>

    <div class="meta-row">
      <div class="meta-label">作業名</div>
      <div class="meta-value">${esc(workName)}</div>
    </div>
  </div>
</div>

  <div class="amount-tax">
    <div class="amount-box">
      <div class="amount-label">ご請求金額</div>
      <div class="amount-value">¥${yen(salesGross)}-</div>
    </div>

    <div class="tax-summary">
      <div class="tax-grid">
        <div class="tax-cell">
          <span class="tax-label">課税対象</span>
          <span class="tax-value">¥${yen(taxableTotal)}</span>
        </div>
        <div class="tax-cell">
          <span class="tax-label">消費税</span>
          <span class="tax-value">¥${yen(salesTax)}</span>
        </div>
        <div class="tax-cell">
          <span class="tax-label">非課税/不課税</span>
          <span class="tax-value">¥${yen(nonTaxableTotal)}</span>
        </div>
        <div class="tax-cell">
          <span class="tax-label">免税</span>
          <span class="tax-value">¥${yen(exemptTotal)}</span>
        </div>
      </div>
    </div>
  </div>

  <div class="cargo">
    <div class="cargo-title">出荷情報</div>
    <div class="cargo-grid">
      <div class="cargo-item">
  <div class="cargo-label">HBL / MBL</div>
  <div class="cargo-value">${esc(header.hbl_no || '')} / ${esc(header.mbl_no || '')}</div>
</div>

<div class="cargo-item">
  <div class="cargo-label">ETD / ETA</div>
  <div class="cargo-value">${esc(etd)} / ${esc(header.eta || '')}</div>
</div>
      <div class="cargo-item">
        <div class="cargo-label">Vessel / Voyage</div>
        <div class="cargo-value">${esc(header.vessel || '')} / ${esc(header.voyage || '')}</div>
      </div>
      <div class="cargo-item">
        <div class="cargo-label">POL / POD</div>
        <div class="cargo-value">${esc(header.pol || '')} / ${esc(header.pod || '')}</div>
      </div>
      <div class="cargo-item">
        <div class="cargo-label">数量 / 重量 / 容積</div>
        <div class="cargo-value">${esc(qtyText)}</div>
      </div>
      <div class="cargo-item">
        <div class="cargo-label">搬入確認番号</div>
        <div class="cargo-value">${esc(header.inbound_no || '')}</div>
      </div>
      <div class="cargo-item">
        <div class="cargo-label">Commercial Invoice</div>
        <div class="cargo-value">${esc(header.commercial_invoice_no || '')}</div>
      </div>
      <div class="cargo-item">
        <div class="cargo-label">配達情報</div>
        <div class="cargo-value">${esc(header.remarks || '')}</div>
      </div>
      <div class="cargo-item">
        <div class="cargo-label">品名</div>
        <div class="cargo-value">${esc(cargoName)}</div>
      </div>
    </div>
  </div>

<div class="invoice-frame">

  <div class="invoice-table">
    <table>
      <thead>
        <tr>
            <th style="width:8mm">No</th>
            <th>項目</th>
            <th style="width:22mm">税区分</th>
            <th style="width:14mm">数量</th>
            <th style="width:18mm;">単位</th>
            <th style="width:22mm">単価</th>
            <th style="width:26mm">金額</th>
            <th style="width:32mm">備考</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
        ${blankRowsHtml}
      </tbody>
    </table>
  </div>

  <div class="bank">
    <strong>お振込先</strong><br>
    三井住友銀行　日本橋東支店　普通 7828377　ｶ)ﾋﾞｼﾞﾈｽﾗﾎﾞ    ※振込手数料は貴社にてご負担をお願いいたします。
   <div class="note">
    備考：本請求書はinvoice_headers / invoice_lines のデータを正本として作成しています。
  </div>
</div>
</section>
</body>
</html>`;
}