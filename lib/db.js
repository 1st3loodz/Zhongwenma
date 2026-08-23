import path from 'path';

// ─── Unified DB Adapter ───────────────────────────────────────────────────────
//
// Provides a single `initDb()` function that returns a db object with a
// consistent API surface:  { all, run, get, exec }
//
// Priority:
//   1. If TURSO_DATABASE_URL + TURSO_AUTH_TOKEN are set  →  Turso / libSQL (cloud)
//   2. Otherwise                                         →  local SQLite file via `sqlite` + `sqlite3`

async function createLocalDb() {
  const sqlite3 = (await import('sqlite3')).default;
  const { open } = await import('sqlite');

  const db = await open({
    filename: path.join(process.cwd(), 'vocab.db'),
    driver: sqlite3.Database,
  });

  // Return as-is — the `sqlite` package already matches our required API.
  return db;
}

async function createTursoDb(url, authToken) {
  const { createClient } = await import('@libsql/client');

  const client = createClient({ url, authToken });

  // Wrap libSQL client to match the `sqlite` package interface
  // libSQL returns { rows: [{...},...] } and uses `execute()` for all queries.
  return {
    /** Run a SELECT and return an array of plain row objects */
    async all(sql, params = []) {
      const result = await client.execute({ sql, args: params });
      return result.rows.map(row => ({ ...row }));
    },

    /** Run an INSERT / UPDATE / DELETE — returns lastID and changes */
    async run(sql, params = []) {
      const result = await client.execute({ sql, args: params });
      return {
        lastID: result.lastInsertRowid != null ? Number(result.lastInsertRowid) : undefined,
        changes: result.rowsAffected,
      };
    },

    /** Run a SELECT and return the first row (or undefined) */
    async get(sql, params = []) {
      const result = await client.execute({ sql, args: params });
      return result.rows.length > 0 ? { ...result.rows[0] } : undefined;
    },

    /** Execute one or more DDL / DML statements (no return value needed) */
    async exec(sql) {
      // libSQL's `execute` handles a single statement; split on `;` for multi-stmt blocks
      const statements = sql
        .split(';')
        .map(s => s.trim())
        .filter(Boolean);
      for (const stmt of statements) {
        await client.execute(stmt);
      }
    },

    // Expose the raw client for edge cases
    _client: client,
  };
}

// ─── initDb ──────────────────────────────────────────────────────────────────
// Initializes the connection and runs all pending schema migrations.
export async function initDb() {
  const { TURSO_DATABASE_URL, TURSO_AUTH_TOKEN } = process.env;

  const useTurso =
    typeof TURSO_DATABASE_URL === 'string' && TURSO_DATABASE_URL.trim() !== '' &&
    typeof TURSO_AUTH_TOKEN  === 'string' && TURSO_AUTH_TOKEN.trim()  !== '';

  if (useTurso) {
    console.log('[DB] Connecting via Turso / libSQL:', TURSO_DATABASE_URL);
  } else {
    console.log('[DB] Connecting via local SQLite (vocab.db)');
  }

  const db = useTurso
    ? await createTursoDb(TURSO_DATABASE_URL, TURSO_AUTH_TOKEN)
    : await createLocalDb();

  // ── Base schema ────────────────────────────────────────────────────────────
  await db.exec(`
    CREATE TABLE IF NOT EXISTS vocab_cards (
      id                              TEXT PRIMARY KEY,
      created_at                      DATETIME DEFAULT CURRENT_TIMESTAMP,
      user_input                      TEXT,
      pinyin                          TEXT,
      hanzi                           TEXT,
      word_type                       TEXT,
      translation_th                  TEXT,
      translation_en                  TEXT,
      example_sentence_pinyin         TEXT,
      example_sentence_hanzi          TEXT,
      example_sentence_translation_en TEXT,
      example_sentence_translation_th TEXT,
      next_review_date                DATETIME,
      is_mastered                     INTEGER DEFAULT 0,
      hsk_level                       TEXT
    )
  `);

  // ── Incremental migrations (safe to re-run) ────────────────────────────────
  const columns = await db.all(`PRAGMA table_info(vocab_cards)`);
  const colNames = columns.map(c => c.name);

  // V1 → V2: dual example sentence translations
  if (!colNames.includes('example_sentence_translation_en')) {
    await db.exec(`ALTER TABLE vocab_cards ADD COLUMN example_sentence_translation_en TEXT`);
    console.log('[DB Migration V2] Added: example_sentence_translation_en');
  }
  if (!colNames.includes('example_sentence_translation_th')) {
    await db.exec(`ALTER TABLE vocab_cards ADD COLUMN example_sentence_translation_th TEXT`);
    console.log('[DB Migration V2] Added: example_sentence_translation_th');
  }

  // V2 → V2.5: word_type
  if (!colNames.includes('word_type')) {
    await db.exec(`ALTER TABLE vocab_cards ADD COLUMN word_type TEXT`);
    console.log('[DB Migration V2.5] Added: word_type');
  }

  // V2.5 → V2.6: is_mastered
  if (!colNames.includes('is_mastered')) {
    try {
      await db.exec(`ALTER TABLE vocab_cards ADD COLUMN is_mastered INTEGER DEFAULT 0`);
      console.log('[DB Migration V2.6] Added: is_mastered');
    } catch (err) {
      if (!err.message?.includes('duplicate column')) throw err;
    }
  }

  // V2.7: deduplicate hanzi rows + unique index (safe to re-run)
  try {
    // Step 1 — delete duplicate hanzi rows, keeping the earliest created_at per hanzi
    await db.exec(`
      DELETE FROM vocab_cards
      WHERE id NOT IN (
        SELECT id FROM vocab_cards
        WHERE (hanzi, created_at) IN (
          SELECT hanzi, MIN(created_at) FROM vocab_cards GROUP BY hanzi
        )
      )
    `);

    // Step 2 — create a unique index so the DB itself rejects future duplicates
    await db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_vocab_hanzi ON vocab_cards (hanzi)
    `);
    console.log('[DB Migration V2.7] Deduplication + unique index on hanzi applied.');
  } catch (err) {
    // Index may already exist or dedup already clean — log and continue
    console.warn('[DB Migration V2.7] Skipped (already applied or error):', err.message);
  }
  // V2.8: hsk_level column
  if (!colNames.includes('hsk_level')) {
    try {
      await db.exec(`ALTER TABLE vocab_cards ADD COLUMN hsk_level TEXT`);
      console.log('[DB Migration V2.8] Added: hsk_level');
    } catch (err) {
      if (!err.message?.includes('duplicate column')) throw err;
    }
  }

  // V2.9: example_sentence_hanzi column
  if (!colNames.includes('example_sentence_hanzi')) {
    try {
      await db.exec(`ALTER TABLE vocab_cards ADD COLUMN example_sentence_hanzi TEXT`);
      console.log('[DB Migration V2.9] Added: example_sentence_hanzi');
    } catch (err) {
      if (!err.message?.includes('duplicate column')) throw err;
    }
  }

  return db;
}

// Legacy alias kept for any code that may import openDb directly
export async function openDb() {
  return createLocalDb();
}
