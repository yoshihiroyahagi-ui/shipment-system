function normalizeText(raw) {
  return String(raw || '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function parseContainerLine(line) {
  const parts = line.split('/').map(v => v.trim());

  return {
    container_no: parts[0] || '',
    container_type: (parts[1] || '').replace(/'/g, ''),
    seal_no: parts[2] || '',
    packages: parts[3] || '',
    gross_weight: parts[4] || '',
    cbm: parts[5] || ''
  };
}

function isContainerLine(line) {
  return /^[A-Z]{4}\d{7}\//.test(String(line || '').trim());
}

function extractCaseMarkLines(lines) {
  const result = [];

  // 「MARKS AND NUMBER」を含む見出し行を探す
  const startIdx = lines.findIndex(line =>
    /MARKS AND NUMBER/i.test(String(line || ''))
  );

  if (startIdx < 0) return result;

  // 見出しの次行から開始
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = String(lines[i] || '').trim();
    if (!line) continue;

    // コンテナ行が来たら終了
    if (isContainerLine(line)) break;

    result.push(line);
  }

  return result;
}

function parseBLTextToJson(rawText) {
  const text = normalizeText(rawText);
  const lines = text.split('\n').map(v => v.trim()).filter(Boolean);

  const json = {
    bl_no: '',
    hbl_no: '',
    mbl_no: '',
    on_board_date: '',
    atd: '',
    vessel: '',
    voyage: '',
    pol: '',
    pod: '',
    shipper: { name: '' },
    consignee: { name: '' },
    notify_party: { name: '' },
    containers: [],
    goods: { description: '', hs_code: '' },
    movement: { part_of: '', move_type: '' },
    case_mark_lines: []
  };

  // BL NO
  json.bl_no = lines.find(v => /^[A-Z]{2,6}\d{6,}$/.test(v)) || '';
  json.hbl_no = json.bl_no;

  // Container
  const containerLine = lines.find(v => /^[A-Z]{4}\d{7}\//.test(v));
  if (containerLine) {
    json.containers.push(parseContainerLine(containerLine));
  }

  // Vessel / Voyage
  const vvLine = lines.find(v => /\d{3,4}-\d{3,4}/.test(v));
  if (vvLine) {
    const m = vvLine.match(/^(.*)\s+(\d{3,4}-\d{3,4}[A-Z]?)$/);
    if (m) {
      json.vessel = m[1];
      json.voyage = m[2];
    }
  }

  // Date
  const dateLines = lines.filter(v => /^\d{4}\/\d{2}\/\d{2}$/.test(v));
  if (dateLines.length) {
    json.on_board_date = dateLines[dateLines.length - 1];
    json.atd = json.on_board_date;
  }

  // Goods
  json.goods.description = lines.find(v => /HEADSET/i.test(v)) || '';
  json.goods.hs_code = (text.match(/HS CODE[:\s]*(\d+)/i) || [])[1] || '';

  // Movement
  const partMatch = text.match(/\((PART OF [^\)]+)\)/i);
  if (partMatch) json.movement.part_of = partMatch[1];

  const moveMatch = text.match(/\((CY-CY|CFS-CFS|CY-CFS|CFS-CY)\)/i);
  if (moveMatch) json.movement.move_type = moveMatch[1];

  // Ports
  const portLines = lines.filter(v => /, (CHINA|JAPAN)/.test(v));
  if (portLines.length >= 2) {
    json.pod = portLines[0];
    json.pol = portLines[portLines.length - 1];
  }

  // Company
  const companies = lines.filter(v => /CO.,LTD|LIMITED|IMP|FREIGHT/i.test(v));
  if (companies.length >= 2) {
    json.consignee.name = companies[0];
    json.shipper.name = companies[1];
  }

  // Notify
  if (lines.includes('SAME AS CONSIGNEE')) {
    json.notify_party.name = 'SAME AS CONSIGNEE';
  }

  // Case Mark
  json.case_mark_lines = extractCaseMarkLines(lines);

  return json;
}

export { parseBLTextToJson };