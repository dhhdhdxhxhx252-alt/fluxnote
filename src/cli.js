#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { snippet } from './text.js';
import { Library } from './library.js';
import { NoteError } from './note.js';
import { VaultError } from './vault.js';

const HELP = `fluxnote — локальный markdown-журнал с собственным поисковым индексом (BM25).

Использование:
  fluxnote init                          создать хранилище
  fluxnote new "Заголовок" [фрагмент]    добавить заметку (--tags a,b)
  fluxnote new "Заголовок" --stdin       прочитать тело из stdin
  fluxnote append <ref> "строка"         дописать в конец заметки
  fluxnote search запрос... [--tag t]    поиск, --json для машинного вывода
  fluxnote show <ref> [--json]           полный текст заметки
  fluxnote list [--tag t] [--limit N]    свежие заметки
  fluxnote tags                          теги с количеством
  fluxnote tag <ref> <tag>               добавить тег
  fluxnote untag <ref> <tag>             убрать тег
  fluxnote rm <ref> [--yes]              в корзину (.trash)
  fluxnote purge                         очистить корзину
  fluxnote reindex                       пересобрать индекс с нуля
  fluxnote stats                         размеры хранилища и самые частые термины

Ссылка на заметку (<ref>): имя файла, префикс имени или заголовок.
Хранилище: --vault <путь>, иначе FLUXNOTE_HOME, иначе ~/.fluxnote.
`;

