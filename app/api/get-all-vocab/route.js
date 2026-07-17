import { initDb } from '../../../lib/db';

/**
 * GET /api/get-all-vocab
 * Returns ALL vocab cards ordered by most recent first.
 * Used by the Vocab Bank tab.
 */
export async function GET() {
  try {
    const db = await initDb();
    const rows = await db.all(`
      SELECT * FROM vocab_cards
      ORDER BY created_at DESC
    `);

    // Normalise legacy rows so clients never receive undefined for V2/V2.5 fields
    const normalised = rows.map(row => ({
      ...row,
      word_type: row.word_type || null,
      example_sentence_translation_en:
        row.example_sentence_translation_en
        || row.example_sentence_translation
        || null,
      example_sentence_translation_th:
        row.example_sentence_translation_th || null,
    }));

    return Response.json(normalised);
  } catch (error) {
    console.error('GET /api/get-all-vocab Error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
