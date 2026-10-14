import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { Library } from '../src/library.js';
import { insideVault, VaultError } from '../src/vault.js';

const FIXED = new Date('2026-02-03T09:00:00.000Z');

function vault() {
  const dir = mkdtempSync(join(tmpdir(), 'fluxnote-'));
  return {
    dir,
    library: new Library(dir, { now: () => FIXED }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('vault раскрывает notes/.trash и отклоняет побег за пределы хранилища', () => {
  const { dir, library, cleanup } = vault();
  try {
    assert.ok(existsSync(join(dir, 'notes')));
    assert.ok(existsSync(join(dir, '.trash')));
    assert.equal(library.paths.root, resolve(dir));
    assert.throws(() => insideVault(dir, '../escape.md'), VaultError);
    assert.throws(() => insideVault(dir, 'notes/../../outside.md'), VaultError);
  } finally {
    cleanup();
  }
});

test('create пишет файл с frontmatter и сразу делает его находимым', () => {
  const { library, cleanup } = vault();
  try {
    const note = library.create({ title: 'Настройка nginx', body: 'прокси и кэш', tags: ['infra'] });
    assert.equal(note.id, '2026-02-03-настройка-nginx.md');

    const raw = readFileSync(join(library.paths.notes, note.id), 'utf8');
    assert.match(raw, /^---\ntitle: Настройка nginx\n/);
    assert.match(raw, /tags: \[infra]/);

    assert.deepEqual(library.search('nginx').map((hit) => hit.id), [note.id]);
  } finally {
    cleanup();
  }
});

test('коллизия имён добавляет суффикс, а не перезаписывает', () => {
  const { library, cleanup } = vault();
  try {
    const first = library.create({ title: 'Запись', body: 'раз' });
    const second = library.create({ title: 'Запись', body: 'два' });
    assert.equal(first.id, '2026-02-03-запись.md');
    assert.equal(second.id, '2026-02-03-запись-2.md');
    assert.equal(library.list().length, 2);
  } finally {
    cleanup();
  }
});

test('sync перечитывает только изменённые файлы', () => {
  const { library, cleanup } = vault();
  try {
    const note = library.create({ title: 'До', body: 'оригинал' });
    let stats = library.sync();
    assert.deepEqual(
      { files: stats.files, reindexed: stats.reindexed, unchanged: stats.unchanged },
      { files: 1, reindexed: 0, unchanged: 1 },
    );

    writeFileSync(join(library.paths.notes, note.id), '---\ntitle: После\n---\nновое содержимое');
    stats = library.sync();
    assert.deepEqual({ reindexed: stats.reindexed, unchanged: stats.unchanged }, { reindexed: 1, unchanged: 0 });
    assert.equal(library.search('оригинал').length, 0);
    assert.equal(library.search('содержимое')[0].title, 'После');
  } finally {
    cleanup();
  }
});

test('файл, удалённый мимо API, выпадает из индекса при sync', () => {
  const { library, cleanup } = vault();
  try {
    const note = library.create({ title: 'Временная', body: 'терминмаркер' });
    assert.equal(library.search('терминмаркер').length, 1);
    rmSync(join(library.paths.notes, note.id));

    const stats = library.sync();
    assert.equal(stats.removed, 1);
    assert.equal(library.search('терминмаркер').length, 0);
  } finally {
    cleanup();
  }
});

test('rm перекладывает в .trash и убирает из поиска, purge чистит корзину', () => {
  const { library, cleanup } = vault();
  try {
    const note = library.create({ title: 'На удаление', body: 'маркер' });
    const removed = library.remove(note.id);
    assert.ok(removed.trash.includes('.trash'));
    assert.ok(existsSync(removed.trash));
    assert.equal(existsSync(join(library.paths.notes, note.id)), false);
    assert.equal(library.search('маркер').length, 0);

    assert.equal(library.purge(), 1);
    assert.equal(existsSync(removed.trash), false);
  } finally {
    cleanup();
  }
});

test('append, tag и untag переживают перезапуск: состояние только на диске', () => {
  const { dir, library, cleanup } = vault();
  try {
    const note = library.create({ title: 'Журнал', body: 'запись один', tags: ['log'] });
    library.append(note.id, 'запись два');
    library.tag(note.id, 'important');
    library.untag(note.id, 'log');

    const reopened = new Library(dir, { now: () => FIXED });
    const { id, note: read } = reopened.read(note.id);
    assert.equal(id, note.id);
    assert.match(read.body, /запись один\n\nзапись два/);
    assert.deepEqual(read.tags, ['important']);
    assert.equal(reopened.search('два')[0].id, note.id);
  } finally {
    cleanup();
  }
});

test('ссылка разрешается по префиксу, подстроке имени и заголовку', () => {
  const { library, cleanup } = vault();
  try {
    const note = library.create({ title: 'Разбор BM25', body: 'okapi' });
    assert.equal(library.read('2026-02-03-разбор').id, note.id);
    assert.equal(library.read('разбор').id, note.id);
    assert.equal(library.read('Разбор BM25').id, note.id);
    assert.equal(library.read(note.id).id, note.id);
  } finally {
    cleanup();
  }
});

test('неоднозначная ссылка и несуществующая дают внятную ошибку', () => {
  const { library, cleanup } = vault();
  try {
    library.create({ title: 'Общее имя', body: 'раз' });
    library.create({ title: 'Общее имя', body: 'два' });
    assert.throws(() => library.read('Общее имя'), /нескольких заметок/);
    assert.throws(() => library.read('нет-такого'), /не найдена/);
    assert.throws(() => library.read(''), VaultError);
  } finally {
    cleanup();
  }
});

test('фильтры search: по тегу и по дате, limit применяется после фильтра', () => {
  const { library, cleanup } = vault();
  try {
    const nginx = library.create({ title: 'nginx upstream', body: 'proxy', tags: ['infra'] });
    library.create({ title: 'nginx рецепт', body: 'proxy food', tags: ['food'] });

    assert.deepEqual(library.search('nginx proxy', { tag: 'infra' }).map((hit) => hit.id), [nginx.id]);
    assert.deepEqual(library.search('nginx proxy', { tag: 'nope' }), []);
    assert.equal(library.search('nginx', { since: '2026-02-03' }).length, 2);
    assert.equal(library.search('nginx', { since: '2027-01-01' }).length, 0);
    assert.equal(library.search('nginx proxy', { limit: 1 }).length, 1);
  } finally {
    cleanup();
  }
});

test('tags считает вхождения, stats даёт размеры корпуса', () => {
  const { library, cleanup } = vault();
  try {
    library.create({ title: 'Раз', body: 'nginx nginx', tags: ['a', 'b'] });
    library.create({ title: 'Два', body: 'nginx redis', tags: ['b'] });

    assert.deepEqual(library.tags(), [{ tag: 'b', count: 2 }, { tag: 'a', count: 1 }]);
    const stats = library.stats();
    assert.equal(stats.notes, 2);
    assert.equal(stats.words, 4);
    assert.equal(stats.tags, 2);
    assert.ok(stats.terms > 0);
    assert.equal(stats.topTerms[0].documents, 2);
    assert.ok(stats.topTerms.some((entry) => entry.term === 'nginx'));
    assert.ok(stats.topTerms.some((entry) => entry.term === 'b'), 'теги тоже попадают в индекс');
  } finally {
    cleanup();
  }
});

test('rebuild пересобирает индекс с нуля и находит то же самое', () => {
  const { dir, library, cleanup } = vault();
  try {
    library.create({ title: 'Кэш', body: 'терминмаркер', tags: ['perf'] });
    const stats = new Library(dir, { now: () => FIXED }).rebuild();
    assert.deepEqual({ files: stats.files, reindexed: stats.reindexed }, { files: 1, reindexed: 1 });
    assert.equal(library.search('терминмаркер')[0].title, 'Кэш');
  } finally {
    cleanup();
  }
});

test('битый кэш и служебные файлы не ломают sync', () => {
  const { dir, library, cleanup } = vault();
  try {
    library.create({ title: 'Живая', body: 'маркер' });
    writeFileSync(library.paths.cache, '{ это не json');
    writeFileSync(join(library.paths.notes, '.hidden.md'), '# Скрыто\nнескрытыйтермин');
    writeFileSync(join(library.paths.notes, '_draft.md'), '# Черновик\nчерновиктермин');
    writeFileSync(join(library.paths.notes, 'заметка.txt'), 'не markdown');

    const reopened = new Library(dir, { now: () => FIXED });
    const stats = reopened.sync();
    assert.equal(stats.files, 1);
    assert.equal(stats.reindexed, 1);
    assert.equal(reopened.search('маркер').length, 1);
    assert.equal(reopened.search('черновиктермин').length, 0);
    assert.equal(reopened.search('нескрытыйтермин').length, 0);
  } finally {
    cleanup();
  }
});

test('mtime без изменения размера всё равно ловится как правка', () => {
  const { library, cleanup } = vault();
  try {
    const note = library.create({ title: 'Правка', body: 'раз' });
    const path = join(library.paths.notes, note.id);
    writeFileSync(path, readFileSync(path, 'utf8').replace('раз', 'два'));
    utimesSync(path, new Date('2020-01-01T00:00:00.000Z'), new Date('2020-01-01T00:00:00.000Z'));

    const stats = library.sync();
    assert.equal(stats.reindexed, 1);
    assert.equal(library.search('два').length, 1);
  } finally {
    cleanup();
  }
});

test('create без заголовка отклоняется', () => {
  const { library, cleanup } = vault();
  try {
    assert.throws(() => library.create({ title: '   ', body: 'x' }), VaultError);
  } finally {
    cleanup();
  }
});
