import { deriveTitle, slugify } from './text.js';

const DELIMITER = '---';

export class NoteError extends Error {}

/**
 * Разбирает заметку: опциональный frontmatter между первыми двумя `---`
 * и остальной текст как тело. Формат намеренно крошечный: title, tags, created, updated.
 */
export function parseNote(raw) {
  const text = raw.replace(/\r\n/g, '\n');
  const lines = text.split('\n');

  if (lines[0]?.trim() !== DELIMITER) {
    return { title: deriveTitle(text), tags: [], created: null, updated: null, body: text.trim() };
  }

  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === DELIMITER);
  if (closing === -1) {
    throw new NoteError('Frontmatter не закрыт: нужен второй разделитель ---');
  }

  const fields = {};
  for (const line of lines.slice(1, closing)) {
    if (line.trim() === '') continue;
    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) throw new NoteError(`Непонятная строка frontmatter: ${line}`);
    fields[match[1].toLowerCase()] = match[2].trim();
  }

  const body = lines.slice(closing + 1).join('\n').trim();

  return {
    title: fields.title || deriveTitle(body),
    tags: parseTags(fields.tags),
    created: fields.created || null,
    updated: fields.updated || null,
    body,
  };
}

function parseTags(value) {
  if (!value) return [];
  const inner = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  return uniqueStrings(
    inner
      .split(',')
      .map((tag) => tag.trim().replace(/^["']|["']$/g, ''))
      .filter((tag) => tag !== ''),
  );
}

function uniqueStrings(values) {
  return [...new Set(values)];
}

export function serializeNote({ title, tags = [], created = null, updated = null, body }) {
  const lines = [DELIMITER];
  lines.push(`title: ${title}`);
  if (created) lines.push(`created: ${created}`);
  if (updated) lines.push(`updated: ${updated}`);
  if (tags.length > 0) lines.push(`tags: [${tags.join(', ')}]`);
  lines.push(DELIMITER, '', body.trim(), '');
  return lines.join('\n');
}

/** Имя файла заметки: дата + слаг заголовка, без пробелов и небезопасных символов. */
export function fileNameFor(note, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const slug = slugify(note.title);
  return `${day}-${slug}.md`;
}

export function addTag(note, tag) {
  const clean = tag.trim().replace(/^#/, '');
  if (clean === '') return note;
  return { ...note, tags: uniqueStrings([...note.tags, clean]) };
}

export function removeTag(note, tag) {
  const clean = tag.trim().replace(/^#/, '');
  return { ...note, tags: note.tags.filter((value) => value !== clean) };
}
