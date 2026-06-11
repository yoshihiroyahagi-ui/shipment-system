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
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return esc(v);
  return `${d.getFullYear()}年 ${d.getMonth() + 1}月 ${d.getDate()}日`;
}

function renderRemark(r) {
  return `
    <div class="remark-grid">
      <span>${esc(r.remark1)}</span>
      <span>${esc(r.remark2)}</span>
      <span>${esc(r.remark3)}</span>
      <span>${esc(r.remark4)}</span>
    </div>
  `;
}

export function renderTotalInvoiceHtml(data = {}) {
  const rows = data.rows || [];
  const totals = data.totals || {};

  const invoiceDate = data.invoice_date || data.invoiceDate || new Date();
  const dueDate = data.due_date || data.payment_due_date || data.dueDate || '';

  const rowHtml = rows.map((r, i) => `
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
  `).join('');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>一括請求明細書</title>
<style>
*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
:root{--main:#B78D78;--border:#B78D78}
body{margin:0;background:#fff;font-family:"Yu Gothic","Meiryo",sans-serif;color:#111}
.page{width:1123px;min-height:794px;margin:0 auto;padding:28px 34px;background:#fff}
.top-bar{background:var(--main);color:#fff;padding:14px 22px;font-size:26px;font-weight:bold;display:flex;justify-content:space-between}
.header{display:grid;grid-template-columns:38% 28% 34%;gap:24px;margin-top:28px;align-items:start}
.label{background:var(--main);color:#fff;padding:8px 16px;font-weight:bold;display:inline-block;min-width:96px;text-align:center}
.box{border:1px solid var(--border);padding:18px;min-height:100px;line-height:1.6}
.amount-box{border:1px solid var(--border);text-align:center;padding:16px}
.amount-title{background:var(--main);color:#fff;display:inline-block;padding:6px 22px;font-weight:bold;margin-top:-34px}
.amount{font-size:34px;font-weight:bold;margin-top:18px}
.company{padding-top:28px;line-height:1.7}
.company-title{font-size:20px;font-weight:bold;color:var(--main);margin-bottom:14px}
table{width:100%;border-collapse:collapse;margin-top:28px;font-size:14px}
th{background:var(--main);color:#fff;border:1px solid var(--border);padding:9px 6px;text-align:center}
td{border:1px solid var(--border);padding:8px 8px;height:42px}
.center{text-align:center}.right{text-align:right}.bold{font-weight:bold}
.remark-cell{padding:0}
.remark-grid{display:grid;grid-template-columns:27% 38% 17% 18%;padding:8px 10px;column-gap:18px;white-space:nowrap}
.total-row td{background:var(--main);color:#fff;font-weight:bold}
.total-row .blank{background:#fff;color:#111}
.bottom{display:grid;grid-template-columns:23% 32% 45%;gap:18px;margin-top:20px}
.bottom-title{background:var(--main);color:#fff;text-align:center;padding:8px;font-weight:bold}
.bottom-box{border:1px solid var(--border);min-height:86px;padding:18px;line-height:1.6}
@media print{
  @page{size:A4 landscape;margin:8mm}
  .page{width:auto;min-height:auto;padding:0}
}
</style>
</head>

<body>
<div class="page">

  <div class="top-bar">
    <div>一括請求明細書</div>
    <div>1 / 1 ページ</div>
  </div>

  <div class="header">
    <div>
      <div style="margin-bottom:12px;">
        <span class="label">請求日</span>
        <span style="margin-left:24px;font-size:18px;">${formatDateJa(invoiceDate)}</span>
      </div>

      <span class="label">ご請求先</span>
      <div class="box">
        ${esc(data.customer_name)}　御中<br>
        ${esc(data.customer_address || '')}
      </div>
    </div>

    <div style="padding-top:58px;">
      <div class="amount-box">
        <div class="amount-title">御請求金額</div>
        <div class="amount">${yen(totals.total_amount)}-</div>
        <div>（うち消費税額 ${yen(totals.tax_amount)}-）</div>
      </div>
    </div>

    <div class="company">
      <div class="company-title">${esc(data.company_name || '株式会社シッピングソリューションズ')}</div>
      ${esc(data.company_postal || '〒104-0045')}<br>
      ${esc(data.company_address1 || '東京都中央区築地2-11-24')}<br>
      ${esc(data.company_address2 || '第29興和ビル 5F')}<br>
      TEL：${esc(data.company_tel || '03-6264-2737')}　FAX：${esc(data.company_fax || '03-6264-2738')}<br>
      登録番号：${esc(data.invoice_registration_no || 'T3010001171046')}
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width:4%;">No.</th>
        <th style="width:13%;">請求書No.</th>
        <th style="width:10%;">課税対象金額</th>
        <th style="width:9%;">消費税</th>
        <th style="width:10%;">非課税金額</th>
        <th style="width:10%;">対象外／立替</th>
        <th style="width:11%;">請求合計金額</th>
        <th style="width:33%;">備考</th>
      </tr>
    </thead>
    <tbody>
      ${rowHtml}

      <tr class="total-row">
        <td colspan="2" class="center">合計</td>
        <td class="right">${yen(totals.taxable_amount)}</td>
        <td class="right">${yen(totals.tax_amount)}</td>
        <td class="right">${yen(totals.exempt_amount)}</td>
        <td class="right">${yen(totals.advance_amount)}</td>
        <td class="right">${yen(totals.total_amount)}</td>
        <td class="blank"></td>
      </tr>
    </tbody>
  </table>

  <div class="bottom">
    <div>
      <div class="bottom-title">支払期限</div>
      <div class="bottom-box center" style="font-size:22px;padding-top:26px;">
        ${formatDateJa(dueDate)}
      </div>
    </div>

    <div>
      <div class="bottom-title">お振込先</div>
      <div class="bottom-box">
        ${esc(data.bank_info || '三井住友銀行　日本橋支店（店番号：012）\\n普通預金　1234567\\nカ）シッピングソリューションズ').replaceAll('\\n', '<br>')}
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