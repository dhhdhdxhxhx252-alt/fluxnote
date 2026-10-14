import { tokenize } from './text.js';
import { addTag, NoteError, parseNote, removeTag, serializeNote, fileNameFor } from './note.js';
import { SearchIndex } from './index.js';
import {
  allocateName,
  deleteNoteFile,
  ensureVault,
  listNoteFiles,
  purgeTrash,
  readCache,
  readNoteFile,
  statNoteFile,
  VaultError,
  writeCache,
  writeNoteFile,
} from './vault.js';

const SCAN_LIMIT = 1000;

export class Library {
  #cache;

  constructor(root, { now = () => new Date() } = {}) {
    this.paths = ensureVault(root);
    this.now = now;
    this.index = new SearchIndex();
    this.#cache = readCache(this.paths);
  }

  /**
   * Догоняет индекс: перечитывает только те файлы, у которых изменились size или mtime.
   * Удалённые с диска заметки выпадают из индекса сами.
   */
  sync() {
    const files = listNoteFiles(this.paths);
    const present = new Set(files);
    let reindexed = 0;
    let removed = 0;
    let unchanged = 0;

    for (const name of Object.keys(this.#cache.files)) {
      if (present.has(name)) continue;
      this.index.remove(name);
      delete this.#cache.files[name];
      removed += 1;
    }

    for (const name of files) {
      const stamp = statNoteFile(this.paths, name);
      const known = this.#cache.files[name];
      if (stamp && known && known.size === stamp.size && known.mtimeMs === stamp.mtimeMs && this.index.has(name)) {
        unchanged += 1;
        continue;
      }
      if (!stamp) continue;
      const note = parseNote(readNoteFile(this.paths, name));
      this.index.add(name, { id: name, ...note });
      this.#cache.files[name] = { size: stamp.size, mtimeMs: stamp.mtimeMs };
      reindexed += 1;
    }

    writeCache(this.paths, this.#cache);
    return { files: files.length, reindexed, removed, unchanged };
  }

  create({ title, body = '', tags = [] }) {
    if (!String(title).trim()) throw new VaultError('Заметке нужен заголовок.');
    const stamp = this.now().toISOString();
    const note = { title: String(title).trim(), tags: cleanTags(tags), created: stamp, updated: stamp, body };
    const name = allocateName(this.paths, fileNameFor(note, this.now()));
    writeNoteFile(this.paths, name, serializeNote(note));
    this.index.add(name, { id: name, ...note });
    this.#cache.files[name] = statNoteFile(this.paths, name);
    writeCache(this.paths, this.#cache);
    return { id: name, ...note };
  }

  /** Допишет строку в конец тела — режим «журнала», где заметка растёт по дням. */
  append(ref, line) {
    const { id, note } = this.read(ref);
    const body = `${note.body.trimEnd()}\n\n${String(line).trim()}\n`;
    return this.#store(id, { ...note, body, updated: this.now().toISOString() });
  }

  tag(ref, tag) {
    const { id, note } = this.read(ref);
    return this.#store(id, { ...addTag(note, tag), updated: this.now().toISOString() });
  }

  untag(ref, tag) {
    const { id, note } = this.read(ref);
    return this.#store(id, { ...removeTag(note, tag), updated: this.now().toISOString() });
  }

  replaceBody(ref, body) {
    const { id, note } = this.read(ref);
    const parsed = parseNote(body);
    return this.#store(id, {
      ...note,
      ...parsed,
      title: parsed.title || note.title,
      tags: parsed.tags.length > 0 ? parsed.tags : note.tags,
      created: note.created,
      updated: this.now().toISOString(),
    });
  }

  remove(ref) {
    const { id } = this.read(ref);
    const trashPath = deleteNoteFile(this.paths, id, this.now());
    this.index.remove(id);
    delete this.#cache.files[id];
    writeCache(this.paths, this.#cache);
    return { id, trash: trashPath };
  }

  purge() {
    return purgeTrash(this.paths);
  }

  read(ref) {
    const name = this.#resolve(ref);
    return { id: name, note: parseNote(readNoteFile(this.paths, name)) };
  }

  /** Полный пересбор: сбрасывает индекс и кэш стадов, затем обходит все файлы. */
  rebuild() {
    this.index.clear();
    this.#cache = { version: 1, files: {} };
    writeCache(this.paths, this.#cache);
    return this.sync();
  }

  list({ tag = null, limit = 50 } = {}) {
    this.sync();
    return this.index
      .documents()
      .filter((doc) => (tag === null ? true : doc.tags.includes(tag)))
      .sort((left, right) => String(right.updated ?? right.created ?? '').localeCompare(String(left.updated ?? left.created ?? '')))
      .slice(0, limit);
  }

  /**
   * BM25-ранжирование поверх AND-семантики, затем фильтры по тегам и дате.
   * Фильтры применяются после скоринга, поэтому `limit` — это уже отфильтрованный вывод.
   */
  search(query, { tag = null, since = null, limit = 20 } = {}) {
    this.sync();
    const hits = this.index.search(query, { limit: SCAN_LIMIT })
      .filter((doc) => (tag === null || doc.tags.includes(tag)))
      .filter((doc) => (since === null || dateOf(doc) !== null && dateOf(doc) >= since))
      .slice(0, limit);
    return hits;
  }

  tags() {
    this.sync();
    const counts = new Map();
    for (const doc of this.index.documents()) {
      for (const tag of doc.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag));
  }

  stats() {
    this.sync();
    const documents = this.index.documents();
    const words = documents.reduce((total, doc) => total + tokenize(doc.body).length, 0);
    return {
      notes: documents.length,
      terms: this.index.terms,
      words,
      tags: this.tags().length,
      averageBody: documents.length === 0 ? 0 : Math.round(words / documents.length),
      topTerms: this.index.topTerms(8),
    };
  }

  #store(name, note) {
    writeNoteFile(this.paths, name, serializeNote(note));
    this.index.add(name, { id: name, ...note });
    this.#cache.files[name] = statNoteFile(this.paths, name);
    writeCache(this.paths, this.#cache);
    return { id: name, ...note };
  }

  /** Имя файла, имя без .md, уникальный префикс или уникальное совпадение заголовка. */
  #resolve(ref) {
    const wanted = String(ref).trim();
    if (wanted === '') throw new VaultError('Пустая ссылка на заметку.');

    const files = listNoteFiles(this.paths);
    const exact = wanted.endsWith('.md') ? wanted : `${wanted}.md`;
    if (files.includes(exact)) return exact;
    if (files.includes(wanted)) return wanted;

    const prefixed = files.filter((name) => name.startsWith(wanted.replace(/\.md$/i, '')));
    if (prefixed.length === 1) return prefixed[0];
    if (prefixed.length > 1) throw new VaultError(`Префикс «${wanted}» неоднозначен: ${prefixed.join(', ')}`);

    const substring = files.filter((name) => name.includes(wanted.replace(/\.md$/i, '')));
    if (substring.length === 1) return substring[0];
    if (substring.length > 1) throw new VaultError(`Подстрока «${wanted}» неоднозначна: ${substring.join(', ')}`);

    this.sync();
    const byTitle = this.index.documents().filter(
      (doc) => normalizeTitle(doc.title) === normalizeTitle(wanted),
    );
    if (byTitle.length === 1) return byTitle[0].id;
    if (byTitle.length > 1) {
      throw new VaultError(`Заголовок «${wanted}» есть у нескольких заметок: ${byTitle.map((doc) => doc.id).join(', ')}`);
    }

    throw new VaultError(`Заметка не найдена: ${wanted}`);
  }
}

function normalizeTitle(value) {
  return String(value).normalize('NFKC').toLowerCase().trim();
}

function dateOf(doc) {
  const raw = doc.updated ?? doc.created;
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function cleanTags(tags) {
  return [...new Set(
    (tags ?? []).map((tag) => String(tag).trim().replace(/^#/, '')).filter((tag) => tag !== ''),
  )];
}

export { NoteError };
