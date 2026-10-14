import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { main } from '../src/cli.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function vault() {
  return mkdtempSync(join(tmpdir(), 'fluxnote-cli-'));
}

async function run(args) {
  const lines = { out: [], err: [] };
  const streams = [process.stdout, process.stderr];
  const originals = streams.map((stream) => stream.write);
  streams[0].write = (chunk) => { lines.out.push(String(chunk)); return true; };
  streams[1].write = (chunk) => { lines.err.push(String(chunk)); return true; };
  try {
    const code = await Promise.resolve(main(args));
    return { code, out: lines.out.join(''), err: lines.err.join('') };
  } finally {
    streams.forEach((stream, index) => { stream.write = originals[index]; });
  }
}

test('полный путь: init → new → search → show → rm', async () => {
  const dir = vault();
  try {
    const init = await run(['--vault', dir, 'init']);
    assert.equal(init.code, 0);
    assert.match(init.out, /Хранилище готово/);
    assert.ok(existsSync(join(dir, 'notes')));

    const created = await run(['--vault', dir, 'new', 'Настройка nginx', 'прокси', 'и', 'кэш', '--tags', 'infra,nginx']);
    assert.equal(created.code, 0);
    assert.match(created.out, /Создана 2026-\d\d-\d\d-настройка-nginx\.md/);

    const found = await run(['--vault', dir, 'search', 'nginx']);
    assert.equal(found.code, 0);
    assert.match(found.out, /⟪nginx⟫|nginx/);

    const missing = await run(['--vault', dir, 'search', 'отсутствуетполностью']);
    assert.equal(missing.code, 1);
    assert.match(missing.out, /Ничего не найдено/);

    const shown = await run(['--vault', dir, 'show', 'настройка']);
    assert.equal(shown.code, 0);
    assert.match(shown.out, /Настройка nginx/);
    assert.match(shown.out, /прокси и кэш/);

    const removed = await run(['--vault', dir, 'rm', 'настройка', '--yes']);
    assert.equal(removed.code, 0);
    assert.ok(existsSync(join(dir, '.trash')));
    assert.equal(existsSync(join(dir, 'notes', 'nope')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('новое заметка читает тело из stdin (реальный запуск процесса)', () => {
  const dir = vault();
  try {
    const result = spawnSync(
      process.execPath,
      [CLI, '--vault', dir, 'new', 'Импорт', '--stdin'],
      { input: 'тело из pipes\nвторая строка', encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Создана .*импорт\.md/);

    const listed = spawnSync(process.execPath, [CLI, '--vault', dir, 'search', 'pipes', '--json'], { encoding: 'utf8' });
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(JSON.parse(listed.stdout)[0].title, 'Импорт');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('list, tags и stats отдают машиночитаемый json', async () => {
  const dir = vault();
  try {
    await run(['--vault', dir, 'new', 'Первая', 'nginx', 'proxy', '--tags', 'infra']);
    await run(['--vault', dir, 'new', 'Вторая', 'redis', '--tags', 'infra']);

    const list = await run(['--vault', dir, 'list', '--json']);
    const notes = JSON.parse(list.out);
    assert.equal(notes.length, 2);
    assert.equal('body' in notes[0], true);
    assert.equal('termCount' in notes[0], false);

    const tags = await run(['--vault', dir, 'tags', '--json']);
    assert.deepEqual(JSON.parse(tags.out), [{ tag: 'infra', count: 2 }]);

    const stats = await run(['--vault', dir, 'stats', '--json']);
    const parsed = JSON.parse(stats.out);
    assert.equal(parsed.notes, 2);
    assert.equal(parsed.vault.replace(/\\/g, '/'), dir.replace(/\\/g, '/'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('search --json отдаёт id, title, tags и score', async () => {
  const dir = vault();
  try {
    await run(['--vault', dir, 'new', 'Кэш', 'маркертермин', '--tags', 'perf']);
    const result = await run(['--vault', dir, 'search', 'маркертермин', '--json']);
    assert.equal(result.code, 0);
    const [hit] = JSON.parse(result.out);
    assert.equal(hit.title, 'Кэш');
    assert.deepEqual(hit.tags, ['perf']);
    assert.ok(hit.score > 0);
    assert.equal('termCount' in hit, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rm без --yes ничего не удаляет, неизвестная команда даёт код 2', async () => {
  const dir = vault();
  try {
    await run(['--vault', dir, 'new', 'Живучая', 'телозаписи']);

    const guarded = await run(['--vault', dir, 'rm', 'живучая']);
    assert.equal(guarded.code, 1);
    assert.match(guarded.out, /--yes/);
    assert.equal(readdirSync(join(dir, 'notes')).length, 1);
    assert.deepEqual(readdirSync(join(dir, '.trash')), []);

    const found = await run(['--vault', dir, 'search', 'телозаписи']);
    assert.equal(found.code, 0);

    const removed = await run(['--vault', dir, 'rm', 'живучая', '--yes']);
    assert.equal(removed.code, 0);
    assert.equal(readdirSync(join(dir, 'notes')).length, 0);
    assert.equal(readdirSync(join(dir, '.trash')).length, 1);

    const unknown = await run(['--vault', dir, 'вырвиглаз']);
    assert.equal(unknown.code, 2);
    assert.match(unknown.err, /неизвестная/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ошибка ссылки на заметку печатается одной строкой, без стектрейса', async () => {
  const dir = vault();
  try {
    const result = await run(['--vault', dir, 'show', 'нет-такой-заметки']);
    assert.equal(result.code, 1);
    assert.match(result.err, /не найдена/);
    assert.doesNotMatch(result.out + result.err, /at |node:internal/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--help печатает список команд', async () => {
  const result = await run(['--help']);
  assert.equal(result.code, 0);
  assert.match(result.out, /fluxnote new/);
  assert.match(result.out, /reindex/);
});
