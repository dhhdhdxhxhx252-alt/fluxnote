import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deriveTitle, normalize, slugify, snippet, tokenize } from '../src/text.js';

test('tokenize оставляет слова обоих алфавитов, цифры и дефис внутри слова', () => {
  assert.deepEqual(tokenize('Hello, МИР! test-2024 #тег'), ['hello', 'мир', 'test-2024', 'тег']);
});

test('tokenize пустого текста и текста без слов даёт пустой массив', () => {
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize('...!!!'), []);
});

test('normalize приводит NFKC и нижний регистр: полноширинный nginx равен ascii', () => {
  assert.equal(normalize('ＮＧＩＮＸ'), 'nginx');
  assert.equal(normalize('ПРОКСИ'), 'прокси');
});

test('slugify убирает стоп-слова и сокращает до дефисной ссылки', () => {
  assert.equal(slugify('The nginx settings of DNS'), 'nginx-settings-dns');
  assert.equal(slugify('Настройка и разбор BM25'), 'настройка-разбор-bm25');
});

test('slugify на мусор возвращает note, а не пустую строку', () => {
  assert.equal(slugify('!!! ???'), 'note');
  assert.equal(slugify('a i в'), 'note');
});

test('slugify обрезает по maxLength на границе слова', () => {
  const slug = slugify('один два три четыре пять шесть семь', { maxLength: 12 });
  assert.ok(slug.length <= 12);
  assert.doesNotMatch(slug, /-$/);
});

test('deriveTitle берёт markdown-заголовок, иначе первую строку', () => {
  assert.equal(deriveTitle('# Привет мир\nbody'), 'Привет мир');
  assert.equal(deriveTitle('###   Spaced heading'), 'Spaced heading');
  assert.equal(deriveTitle('просто текст\nвторая строка'), 'просто текст');
  assert.equal(deriveTitle(''), 'Untitled');
});

test('snippet подсвечивает совпадение и сохраняет оригинальный регистр', () => {
  assert.equal(snippet('Nginx прокси конфиг', ['nginx']), '⟪Nginx⟫ прокси конфиг');
});

test('snippet регистронезависим и работает по нормализованной форме', () => {
  assert.equal(snippet('ПРОКСИ на 443', ['прокси']), '⟪ПРОКСИ⟫ на 443');
});

test('snippet без совпадения отдаёт начало текста с многоточием', () => {
  const long = 'a'.repeat(200);
  assert.equal(snippet(long, ['нет']), `${'a'.repeat(84)}…`);
  assert.equal(snippet('короткий', ['нет']), 'короткий');
});

test('snippet режет окно вокруг первого совпадения с обеих сторон', () => {
  const body = `${'префикс '.repeat(20)}нужноеслово ${'суффикс '.repeat(20)}`;
  const out = snippet(body, ['нужноеслово'], { radius: 10 });
  assert.match(out, /⟪нужноеслово⟫/);
  assert.ok(out.startsWith('…'));
  assert.ok(out.endsWith('…'));
  assert.ok(out.length < body.length);
});

test('snippet на пустом теле возвращает пустую строку', () => {
  assert.equal(snippet('   ', ['что']), '');
});