const OPTIONS = {
  vault: { type: 'string' },
  tags: { type: 'string' },
  tag: { type: 'string' },
  since: { type: 'string' },
  limit: { type: 'string', default: '20' },
  stdin: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  yes: { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
};

function vaultRoot(values) {
  const raw = values.vault ?? process.env.FLUXNOTE_HOME ?? join(homedir(), '.fluxnote');
  return resolve(raw);
}

function parseTags(raw) {
  if (!raw) return [];
  return raw.split(',').map((tag) => tag.trim()).filter((tag) => tag !== '');
}

function line(text = '') {
  process.stdout.write(`${text}\n`);
}

function pad(value, width) {
  return String(value).padEnd(width);
}

function when(doc) {
  return (doc.updated ?? doc.created ?? '').slice(0, 10) || '—';
}

function printSearch(library, query, values) {
  const hits = library.search(query, {
    tag: values.tag ?? null,
    since: values.since ?? null,
    limit: Number(values.limit),
  });

  if (values.json) {
    line(JSON.stringify(hits.map(({ termCount, uniqueTerms, ...hit }) => hit), null, 2));
    return hits.length === 0 ? 1 : 0;
  }

  if (hits.length === 0) {
    line(`Ничего не найдено по запросу: ${query}`);
    return 1;
  }

  for (const hit of hits) {
    line(`${pad(hit.score, 7)} ${pad(hit.id, 34)} ${hit.title}`);
    line(`        ${when(hit)} · ${hit.tags.length > 0 ? hit.tags.join(', ') : 'без тегов'}`);
    const preview = snippet(hit.body, query.split(/\s+/).filter(Boolean), { radius: 46 });
    if (preview) line(`        ${preview}`);
  }
  line(`\n${hits.length} совпадени${hits.length === 1 ? 'е' : 'й'} (из ${library.index.size} заметок).`);
  return 0;
}

export function main(argv) {
  try {
    return dispatch(argv);
  } catch (error) {
    if (error instanceof VaultError || error instanceof NoteError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

function dispatch(argv) {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  const command = positionals[0] ?? 'help';
  const library = new Library(vaultRoot(values));
  const words = positionals.slice(1);

  switch (command) {
    case 'help':
    case '--help':
      process.stdout.write(HELP);
      return 0;

    case 'init': {
      const stats = library.sync();
      line(`Хранилище готово: ${library.paths.notes}`);
      line(`Заметок: ${stats.files}, индексировано заново: ${stats.reindexed}.`);
      return 0;
    }

    case 'new': {
      const title = words[0] ?? 'Без названия';
      const body = values.stdin
        ? readFileSync(0, 'utf8')
        : words.slice(1).join(' ');
      const note = library.create({ title, body, tags: parseTags(values.tags) });
      line(`Создана ${note.id}`);
      if (values.json) line(JSON.stringify({ id: note.id, ...note }, null, 2));
      return 0;
    }

    case 'append': {
      const [ref, ...rest] = words;
      if (!ref || rest.length === 0) throw new VaultError('append: нужен <ref> и текст.');
      const note = library.append(ref, rest.join(' '));
      line(`Дописано в ${note.id} (обновлено ${note.updated}).`);
      return 0;
    }

    case 'search': {
      if (words.length === 0) throw new VaultError('search: пустой запрос.');
      return printSearch(library, words.join(' '), values);
    }

    case 'show': {
      const [ref] = words;
      if (!ref) throw new VaultError('show: нужен <ref>.');
      const { id, note } = library.read(ref);
      if (values.json) {
        line(JSON.stringify({ id, ...note }, null, 2));
        return 0;
      }
      line(`${note.title}`);
      line(`${'='.repeat(Math.max(3, note.title.length))}`);
      line(`id: ${id} · created: ${note.created ?? '—'} · updated: ${note.updated ?? '—'}`);
      line(`tags: ${note.tags.join(', ') || '—'}`);
      line('');
      line(note.body);
      return 0;
    }

    case 'list': {
      const notes = library.list({ tag: values.tag ?? null, limit: Number(values.limit) });
      if (values.json) {
        line(JSON.stringify(notes.map(({ termCount, uniqueTerms, ...note }) => note), null, 2));
        return 0;
      }
      if (notes.length === 0) {
        line('Заметок пока нет — начни с `fluxnote new "…"`.');
        return 0;
      }
      for (const note of notes) {
        line(`${pad(when(note), 11)} ${pad(note.id, 34)} ${note.title}${note.tags.length ? `  [${note.tags.join(', ')}]` : ''}`);
      }
      return 0;
    }

    case 'tags': {
      const tags = library.tags();
      if (values.json) {
        line(JSON.stringify(tags, null, 2));
        return 0;
      }
      if (tags.length === 0) {
        line('Тегов нет.');
        return 0;
      }
      for (const entry of tags) line(`${pad(entry.count, 6)} ${entry.tag}`);
      return 0;
    }

    case 'tag': {
      const [ref, tag] = words;
      if (!ref || !tag) throw new VaultError('tag: нужен <ref> и тег.');
      const note = library.tag(ref, tag);
      line(`Теги ${note.id}: ${note.tags.join(', ')}`);
      return 0;
    }

    case 'untag': {
      const [ref, tag] = words;
      if (!ref || !tag) throw new VaultError('untag: нужен <ref> и тег.');
      const note = library.untag(ref, tag);
      line(`Теги ${note.id}: ${note.tags.join(', ') || '—'}`);
      return 0;
    }

    case 'rm': {
      const [ref] = words;
      if (!ref) throw new VaultError('rm: нужен <ref>.');
      const { id } = library.read(ref);
      if (!values.yes) {
        line(`Удалить ${id}? Переместить в .trash? Передай --yes.`);
        return 1;
      }
      const removed = library.remove(ref);
      line(`Удалено в ${removed.trash}`);
      return 0;
    }

    case 'purge':
      line(`Очищено файлов: ${library.purge()}.`);
      return 0;

    case 'reindex': {
      const stats = library.rebuild();
      line(`Проверено файлов: ${stats.files}, заново: ${stats.reindexed}, убрано: ${stats.removed}.`);
      return 0;
    }

    case 'stats': {
      const stats = library.stats();
      if (values.json) {
        line(JSON.stringify({ vault: library.paths.root, ...stats }, null, 2));
        return 0;
      }
      line(`Хранилище:  ${library.paths.root}`);
      line(`Заметок:   ${stats.notes}`);
      line(`Терминов:  ${stats.terms}`);
      line(`Слов:      ${stats.words} (в среднем ${stats.averageBody} на заметку)`);
      line(`Тегов:     ${stats.tags}`);
      if (stats.topTerms.length > 0) {
        line('\nЧастые термины:');
        for (const entry of stats.topTerms) line(`  ${pad(entry.documents, 4)} ${entry.term}`);
      }
      return 0;
    }

    default:
      process.stderr.write(`Неизвестная команда: ${command}. fluxnote --help\n`);
      return 2;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
