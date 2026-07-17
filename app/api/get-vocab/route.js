import { initDb } from '../../../lib/db';

// Returns the 10 most recently added vocab cards for the Add Words tab list
export async function GET() {
  try {
    const db = await initDb();
    const rows = await db.all('SELECT * FROM vocab_cards ORDER BY created_at DESC LIMIT 10');
    return Response.json(rows);
  } catch (error) {
    console.error("GET /api/get-vocab Error:", error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
