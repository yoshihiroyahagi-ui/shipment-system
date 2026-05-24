// services/invoiceExcelBuilder.js
import ExcelJS from 'exceljs';
import path from 'path';

const templatePath = path.resolve('templates/invoice_template.xlsx');

export async function createInvoiceWorkbook() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(templatePath);
  return wb;
}

function safeSheetName(name) {
  return String(name || '')
    .replace(/[\\/?*[\]:]/g, '')
    .slice(0, 31);
}

function toNum(v) {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function sumPackages(containers = []) {
  const map = new Map();

  for (const c of containers) {
    const pcsRaw = String(c.pcs || '').trim();
    const unitRaw = String(c.pkg_unit || '').trim();

    if (!pcsRaw && !unitRaw) continue;

    let qty = 0;
    let unit = unitRaw;

    const m = pcsRaw.match(/^([\d,.]+)\s*(.*)$/);

    if (m) {
      qty = toNum(m[1]);
      if (!unit) unit = String(m[2] || '').trim();
    } else {
      qty = toNum(pcsRaw);
    }

    if (!qty) continue;
    if (!unit) unit = 'PCS';

    map.set(unit, (map.get(unit) || 0) + qty);
  }

  return [...map.entries()]
    .map(([unit, qty]) => `${qty.toLocaleString('en-US')}${unit}`)
    .join(' ');
}

function sumField(containers = [], field) {
  return containers.reduce((sum, c) => sum + toNum(c[field]), 0);
}

function formatJpDate(v, withYear = false) {
  if (!v) return '';

  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);

  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();

  return withYear ? `${y}年${m}月${day}日` : `${m}月${day}日`;
}

