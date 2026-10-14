import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

export class VaultError extends Error {}

const NOTES_DIR = 'notes';
const TRASH_DIR = '.trash';

export function vaultPaths(root) {
  const absolute = resolve(root);
  return {
    root: absolute,
    notes: join(absolute, NOTES_DIR),
    trash: join(absolute, TRASH_DIR),
    cache: join(absolute, '.fluxnote-index.json'),
  };
}

/** Путь обязан остаться внутри root — иначе `../../etc/passwd` становится заметкой. */
export function insideVault(root, relative) {
  const absolute = resolve(root, relative);
  const prefix = resolve(root) + sep;
  if (absolute !== resolve(root) && !absolute.startsWith(prefix)) {
    throw new VaultError(`Путь выходит за пределы хранилища: ${relative}`);
  }
  return absolute;
}

export function ensureVault(root) {
  const paths = vaultPaths(root);
  mkdirSync(paths.notes, { recursive: true });
  mkdirSync(paths.trash, { recursive: true });
  return paths;
}

/** Служебные файлы (с точкой или подчёркиванием в начале) в индекс не попадают. */
export function isMarkdown(name) {
  return name.toLowerCase().endsWith('.md') && !name.startsWith('.') && !name.startsWith('_');
}

export function listNoteFiles(paths) {
  if (!existsSync(paths.notes)) return [];
  return readdirSortedSafe(paths.notes).filter(isMarkdown);
}

function readdirSortedSafe(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

export function readNoteFile(paths, name) {
  const target = insideVault(paths.notes, name);
  if (!existsSync(target)) throw new VaultError(`Заметка не найдена: ${name}`);
  return readFileSync(target, 'utf8');
}

export function statNoteFile(paths, name) {
  const target = insideVault(paths.notes, name);
  if (!existsSync(target)) return null;
  const { size, mtimeMs } = statSync(target);
  return { size, mtimeMs };
}

/** Свободное имя файла: дата+слаг, при коллизии -2, -3 и так далее. */
export function allocateName(paths, desired) {
  const dot = desired.lastIndexOf('.');
  const stem = dot === -1 ? desired : desired.slice(0, dot);
  const extension = dot === -1 ? '.md' : desired.slice(dot);
  let attempt = `${stem}${extension}`;
  for (let index = 2; existsSync(join(paths.notes, attempt)); index += 1) {
    attempt = `${stem}-${index}${extension}`;
  }
  return attempt;
}

export function writeNoteFile(paths, name, contents) {
  const target = insideVault(paths.notes, name);
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, contents, 'utf8');
  renameSync(temp, target);
  return target;
}

export function deleteNoteFile(paths, name, now = new Date()) {
  const source = insideVault(paths.notes, name);
  if (!existsSync(source)) throw new VaultError(`Заметка не найдена: ${name}`);
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const target = join(paths.trash, `${stamp}-${name}`);
  mkdirSync(dirname(target), { recursive: true });
  renameSync(source, target);
  return target;
}

export function purgeTrash(paths) {
  if (!existsSync(paths.trash)) return 0;
  const entries = readdirNames(paths.trash);
  rmSync(paths.trash, { recursive: true, force: true });
  mkdirSync(paths.trash, { recursive: true });
  return entries.length;
}

function readdirNames(dir) {
  return readdirSync(dir);
}

export function readCache(paths) {
  if (!existsSync(paths.cache)) return { version: 1, files: {} };
  try {
    const parsed = JSON.parse(readFileSync(paths.cache, 'utf8'));
    if (parsed?.version !== 1 || typeof parsed.files !== 'object') return { version: 1, files: {} };
    return { version: 1, files: parsed.files };
  } catch {
    return { version: 1, files: {} };
  }
}

export function writeCache(paths, cache) {
  writeFileSync(paths.cache, `${JSON.stringify({ version: 1, ...cache }, null, 2)}\n`, 'utf8');
}
