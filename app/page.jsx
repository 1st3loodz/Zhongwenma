"use client";

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import './page.css';

// ─── Constants ────────────────────────────────────────────────────────
const TABS = { ADD: 'add', CARDS: 'cards', BANK: 'bank', TRANSLATE: 'translate' };

// ─── Shared Helpers ───────────────────────────────────────────────────

/** Normalise a raw DB row so no V2/V2.5 field is ever undefined */
function normaliseCard(row) {
  if (!row) return null;
  return {
    ...row,
    word_type: row.word_type || null,
    example_sentence_translation_en:
      row.example_sentence_translation_en
      || row.example_sentence_translation
      || null,
    example_sentence_translation_th:
      row.example_sentence_translation_th || null,
  };
}

// ─── Week Number Utilities ─────────────────────────────────────────────
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

/** Week number relative to the first card ever added (w1 = first 7 days) */
function getWeekNum(cardDate, firstDate) {
  if (!firstDate) return 1;
  return Math.max(1, Math.floor((cardDate.getTime() - firstDate.getTime()) / MS_PER_WEEK) + 1);
}

/** Returns a formatted string like "2026-06-28 (w1)" */
function formatDateWithWeek(dateStr, firstDate) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  const ymd = d.toISOString().split('T')[0];
  if (!firstDate) return ymd;
  return `${ymd} (w${getWeekNum(d, firstDate)})`;
}

/** Fisher-Yates shuffle — returns a new shuffled array */
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Small coloured badge for word type */
function WordTypeBadge({ type }) {
  if (!type) return null;
  return <span className={`word-type-badge wt-${type}`}>{type}</span>;
}

