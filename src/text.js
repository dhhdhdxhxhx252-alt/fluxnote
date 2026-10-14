const WORD_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu;

export function normalize(text) {
  return String(text).normalize('NFKC').toLocaleLowerCase('en');
}

/** Разбивает текст на токены: буквы обоих регистров, цифры, апостроф и дефис внутри слова. */
export function tokenize(text) {
  return normalize(text).match(WORD_PATTERN) ?? [];
}

export function uniqueTerms(terms) {
  return [...new Set(terms)];
}

const SLUG_STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'was',
  'и', 'в', 'во', 'с', 'со', 'на', 'не', 'но', 'как', 'что', 'это', 'для', 'от', 'до', 'из', 'или',
]);

/** Короткая читаемая ссылка для имени файла. Пустая строка даёт 'note'. */
export function slugify(text, { maxLength = 48 } = {}) {
  const words = tokenize(text).filter((term) => term.length > 1 && !SLUG_STOP.has(term));
  const slug = words.join('-').slice(0, maxLength).replace(/-+$/g, '');
  return slug || 'note';
}

/** Возвращает первую строку-заголовок markdown (# …) либо первое непустое содержимое. */
export function deriveTitle(body) {
  const lines = String(body).split(/\r?\n/);
  const heading = lines.find((line) => /^#{1,6}\s+\S/.test(line));
  if (heading) return heading.replace(/^#{1,6}\s+/, '').trim();
  const text = lines.find((line) => line.trim() !== '' && !line.startsWith('---'));
  return (text ?? 'Untitled').trim().slice(0, 120);
}

/** Одна строка- snippet с подсветкой совпадений через ⟪ ⟫. */
export function snippet(body, terms, { radius = 42 } = {}) {
  const flat = String(body).replace(/[#>*`_\-]{1,}/g, ' ').replace(/\s+/g, ' ').trim();
  if (flat === '') return '';
  const wanted = uniqueTerms(terms.map(normalize)).filter((term) => term.length > 0);

  let at = -1;
  for (const term of wanted) {
    const index = indexOfTerm(flat, term);
    if (index !== -1 && (at === -1 || index < at)) at = index;
  }

  if (at === -1) {
    return flat.length <= radius * 2 ? flat : `${flat.slice(0, radius * 2)}…`;
  }
  const start = Math.max(0, at - radius);
  const end = Math.min(flat.length, at + radius * 2);
  const fragment = `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
  return wanted.reduce((output, term) => markTerm(output, term), fragment);
}

/** Позиция термина в оригинальном регистре; поиск идёт по нормализованной форме. */
export function indexOfTerm(text, term, from = 0) {
  for (let index = Math.max(0, from); index + term.length <= text.length; index += 1) {
    const candidate = text.slice(index, index + term.length);
    if (normalize(candidate) === term) return index;
  }
  return -1;
}

function markTerm(text, term) {
  let output = '';
  let cursor = 0;
  for (;;) {
    const at = indexOfTerm(text, term, cursor);
    if (at === -1) return `${output}${text.slice(cursor)}`;
    output += text.slice(cursor, at) + `⟪${text.slice(at, at + term.length)}⟫`;
    cursor = at + term.length;
  }
}
