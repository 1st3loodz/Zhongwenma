import { NextResponse } from 'next/server';
import { initDb } from '../../../lib/db';

export async function POST(request) {
  try {
    const { id, is_mastered } = await request.json();

    if (!id) {
      return NextResponse.json({ error: 'Card ID required' }, { status: 400 });
    }

    const db = await initDb();
    const newMasteredState = is_mastered ? 1 : 0;

    await db.run(
      'UPDATE vocab_cards SET is_mastered = ? WHERE id = ?',
      [newMasteredState, id]
    );

    return NextResponse.json({ success: true, id, is_mastered: newMasteredState });
  } catch (error) {
    console.error("Toggle Mastered Error:", error);
    return NextResponse.json({ error: 'Failed to update mastered state' }, { status: 500 });
  }
}