// ─── Tab 1: Add Words ──────────────────────────────────────────────────
function AddWordsTab({ onCardAdded }) {
  const [inputValue, setInputValue] = useState('');
  const [isSubmitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [isDuplicate, setIsDuplicate] = useState(false);
  const [recentWords, setRecentWords] = useState([]);

  const loadRecent = useCallback(async () => {
    try {
      const res = await fetch('/api/get-vocab');
      if (res.ok) {
        const data = await res.json();
        setRecentWords(data.slice(0, 5).map(normaliseCard));
      }
    } catch (err) { console.error('Failed to load recent words:', err); }
  }, []);

  useEffect(() => { loadRecent(); }, [loadRecent]);

  const handleAddWord = async (e) => {
    e.preventDefault();
    if (!inputValue.trim()) return;
    setSubmitting(true);
    setErrorMsg('');
    setIsDuplicate(false);
    try {
      const res = await fetch('/api/generate-vocab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userInput: inputValue }),
      });
      const data = await res.json();

      // 409 = duplicate word — show a warning, not an error
      if (res.status === 409) {
        setIsDuplicate(true);
        setErrorMsg(data.error || 'Word already exists in your vocabulary bank!');
        setTimeout(() => { setIsDuplicate(false); setErrorMsg(''); }, 4000);
        return;
      }

      if (!res.ok) throw new Error(data.error || 'API failed');
      const newCards = (Array.isArray(data) ? data : [data]).map(normaliseCard);
      setRecentWords(prev => [...newCards, ...prev].slice(0, 5));
      setInputValue('');
      onCardAdded(newCards.length);
    } catch (err) {
      setErrorMsg(err.message || 'Failed to process word. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="add-form-card">
        <p className="section-title">Add New Word</p>
        <form className="add-word-form" onSubmit={handleAddWord}>
          <input
            id="word-input"
            type="text"
            className="add-input"
            placeholder="Thai, English, Pinyin, or Hanzi…"
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            disabled={isSubmitting}
            autoComplete="off"
          />
          <button type="submit" className="add-btn" disabled={isSubmitting}>
            {isSubmitting ? '⏳' : '+ Add'}
          </button>
        </form>
        <div className="add-hint">
          Try: <span>สนุก</span> <span>Coffee</span> <span>nǐ hǎo</span> <span>你好</span>
        </div>
      </div>

      {isDuplicate && (
        <div className="duplicate-banner">
          📚 <strong>Already in your bank!</strong> {errorMsg}
        </div>
      )}
      {!isDuplicate && errorMsg && <div className="error-banner">⚠️ {errorMsg}</div>}

      <div className="recent-card">
        <h3>📋 Last 5 Added</h3>
        {recentWords.length === 0 ? (
          <p className="empty-list">No words yet — add one above!</p>
        ) : (
          <table className="recent-table">
            <thead>
              <tr>
                <th>Pinyin / Hanzi</th>
                <th style={{ textAlign: 'right' }}>Meaning</th>
              </tr>
            </thead>
            <tbody>
              {recentWords.map((w, i) => (
                <tr key={w.id || i}>
                  <td>
                    <div className="cell-pinyin">{w.pinyin}</div>
                    <div className="cell-hanzi">{w.hanzi}</div>
                  </td>
                  <td>
                    <div className="cell-en">{w.translation_en}</div>
                    <div className="cell-th">{w.translation_th}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

// ─── Tab 2: Flashcards ─────────────────────────────────────────────────
// Self-contained: owns vocab loading, week filtering, and session queue.
// Three phases: SETUP → PLAYING → DONE → SETUP
// Session state (phase, queue, index) is LIFTED to the root so it survives
// tab navigation — passed in as {flashSession, setFlashSession}.
function FlashcardsTab({ onReview, flashSession, setFlashSession }) {
  // ── Vocab pool (local — reloads on mount, but session queue is persisted) ──
  const [allVocab, setAllVocab]             = useState([]);
  const [firstCardDate, setFirstCardDate]   = useState(null);
  const [availableWeeks, setAvailableWeeks] = useState([]);
  const [vocabLoading, setVocabLoading]     = useState(true);

  // ── Setup config (local — user can re-pick on next session) ──────────
  const [wordCount, setWordCount]     = useState('10');
  const [weekFilter, setWeekFilter]   = useState('all');
  // 'unmastered' = only is_mastered=0|null, 'all' = every card
  const [masteryScope, setMasteryScope] = useState('unmastered');

  // ── Per-card UI state (local — always resets on card change) ─────────
  const [isRevealed, setIsRevealed] = useState(false);
  const [flipKey, setFlipKey]       = useState(0);

  // ── Destructure lifted session state ─────────────────────────────────
  const { phase, sessionCards, sessionIndex, knewCount } = flashSession;
  const setPhase        = (v) => setFlashSession(s => ({ ...s, phase: typeof v === 'function' ? v(s.phase) : v }));
  const setSessionCards = (v) => setFlashSession(s => ({ ...s, sessionCards: typeof v === 'function' ? v(s.sessionCards) : v }));
  const setSessionIndex = (v) => setFlashSession(s => ({ ...s, sessionIndex: typeof v === 'function' ? v(s.sessionIndex) : v }));
  const setKnewCount    = (v) => setFlashSession(s => ({ ...s, knewCount: typeof v === 'function' ? v(s.knewCount) : v }));

  // Load all vocab on mount so the setup selectors can populate
  useEffect(() => {
    async function load() {
      setVocabLoading(true);
      try {
        const res  = await fetch('/api/get-all-vocab');
        const data = await res.json();
        const normalised = data.map(normaliseCard);
        setAllVocab(normalised);
        if (normalised.length > 0) {
          // API returns DESC; last item is the earliest card
          const earliest = new Date(normalised[normalised.length - 1].created_at);
          setFirstCardDate(earliest);
          const weeks = [...new Set(
            normalised.map(c => getWeekNum(new Date(c.created_at), earliest))
          )].sort((a, b) => a - b);
          setAvailableWeeks(weeks);
        }
      } catch (err) { console.error('FlashcardsTab: failed to load vocab', err); }
      finally { setVocabLoading(false); }
    }
    load();
  }, []);

  // Reset per-card UI whenever we advance to the next card
  useEffect(() => { setIsRevealed(false); setFlipKey(0); }, [sessionIndex]);

  // Flip the card (toggle front/back) with animation trigger
  const handleFlip = () => {
    setIsRevealed(v => !v);
    setFlipKey(k => k + 1);
  };

  // Pool respecting mastery scope
  const scopedCards = useMemo(() =>
    masteryScope === 'unmastered' ? allVocab.filter(c => !c.is_mastered) : allVocab,
    [allVocab, masteryScope]
  );

  // How many scoped cards match the current week filter (live preview)
  const matchingCount = useMemo(() => {
    if (weekFilter === 'all') return scopedCards.length;
    const curWeek = firstCardDate ? getWeekNum(new Date(), firstCardDate) : 1;
    const target  = weekFilter === 'current' ? curWeek : Number(weekFilter);
    return scopedCards.filter(c =>
      getWeekNum(new Date(c.created_at), firstCardDate) === target
    ).length;
  }, [scopedCards, weekFilter, firstCardDate]);

  // True when the user picked Unmastered but all words in this batch are already mastered
  const allMasteredInBatch = useMemo(() => {
    if (masteryScope !== 'unmastered') return false;
    // check if there are any words at all in the week filter before declaring "all mastered"
    const totalInBatch = weekFilter === 'all'
      ? allVocab.length
      : (() => {
          const curWeek = firstCardDate ? getWeekNum(new Date(), firstCardDate) : 1;
          const target  = weekFilter === 'current' ? curWeek : Number(weekFilter);
          return allVocab.filter(c => getWeekNum(new Date(c.created_at), firstCardDate) === target).length;
        })();
    return totalInBatch > 0 && matchingCount === 0;
  }, [allVocab, scopedCards, matchingCount, masteryScope, weekFilter, firstCardDate]);

  const startSession = () => {
    let pool = [...scopedCards];
    if (weekFilter !== 'all') {
      const curWeek = firstCardDate ? getWeekNum(new Date(), firstCardDate) : 1;
      const target  = weekFilter === 'current' ? curWeek : Number(weekFilter);
      pool = pool.filter(c =>
        getWeekNum(new Date(c.created_at), firstCardDate) === target
      );
    }
    pool = shuffleArray(pool);
    if (wordCount !== 'all') pool = pool.slice(0, Number(wordCount));
    // Write the entire new session atomically
    setFlashSession({ phase: 'PLAYING', sessionCards: pool, sessionIndex: 0, knewCount: 0 });
    setIsRevealed(false);
  };

  // Return to SETUP — used by Restart button and Done screen
  const resetToSetup = () => setFlashSession(s => ({ ...s, phase: 'SETUP' }));

  const handleReviewAction = (action) => {
    if (action === 'KNEW') setKnewCount(k => k + 1);
    onReview();
    if (sessionIndex + 1 >= sessionCards.length) {
      setFlashSession(s => ({ ...s, phase: 'DONE' }));
    } else {
      setSessionIndex(i => i + 1);
    }
  };

  const currentCard = sessionCards[sessionIndex] || null;

  // ── SETUP PHASE ──────────────────────────────────────────────────────
  if (phase === 'SETUP') return (
    <div className="setup-wrapper">
      <div className="setup-card">
        <div className="setup-icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
            <polyline points="2 12 12 17 22 12"></polyline>
            <polyline points="2 17 12 22 22 17"></polyline>
          </svg>
        </div>
        <h2 className="setup-title">Flash Cards</h2>
        <p className="setup-subtitle">Choose your session settings to start practicing</p>

        {vocabLoading ? (
          <p className="setup-loading">⏳ Loading your vocab pool…</p>
        ) : allVocab.length === 0 ? (
          <p className="setup-loading">
            No words yet. Add some on the <strong>Add Words</strong> tab first!
          </p>
        ) : (
          <>
            {/* ── Word Scope toggle ──────────────────────────────── */}
            <div className="setup-field">
              <label className="setup-label">Word Scope</label>
              <div className="setup-scope-group">
                <button
                  id="scope-unmastered"
                  className={`setup-scope-btn ${masteryScope === 'unmastered' ? 'active' : ''}`}
                  onClick={() => setMasteryScope('unmastered')}
                >
                  📚 Unmastered Only
                </button>
                <button
                  id="scope-all"
                  className={`setup-scope-btn ${masteryScope === 'all' ? 'active' : ''}`}
                  onClick={() => setMasteryScope('all')}
                >
                  ☀️ All Words
                </button>
              </div>
            </div>

            {/* ── Word Count ─────────────────────────────────────── */}
            <div className="setup-field">
              <label className="setup-label" htmlFor="setup-count">Number of words</label>
              <select
                id="setup-count"
                className="setup-select"
                value={wordCount}
                onChange={e => setWordCount(e.target.value)}
              >
                <option value="5">5 words</option>
                <option value="10">10 words</option>
                <option value="20">20 words</option>
                <option value="all">All words</option>
              </select>
            </div>

            {/* ── Week Filter ────────────────────────────────────── */}
            <div className="setup-field">
              <label className="setup-label" htmlFor="setup-week">Study period</label>
              <select
                id="setup-week"
                className="setup-select"
                value={weekFilter}
                onChange={e => setWeekFilter(e.target.value)}
              >
                <option value="all">All Weeks</option>
                <option value="current">Current Week</option>
                {availableWeeks.map(w => (
                  <option key={w} value={w}>Week {w} (w{w})</option>
                ))}
              </select>
            </div>

            {/* ── Pool preview / empty-state ─────────────────────── */}
            {allMasteredInBatch ? (
              <div className="setup-mastered-notice">
                <span className="setup-mastered-icon">🎉</span>
                <p>All words in this batch are mastered!</p>
                <p className="setup-mastered-hint">Try selecting <strong>All Words</strong> or a different week.</p>
              </div>
            ) : (
              <div className="setup-pool-info">
                <span className="setup-pool-count">{matchingCount}</span>
                <span className="setup-pool-label">
                  {matchingCount === 1 ? 'word' : 'words'} available in this period
                </span>
              </div>
            )}

            <button
              id="start-practice-btn"
              className="setup-start-btn"
              onClick={startSession}
              disabled={matchingCount === 0}
            >
              Start Practice →
            </button>
          </>
        )}
      </div>
    </div>
  );

  // ── DONE PHASE ───────────────────────────────────────────────────────
  if (phase === 'DONE') return (
    <div className="setup-wrapper">
      <div className="setup-card">
        <div className="setup-icon">🎉</div>
        <h2 className="setup-title">Session Complete!</h2>
        <div className="done-stats">
          <div className="done-stat">
            <div className="done-stat-value">{sessionCards.length}</div>
            <div className="done-stat-label">Cards Studied</div>
          </div>
          <div className="done-stat">
            <div className="done-stat-value done-knew">{knewCount}</div>
            <div className="done-stat-label">Knew It ✓</div>
          </div>
          <div className="done-stat">
            <div className="done-stat-value done-again">{sessionCards.length - knewCount}</div>
            <div className="done-stat-label">Study Again 🔁</div>
          </div>
        </div>
        <button className="setup-start-btn" onClick={resetToSetup} style={{ marginTop: '20px' }}>
          New Session
        </button>
      </div>
    </div>
  );

  // ── PLAYING PHASE ────────────────────────────────────────────────────
  return (
    <div className="flashcard-wrapper">

      {/* Session progress strip + Restart button */}
      <div className="session-progress">
        <div className="session-progress-bar">
          <div
            className="session-progress-fill"
            style={{ width: `${(sessionIndex / sessionCards.length) * 100}%` }}
          />
        </div>
        <div className="session-progress-label">
          {sessionIndex + 1} / {sessionCards.length}
        </div>
        <button
          id="restart-practice-btn"
          className="restart-btn"
          onClick={resetToSetup}
          title="Restart Practice"
          aria-label="Restart Practice"
        >
          ↺
        </button>
      </div>

      {/* ── Flip Card — click anywhere to toggle ── */}
      <div
        className="card-scene"
        onClick={handleFlip}
        role="button"
        tabIndex={0}
        aria-label={isRevealed ? 'Showing answer — tap to flip back' : 'Tap to reveal answer'}
        onKeyDown={e => e.key === 'Enter' && handleFlip()}
      >
        {/* key=flipKey forces remount → triggers CSS flip-in animation */}
        <div key={flipKey} className={`card-face ${isRevealed ? 'card-back' : 'card-front'}`}>

          {!isRevealed ? (
            /* ── FRONT: Clean & minimal — meanings only, no labels */
            <>
              <div className="flip-hint">Tap to reveal ↓</div>
              <div className="front-meaning-en">{currentCard.translation_en}</div>
              <div className="front-divider" />
              <div className="front-meaning-th">{currentCard.translation_th}</div>
            </>
          ) : (
            /* ── BACK: Structured answer layout */
            <>
              <div className="back-meta-row">
                <WordTypeBadge type={currentCard.word_type} />
                <span className="card-badge" style={{ fontSize: '9px' }}>🎲 Practice</span>
              </div>

              <div className="pinyin-main">{currentCard.pinyin}</div>
              <div className="hanzi-secondary">{currentCard.hanzi}</div>
              <div className="divider" />

              <div className="example-label">Example Sentence</div>
              <div className="example-pinyin">"{currentCard.example_sentence_pinyin}"</div>

              <div className="example-translations" style={{ marginTop: '10px' }}>
                <div className="trans-row">
                  <span className="lang-pill lang-en">EN</span>
                  <span className="trans-text">{currentCard.example_sentence_translation_en || '—'}</span>
                </div>
                <div className="trans-row">
                  <span className="lang-pill lang-th">TH</span>
                  <span className="trans-text">{currentCard.example_sentence_translation_th || '—'}</span>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Circle action buttons — slide up below card once flipped ── */}
      {/* ── Action buttons — always visible, anchored at bottom of card area ── */}
      <div className="circle-actions">
        <div className="circle-action-item">
          <button
            id="study-again-btn"
            className="circle-btn circle-again"
            onClick={e => { e.stopPropagation(); handleReviewAction('STUDY_AGAIN'); }}
            aria-label="Study Again"
          >
            ✕
          </button>
          <span className="circle-action-label">Again</span>
        </div>

        <div className="circle-action-item">
          <button
            id="knew-it-btn"
            className="circle-btn circle-knew"
            onClick={e => { e.stopPropagation(); handleReviewAction('KNEW'); }}
            aria-label="Knew It"
          >
            ✓
          </button>
          <span className="circle-action-label">Knew It</span>
        </div>
      </div>

    </div>
  );
}

// ─── Detail Modal (Vocab Bank) ─────────────────────────────────────────
function DetailModal({ card, firstCardDate, onClose }) {
  const handleBackdropClick = (e) => {
    if (e.target === e.currentTarget) onClose();
  };

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={handleBackdropClick}>
      <div className="modal-sheet" role="dialog" aria-modal="true">
        <div className="modal-handle-bar"><span /></div>

        <div className="modal-header">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
              <div className="modal-pinyin">{card.pinyin}</div>
              <WordTypeBadge type={card.word_type} />
            </div>
            <div className="modal-hanzi">{card.hanzi}</div>
          </div>
          <button className="modal-close-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="modal-body">
          {/* Meaning */}
          <div className="modal-section">
            <div className="modal-section-label">✦ Word Meaning</div>
            <div className="modal-meaning-row">
              <span className="lang-pill lang-en">EN</span>
              <span className="modal-meaning-text">{card.translation_en || '—'}</span>
            </div>
            <div className="modal-meaning-row">
              <span className="lang-pill lang-th">TH</span>
              <span className="modal-meaning-text">{card.translation_th || '—'}</span>
            </div>
          </div>

          {/* Example sentence */}
          <div className="modal-section">
            <div className="modal-section-label">✦ Example Sentence</div>
            <div className="modal-example-pinyin">
              "{card.example_sentence_pinyin || '—'}"
            </div>
            {(card.example_sentence_translation_en || card.example_sentence_translation_th) ? (
              <>
                <div className="modal-trans-row">
                  <span className="lang-pill lang-en">EN</span>
                  <span className="modal-trans-text">{card.example_sentence_translation_en || '—'}</span>
                </div>
                <div className="modal-trans-row">
                  <span className="lang-pill lang-th">TH</span>
                  <span className="modal-trans-text">{card.example_sentence_translation_th || '—'}</span>
                </div>
              </>
            ) : (
              <p className="modal-no-data">Translations not available for this legacy entry.</p>
            )}
          </div>

          {/* Meta / Card Info */}
          <div className="modal-section">
            <div className="modal-section-label">✦ Card Info</div>
            <div style={{ fontSize: '12px', color: 'var(--gray)', lineHeight: '1.9' }}>
              <div>You searched: <strong>{card.user_input}</strong></div>
              <div>Next review: <strong>
                {card.next_review_date
                  ? new Date(card.next_review_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
                  : '—'}
              </strong></div>
              {/* Feature 1: Week number tracking */}
              <div>Added: <strong>{formatDateWithWeek(card.created_at, firstCardDate)}</strong></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Tab 3: Vocab Bank ─────────────────────────────────────────────────
function VocabBankTab() {
  const [allWords, setAllWords]         = useState([]);
  const [isLoading, setIsLoading]       = useState(true);
  const [search, setSearch]             = useState('');
  const [selectedCard, setSelectedCard] = useState(null);

  // Pagination & Filters
  const [page, setPage]                 = useState(1);
  const [pageSize, setPageSize]         = useState(15);
  const [weekFilter, setWeekFilter]     = useState('all');
  const [masteryFilter, setMasteryFilter] = useState('all'); // 'all', 'mastered', 'unmastered'

  // Earliest card date — computed once from sorted desc list
  const firstCardDate = useMemo(() => {
    if (allWords.length === 0) return null;
    const dateStr = allWords[allWords.length - 1]?.created_at;
    return dateStr ? new Date(dateStr) : null;
  }, [allWords]);

  const availableWeeks = useMemo(() => {
    if (!firstCardDate || allWords.length === 0) return [];
    return [...new Set(
      allWords.map(c => getWeekNum(new Date(c.created_at), firstCardDate))
    )].sort((a, b) => a - b);
  }, [allWords, firstCardDate]);

  useEffect(() => {
    async function load() {
      setIsLoading(true);
      try {
        const res = await fetch('/api/get-all-vocab');
        if (res.ok) {
          const data = await res.json();
          setAllWords(data.map(normaliseCard));
        }
      } catch (err) { console.error('Failed to load vocab bank:', err); }
      finally { setIsLoading(false); }
    }
    load();
  }, []);

  const filtered = useMemo(() => {
    let result = allWords;

    // 1. Mastery Filter
    if (masteryFilter === 'mastered') {
      result = result.filter(w => w.is_mastered);
    } else if (masteryFilter === 'unmastered') {
      result = result.filter(w => !w.is_mastered);
    }

    // 2. Week Filter
    if (weekFilter !== 'all') {
      const curWeek = firstCardDate ? getWeekNum(new Date(), firstCardDate) : 1;
      const target = weekFilter === 'current' ? curWeek : Number(weekFilter);
      result = result.filter(w =>
        getWeekNum(new Date(w.created_at), firstCardDate) === target
      );
    }

    // 3. Search Query
    const q = search.toLowerCase().trim();
    if (q) {
      result = result.filter(w =>
        w.pinyin?.toLowerCase().includes(q) ||
        w.hanzi?.includes(q) ||
        w.translation_en?.toLowerCase().includes(q) ||
        w.translation_th?.includes(q) ||
        w.word_type?.toLowerCase().includes(q)
      );
    }

    return result;
  }, [allWords, search, masteryFilter, weekFilter, firstCardDate]);

  // Reset to page 1 if filtered results change
  useEffect(() => {
    setPage(1);
  }, [filtered.length, pageSize]);

  // Pagination Logic
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentSafePage = Math.min(page, totalPages);
  const startIndex = (currentSafePage - 1) * pageSize;
  const paginatedCards = filtered.slice(startIndex, startIndex + pageSize);

  return (
    <>
      {selectedCard && (
        <DetailModal
          card={selectedCard}
          firstCardDate={firstCardDate}
          onClose={() => setSelectedCard(null)}
        />
      )}

      <div className="bank-header">
        <h3>📚 Vocab Bank</h3>
        <span className="bank-count">{filtered.length} words</span>
      </div>

      <div className="bank-controls">
        <input
          type="search"
          className="bank-search"
          placeholder="Search Pinyin, Hanzi, English, Thai…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <div className="bank-filters">
          <select
            className="bank-filter-select"
            value={weekFilter}
            onChange={e => setWeekFilter(e.target.value)}
          >
            <option value="all">All Weeks</option>
            <option value="current">Current Week</option>
            {availableWeeks.map(w => (
              <option key={w} value={w}>Week {w} (w{w})</option>
            ))}
          </select>
          <select
            className="bank-filter-select"
            value={masteryFilter}
            onChange={e => setMasteryFilter(e.target.value)}
          >
            <option value="all">All Words</option>
            <option value="unmastered">Unmastered Only</option>
            <option value="mastered">Mastered Only</option>
          </select>
        </div>
      </div>

      <div className="bank-card">
        {isLoading ? (
          <p className="empty-list" style={{ padding: '24px 0' }}>Loading…</p>
        ) : filtered.length === 0 ? (
          <p className="empty-list" style={{ padding: '24px 0' }}>
            {search || masteryFilter !== 'all' || weekFilter !== 'all' ? 'No results found.' : 'No words yet — add some!'}
          </p>
        ) : (
          <>
            <table className="bank-table">
              <thead>
                <tr>
                  <th>Mastered</th>
                  <th>Pinyin / Hanzi</th>
                  <th>Meaning</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {paginatedCards.map((w, i) => (
                  <tr key={w.id || i} onClick={() => setSelectedCard(w)} className={w.is_mastered ? 'mastered-row' : ''}>
                    <td className="bank-mastered-col" onClick={e => e.stopPropagation()}>
                      <input 
                        type="checkbox" 
                        className="mastered-checkbox"
                        checked={!!w.is_mastered} 
                        onChange={async (e) => {
                          const newVal = e.target.checked;
                          // Optimistic update
                          setAllWords(prev => prev.map(card => card.id === w.id ? { ...card, is_mastered: newVal ? 1 : 0 } : card));
                          try {
                            await fetch('/api/toggle-mastered', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ id: w.id, is_mastered: newVal })
                            });
                          } catch(err) {
                            // Revert on error
                            setAllWords(prev => prev.map(card => card.id === w.id ? { ...card, is_mastered: !newVal ? 1 : 0 } : card));
                            console.error("Failed to toggle mastered", err);
                          }
                        }} 
                      />
                    </td>
                    <td>
                      <div className="bank-pinyin">{w.pinyin}</div>
                      <div style={{ display: 'flex', gap: '5px', alignItems: 'center', marginTop: '2px' }}>
                        <div className="bank-hanzi">{w.hanzi}</div>
                        {w.word_type && <WordTypeBadge type={w.word_type} />}
                      </div>
                    </td>
                    <td>
                      <div className="bank-en">{w.translation_en}</div>
                      <div className="bank-th">{w.translation_th}</div>
                    </td>
                    <td className="bank-actions">
                      <button
                        className="view-btn"
                        onClick={e => { e.stopPropagation(); setSelectedCard(w); }}
                      >
                        Detail
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            
            {/* Pagination Controls */}
            {totalPages > 1 && (
              <div className="pagination-controls">
                <div className="pagination-info">
                  Page {currentSafePage} of {totalPages}
                </div>
                <div className="pagination-actions">
                  <button 
                    className="pagination-btn" 
                    disabled={currentSafePage === 1}
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                  >
                    Previous
                  </button>
                  <button 
                    className="pagination-btn" 
                    disabled={currentSafePage === totalPages}
                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  >
                    Next
                  </button>
                </div>
                <div className="pagination-size">
                  <select 
                    className="pagination-select"
                    value={pageSize}
                    onChange={e => setPageSize(Number(e.target.value))}
                  >
                    <option value="15">15 / page</option>
                    <option value="30">30 / page</option>
                    <option value="50">50 / page</option>
                  </select>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

// ─── Tab 5: Quick Translate ─────────────────────────────────────────────────
// Transient scratchpad — calls Gemini, never writes to the database.
function QuickTranslateTab({ onCardAdded }) {
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult]       = useState(null);
  const [error, setError]         = useState('');
  const [addingWords, setAddingWords] = useState({}); // track loading state per word

  const handleTranslate = async () => {
    if (!inputText.trim()) return;
    setIsLoading(true);
    setError('');
    setResult(null);
    try {
      const res  = await fetch('/api/quick-translate', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ userInput: inputText }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Translation failed');
      setResult(data);
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddFromBreakdown = async (wordHanzi, idx) => {
    setAddingWords(prev => ({ ...prev, [idx]: true }));
    try {
      const res = await fetch('/api/generate-vocab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userInput: wordHanzi }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add word');
      
      const newCards = Array.isArray(data) ? data : [data];
      
      // Update local state to show it's in bank
      setResult(prev => {
        const next = { ...prev };
        next.breakdown[idx].inBank = true;
        return next;
      });
      
      onCardAdded(newCards.length, true); // true = skip tab navigation for background add
    } catch (err) {
      alert(err.message);
    } finally {
      setAddingWords(prev => ({ ...prev, [idx]: false }));
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleTranslate();
  };

  return (
    <>
      {/* Input card */}
      <div className="qt-input-card">
        <p className="section-title">Quick Translate</p>
        <p className="qt-subtitle">
          Type anything in English, Thai, or Pinyin to get the full Chinese breakdown.
        </p>
        <textarea
          id="qt-textarea"
          className="qt-textarea"
          placeholder="e.g. 'I am happy', 'สนุก', or 'ni hao'…"
          value={inputText}
          onChange={e => setInputText(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={3}
          disabled={isLoading}
        />
        <button
          id="qt-translate-btn"
          className="qt-btn"
          onClick={handleTranslate}
          disabled={isLoading || !inputText.trim()}
        >
          {isLoading ? '⏳ Translating…' : '🔤 Translate with AI'}
        </button>
        <div className="qt-cmd-hint">⌘ Ctrl+Enter to translate</div>
      </div>

      {error && <div className="error-banner">⚠️ {error}</div>}

      {/* Result card */}
      {result && (
        <div className="qt-result-card">

          {/* Detected language */}
          <div className="qt-lang-badge">
            Detected: <strong>{result.detected_language}</strong>
          </div>

          {/* Per-character breakdown grid */}
          {result.breakdown?.length > 0 && (
            <div className="qt-breakdown">
              {result.breakdown.map((item, i) => (
                <div key={i} className="qt-char-block">
                  <div className="qt-char-pinyin">{item.pinyin}</div>
                  <div className="qt-char-hanzi">{item.hanzi}</div>
                  <div className="qt-char-meaning">{item.meaning_en}</div>
                  
                  {item.inBank ? (
                    <div className="qt-added-badge">✓ In Bank</div>
                  ) : (
                    <button 
                      className="qt-add-btn" 
                      onClick={() => handleAddFromBreakdown(item.hanzi, i)}
                      disabled={addingWords[i]}
                    >
                      {addingWords[i] ? '⏳' : '➕ Add'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="divider" style={{ margin: '16px 0 14px' }} />

          {/* Full Pinyin */}
          <div className="qt-row">
            <div className="qt-row-label">Pinyin</div>
            <div className="qt-pinyin-full">{result.pinyin}</div>
          </div>

          {/* Hanzi */}
          <div className="qt-row" style={{ marginTop: '10px' }}>
            <div className="qt-row-label">Hanzi</div>
            <div className="qt-hanzi-full">{result.hanzi}</div>
          </div>

          <div className="divider" style={{ margin: '14px 0' }} />

          {/* Translations */}
          <div className="example-translations">
            <div className="trans-row">
              <span className="lang-pill lang-en">EN</span>
              <span className="trans-text">{result.translation_en}</span>
            </div>
            <div className="trans-row">
              <span className="lang-pill lang-th">TH</span>
              <span className="trans-text">{result.translation_th}</span>
            </div>
          </div>

          {/* No-save notice */}
          <div className="qt-no-save">
            🔍 Quick lookup only — not saved to your Vocab Bank
          </div>
        </div>
      )}
    </>
  );
}

// ─── Root App ──────────────────────────────────────────────────────────
export default function PinyinFirstApp() {
  const [activeTab, setActiveTab] = useState(TABS.ADD);

  // ── Dark / Light theme ─────────────────────────────────────────────────
  const [theme, setTheme] = useState('light');

  // On mount: read saved preference, then keep data-theme in sync
  useEffect(() => {
    const saved = localStorage.getItem('pinyinfirst-theme') || 'light';
    setTheme(saved);
    document.documentElement.setAttribute('data-theme', saved);
  }, []);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('pinyinfirst-theme', next);
  };

  // ── Lifted flashcard session state — persists across tab navigation ──
  const [flashSession, setFlashSession] = useState({
    phase: 'SETUP',
    sessionCards: [],
    sessionIndex: 0,
    knewCount: 0,
  });

  // Called by AddWordsTab and QuickTranslateTab when a word is saved
  const handleCardAdded = (count = 1, skipNav = false) => {
    if (!skipNav) {
      // Reset flashcard session to SETUP so the new word can be included
      setFlashSession({ phase: 'SETUP', sessionCards: [], sessionIndex: 0, knewCount: 0 });
      setActiveTab(TABS.CARDS);
    }
  };

  // Called by FlashcardsTab on each Knew It / Study Again action
  const handleReview = () => {
    // No-op since Progress tab was removed
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="logo-badge">中</div>
        <div>
          <h1>Zhongwenma</h1>
          <p>Master Chinese, One Card at a Time</p>
        </div>
        <button
          id="theme-toggle"
          className="theme-toggle-btn"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          title={theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
        >
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
      </header>

      <main className="tab-content">
        {activeTab === TABS.ADD       && <AddWordsTab onCardAdded={handleCardAdded} />}
        {activeTab === TABS.CARDS     && <FlashcardsTab onReview={handleReview} flashSession={flashSession} setFlashSession={setFlashSession} />}
        {activeTab === TABS.BANK      && <VocabBankTab />}
        {activeTab === TABS.TRANSLATE && <QuickTranslateTab onCardAdded={handleCardAdded} />}
      </main>

      <nav className="tab-bar">
        {[
          { id: TABS.ADD,       icon: '➕',  label: 'Add'       },
          { id: TABS.CARDS,     icon: '🎴',  label: 'Cards'     },
          { id: TABS.BANK,      icon: '📚',  label: 'Library'   },
          { id: TABS.TRANSLATE, icon: '🔤',  label: 'Translate' },
        ].map(tab => (
          <button
            key={tab.id}
            id={`tab-${tab.id}`}
            className={`tab-btn ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <span className="tab-icon">{tab.icon}</span>
            <span className="tab-label">{tab.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
