import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse/sync';
import db from '../db.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSV_PATH = path.join(PROJECT_ROOT, 'data', 'import', 'persona_20260812.csv');

const raw = fs.readFileSync(CSV_PATH, 'utf-8');
const rows = parse(raw, { columns: false, relax_column_count: true });

// Row 0: Qualtrics Q-codes (canonical field names).
// Row 1: human-readable question text (unused here).
// Row 2: Qualtrics ImportId JSON metadata (unused here).
// Row 3+: actual response data.
const codes = rows[0];
const dataRows = rows.slice(3);

const codeIndex = Object.fromEntries(codes.map((code, i) => [code, i]));

function get(row, code) {
  const i = codeIndex[code];
  return i === undefined ? '' : (row[i] ?? '');
}

const insert = db.prepare(`
  INSERT OR IGNORE INTO survey_respondents (
    response_id, prolific_pid, age, gender, education, occupation,
    marital_status, income_band, housing_type, residency_status, ethnicity, raw_json
  ) VALUES (
    @response_id, @prolific_pid, @age, @gender, @education, @occupation,
    @marital_status, @income_band, @housing_type, @residency_status, @ethnicity, @raw_json
  )
`);

let imported = 0;
let skipped = 0;

const insertMany = db.transaction((records) => {
  for (const record of records) {
    const result = insert.run(record);
    if (result.changes > 0) imported++;
    else skipped++;
  }
});

const records = [];
for (const row of dataRows) {
  if (row.length <= 1) continue; // blank trailing line

  const status = get(row, 'Status');
  if (status === 'Survey Preview') {
    skipped++;
    continue;
  }

  const responseId = get(row, 'ResponseId');
  if (!responseId) {
    skipped++;
    continue;
  }

  const fields = {};
  codes.forEach((code, i) => {
    fields[code] = row[i] ?? '';
  });

  records.push({
    response_id: responseId,
    prolific_pid: get(row, 'PROLIFIC_PID') || null,
    age: get(row, 'Q1') || null,
    gender: get(row, 'Q2') || null,
    education: get(row, 'Q3') || null,
    occupation: get(row, 'Q4') || null,
    marital_status: get(row, 'Q5') || null,
    income_band: get(row, 'Q6') || null,
    housing_type: get(row, 'Q43') || null,
    residency_status: get(row, 'Q8') || null,
    ethnicity: get(row, 'Q9') || null,
    raw_json: JSON.stringify(fields)
  });
}

insertMany(records);

console.log(`Imported ${imported} respondent(s), skipped ${skipped}.`);
