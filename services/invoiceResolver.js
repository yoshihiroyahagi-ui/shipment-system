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