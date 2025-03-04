// MIT License
//
// Copyright (c) 2025 Sherbolot Arbaev
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import { exec } from 'child_process';
import * as crypto from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { URL } from 'url';
import { promisify } from 'util';

////////////////////////////////////////////////////////////////////////////////
// Concurrency limit
////////////////////////////////////////////////////////////////////////////////

/*
  A simple concurrency queue to avoid overwhelming the file system with
  countless parallel operations. This helps improve overall throughput
  without hitting OS limits.
*/
function pLimit(concurrency: number) {
  let activeCount = 0;
  const queue: {
    fn: () => Promise<any>;
    resolve: (value: any) => void;
    reject: (reason?: any) => void;
  }[] = [];

  const next = () => {
    while (activeCount < concurrency && queue.length) {
      const { fn, resolve, reject } = queue.shift()!;
      activeCount++;
      fn()
        .then((val) => {
          activeCount--;
          resolve(val);
          next();
        })
        .catch((err) => {
          activeCount--;
          reject(err);
          next();
        });
    }
  };

  return function <T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  };
}

// The concurrency limit for I/O operations
const IO_CONCURRENCY = 32;
const runLimited = pLimit(IO_CONCURRENCY);
const execAsync = promisify(exec);

////////////////////////////////////////////////////////////////////////////////
// Configuration constants
////////////////////////////////////////////////////////////////////////////////

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_DIRECTORY_DEPTH = 20;
const MAX_FILES = 10000;
const MAX_TOTAL_SIZE_BYTES = 500 * 1024 * 1024;
const TMP_BASE_PATH = path.join(tmpdir(), 'gitingest');

////////////////////////////////////////////////////////////////////////////////
// Interfaces
////////////////////////////////////////////////////////////////////////////////

interface IngestionStats {
  totalFiles: number;
  totalSize: number;
}

interface NodeData {
  name: string;
  type: 'file' | 'directory';
  size: number;
  path: string;
  children?: NodeData[];
  content?: string;
  fileCount?: number;
  dirCount?: number;
  ignoreContent?: boolean;
}

interface ParsedQuery {
  user_name?: string;
  repo_name?: string;
  local_path: string;
  url?: string;
  slug: string;
  id: string;
  subpath: string;
  type?: string;
  branch?: string;
  commit?: string;
  max_file_size: number;
  ignorePatterns?: Set<string>;
  includePatterns?: Set<string>;
}

interface CloneConfig {
  url: string;
  localPath: string;
  commit?: string;
  branch?: string;
  subpath: string;
}

////////////////////////////////////////////////////////////////////////////////
// Default Ignore Patterns
////////////////////////////////////////////////////////////////////////////////

const DEFAULT_IGNORE_PATTERNS: Set<string> = new Set([
  '*.pyc',
  '*.pyo',
  '*.pyd',
  '__pycache__',
  '.pytest_cache',
  '.coverage',
  '.tox',
  '.nox',
  '.mypy_cache',
  '.ruff_cache',
  '.hypothesis',
  'poetry.lock',
  'Pipfile.lock',
  'node_modules',
  'bower_components',
  'package-lock.json',
  'yarn.lock',
  '.npm',
  '.yarn',
  '.pnpm-store',
  'bun.lock',
  'bun.lockb',
  '*.class',
  '*.jar',
  '*.war',
  '*.ear',
  '*.nar',
  '.gradle/',
  'build/',
  '.settings/',
  '.classpath',
  'gradle-app.setting',
  '*.gradle',
  '.project',
  '*.o',
  '*.obj',
  '*.dll',
  '*.dylib',
  '*.exe',
  '*.lib',
  '*.out',
  '*.a',
  '*.pdb',
  '.build/',
  '*.xcodeproj/',
  '*.xcworkspace/',
  '*.pbxuser',
  '*.mode1v3',
  '*.mode2v3',
  '*.perspectivev3',
  '*.xcuserstate',
  'xcuserdata/',
  '.swiftpm/',
  '*.gem',
  '.bundle/',
  'vendor/bundle',
  'Gemfile.lock',
  '.ruby-version',
  '.ruby-gemset',
  '.rvmrc',
  'Cargo.lock',
  '**/*.rs.bk',
  'target/',
  'pkg/',
  'obj/',
  '*.suo',
  '*.user',
  '*.userosscache',
  '*.sln.docstates',
  'packages/',
  '*.nupkg',
  'bin/',
  '.git',
  '.svn',
  '.hg',
  '.gitignore',
  '.gitattributes',
  '.gitmodules',
  '*.svg',
  '*.png',
  '*.jpg',
  '*.jpeg',
  '*.gif',
  '*.ico',
  '*.pdf',
  '*.mov',
  '*.mp4',
  '*.mp3',
  '*.wav',
  'venv',
  '.venv',
  'env',
  '.env',
  'virtualenv',
  '.idea',
  '.vscode',
  '.vs',
  '*.swo',
  '*.swn',
  '.settings',
  '*.sublime-*',
  '*.log',
  '*.bak',
  '*.swp',
  '*.tmp',
  '*.temp',
  '.cache',
  '.sass-cache',
  '.eslintcache',
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  'build',
  'dist',
  'out',
  '*.egg-info',
  '*.egg',
  '*.whl',
  '*.so',
  'site-packages',
  '.docusaurus',
  '.next',
  '.nuxt',
  '*.min.js',
  '*.min.css',
  '*.map',
  '.terraform',
  '*.tfstate*',
  'vendor/',
  '*.ttf',
  '*.otf',
  '*.woff',
  'fonts/',
  '*.lock.json',
  '*.lock',
  '*.lockb',
  '*lock.yaml',
  '*lock.yml',
  '*lock.json5',
  '*lock.jsonc',
  '*lock.json5',
  '*lock.jsonc',
  'src/components/ui/',
  '*.mdx',
]);

