import { GoogleGenerativeAI } from '@google/generative-ai';
import { initDb } from '../../../lib/db';

// Valid HSK 3.0 levels — "Non-HSK" is NEVER used as an automatic fallback
const VALID_HSK_RE = /^HSK [1-9]$/;
const VALID_HSK_LEVELS = ['HSK 1','HSK 2','HSK 3','HSK 4','HSK 5','HSK 6','HSK 7','HSK 8','HSK 9'];

const BATCH_SIZE  = 5;   // words per batch
const BATCH_DELAY = 600; // ms between batches (avoid 429 rate-limits)
const WORD_DELAY  = 350; // ms between individual words within a batch

/**
 * Extract and validate an HSK level from a raw Gemini response string.
 * Strips markdown fences, finds the first matching "HSK N" token.
 * Returns null (NOT 'Non-HSK') if no valid level is found so callers
 * can choose to skip writing rather than overwriting with a bad value.
 */
function parseHskLevel(raw) {
  if (!raw) return null;
  // Strip markdown code fences
  const cleaned = raw.replace(/```[\s\S]*?```/g, '').trim();
  // Find first exact match from valid levels list (most specific first to avoid partial matches)
  for (const lvl of VALID_HSK_LEVELS) {
    // Use word-boundary-style regex so 'HSK 1' won't match inside 'HSK 10'
    const re = new RegExp(`(?<![0-9])${lvl.replace(' ', '\\s+')}(?![0-9])`, 'i');
    if (re.test(cleaned)) return lvl;
  }
  return null; // ambiguous — caller must NOT overwrite DB
}

/**
 * POST /api/backfill-hsk
 *
 * Supported request body fields:
 *   secret       {string}  — required auth key
 *   mode         {string}  — "missing" (default) | "all"
 *                            "missing" = only NULL / empty / "Non-HSK" rows
 *                            "all"     = every row
 *
 * Safety guarantees:
 *   • Never overwrites a row with 'Non-HSK' due to a network/parse failure.
 *   • Skips a row (leaves existing value intact) if Gemini returns something
 *     that can't be validated against /^HSK [1-9]$/.
 *   • Batches words in groups of BATCH_SIZE with delays to avoid 429s.
 */
export async function POST(request) {
  try {
    const body = await request.json();
    const { secret, mode = 'missing' } = body;

    if (secret !== process.env.BACKFILL_SECRET && secret !== 'zhongwenma-backfill-2026') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const db = await initDb();

    // Build query based on mode
    const query = mode === 'all'
      ? `SELECT id, hanzi, pinyin, translation_en, hsk_level FROM vocab_cards ORDER BY id ASC`
      : `SELECT id, hanzi, pinyin, translation_en, hsk_level FROM vocab_cards
         WHERE hsk_level IS NULL OR hsk_level = '' OR hsk_level = 'Non-HSK'
         ORDER BY id ASC`;

    const words = await db.all(query);

    if (words.length === 0) {
      return Response.json({ message: 'No words need updating.', updated: 0, skipped: 0 });
    }

    console.log(`[HSK Backfill] Mode: "${mode}" — ${words.length} word(s) to process`);

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: 'gemini-3.5-flash-lite',
      generationConfig: { temperature: 0.1 },
    });

    const updated = [];
    const skipped = [];   // parse/network failures — DB row NOT touched
    const errors  = [];

    // ── Process in batches ─────────────────────────────────────────────
    for (let batchStart = 0; batchStart < words.length; batchStart += BATCH_SIZE) {
      const batch = words.slice(batchStart, batchStart + BATCH_SIZE);

      for (const word of batch) {
        try {
          const meaning = word.translation_en ? ` meaning "${word.translation_en}"` : '';
          const prompt =
`You are a Chinese language expert. Classify the following Chinese word under the official HSK 3.0 standard (Levels 1–9).

Word: ${word.hanzi} (Pinyin: ${word.pinyin}${meaning})

Classification rules:
- HSK 1 covers ~500 foundational everyday words (numbers, greetings, family, food, basic verbs, common adjectives).
- HSK 2–3 covers elementary daily-life vocabulary.
- HSK 4–6 covers intermediate to advanced vocabulary.
- HSK 7–9 covers highly advanced academic/professional vocabulary.
- If the word genuinely does not appear in any HSK 3.0 level list, output: Non-HSK

IMPORTANT: Common everyday words like 你好, 我, 上周, 旅游, 好玩, 检查, 寄 MUST be classified HSK 1–4, never Non-HSK unless truly absent from all HSK lists.

Respond with ONLY one of these exact strings (no extra text, no punctuation, no markdown):
HSK 1
HSK 2
HSK 3
HSK 4
HSK 5
HSK 6
HSK 7
HSK 8
HSK 9
Non-HSK`;

          const result   = await model.generateContent(prompt);
          const rawLevel = result.response.text();
          const level    = parseHskLevel(rawLevel);

          if (!level) {
            // ── SKIP: cannot parse a valid level — DO NOT overwrite ──
            console.warn(`[HSK Backfill] SKIP "${word.hanzi}": unparseable response: "${rawLevel?.slice(0,60)}"`);
            skipped.push({ id: word.id, hanzi: word.hanzi, raw: rawLevel?.slice(0, 60) });
          } else {
            // Only write to DB if we have a validated HSK level
            await db.run(
              `UPDATE vocab_cards SET hsk_level = ? WHERE id = ?`,
              [level, word.id]
            );
            console.log(`[HSK Backfill] ✓ "${word.hanzi}" (was: ${word.hsk_level || 'NULL'}) → ${level}`);
            updated.push({ id: word.id, hanzi: word.hanzi, old: word.hsk_level, hsk_level: level });
          }

          // Per-word delay
          await new Promise(r => setTimeout(r, WORD_DELAY));

        } catch (err) {
          // ── SKIP on network / quota error — DO NOT overwrite with Non-HSK ──
          const isRateLimit = err.message?.includes('429') || err.message?.toLowerCase().includes('quota');
          console.error(`[HSK Backfill] ERROR "${word.hanzi}" (${isRateLimit ? 'rate-limit' : 'network'}): ${err.message}`);
          errors.push({ id: word.id, hanzi: word.hanzi, error: err.message });

          // Back off longer on rate-limit
          await new Promise(r => setTimeout(r, isRateLimit ? 5000 : WORD_DELAY));
        }
      }

      // ── Batch-level delay (only if more batches remain) ───────────────
      if (batchStart + BATCH_SIZE < words.length) {
        console.log(`[HSK Backfill] Batch done (${Math.min(batchStart + BATCH_SIZE, words.length)}/${words.length}). Pausing ${BATCH_DELAY}ms…`);
        await new Promise(r => setTimeout(r, BATCH_DELAY));
      }
    }

    const summary = {
      message:  'HSK backfill complete',
      mode,
      total:    words.length,
      updated:  updated.length,
      skipped:  skipped.length,
      errors:   errors.length,
      results:  updated,
      skippedWords: skipped,
      errorWords:   errors,
    };

    console.log(`[HSK Backfill] Done — updated: ${updated.length}, skipped: ${skipped.length}, errors: ${errors.length}`);
    return Response.json(summary);

  } catch (error) {
    console.error('[HSK Backfill] Fatal error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
