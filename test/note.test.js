import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addTag, fileNameFor, NoteError, parseNote, removeTag, serializeNote } from '../src/note.js';

test('roundtrip: frontmatter и тело восстанавливаются один в один', () => {
  const note = {
    title: 'Настройка nginx',
    tags: ['infra', 'nginx'],
    created: '2026-01-05T10:00:00.000Z',
    updated: '2026-01-06T10:00:00.000Z',
    body: '# Запуск\nproxy_pass 127.0.0.1:8080;\n',
  };
  const parsed = parseNote(serializeNote(note));
  assert.equal(parsed.title, 'Настройка nginx');
  assert.deepEqual(parsed.tags, ['infra', 'nginx']);
  assert.equal(parsed.created, '2026-01-05T10:00:00.000Z');
  assert.equal(parsed.updated, '2026-01-06T10:00:00.000Z');
  assert.equal(parsed.body, '# Запуск\nproxy_pass 127.0.0.1:8080;');
});

test('заметка без frontmatter получает заголовок из тела', () => {
  const parsed = parseNote('# Просто текст\nвторая строка');
  assert.equal(parsed.title, 'Просто текст');
  assert.deepEqual(parsed.tags, []);
  assert.equal(parsed.created, null);
});

test('tags принимаются и списком в скобках, и plain-перечислением', () => {
  assert.deepEqual(parseNote('---\ntitle: T\ntags: [a, b]\n---\nx').tags, ['a', 'b']);
  assert.deepEqual(parseNote('---\ntitle: T\ntags: a, b , c\n---\nx').tags, ['a', 'b', 'c']);
  assert.deepEqual(parseNote('---\ntitle: T\ntags: ["a", b]\n---\nx').tags, ['a', 'b']);
});

test('дубликаты тегов схлопываются при разборе', () => {
  assert.deepEqual(parseNote('---\ntitle: T\ntags: [a, b, a]\n---\nx').tags, ['a', 'b']);
});

test('CRLF в frontmatter не ломает разбор', () => {
  const parsed = parseNote('---\r\ntitle: T\r\ntags: [a]\r\n---\r\nbody\r\n');
  assert.equal(parsed.title, 'T');
  assert.deepEqual(parsed.tags, ['a']);
  assert.equal(parsed.body, 'body');
});

test('незакрытый frontmatter — ошибка, а не тихий fallback', () => {
  assert.throws(() => parseNote('---\ntitle: T\nbody without closing'), NoteError);
});

test('непонятная строка frontmatter отклоняется', () => {
  assert.throws(() => parseNote('---\nnot a field\n---\nbody'), /непонятная строка/i);
});

test('serialize не пишет пустые поля и всегда оставляет тело после разделителя', () => {
  const text = serializeNote({ title: 'T', tags: [], body: 'тело' });
  assert.doesNotMatch(text, /created:/);
  assert.doesNotMatch(text, /tags:/);
  assert.match(text, /^---\ntitle: T\n---\n\nтело\n$/);
});

test('addTag чистит решётку и дубликаты, removeTag убирает точное значение', () => {
  const base = { title: 'T', tags: ['a'], created: null, updated: null, body: '' };
  assert.deepEqual(addTag(base, '#b').tags, ['a', 'b']);
  assert.deepEqual(addTag(base, 'a').tags, ['a']);
  assert.deepEqual(addTag(base, '  ').tags, ['a']);
  assert.deepEqual(removeTag({ ...base, tags: ['a', 'b'] }, 'a').tags, ['b']);
});

test('fileNameFor собирает дату и слаг заголовка', () => {
  const now = new Date('2026-03-09T08:00:00.000Z');
  assert.equal(fileNameFor({ title: 'Настройка nginx' }, now), '2026-03-09-настройка-nginx.md');
  assert.equal(fileNameFor({ title: '??' }, now), '2026-03-09-note.md');
});