const KNOWN_GIT_HOSTS: string[] = [
  'github.com',
  'gitlab.com',
  'bitbucket.org',
  'gitea.com',
  'codeberg.org',
  'gist.github.com',
];

////////////////////////////////////////////////////////////////////////////////
// Helper Functions
////////////////////////////////////////////////////////////////////////////////

function toForwardSlash(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Quickly check if a buffer is likely binary by scanning up to 1024 bytes.
 * If more than 10% of those bytes are "unusual," we treat it as binary.
 */
function isBinaryBuffer(buf: Buffer): boolean {
  if (!buf.length) return false;
  let suspiciousBytes = 0;
  const total = Math.min(buf.length, 1024);
  for (let i = 0; i < total; i++) {
    const charCode = buf[i];
    if (charCode === 0) {
      return true;
    }
    if ((charCode < 7 || charCode > 13) && (charCode < 32 || charCode > 127)) {
      suspiciousBytes++;
      if ((suspiciousBytes * 100) / total > 10) return true;
    }
  }
  return false;
}

/**
 * Checks if a file is textual or binary by reading a small chunk of it.
 */
async function isTextFile(filepath: string): Promise<boolean> {
  try {
    // Concurrency-limited open, read, close
    const fd = await runLimited(() => fs.open(filepath, 'r'));
    const buf = Buffer.alloc(1024);
    const { bytesRead } = await fd.read(buf, 0, 1024, 0);
    await fd.close();
    return !isBinaryBuffer(buf.subarray(0, bytesRead));
  } catch {
    return false;
  }
}

function normalizePattern(p: string): string {
  let normalized = p;
  while (normalized.startsWith('/') || normalized.startsWith('\\')) {
    normalized = normalized.slice(1);
  }
  if (normalized.endsWith('/') || normalized.endsWith('\\')) {
    normalized += '*';
  }
  return normalized;
}

function validatePattern(pattern: string): boolean {
  for (const c of pattern) {
    const allowed =
      (c >= '0' && c <= '9') ||
      (c >= 'a' && c <= 'z') ||
      (c >= 'A' && c <= 'Z') ||
      '-_./+*@'.includes(c);
    if (!allowed) return false;
  }
  return true;
}

/**
 * Convert user-included or excluded pattern strings into a normalized Set.
 */
function parsePatterns(input: string | Set<string>): Set<string> {
  const result = new Set<string>();
  if (typeof input === 'string') {
    const parts = input.split(/[, ]+/).filter((x) => x.trim().length > 0);
    for (const p of parts) {
      if (!validatePattern(p)) {
        throw new Error(`Invalid pattern: '${p}'`);
      }
      result.add(normalizePattern(p));
    }
  } else {
    for (const item of input) {
      const parts = item.split(/[, ]+/).filter((x) => x.trim().length > 0);
      for (const p of parts) {
        if (!validatePattern(p)) {
          throw new Error(`Invalid pattern: '${p}'`);
        }
        result.add(normalizePattern(p));
      }
    }
  }
  return result;
}

/**
 * Remove patterns from ignoreSet that are present in includeSet to keep them included.
 */
function overrideIgnorePatterns(
  ignoreSet: Set<string>,
  includeSet: Set<string>,
): Set<string> {
  const copy = new Set<string>(ignoreSet);
  for (const inc of includeSet) {
    if (copy.has(inc)) {
      copy.delete(inc);
    }
  }
  return copy;
}

/**
 * Run a curl -I request to check if a remote repo URL exists (200 or 301 status).
 */
async function checkRepoExists(url: string): Promise<boolean> {
  try {
    const { stdout } = await runLimited(() => execAsync(`curl -I ${url}`));
    const lines = stdout.toString().split('\n');
    if (lines.length > 0) {
      const statusLine = lines[0].trim();
      if (statusLine.includes('200') || statusLine.includes('301')) {
        return true;
      } else if (statusLine.includes('404') || statusLine.includes('302')) {
        return false;
      }
    }
    throw new Error(`Unexpected response from curl: ${stdout}`);
  } catch {
    return false;
  }
}

/**
 * Fetch the list of branches from a remote repo with "git ls-remote --heads"
 */
async function fetchRemoteBranchList(url: string): Promise<string[]> {
  const { stdout } = await runLimited(() =>
    execAsync(`git ls-remote --heads ${url}`),
  );
  const lines = stdout.split('\n').filter((x) => x.trim().length > 0);
  const branches: string[] = [];
  for (const line of lines) {
    if (line.includes('refs/heads/')) {
      const parts = line.split('refs/heads/');
      if (parts.length === 2) {
        branches.push(parts[1].trim());
      }
    }
  }
  return branches;
}

function isValidGitCommitHash(commit: string): boolean {
  return commit.length === 40 && /^[0-9a-fA-F]{40}$/.test(commit);
}

async function tryDomainsForUserAndRepo(
  userName: string,
  repoName: string,
): Promise<string> {
  for (const domain of KNOWN_GIT_HOSTS) {
    const candidate = `https://${domain}/${userName}/${repoName}`;
    if (await checkRepoExists(candidate)) {
      return domain;
    }
  }
  throw new Error(
    `Could not find a valid repository host for '${userName}/${repoName}'.`,
  );
}

function getUserAndRepoFromPath(p: string): [string, string] {
  const parts = p.toLowerCase().replace(/^\/+/, '').split('/');
  if (parts.length < 2) {
    throw new Error(`Invalid repository URL '${p}'`);
  }
  return [parts[0], parts[1]];
}

function validateHost(host: string): void {
  if (!KNOWN_GIT_HOSTS.includes(host)) {
    throw new Error(`Unknown domain '${host}' in URL`);
  }
}

function validateScheme(scheme: string): void {
  if (scheme !== 'https' && scheme !== 'http') {
    throw new Error(`Invalid URL scheme '${scheme}' in URL`);
  }
}

async function configureBranchAndSubpath(
  parts: string[],
  remoteUrl: string,
): Promise<string | undefined> {
  try {
    const branches = await fetchRemoteBranchList(remoteUrl);
    const branchPieces: string[] = [];
    while (parts.length > 0) {
      branchPieces.push(parts.shift()!);
      const candidate = branchPieces.join('/');
      if (branches.includes(candidate)) {
        return candidate;
      }
    }
    return branchPieces.join('/');
  } catch {
    return parts.shift();
  }
}

////////////////////////////////////////////////////////////////////////////////
// Repository / Path Parsing
////////////////////////////////////////////////////////////////////////////////

async function parseRepoSource(source: string): Promise<ParsedQuery> {
  const decoded = decodeURIComponent(source);
  let parsed: URL;

  try {
    parsed = new URL(decoded);
    validateScheme(parsed.protocol.replace(':', ''));
    validateHost(parsed.hostname.toLowerCase());
  } catch {
    // If it's not a valid URL with scheme, parse the host from the first segment
    const firstSlash = decoded.split('/')[0].toLowerCase();
    if (firstSlash.includes('.')) {
      validateHost(firstSlash);
      const full = 'https://' + decoded;
      parsed = new URL(full);
    } else {
      // Attempt known domains until we find one that actually exists
      const [u, r] = getUserAndRepoFromPath(decoded);
      const domain = await tryDomainsForUserAndRepo(u, r);
      const finalUrl = 'https://' + domain + '/' + decoded;
      parsed = new URL(finalUrl);
    }
  }

  const host = parsed.hostname.toLowerCase();
  let [userName, repoName] = ['', ''];
  const pieces = parsed.pathname.replace(/^\/+/, '').split('/');
  if (pieces.length >= 2) {
    userName = pieces[0];
    repoName = pieces[1];
  } else {
    throw new Error(`Invalid repository URL '${source}'`);
  }
  const id = crypto.randomUUID();
  const slug = `${userName}-${repoName}`;
  const localPath = path.join(TMP_BASE_PATH, id, slug);
  const finalUrl = `https://${host}/${userName}/${repoName}`;

  const result: ParsedQuery = {
    user_name: userName,
    repo_name: repoName,
    local_path: localPath,
    url: finalUrl,
    slug,
    id,
    subpath: '/',
    max_file_size: MAX_FILE_SIZE,
  };

  const remainder = pieces.slice(2);
  if (remainder.length === 0) {
    return result;
  }
  const possibleType = remainder.shift()!;
  if (remainder.length === 0) {
    return result;
  }
  if (['issues', 'pull'].includes(possibleType)) {
    return result;
  }
  result.type = possibleType;

  const cOrB = remainder[0];
  if (isValidGitCommitHash(cOrB)) {
    result.commit = cOrB;
    remainder.shift();
  } else {
    const br = await configureBranchAndSubpath(remainder, finalUrl);
    if (br && br.length > 0) {
      result.branch = br;
    }
  }
  if (remainder.length > 0) {
    result.subpath += remainder.join('/');
  }
  return result;
}

function parseLocalPath(source: string): ParsedQuery {
  const absolute = path.resolve(source);
  const pdir = path.dirname(absolute);
  const pname = path.basename(absolute);
  const id = crypto.randomUUID();
  return {
    local_path: absolute,
    slug: `${pdir}/${pname}`,
    id,
    subpath: '/',
    max_file_size: MAX_FILE_SIZE,
  };
}

export async function parseQuery(
  source: string,
  maxFileSize: number,
  fromWeb: boolean,
  includePatterns?: string | Set<string>,
  ignorePatterns?: string | Set<string>,
): Promise<ParsedQuery> {
  let base: ParsedQuery;
  const isLikelyUrl =
    fromWeb ||
    source.startsWith('http://') ||
    source.startsWith('https://') ||
    KNOWN_GIT_HOSTS.some((h) => source.includes(h));

  if (isLikelyUrl) {
    base = await parseRepoSource(source);
  } else {
    base = parseLocalPath(source);
  }
  base.max_file_size = maxFileSize;

  const ignoreSet = new Set<string>(DEFAULT_IGNORE_PATTERNS);
  if (ignorePatterns) {
    const extraIgnores = parsePatterns(ignorePatterns);
    for (const ig of extraIgnores) {
      ignoreSet.add(ig);
    }
  }

  if (includePatterns) {
    const parsedInclude = parsePatterns(includePatterns);
    const overridden = overrideIgnorePatterns(ignoreSet, parsedInclude);
    base.ignorePatterns = overridden;
    base.includePatterns = parsedInclude;
  } else {
    base.ignorePatterns = ignoreSet;
  }

  return base;
}

////////////////////////////////////////////////////////////////////////////////
// Git Operations
////////////////////////////////////////////////////////////////////////////////

async function checkGitInstalled(): Promise<void> {
  try {
    await runLimited(() => execAsync('git --version'));
  } catch {
    throw new Error('Git is not installed or not accessible.');
  }
}

async function runCommand(
  ...args: string[]
): Promise<{ stdout: string; stderr: string }> {
  await checkGitInstalled();
  try {
    // concurrency-limited exec
    const { stdout, stderr } = await runLimited(() =>
      execAsync(args.join(' ')),
    );
    return { stdout, stderr };
  } catch (err: any) {
    throw new Error(
      `Command failed: ${args.join(' ')}\nError: ${err.message || err}`,
    );
  }
}

export async function cloneRepo(config: CloneConfig): Promise<void> {
  const { url, localPath, commit, branch, subpath } = config;
  const partialClone = subpath !== '/';
  const parentDir = path.dirname(localPath);

  await runLimited(() => fs.mkdir(parentDir, { recursive: true }));

  if (!(await checkRepoExists(url))) {
    throw new Error('Repository not found, ensure it is public.');
  }

  const cloneArgs = ['git', 'clone', '--recurse-submodules', '--single-branch'];
  if (partialClone) {
    cloneArgs.push('--filter=blob:none');
    cloneArgs.push('--sparse');
  }
  if (!commit) {
    cloneArgs.push('--depth=1');
    if (branch && !['main', 'master'].includes(branch.toLowerCase())) {
      cloneArgs.push('--branch');
      cloneArgs.push(branch);
    }
  }
  cloneArgs.push(url);
  cloneArgs.push(localPath);
  await runCommand(...cloneArgs);

  if (commit || partialClone) {
    if (partialClone) {
      const checkoutArgs = [
        'git',
        '-C',
        localPath,
        'sparse-checkout',
        'set',
        subpath.replace(/^\/+/, ''),
      ];
      await runCommand(...checkoutArgs);
    }
    if (commit) {
      const checkoutArgs2 = ['git', '-C', localPath, 'checkout', commit];
      await runCommand(...checkoutArgs2);
    }
  }
}

////////////////////////////////////////////////////////////////////////////////
// .gitingest File
////////////////////////////////////////////////////////////////////////////////

function mockTomlParse(content: string): any {
  // Minimal parse for 'config.ignorePatterns'
  const lines = content.split('\n');
  const result: any = { config: {} };
  for (let line of lines) {
    line = line.trim();
    if (line.startsWith('#') || line.length === 0) continue;
    if (line.includes('ignorePatterns')) {
      const eqIndex = line.indexOf('=');
      if (eqIndex !== -1) {
        const val = line.slice(eqIndex + 1).trim();
        if (val.startsWith('[')) {
          const arr = val
            .slice(1, -1)
            .split(',')
            .map((v) => v.trim().replace(/^"|"$/g, ''));
          result.config.ignorePatterns = arr;
        } else {
          const stripped = val.replace(/^"|"$/g, '');
          result.config.ignorePatterns = stripped;
        }
      }
    }
  }
  return result;
}

async function applyGitingestFile(
  dirPath: string,
  query: ParsedQuery,
): Promise<void> {
  const gitingestPath = path.join(dirPath, '.gitingest');
  try {
    const st = await runLimited(() => fs.stat(gitingestPath));
    if (!st.isFile()) return;
  } catch {
    return;
  }
  let data: any = {};
  try {
    const content = await runLimited(() => fs.readFile(gitingestPath, 'utf-8'));
    data = mockTomlParse(content);
  } catch {
    return;
  }
  const cfg = data.config || {};
  const ignoreP = cfg.ignorePatterns;
  if (!ignoreP) return;

  const ignoreList: string[] = [];
  if (typeof ignoreP === 'string') {
    ignoreList.push(ignoreP);
  } else if (Array.isArray(ignoreP)) {
    for (const el of ignoreP) {
      if (typeof el === 'string') ignoreList.push(el);
    }
  } else {
    return;
  }

  const newSet = parsePatterns(new Set(ignoreList));
  if (!query.ignorePatterns) {
    query.ignorePatterns = newSet;
  } else {
    for (const np of newSet) {
      query.ignorePatterns.add(np);
    }
  }
}

////////////////////////////////////////////////////////////////////////////////
// File Reading and Content Extraction
////////////////////////////////////////////////////////////////////////////////

async function readFileContent(filePath: string): Promise<string> {
  const ext = path.extname(filePath);
  if (ext === '.ipynb') {
    try {
      const raw = await runLimited(() => fs.readFile(filePath, 'utf-8'));
      return processNotebook(raw, filePath);
    } catch (e: any) {
      return `Error processing notebook: ${e}`;
    }
  }
  try {
    return await runLimited(() => fs.readFile(filePath, 'utf-8'));
  } catch (error: any) {
    return `Error reading file: ${error.message || error}`;
  }
}

function processNotebook(content: string, _path: string): string {
  try {
    JSON.parse(content);
    // For demonstration, just returning raw JSON with a comment
    return `# Jupyter notebook content from: ${_path}\n${content}`;
  } catch (err: any) {
    return `Error processing notebook JSON: ${err}`;
  }
}

async function processFile(
  itemPath: string,
  stats: IngestionStats,
  query: ParsedQuery,
): Promise<NodeData | null> {
  let size = 0;
  try {
    const st = await runLimited(() => fs.stat(itemPath));
    size = st.size;
  } catch {
    return null;
  }
  if (stats.totalSize + size > MAX_TOTAL_SIZE_BYTES) {
    throw new Error(
      `MaxFileSizeReachedError: Maximum total size ${MAX_TOTAL_SIZE_BYTES} reached`,
    );
  }
  stats.totalFiles += 1;
  stats.totalSize += size;
  if (stats.totalFiles > MAX_FILES) {
    throw new Error(`MaxFilesReachedError: Max files = ${MAX_FILES} reached`);
  }
  let content = '[Non-text file]';
  if (size <= query.max_file_size && (await isTextFile(itemPath))) {
    content = await readFileContent(itemPath);
  }
  const node: NodeData = {
    name: path.basename(itemPath),
    type: 'file',
    size,
    content,
    path: itemPath,
  };
  return node;
}

function shouldExclude(
  itemPath: string,
  basePath: string,
  ignorePatterns?: Set<string>,
): boolean {
  if (!ignorePatterns) return false;
  let rel: string;
  try {
    rel = path.relative(basePath, itemPath);
  } catch {
    return true;
  }
  rel = toForwardSlash(rel);
  for (const pat of ignorePatterns) {
    if (matchesPattern(rel, pat)) return true;
  }
  return false;
}

function shouldInclude(
  itemPath: string,
  basePath: string,
  includePatterns?: Set<string>,
): boolean {
  if (!includePatterns) return true;
  let rel: string;
  try {
    rel = path.relative(basePath, itemPath);
  } catch {
    return false;
  }
  rel = toForwardSlash(rel);
  for (const pat of includePatterns) {
    if (matchesPattern(rel, pat)) return true;
  }
  return false;
}

/**
 * Basic wildcard matching approach. For more robust usage, consider packages like "minimatch".
 */
function matchesPattern(target: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  const reg = new RegExp(`^${escaped}$`);
  return reg.test(target);
}

////////////////////////////////////////////////////////////////////////////////
// Recursive Directory Scanning (with concurrency)
////////////////////////////////////////////////////////////////////////////////

async function scanDirectory(
  dirPath: string,
  query: ParsedQuery,
  seenPaths: Set<string>,
  depth: number,
  stats: IngestionStats,
): Promise<NodeData | null> {
  if (depth > MAX_DIRECTORY_DEPTH) return null;
  if (
    stats.totalFiles >= MAX_FILES ||
    stats.totalSize >= MAX_TOTAL_SIZE_BYTES
  ) {
    return null;
  }

  const realPath = path.resolve(dirPath);
  if (seenPaths.has(realPath)) return null;
  seenPaths.add(realPath);

  const result: NodeData = {
    name: path.basename(dirPath),
    type: 'directory',
    size: 0,
    path: dirPath,
    children: [],
    fileCount: 0,
    dirCount: 0,
    ignoreContent: false,
  };

  let items: string[] = [];
  try {
    items = await runLimited(() => fs.readdir(dirPath));
  } catch {
    return result;
  }

  // For maximum parallelism, we can collect tasks and run them via Promise.all
  const tasks: Promise<void>[] = [];

  for (const item of items) {
    const itemFull = path.join(dirPath, item);
    tasks.push(
      (async () => {
        try {
          if (shouldExclude(itemFull, query.local_path, query.ignorePatterns)) {
            return;
          }
          const st = await runLimited(() => fs.lstat(itemFull));

          if (st.isSymbolicLink()) {
            const resolved = await runLimited(() =>
              fs.readlink(itemFull).catch(() => null),
            );
            if (!resolved) return;
            const absoluteTarget = path.resolve(dirPath, resolved);
            if (seenPaths.has(absoluteTarget)) return;
            const stTar = await runLimited(() =>
              fs.stat(absoluteTarget).catch(() => null),
            );
            if (!stTar) return;
            if (!absoluteTarget.startsWith(path.resolve(query.local_path)))
              return;

            if (stTar.isFile()) {
              const fnode = await processFile(absoluteTarget, stats, query);
              if (fnode) {
                fnode.name = item;
                fnode.path = itemFull;
                result.children?.push(fnode);
                result.size += fnode.size;
                result.fileCount! += 1;
              }
            } else if (stTar.isDirectory()) {
              const subdir = await scanDirectory(
                absoluteTarget,
                query,
                seenPaths,
                depth + 1,
                stats,
              );
              if (subdir && (!query.includePatterns || subdir.fileCount! > 0)) {
                subdir.name = item;
                subdir.path = itemFull;
                result.children?.push(subdir);
                result.size += subdir.size;
                result.fileCount! += subdir.fileCount!;
                result.dirCount! += 1 + subdir.dirCount!;
              }
            }
          } else if (st.isFile()) {
            if (
              query.includePatterns &&
              !shouldInclude(itemFull, query.local_path, query.includePatterns)
            ) {
              result.ignoreContent = true;
              return;
            }
            const fnode = await processFile(itemFull, stats, query);
            if (fnode) {
              result.children?.push(fnode);
              result.size += fnode.size;
              result.fileCount! += 1;
            }
          } else if (st.isDirectory()) {
            const subdir = await scanDirectory(
              itemFull,
              query,
              seenPaths,
              depth + 1,
              stats,
            );
            if (subdir && (!query.includePatterns || subdir.fileCount! > 0)) {
              result.children?.push(subdir);
              result.size += subdir.size;
              result.fileCount! += subdir.fileCount!;
              result.dirCount! += 1 + (subdir.dirCount || 0);
            }
          }
        } catch {
          // Swallow errors from single items, continue
        }
      })(),
    );
  }

  await Promise.all(tasks);
  result.children = sortChildren(result.children!);
  return result;
}

/**
 * Sort directories/files for a nicer listing:
 *  1) readme.md
 *  2) normal files
 *  3) hidden files
 *  4) normal dirs
 *  5) hidden dirs
 */
function sortChildren(children: NodeData[]): NodeData[] {
  const readmeFiles = children.filter(
    (c) => c.name.toLowerCase() === 'readme.md',
  );
  const otherFiles = children.filter(
    (c) => c.type === 'file' && c.name.toLowerCase() !== 'readme.md',
  );
  const directories = children.filter((c) => c.type === 'directory');
  const hiddenFiles = otherFiles.filter((f) => f.name.startsWith('.'));
  const regFiles = otherFiles.filter((f) => !f.name.startsWith('.'));
  const hiddenDirs = directories.filter((d) => d.name.startsWith('.'));
  const regDirs = directories.filter((d) => !d.name.startsWith('.'));

  readmeFiles.sort((a, b) => a.name.localeCompare(b.name));
  regFiles.sort((a, b) => a.name.localeCompare(b.name));
  hiddenFiles.sort((a, b) => a.name.localeCompare(b.name));
  regDirs.sort((a, b) => a.name.localeCompare(b.name));
  hiddenDirs.sort((a, b) => a.name.localeCompare(b.name));

  return [
    ...readmeFiles,
    ...regFiles,
    ...hiddenFiles,
    ...regDirs,
    ...hiddenDirs,
  ];
}

////////////////////////////////////////////////////////////////////////////////
// File List Extraction / Summaries
////////////////////////////////////////////////////////////////////////////////

function extractFilesContent(
  query: ParsedQuery,
  node: NodeData,
  files: NodeData[] = [],
): NodeData[] {
  if (node.type === 'file' && node.content !== '[Non-text file]') {
    let fileContent = node.content;
    if (node.size > query.max_file_size) {
      fileContent = undefined;
    }
    files.push({
      path: node.path,
      name: node.name,
      size: node.size,
      type: node.type,
      content: fileContent,
    });
  } else if (node.type === 'directory' && node.children) {
    for (const c of node.children) {
      extractFilesContent(query, c, files);
    }
  }
  return files;
}

function sanitizeRepoPath(query: ParsedQuery, fullPath: string): string {
  // Convert to forward slashes for consistency
  const forwardPath = fullPath.replace(/\\/g, '/');
  // Locate the slug in the path
  const slugIndex = forwardPath.indexOf(query.slug);
  // If the slug was not found, fall back to just the file name or a generic relative path
  if (slugIndex < 0) {
    return `/${path.basename(forwardPath)}`;
  }
  // Keep everything from the slug onward, ensure it starts with '/'
  let sub = forwardPath.substring(slugIndex);
  if (!sub.startsWith('/')) {
    sub = `/${sub}`;
  }
  return sub;
}

function createFileContentString(
  query: ParsedQuery,
  files: NodeData[],
): string {
  let output = '';
  const separator = '================================\n';

  for (const f of files) {
    // If there's no text content, skip
    if (!f.content) continue;

    // Compute the sanitized path
    const displayPath = sanitizeRepoPath(query, f.path);

    output += separator;
    // Print the sanitized path with "File:"
    output += `File: ${displayPath}\n`;
    output += separator;
    output += f.content + '\n\n';
  }
  return output;
}

function createSummaryString(query: ParsedQuery, root: NodeData): string {
  let summary = '';
  if (query.user_name) {
    summary += `Repository: ${query.user_name}/${query.repo_name}\n`;
  } else {
    summary += `Repository: ${query.slug}\n`;
  }
  summary += `Files analyzed: ${root.fileCount || 0}\n`;
  if (query.subpath !== '/') {
    summary += `Subpath: ${query.subpath}\n`;
  }
  if (query.commit) {
    summary += `Commit: ${query.commit}\n`;
  } else if (
    query.branch &&
    !['main', 'master'].includes(query.branch.toLowerCase())
  ) {
    summary += `Branch: ${query.branch}\n`;
  }
  return summary;
}

function createTreeStructure(
  query: ParsedQuery,
  node: NodeData,
  prefix = '',
  isLast = true,
): string {
  let res = '';
  let displayName = node.name || query.slug;
  const currentPrefix = isLast ? '└── ' : '├── ';
  if (node.type === 'directory') displayName += '/';
  res += prefix + currentPrefix + displayName + '\n';

  if (node.type === 'directory' && node.children && node.children.length > 0) {
    const newPrefix = prefix + (isLast ? '    ' : '│   ');
    for (let i = 0; i < node.children.length; i++) {
      res += createTreeStructure(
        query,
        node.children[i],
        newPrefix,
        i === node.children.length - 1,
      );
    }
  }
  return res;
}

////////////////////////////////////////////////////////////////////////////////
// Main ingestion routines
////////////////////////////////////////////////////////////////////////////////

async function ingestSingleFile(
  filePath: string,
  query: ParsedQuery,
): Promise<[string, string, string]> {
  const st = await runLimited(() => fs.stat(filePath));
  if (!st.isFile()) {
    throw new Error(`Path ${filePath} is not a file`);
  }
  if (!(await isTextFile(filePath))) {
    throw new Error(`File ${filePath} is not a text file`);
  }
  const size = st.size;
  let content = '[Content ignored: file too large]';
  if (size <= query.max_file_size) {
    content = await readFileContent(filePath);
  }
  const lineCount = content.split('\n').length;
  const summary = `Repository: ${query.user_name || ''}/${query.repo_name || ''}
File: ${path.basename(filePath)}
Size: ${size} bytes
Lines: ${lineCount}
`;

  const fileInfo: NodeData = {
    name: path.basename(filePath),
    path: filePath,
    size,
    type: 'file',
    content,
  };
  const filesContent = createFileContentString(query, [fileInfo]);
  const tree = `Directory structure:\n└── ${path.basename(filePath)}`;
  return [summary, tree, filesContent];
}

async function ingestDirectory(
  dirPath: string,
  query: ParsedQuery,
): Promise<[string, string, string]> {
  const stats: IngestionStats = { totalFiles: 0, totalSize: 0 };
  const seen = new Set<string>();
  const rootNode = await scanDirectory(dirPath, query, seen, 0, stats);
  if (!rootNode) {
    throw new Error(`No files found in ${dirPath}`);
  }
  const files = extractFilesContent(query, rootNode);
  const summary = createSummaryString(query, rootNode);
  const tree = 'Directory structure:\n' + createTreeStructure(query, rootNode);
  const content = createFileContentString(query, files);
  return [summary, tree, content];
}

export async function runIngestQuery(
  query: ParsedQuery,
): Promise<[string, string, string]> {
  const subPathNormalized = query.subpath.replace(/^\/+/, '');
  const finalPath = path.join(query.local_path, subPathNormalized);

  let st;
  try {
    st = await runLimited(() => fs.stat(finalPath));
  } catch {
    throw new Error(`${query.slug} cannot be found`);
  }

  // Apply .gitingest for local ignoring or including patterns
  await applyGitingestFile(finalPath, query);

  if (query.type === 'blob') {
    return ingestSingleFile(finalPath, query);
  }
  if (st.isFile()) {
    return ingestSingleFile(finalPath, query);
  }
  return ingestDirectory(finalPath, query);
}

////////////////////////////////////////////////////////////////////////////////
// High-level ingestion: clone if needed, then ingest
////////////////////////////////////////////////////////////////////////////////

/**
 * This function is used to ingest a repository.
 * It will clone the repository if it is not already cloned.
 * It will then parse the query and ingest the repository.
 * It will then return the summary, tree, and content.
 * Then delete the cloned repository.
 * author: @sherbolotarbaev
 */
export async function ingestAsync(
  source: string,
  maxFileSize: number = MAX_FILE_SIZE,
  includePatterns?: string | Set<string>,
  excludePatterns?: string | Set<string>,
  branch?: string,
  output?: string,
): Promise<[string, string, string]> {
  let cloned = false;
  try {
    const parsed = await parseQuery(
      source,
      maxFileSize,
      false,
      includePatterns,
      excludePatterns,
    );
    if (parsed.url) {
      if (branch) {
        parsed.branch = branch;
      }
      const cconf: CloneConfig = {
        url: parsed.url,
        localPath: parsed.local_path,
        commit: parsed.commit,
        branch: parsed.branch,
        subpath: parsed.subpath,
      };
      await cloneRepo(cconf);
      cloned = true;
    }
    const [summary, tree, content] = await runIngestQuery(parsed);
    if (output) {
      await runLimited(() =>
        fs.writeFile(output, tree + '\n' + content, 'utf-8'),
      );
    }

    return [summary, tree, content];
  } finally {
    // Cleanup to ensure we don't leave behind temp files
    if (cloned) {
      await removeRecursive(path.join(TMP_BASE_PATH));
    }
  }
}

export async function ingest(
  source: string,
  maxFileSize: number = MAX_FILE_SIZE,
  includePatterns?: string | Set<string>,
  excludePatterns?: string | Set<string>,
  branch?: string,
  output?: string,
): Promise<[string, string, string]> {
  return ingestAsync(
    source,
    maxFileSize,
    includePatterns,
    excludePatterns,
    branch,
    output,
  );
}

async function removeRecursive(target: string): Promise<void> {
  try {
    // concurrency-limited existence check
    const st = await runLimited(() => fs.stat(target));
    if (!st) return;
  } catch {
    return;
  }
  await runLimited(() => fs.rm(target, { recursive: true, force: true }));
}
