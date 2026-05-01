export function buildDeliveryHtmlFromPayload(payload = {}) {
  const esc = (s) => String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const s = payload.shipment || {};
  const d = payload.delivery || {};
  const p = payload.party || {};

  return `
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>配送依頼書</title>
<style>
  body { font-family: Arial, "Yu Gothic", sans-serif; padding: 24px; }
  .title { text-align:center; font-size:22px; font-weight:bold; margin-bottom:20px; }
  .box { border:1px solid #333; padding:8px; margin-bottom:8px; white-space:pre-wrap; }
  .label { font-size:12px; font-weight:bold; color:#555; }
  @media print { .no-print { display:none; } }
</style>
</head>
<body>
<button class="no-print" onclick="window.print()">Print</button>

<div class="title">配送依頼書</div>

<div class="box">
  <div class="label">顧客</div>
  ${esc(p.customer_name || s.customer_name || '')}
</div>

<div class="box">
  <div class="label">JOB NO</div>
  ${esc(s.job_no)}
</div>

<div class="box">
  <div class="label">搬入先 / 引取場所</div>
  ${esc(s.pickup_place_name || '')}
</div>

<div class="box">
  <div class="label">配送先</div>
  ${esc(d.delivery_dest_name || d.address || '')}
</div>

</body>
</html>
`;
}