function formatNumber2(v) {
  const n = toNum(v);
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function isUsdCurrency(v) {
  const s = String(v || '').trim().toUpperCase();
  return ['USD', 'US$', '$', 'DOLLAR', 'DOLLARS'].includes(s);
}

function copySheet(template, target) {
  // シート設定
  target.properties = JSON.parse(JSON.stringify(template.properties || {}));
  target.pageSetup = JSON.parse(JSON.stringify(template.pageSetup || {}));
  target.headerFooter = JSON.parse(JSON.stringify(template.headerFooter || {}));
  target.views = JSON.parse(JSON.stringify(template.views || []));

  // 列幅
  template.columns.forEach((col, i) => {
    const targetCol = target.getColumn(i + 1);
    targetCol.width = col.width;
    targetCol.hidden = col.hidden;
    targetCol.outlineLevel = col.outlineLevel;
    if (col.style) {
      targetCol.style = JSON.parse(JSON.stringify(col.style));
    }
  });

  // セル・行高さ
  template.eachRow({ includeEmpty: true }, (row, rowNum) => {
    const targetRow = target.getRow(rowNum);

    targetRow.height = row.height;
    targetRow.hidden = row.hidden;
    targetRow.outlineLevel = row.outlineLevel;

    row.eachCell({ includeEmpty: true }, (cell, colNum) => {
      const newCell = target.getCell(rowNum, colNum);

      newCell.value = cell.value;

      if (cell.style) {
        newCell.style = JSON.parse(JSON.stringify(cell.style));
      }

      if (cell.numFmt) {
        newCell.numFmt = cell.numFmt;
      }
    });

    targetRow.commit();
  });

  // 結合セル
  const merges = template.model?.merges || [];

  for (const range of merges) {
    try {
      target.mergeCells(range);
    } catch (e) {
      console.warn('[copySheet merge skipped]', range, e.message);
    }
  }
}

export async function appendInvoiceSheets(wb, payload) {

  const { shipment, customer, lines, containers, charges } = payload;

  const jobNo = safeSheetName(
    shipment.job_no || shipment.shipment_id
  );

  // テンプレ取得
  const templateFront = wb.getWorksheet('請求書表');
  const templateBack = wb.getWorksheet('請求書裏');

  if (!templateFront) {
    throw new Error('template sheet 請求書表 not found');
  }

  if (!templateBack) {
    throw new Error('template sheet 請求書裏 not found');
  }

  // 新規sheet作成
  const front = wb.addWorksheet(jobNo);

  const back = wb.addWorksheet(
    safeSheetName(`下払(${jobNo})`)
  );

  // テンプレコピー
  copySheet(templateFront, front);
  copySheet(templateBack, back);

  // invoice date
  front.getCell('J1').value = formatJpDate(new Date(), true);

  // 顧客マスタ相当
  front.getCell('B5').value = customer?.zip || '';
  front.getCell('B6').value = customer?.address1 || '';
  front.getCell('B7').value = customer?.address2 || '';
  front.getCell('B9').value = customer?.billing_name || customer?.customer_name || '';

  // 出荷明細相当
  front.getCell('C21').value = shipment.pol || '';
  front.getCell('C22').value = shipment.pod || '';
  front.getCell('C23').value = [shipment.vessel, shipment.voyage].filter(Boolean).join(' ');
  front.getCell('C24').value = formatJpDate(shipment.eta || shipment.etd);
  front.getCell('C25').value = shipment.bl_no || shipment.mbl_no || shipment.master_bl_no || '';

  const firstLine = lines?.[0] || {};
  front.getCell('H20').value =
  shipment.invoice_no ||
  shipment.job_no ||
  shipment.shipment_id ||
  '';

  front.getCell('H21').value = sumPackages(containers);
  front.getCell('H22').value = `${formatNumber2(sumField(containers, 'gw'))} KG`;
  front.getCell('H23').value = `${formatNumber2(sumField(containers, 'cbm'))} M3`;

  // 請求書表：料金詳細
  let r = 31;
  for (const ch of charges) {
    if (r > 53) break;

    front.getCell(`C${r}`).value = ch.charge_name || '';
    front.getCell(`E${r}`).value = toNum(ch.qty);
    front.getCell(`F${r}`).value = ch.unit || '';
    front.getCell(`G${r}`).value = toNum(ch.rate);
    front.getCell(`I${r}`).value = ch.tax_category || '';

    if (isUsdCurrency(ch.currency)) {
    front.getCell(`J${r}`).value = ch.fx_rate || '';
    } else {
    front.getCell(`J${r}`).value = ch.note || '';
    }

    r++;
  }

  // 請求書裏：下払分類
  let taxableRow = 13;
  let nonTaxRow = 27;
  let exemptRow = 43;

  for (const ch of charges) {
    const tax = String(ch.tax_category || '').trim();

    if (tax === '課税' && taxableRow <= 23) {
      back.getCell(`B${taxableRow}`).value = ch.charge_name || '';
      back.getCell(`C${taxableRow}`).value = toNum(ch.qty);
      back.getCell(`D${taxableRow}`).value = toNum(ch.rate);
      taxableRow++;
    }

    if (tax === '非課税' && nonTaxRow <= 38) {
      back.getCell(`B${nonTaxRow}`).value = ch.charge_name || '';
      back.getCell(`C${nonTaxRow}`).value = toNum(ch.qty);
      back.getCell(`D${nonTaxRow}`).value = toNum(ch.rate);
      nonTaxRow++;
    }

    if (tax === '免税' && exemptRow <= 53) {
      back.getCell(`B${exemptRow}`).value = ch.charge_name || '';
      back.getCell(`C${exemptRow}`).value = toNum(ch.qty);
      back.getCell(`D${exemptRow}`).value = toNum(ch.rate);
      back.getCell(`E${exemptRow}`).value = ch.note || '';
      exemptRow++;
    }
  }
  // ===== 表B列の日付式復旧 =====
// B28は触らない
front.getCell('B29').value = {
  formula: `B28`
};
// B30は触らない

for (let row = 31; row <= 53; row++) {
  const chargeName = front.getCell(`C${row}`).value;

  if (chargeName !== null && chargeName !== undefined && String(chargeName).trim() !== '') {
    front.getCell(`B${row}`).value = {
      formula: `$C$24`
    };
  } else {
    front.getCell(`B${row}`).value = null;
  }
}

  // ===== 数式復旧 =====

// H2
back.getCell('H2').value = {
  formula: `IF('${jobNo}'!B14=SUM('${back.name}'!C2:C6),"〇","チェックが必要")`
};

// D11 = 請求書表!H30
back.getCell('D11').value = {
  formula: `'${jobNo}'!H30`
};

// C26 = 請求書表!E28
back.getCell('C26').value = {
  formula: `'${jobNo}'!E28`
};

  back.getCell('H2').value = {
  formula: `IF('${jobNo}'!B14=SUM('${back.name}'!C2:C6),"〇","チェックが必要")`
};


  return wb;
}
