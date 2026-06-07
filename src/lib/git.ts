import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

const exec = promisify(execFile);

async function git(repoPath: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['--git-dir', repoPath, ...args], { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function gitBuf(repoPath: string, ...args: string[]): Promise<Buffer> {
  const { stdout } = await exec('git', ['--git-dir', repoPath, ...args], {
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

export async function initRepo(repoPath: string): Promise<void> {
  await fs.mkdir(path.dirname(repoPath), { recursive: true });
  await exec('git', ['init', '--bare', repoPath]);
  await fs.writeFile(path.join(repoPath, 'HEAD'), 'ref: refs/heads/main\n');
  await git(repoPath, 'config', 'http.receivepack', 'true');
  await git(repoPath, 'config', 'receive.denyNonFastForwards', 'false');
  await git(repoPath, 'config', 'uploadpack.allowFilter', 'true');
}

export async function forkRepo(srcPath: string, destPath: string): Promise<void> {
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await exec('git', ['clone', '--bare', srcPath, destPath]);
  await git(destPath, 'config', 'http.receivepack', 'true');
}

export async function deleteRepo(repoPath: string): Promise<void> {
  await fs.rm(repoPath, { recursive: true, force: true });
}

export async function isEmpty(repoPath: string): Promise<boolean> {
  try {
    await git(repoPath, 'rev-parse', 'HEAD');
    return false;
  } catch {
    return true;
  }
}

export async function getDefaultBranch(repoPath: string): Promise<string> {
  try {
    const head = await fs.readFile(path.join(repoPath, 'HEAD'), 'utf8');
    return head.match(/ref: refs\/heads\/(.+)/)?.[1]?.trim() ?? 'main';
  } catch {
    return 'main';
  }
}

export async function getBranches(repoPath: string): Promise<string[]> {
  try {
    const out = await git(repoPath, 'branch', '--format=%(refname:short)');
    return out.split('\n').map(b => b.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export async function refExists(repoPath: string, ref: string): Promise<boolean> {
  try {
    await git(repoPath, 'rev-parse', '--verify', ref);
    return true;
  } catch {
    return false;
  }
}

export interface TreeEntry {
  mode: string;
  type: 'blob' | 'tree';
  hash: string;
  name: string;
}

export async function getTree(repoPath: string, ref: string, treePath = ''): Promise<TreeEntry[]> {
  const treeRef = treePath ? `${ref}:${treePath}` : `${ref}:`;
  try {
    const out = await git(repoPath, 'ls-tree', treeRef);
    return out.split('\n').filter(Boolean).map(line => {
      const [mode, type, rest] = line.split(/\s+/, 3);
      const tabIdx = line.indexOf('\t');
      const name = line.slice(tabIdx + 1);
      return { mode, type: type as 'blob' | 'tree', hash: rest, name };
    });
  } catch {
    return [];
  }
}

export async function getFileContent(repoPath: string, ref: string, filePath: string): Promise<Buffer> {
  return gitBuf(repoPath, 'show', `${ref}:${filePath}`);
}

export async function getFileSize(repoPath: string, ref: string, filePath: string): Promise<number> {
  try {
    const out = await git(repoPath, 'cat-file', '-s', `${ref}:${filePath}`);
    return parseInt(out.trim(), 10);
  } catch {
    return 0;
  }
}

export interface CommitInfo {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  email: string;
  date: string;
}

const LOG_FMT = '%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%aI%x1e';

export async function getCommits(repoPath: string, ref: string, limit = 30, filePath?: string): Promise<CommitInfo[]> {
  try {
    const args = ['log', `--format=${LOG_FMT}`, `-n`, String(limit), ref];
    if (filePath) args.push('--', filePath);
    const out = await git(repoPath, ...args);
    return out.trim().split('\x1e').filter(s => s.trim()).map(e => {
      const [hash, shortHash, message, author, email, date] = e.trim().split('\x1f');
      if (!hash?.trim()) return null;
      return { hash: hash.trim(), shortHash: shortHash?.trim() ?? '', message: message?.trim() ?? '', author: author?.trim() ?? '', email: email?.trim() ?? '', date: date?.trim() ?? '' };
    }).filter((c): c is CommitInfo => c !== null);
  } catch {
    return [];
  }
}

export async function getCommit(repoPath: string, hash: string): Promise<CommitInfo | null> {
  try {
    const out = await git(repoPath, 'log', '-1', `--format=${LOG_FMT}`, hash);
    const e = out.trim().split('\x1e').find(s => s.trim());
    if (!e) return null;
    const [h, sh, msg, author, email, date] = e.trim().split('\x1f');
    if (!h?.trim()) return null;
    return { hash: h.trim(), shortHash: sh?.trim() ?? '', message: msg?.trim() ?? '', author: author?.trim() ?? '', email: email?.trim() ?? '', date: date?.trim() ?? '' };
  } catch {
    return null;
  }
}

export async function getLastCommitForPath(repoPath: string, ref: string, filePath: string): Promise<CommitInfo | null> {
  const commits = await getCommits(repoPath, ref, 1, filePath);
  return commits[0] ?? null;
}

export async function getDiff(repoPath: string, base: string, head: string): Promise<string> {
  try {
    return await git(repoPath, 'diff', `${base}...${head}`);
  } catch {
    return '';
  }
}

export async function mergeBranch(repoPath: string, base: string, head: string): Promise<boolean> {
  try {
    const workDir = repoPath + '.merge-tmp';
    await exec('git', ['clone', repoPath, workDir]);
    await exec('git', ['-C', workDir, 'checkout', base]);
    await exec('git', ['-C', workDir, 'merge', `origin/${head}`, '--no-edit', '-m', `Merge ${head} into ${base}`]);
    await exec('git', ['-C', workDir, 'push', 'origin', base]);
    await fs.rm(workDir, { recursive: true, force: true });
    return true;
  } catch (err) {
    try { await fs.rm(repoPath + '.merge-tmp', { recursive: true, force: true }); } catch {}
    return false;
  }
}

export async function getRepoSize(repoPath: string): Promise<number> {
  try {
    const out = await git(repoPath, 'count-objects', '-v');
    const match = out.match(/size-pack:\s*(\d+)/);
    return match ? parseInt(match[1], 10) * 1024 : 0;
  } catch {
    return 0;
  }
}

export interface ParsedDiff {
  files: ParsedDiffFile[];
  stats: { additions: number; deletions: number; files: number };
}

export interface ParsedDiffFile {
  from: string;
  to: string;
  additions: number;
  deletions: number;
  hunks: { header: string; lines: DiffLine[] }[];
}

export interface DiffLine {
  type: '+' | '-' | ' ';
  content: string;
}

export function parseDiff(diffText: string): ParsedDiff {
  const files: ParsedDiffFile[] = [];
  let totalAdd = 0, totalDel = 0;

  const parts = diffText.split(/^diff --git /m).filter(Boolean);
  for (const part of parts) {
    const fromMatch = part.match(/^--- a\/(.+)$/m);
    const toMatch = part.match(/^\+\+\+ b\/(.+)$/m);
    const headerLine = part.split('\n')[0] ?? '';
    const from = fromMatch?.[1] ?? headerLine.split(' ')[0]?.replace(/^a\//, '') ?? '';
    const to = toMatch?.[1] ?? headerLine.split(' ')[1]?.replace(/^b\//, '') ?? '';

    const hunks: ParsedDiffFile['hunks'] = [];
    let cur: ParsedDiffFile['hunks'][0] | null = null;
    let additions = 0, deletions = 0;

    for (const line of part.split('\n')) {
      if (line.startsWith('@@ ')) {
        if (cur) hunks.push(cur);
        cur = { header: line, lines: [] };
      } else if (cur) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          cur.lines.push({ type: '+', content: line.slice(1) }); additions++;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          cur.lines.push({ type: '-', content: line.slice(1) }); deletions++;
        } else if (!line.startsWith('\\') && !line.startsWith('diff') && !line.startsWith('index') && !line.startsWith('---') && !line.startsWith('+++') && !line.startsWith('new file') && !line.startsWith('deleted file') && line !== '') {
          cur.lines.push({ type: ' ', content: line.slice(1) });
        }
      }
    }
    if (cur) hunks.push(cur);
    totalAdd += additions; totalDel += deletions;
    if (from || to) files.push({ from, to, additions, deletions, hunks });
  }

  return { files, stats: { additions: totalAdd, deletions: totalDel, files: files.length } };
}

const MIME: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html',
  '.css': 'text/css', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.json': 'application/json', '.ts': 'text/plain', '.tsx': 'text/plain',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.xml': 'text/xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
};

export function getMimeType(ext: string): string {
  return MIME[ext.toLowerCase()] ?? 'application/octet-stream';
}
