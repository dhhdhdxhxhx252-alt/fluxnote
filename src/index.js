import { normalize, tokenize, uniqueTerms } from './text.js';

const K1 = 1.4;
const B = 0.75;

/**
 * Inverted index + скоринг BM25 (Okapi BM25).
 * postings: term -> Map(noteId -> tf). Пустой запрос не матчится вообще.
 */
export class SearchIndex {
  #postings = new Map();
  #docs = new Map();

  get size() {
    return this.#docs.size;
  }

  get terms() {
    return this.#postings.size;
  }

  documents() {
    return [...this.#docs.values()];
  }

  has(id) {
    return this.#docs.has(id);
  }

  add(id, document) {
    this.remove(id);
    const terms = tokenize(`${document.title}\n${document.title}\n${document.tags.join(' ')}\n${document.body}`);
    const counts = new Map();
    for (const term of terms) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }

    this.#docs.set(id, {
      ...document,
      termCount: terms.length,
      uniqueTerms: counts.size,
    });

    for (const [term, frequency] of counts) {
      const posting = this.#postings.get(term) ?? new Map();
      posting.set(id, frequency);
      this.#postings.set(term, posting);
    }
  }

  remove(id) {
    if (!this.#docs.has(id)) return false;
    for (const [term, posting] of this.#postings) {
      posting.delete(id);
      if (posting.size === 0) this.#postings.delete(term);
    }
    this.#docs.delete(id);
    return true;
  }

  clear() {
    this.#postings.clear();
    this.#docs.clear();
  }

  #averageLength() {
    if (this.#docs.size === 0) return 0;
    let total = 0;
    for (const doc of this.#docs.values()) total += doc.termCount;
    return total / this.#docs.size;
  }

  #idf(term) {
    const df = this.#postings.get(term)?.size ?? 0;
    if (df === 0) return 0;
    const total = this.#docs.size;
    return Math.log(1 + (total - df + 0.5) / (df + 0.5));
  }

  /** Термины с префиксным расширением: `поиск` находит и `поиском`, если точного совпадения нет. */
  resolveTerm(input) {
    const term = normalize(input);
    if (term === '') return [];
    if (term.endsWith('*')) {
      const prefix = term.slice(0, -1);
      if (prefix === '') return [];
      return [...this.#postings.keys()].filter((key) => key.startsWith(prefix)).slice(0, 32);
    }
    if (this.#postings.has(term)) return [term];
    if (term.length < 4) return [];
    return [...this.#postings.keys()].filter((key) => key.startsWith(term)).slice(0, 8);
  }

  /**
   * AND-семантика: заметка должна содержать каждый запросный термин (хотя бы одним из
   * его вариантов). Порядок — по убыванию BM25, при равенстве — по свежести.
   */
  search(query, { limit = 20 } = {}) {
    const tokens = uniqueTerms(String(query).trim().split(/\s+/).filter(Boolean));
    if (tokens.length === 0 || this.#docs.size === 0) return [];

    const groups = [];
    for (const token of tokens) {
      const terms = this.resolveTerm(token);
      if (terms.length === 0) return [];
      groups.push(terms);
    }

    const average = this.#averageLength() || 1;

    const perGroup = groups.map((group) => {
      const matched = new Map();
      for (const term of group) {
        for (const [id, frequency] of this.#postings.get(term)) {
          matched.set(id, Math.max(matched.get(id) ?? 0, frequency));
        }
      }
      return { group, matched };
    });

    // AND: остаёмся только на тех документах, где каждый термин запроса встретился.
    let candidates = new Set(perGroup[0].matched.keys());
    for (const { matched } of perGroup.slice(1)) {
      candidates = new Set([...candidates].filter((id) => matched.has(id)));
    }
    if (candidates.size === 0) return [];

    const scores = new Map();
    for (const { group, matched } of perGroup) {
      const idf = Math.max(...group.map((term) => this.#idf(term)), 0);
      for (const id of candidates) {
        const frequency = matched.get(id);
        if (frequency === undefined) continue;
        const doc = this.#docs.get(id);
        const norm = frequency * (K1 + 1);
        const denominator = frequency + K1 * (1 - B + B * (doc.termCount / average));
        scores.set(id, (scores.get(id) ?? 0) + idf * (norm / denominator));
      }
    }

    return [...scores.entries()]
      .map(([id, score]) => ({ ...this.#docs.get(id), id, score: Math.round(score * 1000) / 1000 }))
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return String(right.updated ?? right.created ?? '').localeCompare(String(left.updated ?? left.created ?? ''));
      })
      .slice(0, limit);
  }

  frequencies(term) {
    return this.#postings.get(normalize(term))?.size ?? 0;
  }

  topTerms(limit = 10) {
    return [...this.#postings.entries()]
      .sort((left, right) => right[1].size - left[1].size)
      .slice(0, limit)
      .map(([term, posting]) => ({ term, documents: posting.size }));
  }
}
