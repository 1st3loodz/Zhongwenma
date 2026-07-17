import { GoogleGenerativeAI } from '@google/generative-ai';
import { initDb } from '../../../lib/db';
import crypto from 'crypto';

const PRIMARY_MODEL = "gemini-2.5-flash";
const FALLBACK_MODEL = "gemini-2.5-flash-lite";
const MAX_RETRIES = 3;

// Valid word types — used to sanitize Gemini output
const VALID_WORD_TYPES = ['Noun', 'Verb', 'Adj', 'Adv', 'Phrase', 'Particle', 'Numeral', 'Pronoun', 'Other'];

async function callGeminiWithRetry(genAI, userInput) {
  const prompt = `
    You are an expert Chinese language teacher. The user may input text in ANY language:
    Thai, English, Pinyin romanization, or Chinese Hanzi characters.

    Analyze this user input: "${userInput}"

    Your task:
    1. Identify what concept or word the input refers to in Mandarin Chinese.
    2. Provide the standard Mandarin Chinese information for that concept.
    3. Classify the word type using EXACTLY one of these values:
       Noun | Verb | Adj | Adv | Phrase | Particle | Numeral | Pronoun | Other
    4. Generate exactly ONE short, practical, daily-life conversational example sentence in Pinyin.
    5. Translate that example sentence into BOTH English AND Thai.

    CRITICAL RULES:
    - Always respond with valid JSON only. No markdown, no code fences, no extra text.
    - All string values must be properly escaped UTF-8.
    - "word_type" must be exactly one of the values listed above.
    - If the input functions as multiple parts of speech (e.g., both a Noun and a Verb), return separate entries for each type.
    - "translation_th" must be in Thai script.
    - "translation_en" must be in English.
    - "pinyin" and "example_sentence_pinyin" must use standard Pinyin with tone marks (e.g. nǐ hǎo).
    - "example_sentence_translation_en" must be the English translation of the example sentence.
    - "example_sentence_translation_th" must be the Thai translation of the example sentence.

    Respond ONLY with this exact JSON structure (an ARRAY of objects, even if there's only one):
    [
      {
        "pinyin": "string",
        "hanzi": "string",
        "word_type": "string",
        "translation_th": "string",
        "translation_en": "string",
        "example_sentence_pinyin": "string",
        "example_sentence_translation_en": "string",
        "example_sentence_translation_th": "string"
      }
    ]
  `;

  const generationConfig = { responseMimeType: "application/json", temperature: 0.2 };
  const contents = [{ role: "user", parts: [{ text: prompt }] }];

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const modelName = attempt < MAX_RETRIES ? PRIMARY_MODEL : FALLBACK_MODEL;
      if (attempt === MAX_RETRIES) {
        console.warn(`[Gemini] Falling back to ${FALLBACK_MODEL} after ${attempt - 1} attempts.`);
      }
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent({ contents, generationConfig });
      return result.response.text();
    } catch (err) {
      const isTransient = err.message?.includes('503') || err.message?.includes('429');
      if (isTransient && attempt < MAX_RETRIES) {
        const delayMs = 1000 * Math.pow(2, attempt - 1);
        console.warn(`[Gemini] Attempt ${attempt} failed (transient). Retrying in ${delayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      } else {
        throw err;
      }
    }
  }
}

export async function POST(request) {
  try {
    const { userInput } = await request.json();
    console.log(`Processing input: "${userInput}"...`);

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const responseText = await callGeminiWithRetry(genAI, userInput);

    let generatedData;
    try {
      const cleaned = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      generatedData = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error("[JSON Parse Error] Raw response:", responseText);
      throw new Error(`Gemini returned invalid JSON: ${parseErr.message}`);
    }

    // Ensure data is an array
    const dataArray = Array.isArray(generatedData) ? generatedData : [generatedData];
    const insertedCards = [];

    const db = await initDb();
    
    // Process each object in the array
    for (const item of dataArray) {
      // Validate required fields
      const requiredFields = [
        'pinyin', 'hanzi', 'word_type', 'translation_th', 'translation_en',
        'example_sentence_pinyin', 'example_sentence_translation_en', 'example_sentence_translation_th'
      ];
      for (const field of requiredFields) {
        if (!item[field]) throw new Error(`Missing field in Gemini response: "${field}"`);
      }

      // Sanitize word_type
      const wordType = VALID_WORD_TYPES.includes(item.word_type)
        ? item.word_type
        : 'Other';

      const nextReviewDate = new Date();
      nextReviewDate.setDate(nextReviewDate.getDate() + 1);
      const id = crypto.randomUUID();

      await db.run(`
        INSERT INTO vocab_cards (
          id, user_input, pinyin, hanzi, word_type,
          translation_th, translation_en,
          example_sentence_pinyin,
          example_sentence_translation_en,
          example_sentence_translation_th,
          next_review_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        id, userInput,
        item.pinyin, item.hanzi, wordType,
        item.translation_th, item.translation_en,
        item.example_sentence_pinyin,
        item.example_sentence_translation_en,
        item.example_sentence_translation_th,
        nextReviewDate.toISOString()
      ]);

      const cardData = await db.get('SELECT * FROM vocab_cards WHERE id = ?', [id]);
      console.log(`✓ Saved: ${item.pinyin} (${item.hanzi}) [${wordType}]`);
      insertedCards.push(cardData);
    }

    return Response.json(insertedCards);

  } catch (error) {
    console.error("API Route Error:", error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
