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

export function renderInvoiceHtml(payload) {
  const { header, invoiceLines } = payload;

  const dueDate =
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
    header.pcs_total ? `${yen(header.pcs_total)} ${header.package_unit || ''}` : '',
    header.gw_total ? `${yen(header.gw_total)} KG` : '',
    header.cbm_total ? `${header.cbm_total} M3` : ''
  ].filter(Boolean).join('　　');

  const displayInvoiceNo =
    header.job_no ||
    header.invoice_no ||
    header.commercial_invoice_no ||
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

  const rowsHtml = invoiceLines.map((l, idx) => `
    <tr>
      <td class="num">${idx + 1}</td>
      <td>${esc(l.item_name || '')}</td>
      <td>${esc(taxLabel(l.billing_tax_type))}</td>
      <td class="num">1</td>
      <td class="num">${yen(l.billing_amount_net)}</td>
      <td class="num">${yen(l.billing_amount_net)}</td>
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
  margin:6mm 7mm;
}
*{box-sizing:border-box}
body{
  margin:0;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans JP",sans-serif;
  color:#111;
  background:#eee;
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
}
.header{
  display:grid;
  grid-template-columns:1fr 82mm;
  gap:12mm;
  align-items:start;
  border-bottom:2px solid #111;
  padding-bottom:6mm;
}
.title{
  font-size:30px;
  font-weight:900;
  letter-spacing:.35em;
  margin-top:5mm;
}
.company-box{
  display:grid;
  grid-template-columns:1fr 22mm;
  gap:6mm;
  align-items:start;
}
.company-main{
  display:grid;
  grid-template-columns:14mm 1fr;
  gap:4mm;
  align-items:center;
}
.logo-mark{
  width:13mm;
  height:13mm;
  border-radius:4mm;
  background:var(--brand);
  display:grid;
  place-items:center;
  font-weight:900;
  color:#5c443b;
}
.company-name{
  font-size:17px;
  font-weight:900;
}
.company-detail{
  grid-column:1/-1;
  font-size:10.5px;
  line-height:1.55;
  margin-top:2mm;
}
.stamp{
  width:18mm;
  height:18mm;
  border:2px solid #b3261e;
  color:#b3261e;
  border-radius:50%;
  display:grid;
  place-items:center;
  font-weight:900;
  opacity:.75;
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
  border-radius:5px;
  overflow:hidden;
  font-size:11.5px;
}
.meta-row{
  display:grid;
  grid-template-columns:24mm 1fr;
  border-bottom:1px solid #111;
}
.meta-row:last-child{border-bottom:none}
.meta-label{
  background:var(--brand-soft);
  padding:2.5mm;
  font-weight:800;
}
.meta-value{
  padding:2.5mm;
  text-align:right;
  font-weight:800;
}
.amount-tax{
  margin-top:5mm;
  display:grid;
  grid-template-columns:1fr 78mm;
  gap:5mm;
}
.amount-box{
  border:2px solid #111;
  display:grid;
  grid-template-columns:36mm 1fr;
  height:14mm;
  align-items:center;
}
.amount-label{
  background:#111;
  color:white;
  height:100%;
  display:grid;
  place-items:center;
  font-size:12px;
  font-weight:900;
}
.amount-value{
  font-size:22px;
  font-weight:900;
  text-align:right;
  padding-right:5mm;
}
.tax-summary{
  border:1px solid var(--line);
  border-radius:5px;
  overflow:hidden;
  font-size:10.5px;
}
.tax-grid{
  display:grid;
  grid-template-columns:1fr 1fr;
}
.tax-cell{
  display:flex;
  justify-content:space-between;
  gap:4mm;
  padding:1.8mm 2.4mm;
  border-bottom:1px solid var(--line);
}
.tax-cell:nth-child(odd){
  border-right:1px solid var(--line);
}
.tax-cell:nth-last-child(-n+2){
  border-bottom:none;
}
.tax-label{
  color:#555;
  font-weight:700;
}
.tax-value{
  font-weight:900;
}
.cargo{
  margin-top:5mm;
  border:1px solid var(--line);
  border-radius:6px;
  padding:3mm 4mm;
  background:#fff;
  font-size:10.7px;
}
.cargo-title{
  font-weight:900;
  margin-bottom:2mm;
}
.cargo-grid{
  display:grid;
  grid-template-columns:1fr 1fr 1fr;
  gap:3mm 6mm;
}
.cargo-item{
  line-height:1.45;
}
.cargo-label{
  color:#666;
  font-size:9.5px;
  font-weight:700;
}
.cargo-value{
  font-weight:700;
}
.invoice-table{
  margin-top:5mm;
}
table{
  width:100%;
  border-collapse:collapse;
  font-size:10.5px;
}
th{
  background:var(--brand);
  color:#3d2c26;
  padding:2.1mm 1.8mm;
  border-top:1px solid #111;
  border-bottom:1px solid #111;
  text-align:center;
}
td{
  padding:1.7mm 1.8mm;
  border-bottom:1px solid #e6e0dd;
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
.bank{
  margin-top:5mm;
  border:1px solid var(--line);
  border-radius:6px;
  padding:3mm 4mm;
  font-size:10.5px;
  line-height:1.6;
}
.note{
  margin-top:3mm;
  font-size:9.5px;
  color:#555;
}
@media print{
  body{background:white}
  .topbar{display:none}
  .sheet{
    margin:0;
    width:auto;
    min-height:auto;
    padding:0;
  }
}

.logo-img{
  width:52px;
  height:auto;
}

.company-box{
  position:relative;
}

.company-stamp{
  position:absolute;

  right:-10px;
  top:10px;

  width:90px;

  opacity:.7;

  transform:rotate(-8deg);

  z-index:10;
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
        お支払期限：${esc(dueDate)}
      </div>
    </div>

    <div class="meta-table">
      <div class="meta-row">
        <div class="meta-label">請求日</div>
        <div class="meta-value">${esc(header.invoice_date || '')}</div>
      </div>
      <div class="meta-row">
        <div class="meta-label">請求書番号</div>
        <div class="meta-value">${esc(displayInvoiceNo)}</div>
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
        <div class="cargo-label">Job No / HBL</div>
        <div class="cargo-value">${esc(header.job_no || '')} / ${esc(header.hbl_no || '')}</div>
      </div>
      <div class="cargo-item">
        <div class="cargo-label">MBL / ETA</div>
        <div class="cargo-value">${esc(header.mbl_no || '')} / ${esc(header.eta || '')}</div>
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
        <div class="cargo-value">${esc(header.cargo_summary || '')}</div>
      </div>
    </div>
  </div>

  <div class="invoice-table">
    <table>
      <thead>
        <tr>
          <th style="width:9mm">No</th>
          <th>項目</th>
          <th style="width:24mm">税区分</th>
          <th style="width:16mm">数量</th>
          <th style="width:26mm">単価</th>
          <th style="width:30mm">金額</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
        <tr class="total-row">
          <td colspan="5" class="total-label">小計</td>
          <td class="total-amount">¥${yen(salesNet)}</td>
        </tr>
        <tr class="total-row">
          <td colspan="5" class="total-label">消費税</td>
          <td class="total-amount">¥${yen(salesTax)}</td>
        </tr>
        <tr class="total-row">
          <td colspan="5" class="total-label">合計</td>
          <td class="total-amount">¥${yen(salesGross)}</td>
        </tr>
      </tbody>
    </table>
  </div>

  <div class="bank">
    <strong>お振込先</strong><br>
    三井住友銀行　日本橋東支店　普通 7828377　ｶ)ﾋﾞｼﾞﾈｽﾗﾎﾞ<br>
    ※振込手数料は貴社にてご負担をお願いいたします。
  </div>

  <div class="note">
    備考：本請求書はinvoice_headers / invoice_lines のデータを正本として作成しています。
  </div>
</section>
</body>
</html>`;
}