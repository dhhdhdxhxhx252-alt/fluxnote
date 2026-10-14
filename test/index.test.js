import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SearchIndex } from '../src/index.js';

function document(title, body, { tags = [], updated = '2026-01-01T00:00:00.000Z' } = {}) {
  return { title, body, tags, created: updated, updated };
}

function build(entries) {
  const index = new SearchIndex();
  for (const [id, doc] of Object.entries(entries)) index.add(id, doc);
  return index;
}

test('пустой индекс и пустой запрос не матчат ничего', () => {
  const index = new SearchIndex();
  assert.deepEqual(index.search('nginx'), []);
  assert.deepEqual(build({ a: document('T', 'nginx') }).search('   '), []);
});

test('запрос находит только те документы, где термин есть', () => {
  const index = build({
    '1.md': document('Настройка nginx', 'прокси и кэш'),
    '2.md': document('Рецепт пиццы', 'тесто и дрожжи'),
  });
  assert.deepEqual(index.search('nginx').map((hit) => hit.id), ['1.md']);
});

test('AND-семантика: оба термина должны встретиться в одной заметке', () => {
  const index = build({
    'a.md': document('nginx', 'прокси certbot'),
    'b.md': document('dns', 'только прокси'),
    'c.md': document('api', 'только certbot'),
  });
  assert.deepEqual(index.search('прокси certbot').map((hit) => hit.id), ['a.md']);
  assert.deepEqual(index.search('nginx отсутствуешьтермин'), []);
});

test('редкий термин весит больше частого при равной частоте и длине', () => {
  const index = build({
    'a.md': document('aa', 'nginx one'),
    'b.md': document('bb', 'nginx two'),
    'c.md': document('cc', 'nginx three'),
    'd.md': document('dd', 'certbot four'),
  });
  const common = index.search('nginx')[0].score;
  const rare = index.search('certbot')[0].score;
  assert.ok(rare > common, `rare ${rare} должен превышать common ${common}`);
});

test('термин в заголовке стоит дороже того же термина в теле', () => {
  const index = build({
    'title.md': document('nginx', 'slovo drugoe'),
    'body.md': document('proxy', 'nginx slovo'),
  });
  const hits = index.search('nginx');
  assert.deepEqual(hits.map((hit) => hit.id), ['title.md', 'body.md']);
  assert.ok(hits[0].score > hits[1].score);
});

test('частота входит в скор сублинейно, а не линейно', () => {
  const index = build({
    'once.md': document('заметка', 'nginx slovo one two three four five six seven eight nine ten'),
    'many.md': document('заметка', 'nginx nginx nginx nginx nginx nginx nginx nginx nginx nginx nginx'),
  });
  const [many] = index.search('nginx');
  assert.equal(many.id, 'many.md');
  const once = index.search('nginx', { limit: 5 }).find((hit) => hit.id === 'once.md');
  assert.ok(many.score > once.score, '12 вхождений должны быть лучше одного');
  assert.ok(many.score < once.score * 12, 'и заметно хуже, чем в 12 раз лучше');
});

test('короткая заметка с той же частотой ранжируется выше длинной', () => {
  const index = build({
    'short.md': document('nginx', 'nginx slovo'),
    'long.md': document('nginx', `nginx ${'slovo'.repeat(20)}`),
  });
  const hits = index.search('nginx');
  assert.equal(hits[0].id, 'short.md');
});

test('точный термин важнее префиксного расширения', () => {
  const index = build({
    'exact.md': document('поиск', 'поиск'),
    'prefix.md': document('запись', 'поиском'),
  });
  assert.deepEqual(index.resolveTerm('поиск'), ['поиск']);
  assert.deepEqual(index.resolveTerm('поис'), ['поиск', 'поиском']);
  assert.deepEqual(index.resolveTerm('поис*'), ['поиск', 'поиском']);
  assert.deepEqual(index.search('поиском').map((hit) => hit.id), ['prefix.md']);
});

test('короткий неизвестный термин не расширяется по префиксу', () => {
  const index = build({ 'a.md': document('abracadabra', 'текст') });
  assert.deepEqual(index.resolveTerm('ab'), []);
  assert.deepEqual(index.search('ab'), []);
});

test('remove выкидывает документ и из postings, и из size', () => {
  const index = build({
    'a.md': document('nginx', 'прокси'),
    'b.md': document('redis', 'прокси'),
  });
  assert.equal(index.remove('a.md'), true);
  assert.equal(index.remove('a.md'), false);
  assert.equal(index.size, 1);
  assert.deepEqual(index.search('nginx'), []);
  assert.deepEqual(index.search('прокси').map((hit) => hit.id), ['b.md']);
});

test('повторное add того же id заменяет документ, а не удваивает его', () => {
  const index = build({ 'a.md': document('nginx', 'старое') });
  index.add('a.md', document('redis', 'новое'));
  assert.equal(index.size, 1);
  assert.deepEqual(index.search('nginx'), []);
  assert.deepEqual(index.search('старое'), []);
  assert.equal(index.search('redis')[0].title, 'redis');
});

test('при равных очках раньше идёт более свежая заметка', () => {
  const index = build({
    'old.md': document('nginx', 'текст', { updated: '2025-01-01T00:00:00.000Z' }),
    'new.md': document('nginx', 'другой', { updated: '2026-06-01T00:00:00.000Z' }),
  });
  const hits = index.search('nginx');
  assert.equal(hits[0].score, hits[1].score);
  assert.deepEqual(hits.map((hit) => hit.id), ['new.md', 'old.md']);
});

test('limit и topTerms/frequencies работают', () => {
  const index = build({
    'a.md': document('nginx', 'nginx nginx'),
    'b.md': document('nginx', 'nginx'),
    'c.md': document('redis', 'redis'),
  });
  assert.equal(index.search('nginx', { limit: 1 }).length, 1);
  assert.equal(index.frequencies('NGINX'), 2);
  assert.equal(index.topTerms(1)[0].term, 'nginx');
  assert.equal(index.topTerms(1)[0].documents, 2);
});

test('clear обнуляет и документы, и термины', () => {
  const index = build({ 'a.md': document('nginx', 'прокси') });
  index.clear();
  assert.equal(index.size, 0);
  assert.equal(index.terms, 0);
  assert.deepEqual(index.documents(), []);
});
