import { NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { initDb } from '../../../lib/db';

// ─── Prompt ─────────────────────────────────────────────────────────────
const buildPrompt = (text) => `
You are a Chinese language expert for learners. Analyze the input below and return a comprehensive translation breakdown.

Input: "${text}"

Return ONLY a valid JSON object (no markdown code blocks, no extra text):
{
  "detected_language": "English | Thai | Pinyin | Chinese",
  "pinyin": "full pinyin with proper tone marks (ā á ǎ à style)",
  "hanzi": "simplified Chinese characters",
  "translation_en": "clear English translation/meaning",
  "translation_th": "Thai translation",
  "breakdown": [
    { "pinyin": "nǐ", "hanzi": "你", "meaning_en": "you" },
    { "pinyin": "hǎo", "hanzi": "好", "meaning_en": "good / well" }
  ]
}

Rules:
- If input is English or Thai → find the most natural Chinese equivalent
- If input is Hanzi → provide pinyin and both translations
- If input is Pinyin → confirm hanzi and provide translations
- CRITICAL for Pinyin: Use precomposed Unicode characters ONLY (e.g. ā á ǎ à, ē é ě è, ī í ǐ ì, ō ó ǒ ò, ū ú ǔ ù, ǖ ǘ ǚ ǜ).
- NEVER split a tone mark from its vowel with a space (e.g. "yo ˇ u" is WRONG; "yǒu" is CORRECT).
- Use exactly ONE space between syllables. No leading or trailing spaces.
- breakdown should have one entry per individual Chinese vocabulary word found in the input
- Return ONLY the JSON object
`.trim();

// ─── Handler ─────────────────────────────────────────────────────────────
export async function POST(request) {
  try {
    const { userInput } = await request.json();
    if (!userInput?.trim()) {
      return NextResponse.json({ error: 'No input provided' }, { status: 400 });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'GEMINI_API_KEY not configured' }, { status: 500 });
    }

    const genAI = new GoogleGenerativeAI(apiKey);

    // ── Model cascade: try in order, most capable → fastest ──────────────
    // gemini-2.5-flash      : primary (best quality)
    // gemini-2.5-flash-lite : fallback (higher free-tier quota)
    const MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
    let lastError;

    for (const modelName of MODELS) {
      try {
        const model  = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent(buildPrompt(userInput.trim()));
        let raw = result.response.text().trim();

        // Strip accidental markdown fences
        raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

        const parsed = JSON.parse(raw);

        // Normalise breakdown to always be an array
        if (!Array.isArray(parsed.breakdown)) parsed.breakdown = [];

        // Check against local database
        const db = await initDb();
        for (const item of parsed.breakdown) {
          const row = await db.get('SELECT id FROM vocab_cards WHERE hanzi = ?', [item.hanzi]);
          item.inBank = !!row;
        }

        return NextResponse.json(parsed);
      } catch (err) {
        const msg         = err.message || '';
        const isRateLimit = msg.includes('429') || msg.toLowerCase().includes('quota');
        console.warn(`[quick-translate] Model "${modelName}" failed${isRateLimit ? ' (rate-limit)' : ''}: ${msg.slice(0, 120)}`);
        lastError = isRateLimit
          ? new Error('Gemini API rate limit reached — please wait a moment and try again.')
          : err;
        // Continue to next model
      }
    }

    throw lastError;
  } catch (err) {
    console.error('[quick-translate] error:', err);
    return NextResponse.json(
      { error: err.message || 'Translation failed. Please try again.' },
      { status: 500 }
    );
  }
}
