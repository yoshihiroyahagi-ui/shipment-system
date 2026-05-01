import fs from 'fs'
import { parse } from 'csv-parse/sync'
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config()

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
)

const CSV_PATH = './shipments_update.csv'
const TABLE = 'shipments'
const KEY = 'shipment_id'
const BATCH_SIZE = 200

function cleanValue(v) {
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  if (s === '' || s.toUpperCase() === 'NULL') return null
  return s
}

function normalizeRow(row) {
  const out = {}

  for (const [k, v] of Object.entries(row)) {
    const key = String(k).trim()

    if (key === 'shipment_id') {
      out[key] = cleanValue(v)
      continue
    }

    // 空欄で既存値を消したくないなら null は入れない
    const val = cleanValue(v)
    if (val !== null) {
      out[key] = val
    }
  }

  return out
}

async function main() {
  const csvText = fs.readFileSync(CSV_PATH, 'utf-8')
  const records = parse(csvText, {
    columns: true,
    skip_empty_lines: true
  })

  const rows = records
    .map(normalizeRow)
    .filter(r => r[KEY])

  console.log(`Rows to upsert: ${rows.length}`)

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)

    const { error } = await supabase
      .from(TABLE)
      .upsert(batch, {
        onConflict: KEY
      })

    if (error) {
      console.error(`Batch failed: ${i} - ${i + batch.length - 1}`)
      console.error(error)
      process.exit(1)
    }

    console.log(`Upserted: ${i + batch.length}/${rows.length}`)
  }

  console.log('Done:', TABLE)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})