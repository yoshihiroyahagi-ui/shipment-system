// routes/invoice.js
import express from 'express';
import { resolveInvoicePayloadByShipmentId } from '../services/invoiceResolver.js';
import { supabase } from '../lib/supabase.js';

import {
  createInvoiceWorkbook,
  appendInvoiceSheets
} from '../services/invoiceExcelBuilder.js';

const router = express.Router();

router.get('/export-one', async (req, res) => {
  try {
    const shipmentId = req.query.shipment_id;

    const payload = await resolveInvoicePayloadByShipmentId(shipmentId);
    const wb = await buildInvoiceWorkbook(payload);

    const jobNo = payload.shipment.job_no || payload.shipment.shipment_id;
    const filename = `invoice_${jobNo}.xlsx`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(filename)}"`
    );

    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('[invoice export-one] error:', err);
    res.status(500).json({
      ok: false,
      error: err.message || String(err)
    });
  }
});

export default router;

router.get('/export', async (req, res) => {
  try {
    const billingMonth = String(req.query.billing_month || '').trim();

if (!billingMonth) {
  throw new Error('billing_month is required');
}

const billingMonthSlash = billingMonth.replace('-', '/');
const billingMonthHyphen = billingMonth.replace('/', '-');

const { data: shipments, error } = await supabase
  .from('shipments')
  .select('shipment_id, job_no, planned_billing_month')
  .in('planned_billing_month', [billingMonthHyphen, billingMonthSlash])
  .order('job_no', { ascending: true });

    if (error) throw error;

    const wb = await createInvoiceWorkbook();

    for (const s of shipments || []) {
      const payload =
        await resolveInvoicePayloadByShipmentId(s.shipment_id);

      await appendInvoiceSheets(wb, payload);
    }

    // テンプレ削除
    wb.removeWorksheet('請求書表');
    wb.removeWorksheet('請求書裏');

    const filename = `invoice_${billingMonth}.xlsx`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`
    );

    await wb.xlsx.write(res);

    res.end();

  } catch (err) {
    console.error('[invoice export]', err);

    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});