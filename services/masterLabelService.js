const MASTER_LABELS = {
  INCOTERMS: {
    EXW: 'EXW',
    FOB: 'FOB',
    CIF: 'CIF',
    DDP: 'DDP'
  },
  CURRENCY: {
    USD: 'USD',
    JPY: 'JPY',
    EUR: 'EUR',
    CNY: 'CNY'
  },
  CUSTOMS_DOCS: {
    INV: 'Invoice',
    PL: 'Packing List',
    AN: 'Arrival Notice',
    BL: 'B/L'
  },
  REQUEST_BROKER: {
    DECLARATION: '申告依頼',
    DELIVERY: '配送手配',
    INSPECTION: '検査対応'
  },
  COST_COVER: {
    SHIPPER: 'Shipper',
    CONSIGNEE: 'Consignee',
    COLLECT: 'Collect',
    PREPAID: 'Prepaid'
  },
  CONTAINER_TYPE: {
    '20GP': '20GP',
    '20GP(B)': '20GP(B)',
    '40HQ': '40HQ',
    '40HQ(B)': '40HQ(B)'
  }
};

export function getMasterLabel(type, code) {
  if (!code) return '';
  return MASTER_LABELS[type]?.[code] || code;
}