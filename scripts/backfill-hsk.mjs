/**
 * backfill-hsk.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Standalone Node.js script that assigns hsk_level to all vocabulary cards
 * that are currently NULL / empty.
 *
 * Strategy (no Gemini API calls needed):
 *   1. Query all vocab_cards WHERE hsk_level IS NULL OR hsk_level = ''
 *   2. For each word, look up its Hanzi in the static HSK wordlist
 *   3. Update the row in the database
 *
 * Run from the project root:
 *   node scripts/backfill-hsk.mjs
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { HSK_MAP } from './hsk-lookup.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '..', 'vocab.db');

console.log(`\n📚 HSK Backfill Script`);
console.log(`   Database: ${dbPath}`);
console.log(`   HSK entries loaded: ${Object.keys(HSK_MAP).length}`);
console.log(`─────────────────────────────────────────────────`);

const db = new Database(dbPath);

// Ensure hsk_level column exists
try {
  db.exec(`ALTER TABLE vocab_cards ADD COLUMN hsk_level TEXT`);
  console.log('✓ hsk_level column added (was missing)');
} catch (e) {
  if (!e.message.includes('duplicate column')) throw e;
  // Column already exists — fine
}

// Query all words missing hsk_level
const missing = db.prepare(
  `SELECT id, hanzi, pinyin FROM vocab_cards WHERE hsk_level IS NULL OR hsk_level = ''`
).all();

if (missing.length === 0) {
  console.log('\n✅ All words already have HSK levels. Nothing to do.');
  db.close();
  process.exit(0);
}

console.log(`\nFound ${missing.length} word(s) missing HSK level — classifying…\n`);

const update = db.prepare(`UPDATE vocab_cards SET hsk_level = ? WHERE id = ?`);

let matched = 0;
let nonHsk = 0;

for (const word of missing) {
  const level = HSK_MAP[word.hanzi] || 'Non-HSK';
  update.run(level, word.id);

  const marker = level === 'Non-HSK' ? '○' : '●';
  console.log(`  ${marker} ${(word.hanzi || '?').padEnd(8)} ${(word.pinyin || '').padEnd(18)} → ${level}`);

  if (level !== 'Non-HSK') matched++;
  else nonHsk++;
}

console.log(`\n─────────────────────────────────────────────────`);
console.log(`✅ Done! ${missing.length} words updated.`);
console.log(`   HSK match : ${matched}`);
console.log(`   Non-HSK   : ${nonHsk}`);
console.log(`─────────────────────────────────────────────────\n`);

db.close();
