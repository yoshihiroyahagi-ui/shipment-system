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

export function renderInvoiceHtml(payload) {
  const { header, invoiceLines } = payload;

  const salesNet = toNumber(header.sales_net_total);
  const salesTax = toNumber(header.sales_tax_total);

  const salesGross =
    toNumber(header.sales_gross_total) ||
    invoiceLines.reduce((sum, l) => {
      return sum + toNumber(l.billing_amount_gross || l.billing_amount_net);
    }, 0);

  const qtyText = [
    header.pcs_total ? `${yen(header.pcs_total)} ${header.package_unit || ''}` : '',
    header.gw_total ? `${yen(header.gw_total)} KG` : '',
    header.cbm_total ? `${header.cbm_total} M3` : ''
  ].filter(Boolean).join('　　');

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
<title>請求書 ${esc(header.invoice_no || '')}</title>
<style>
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans JP",sans-serif;background:#ECE6F0;color:#111}
.topbar{height:64px;background:#FFFBFE;border-bottom:1px solid #CAC4D0;display:flex;align-items:center;justify-content:space-between;padding:0 24px;position:sticky;top:0;z-index:10}
.brand{display:flex;align-items:center;gap:12px;font-weight:700;font-size:18px}
.logo{width:36px;height:36px;border-radius:12px;background:#6750A4;color:white;display:grid;place-items:center;font-weight:800}
.btn{border:none;border-radius:999px;padding:10px 18px;font-weight:700;cursor:pointer;background:#ECE6F0}
.btn.primary{background:#6750A4;color:white}
.sheet{width:210mm;min-height:297mm;margin:24px auto;background:white;padding:18mm;box-shadow:0 8px 30px rgba(0,0,0,.15)}
.invoice-head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #1D1B20;padding-bottom:16px}
.invoice-title{font-size:30px;font-weight:900;letter-spacing:.25em}
.company{text-align:right;font-size:12px;line-height:1.7}
.billto{margin-top:28px;display:grid;grid-template-columns:1fr 72mm;gap:18px}
.billto-name{font-size:20px;font-weight:800;border-bottom:1px solid #111;padding-bottom:8px}
.summary-box{border:1px solid #111;border-radius:8px;overflow:hidden}
.summary-row{display:grid;grid-template-columns:28mm 1fr;border-bottom:1px solid #111}
.summary-row:last-child{border-bottom:none}
.summary-label{background:#F3EDF7;padding:8px;font-weight:700;font-size:12px}
.summary-value{padding:8px;text-align:right;font-weight:700}
.amount{margin-top:18px;border:2px solid #111;display:grid;grid-template-columns:45mm 1fr;align-items:center}
.amount-label{background:#1D1B20;color:white;padding:12px;font-weight:800;text-align:center}
.amount-value{font-size:24px;font-weight:900;text-align:right;padding:10px 16px}
.cargo{margin-top:22px;border:1px solid #999;border-radius:10px;padding:12px;font-size:12px;line-height:1.8;background:#FFFBFE}
.invoice-table{margin-top:22px;border:1px solid #111;border-radius:8px;overflow:hidden}
table{width:100%;font-size:12px;border-collapse:collapse}
th{background:#EADDFF;color:#21005D;border:1px solid #999;text-align:center;padding:8px}
td{border:1px solid #999;padding:8px}
.num{text-align:right;font-variant-numeric:tabular-nums}
.total td{font-weight:900;background:#F7F2FA}
.bank{margin-top:20px;border:1px solid #999;border-radius:10px;padding:12px;font-size:12px;line-height:1.8}
.note{margin-top:18px;font-size:11px;line-height:1.7;color:#333}
.stamp{width:72px;height:72px;border:3px solid #B3261E;color:#B3261E;border-radius:50%;display:grid;place-items:center;font-weight:900;margin-left:auto;opacity:.75}
@media print{.topbar{display:none}body{background:white}.sheet{box-shadow:none;margin:0;width:auto;min-height:auto}}
</style>
</head>
<body>
<header class="topbar">
  <div class="brand"><div class="logo">BL</div>請求書プレビュー</div>
  <div>
    <button class="btn" onclick="history.back()">戻る</button>
    <button class="btn primary" onclick="window.print()">印刷</button>
  </div>
</header>

<section class="sheet">
  <div class="invoice-head">
    <div>
      <div class="invoice-title">請 求 書</div>
      <div style="margin-top:12px;font-size:12px">Invoice No. ${esc(header.invoice_no || '')}</div>
    </div>
    <div class="company">
      <strong>株式会社 Business Labo</strong><br>
      東京都渋谷区〇〇 1-2-3<br>
      TEL: 03-0000-0000<br>
      登録番号: T0000000000000<br>
      <div class="stamp">印</div>
    </div>
  </div>

  <div class="billto">
    <div>
      <div class="billto-name">${esc(header.customer_name || '')} 御中</div>
      <p style="font-size:12px;line-height:1.8;margin-top:14px">
        下記の通りご請求申し上げます。<br>
        お支払期限：${esc(header.due_date || '')}
      </p>
    </div>
    <div class="summary-box">
      <div class="summary-row"><div class="summary-label">請求日</div><div class="summary-value">${esc(header.invoice_date || '')}</div></div>
      <div class="summary-row"><div class="summary-label">Job No</div><div class="summary-value">${esc(header.job_no || '')}</div></div>
      <div class="summary-row"><div class="summary-label">HBL</div><div class="summary-value">${esc(header.hbl_no || '')}</div></div>
      <div class="summary-row"><div class="summary-label">ETA</div><div class="summary-value">${esc(header.eta || '')}</div></div>
    </div>
  </div>

  <div class="amount">
    <div class="amount-label">ご請求金額</div>
    <div class="amount-value">¥${yen(salesGross)}-</div>
  </div>

  <div class="cargo">
    <strong>出荷情報</strong><br>
    Vessel / Voyage：${esc(header.vessel || '')} / ${esc(header.voyage || '')}　　POL/POD：${esc(header.pol || '')} / ${esc(header.pod || '')}<br>
    MBL：${esc(header.mbl_no || '')}　　品名：${esc(header.cargo_summary || '')}<br>
    ${esc(qtyText)}<br>
    搬入確認番号：${esc(header.inbound_no || '')}　　Commercial Invoice：${esc(header.commercial_invoice_no || '')}<br>
    配達情報：${esc(header.remarks || '')}
  </div>

  <div class="invoice-table">
    <table>
      <thead>
        <tr>
          <th style="width:10mm">No</th>
          <th>項目</th>
          <th style="width:24mm">税区分</th>
          <th style="width:18mm">数量</th>
          <th style="width:28mm">単価</th>
          <th style="width:32mm">金額</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
        <tr class="total"><td colspan="5">小計</td><td class="num">${yen(salesNet)}</td></tr>
        <tr class="total"><td colspan="5">消費税</td><td class="num">${yen(salesTax)}</td></tr>
        <tr class="total"><td colspan="5">合計</td><td class="num">${yen(salesGross)}</td></tr>
      </tbody>
    </table>
  </div>

  <div class="bank">
    <strong>お振込先</strong><br>
    〇〇銀行　〇〇支店　普通 0000000　株式会社 Business Labo<br>
    ※振込手数料は貴社にてご負担をお願いいたします。
  </div>

  <div class="note">
    備考：本請求書はinvoice_headers / invoice_lines のデータを正本として作成しています。
  </div>
</section>
</body>
</html>`;
}