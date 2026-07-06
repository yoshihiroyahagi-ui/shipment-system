// renderers/totalInvoiceRenderer.js

function esc(v) {
  return String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function yen(v) {
  const n = Number(v || 0);
  return `￥${Math.round(n).toLocaleString('ja-JP')}`;
}

function formatDateJa(v) {
  if (!v) return '';

  const s = String(v).slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (m) {
    return `${m[1]}年 ${Number(m[2])}月 ${Number(m[3])}日`;
  }

  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return esc(v);

  return `${d.getFullYear()}年 ${d.getMonth() + 1}月 ${d.getDate()}日`;
}

function renderRemark(r) {
  return `
    <div class="remark-line">
      <span class="remark-commercial">${esc(r.remark1 || '')}</span>
      <span class="remark-free">${esc(r.remark2 || '')}</span>
    </div>
  `;
}

export function renderTotalInvoiceHtml(data = {}) {
  console.log('[renderTotalInvoiceHtml called]', data);
  const rows = data.rows || [];
  const totals = data.totals || {};

  const invoiceDate = data.invoice_date || data.invoiceDate || new Date();

console.log('[bulk invoice date]', {
  raw: data.invoice_date,
  invoiceDate,
  formatted: formatDateJa(invoiceDate)
});
  const dueDate = data.due_date || data.payment_due_date || data.dueDate || '';

  const pageSize = 20;

const pages = [];
for (let i = 0; i < rows.length; i += pageSize) {
  pages.push(rows.slice(i, i + pageSize));
}

const tableHeaderHtml = `
  <thead>
    <tr>
      <th style="width:5.56%;">No.</th>
      <th style="width:11.11%;">請求書No.</th>
      <th style="width:11.11%;">課税対象金額</th>
      <th style="width:11.11%;">消費税</th>
      <th style="width:11.11%;">非課税金額</th>
      <th style="width:11.11%;">対象外／立替</th>
      <th style="width:11.11%;">請求合計金額</th>
      <th style="width:27.78%;">備考</th>
    </tr>
  </thead>
`;

const tablesHtml = pages.map((pageRows, pageIndex) => {
  const bodyRows = pageRows.map((r, j) => {
    const i = pageIndex * pageSize + j;

    return `
      <tr>
        <td class="center">${i + 1}</td>
        <td class="center">${esc(r.invoice_no)}</td>
        <td class="right">${yen(r.taxable_amount)}</td>
        <td class="right">${yen(r.tax_amount)}</td>
        <td class="right">${yen(r.exempt_amount)}</td>
        <td class="right">${yen(r.advance_amount)}</td>
        <td class="right bold">${yen(r.total_amount)}</td>
        <td class="remark-cell">${renderRemark(r)}</td>
      </tr>
    `;
  }).join('');

  const totalRow = pageIndex === pages.length - 1
    ? `
      <tr class="total-row">
        <td colspan="2" class="center">合計</td>
        <td class="right">${yen(totals.taxable_amount)}</td>
        <td class="right">${yen(totals.tax_amount)}</td>
        <td class="right">${yen(totals.exempt_amount)}</td>
        <td class="right">${yen(totals.advance_amount)}</td>
        <td class="right">${yen(totals.total_amount)}</td>
        <td class="blank"></td>
      </tr>
    `
    : '';

  return `
    <table>
      ${tableHeaderHtml}
      <tbody>
        ${bodyRows}
        ${totalRow}
      </tbody>
    </table>
  `;
}).join('<div class="page-break"></div>');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>一括請求明細書</title>
<style>
*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
:root{--main:#B78D78;--border:#B78D78}
html,body{
  width:100%;
  margin:0;
  padding:0;
  background:#fff;
}

body{
  font-family:"Yu Gothic","Meiryo",sans-serif;
  color:#111;
}

.page{
  width:297mm;
  min-height:210mm;
  margin:0 auto;
  padding:8mm;
  background:#fff;
  position:relative;
}
.top-bar{background:var(--main);color:#fff;padding:14px 22px;font-size:26px;font-weight:bold;display:flex;justify-content:space-between}
.page-no{
  font-size:10px;
  font-weight:normal;
  align-self:center;
}
.header{
  display:grid;
  grid-template-columns:40% 30% 30%;
  gap:8mm;
  margin-top:10px;
  align-items:start;
}
.label{
  background:var(--main);
  color:#fff;
  padding:4px 10px;
  font-size:10px;
  font-weight:700;
  display:inline-block;
  min-width:60px;
  text-align:center;
}
  .invoice-date-text{
  margin-left:14px;
  font-size:11px;
  font-weight:700;
}
.box{
  border:1px solid var(--border);
  padding:12px;
  height:70px;
  min-height:70px;
  box-sizing:border-box;

  line-height:1.5;
  font-size:13px;
  font-weight:700;
}
.amount-wrap{
  padding-top:65px;
}

.amount-box{
  border:1px solid var(--border) !important;
  height:70px;
  min-height:70px;
  box-sizing:border-box;

  display:flex;
  align-items:center;
  justify-content:center;
  gap:14px;

  padding:0 12px;
  background:#fff;
}
.amount-title{
  color:var(--main);
  background:none;
  padding:0;
  font-size:18px;
  font-weight:700;
  white-space:nowrap;
}
.amount{
  font-size:24px;
  font-weight:700;
  white-space:nowrap;
  margin:0;
}

.company-box{
  position:relative;
  margin-left:0;
  padding-right:0;
  min-height:20mm;
  overflow:visible;
}

.company-main{
  display:grid;
  grid-template-columns:18mm 1fr;
  gap:7mm;
  align-items:start;
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
  font-size:6.5px;
  line-height:1.3;
  margin-top:1mm;
  white-space:nowrap;
}
table{
  width:100%;
  table-layout:fixed;
  border-collapse:collapse;
  margin-top:18px;
  margin-bottom:32mm;
  font-size:9px;
  table-layout:fixed;
}

th{
  border-top:1px solid var(--border);
  border-bottom:1px solid var(--border);
  border-left:none;
  border-right:none;
}

td{
  border-top:1px solid var(--border);
  border-bottom:1px solid var(--border);
  border-left:none;
  border-right:none;
}
.center{text-align:center}.right{text-align:right}.bold{font-weight:bold}
.remark-cell{padding:0 10px}
.remark-line{
  display:flex;
  gap:10px;
  white-space:nowrap;
}

.remark-line{
  display:flex;
  width:100%;
  gap:8px;
  white-space:nowrap;
}

.remark-invoice{
  flex:6;
  overflow:hidden;
  text-overflow:ellipsis;
}

.remark-free{
  flex:4;
  overflow:hidden;
  text-overflow:ellipsis;
}
.total-row td{background:var(--main);color:#fff;font-weight:bold}
.total-row .blank{background:#fff;color:#111}
.bottom{
  position:absolute;
  left:8mm;
  right:8mm;
  bottom:8mm;
  display:grid;
  grid-template-columns:22% 34% 44%;
  gap:8px;
  margin-top:0;
}

.bottom-title{
  background:var(--main);
  color:#fff;
  text-align:center;
  padding:4px;
  font-weight:bold;
  font-size:9px;
}

.bottom-box{
  border:1px solid var(--border);
  min-height:16mm;
  padding:5px 8px;
  line-height:1.25;
  font-size:8px;
}
.page-break {
  break-before: page;
  page-break-before: always;
}
  
@media print{
  @page{
    size:A4 landscape;
    margin:0;
  }

  html,body{
    width:297mm;
    height:210mm;
    margin:0;
    padding:0;
    overflow:hidden;
  }

  .page{
    width:297mm;
    height:210mm;
    min-height:210mm;
    margin:0;
    padding:8mm;
    position:relative;
    overflow:hidden;
  }
}
</style>
</head>

<body>
<div class="page">

  <div class="top-bar">
  <div>一括請求明細書</div>
  <div class="page-no">1 / 1 ページ</div>
</div>

  <div class="header">
    <div>
      <div style="margin-bottom:12px;">
        <span class="label">請求日</span>
        <span class="invoice-date-text">
            ${formatDateJa(invoiceDate)}    
        </span>
      </div>

      <span class="label">ご請求先</span>
      <div class="box">
        ${esc(data.customer_name)}　御中<br>
        ${esc(data.customer_address || '')}
      </div>
    </div>

   
    <div class="amount-wrap">
        <div class="amount-box">
        <div class="amount-title">御請求金額</div>
        <div class="amount">${yen(totals.total_amount)}-</div>
    </div>
    </div>


    <div class="company-box">
  <div class="company-main">

    <img
      class="logo-img"
      src="https://portal.bizlabo-tokyo.com/assets/bizlabo-logo.png">

    <div>
      <div class="company-name">
        株式会社ビジネスラボ
      </div>

      <div class="company-detail">
        〒103-0026 東京都中央区日本橋兜町2-13<br>
        兜町第6葉山ビル4階<br>
        TEL: 03-6555-4496 FAX: 03-4496-4103<br>
        登録番号: T7010003027314
      </div>
    </div>
    </div>
  </div>
</div>

  ${tablesHtml}

  <div class="bottom">
    <div>
      <div class="bottom-title">支払期限</div>
      <div class="bottom-box center" style="font-size:12px;padding-top:9px;white-space:nowrap;">
        ${formatDateJa(dueDate)}
      </div>
    </div>

    <div>
      <div class="bottom-title">お振込先</div>
      <div class="bottom-box">
        ${esc(data.bank_info || '三井住友銀行　日本橋東支店（店番号：034）\\n普通預金　7828377\\nカ）ビジネスラボ').replaceAll('\\n', '<br>')}
      </div>
    </div>

    <div>
      <div class="bottom-title">備考</div>
      <div class="bottom-box">
        ・お振込手数料は貴社にてご負担をお願い申し上げます。<br>
        ・ご不明な点がございましたら、担当営業までお問い合わせください。<br>
        ・本明細書は請求書の一覧表となります。詳細は各請求書をご確認ください。
      </div>
    </div>
  </div>

</div>
</body>
</html>`;
}