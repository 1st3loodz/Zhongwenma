import { initDb } from '../../../lib/db';

/**
 * GET /api/get-due-card
 *
 * Returns one card to study using this priority:
 *   1. Cards where next_review_date <= NOW  (SRS: genuinely due)
 *   2. Any random card from the whole library (fallback practice)
 *
 * SQLite stores ISO-8601 strings. Comparing them lexicographically
 * against datetime('now') works correctly for UTC timestamps.
 */
export async function GET() {
  try {
    const db = await initDb();

    // Priority 1 — SRS due cards (pick the most overdue one first)
    let card = await db.get(`
      SELECT * FROM vocab_cards
      WHERE next_review_date <= datetime('now')
      ORDER BY next_review_date ASC
      LIMIT 1
    `);

    // Priority 2 — fallback: any card at random
    if (!card) {
      card = await db.get(`
        SELECT * FROM vocab_cards
        ORDER BY RANDOM()
        LIMIT 1
      `);
    }

    if (!card) {
      return Response.json({ card: null, source: 'empty' });
    }

    // Normalise legacy rows: V1 cards have example_sentence_translation but
    // not the two V2 split columns. Surface them gracefully so the UI never
    // receives undefined for a field it tries to render.
    const normalised = {
      ...card,
      example_sentence_translation_en:
        card.example_sentence_translation_en
        || card.example_sentence_translation
        || null,
      example_sentence_translation_th:
        card.example_sentence_translation_th || null,
    };

    const source = card.next_review_date <= new Date().toISOString()
      ? 'due'
      : 'random';

    return Response.json({ card: normalised, source });
  } catch (error) {
    console.error('GET /api/get-due-card Error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
