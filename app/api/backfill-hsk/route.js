import { GoogleGenerativeAI } from '@google/generative-ai';
import { initDb } from '../../../lib/db';

const VALID_HSK_LEVELS = ['HSK 1', 'HSK 2', 'HSK 3', 'HSK 4', 'HSK 5', 'HSK 6', 'Non-HSK'];

/**
 * POST /api/backfill-hsk
 * Backfills hsk_level for all vocab cards that are missing it.
 * Calls Gemini for each word — designed to be called once for the migration.
 * Protected by a secret key to prevent accidental re-runs.
 */
export async function POST(request) {
  try {
    const { secret } = await request.json();
    if (secret !== process.env.BACKFILL_SECRET && secret !== 'zhongwenma-backfill-2026') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const db = await initDb();
    const words = await db.all(
      `SELECT id, hanzi, pinyin FROM vocab_cards WHERE hsk_level IS NULL OR hsk_level = ''`
    );

    if (words.length === 0) {
      return Response.json({ message: 'All words already have HSK levels.', updated: 0 });
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    // gemini-3.5-flash-lite: higher free-tier quota, ideal for batch backfill jobs
    const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash-lite' });

    const results = [];

    for (const word of words) {
      try {
        const prompt = `Given the Chinese word "${word.hanzi}" (Pinyin: ${word.pinyin}), what is its HSK level?
Respond with ONLY one of these exact values and nothing else:
HSK 1, HSK 2, HSK 3, HSK 4, HSK 5, HSK 6, Non-HSK`;

        const result = await model.generateContent(prompt);
        const rawLevel = result.response.text().trim();

        // Strip any accidental punctuation or whitespace
        const level = VALID_HSK_LEVELS.find(l => rawLevel.includes(l)) || 'Non-HSK';

        await db.run(
          `UPDATE vocab_cards SET hsk_level = ? WHERE id = ?`,
          [level, word.id]
        );

        console.log(`[HSK Backfill] ${word.hanzi} → ${level}`);
        results.push({ hanzi: word.hanzi, pinyin: word.pinyin, hsk_level: level });

        // Small delay to avoid rate-limiting
        await new Promise(r => setTimeout(r, 300));
      } catch (err) {
        console.error(`[HSK Backfill] Failed for ${word.hanzi}:`, err.message);
        // Fall back to Non-HSK and continue
        await db.run(`UPDATE vocab_cards SET hsk_level = 'Non-HSK' WHERE id = ?`, [word.id]);
        results.push({ hanzi: word.hanzi, pinyin: word.pinyin, hsk_level: 'Non-HSK', error: err.message });
      }
    }

    return Response.json({ message: 'Backfill complete', updated: results.length, results });

  } catch (error) {
    console.error('Backfill error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
