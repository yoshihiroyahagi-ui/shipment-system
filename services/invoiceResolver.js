// services/invoiceResolver.js
import { supabase } from '../lib/supabase.js';

export async function resolveInvoicePayloadByShipmentId(shipmentId) {
  if (!shipmentId) throw new Error('shipment_id is required');

  const { data: shipment, error: sErr } = await supabase
    .from('shipments')
    .select('*')
    .eq('shipment_id', shipmentId)
    .single();

  if (sErr) throw sErr;
  if (!shipment) throw new Error('shipment not found');

  const { data: customer } = await supabase
    .from('customers')
    .select('*')
    .eq('customer_code', shipment.customer_code)
    .maybeSingle();

  const { data: lines = [] } = await supabase
    .from('shipment_lines')
    .select('*')
    .eq('shipment_id', shipmentId);

  const { data: containers = [] } = await supabase
    .from('shipment_containers')
    .select('*')
    .eq('shipment_id', shipmentId)
    .order('sort_no', { ascending: true });

  const { data: charges = [] } = await supabase
    .from('shipment_charges')
    .select('*')
    .eq('shipment_id', shipmentId)
    .order('created_at', { ascending: true });

  return {
    shipment,
    customer,
    lines,
    containers,
    charges
  };
}
export async function resolveInvoicePayloadByInvoiceId(invoiceId) {
  if (!invoiceId) throw new Error('invoice_id is required');

  const { data: header, error: hErr } = await supabase
    .from('invoice_headers')
    .select('*')
    .eq('invoice_id', invoiceId)
    .single();

  if (hErr) throw hErr;
  if (!header) throw new Error('invoice not found');

  const { data: invoiceLines = [], error: lErr } = await supabase
    .from('invoice_lines')
    .select('*')
    .eq('invoice_id', invoiceId)
    .eq('show_on_invoice', true)
    .order('line_no', { ascending: true });

  if (lErr) throw lErr;

  const { data: payableLines = [], error: pErr } = await supabase
    .from('payable_lines')
    .select('*')
    .eq('invoice_id', invoiceId)
    .order('created_at', { ascending: true });

  if (pErr) throw pErr;

  return {
    header,
    invoiceLines,
    payableLines
  };
}