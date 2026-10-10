/**
 * 抓取公网网页，或浅克隆一个 Git 仓库里的文本文件。
 * 拒绝内网地址，避免把入库接口变成对内网的请求。
 */
import dns from 'node:dns/promises';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const BLOCKED_HOSTS = new Set(['localhost', 'metadata.google.internal', 'metadata.tencentyun.com']);

export async function assertPublicHttpUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('网址不合法');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('只接受 http 或 https 网址');
  }
  if (url.username || url.password) throw new Error('网址里不要带账号密码');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('不能抓取内网地址');
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('不能抓取内网地址');
    return url;
  }
  const records = await dns.lookup(host, { all: true });
  if (records.length === 0) throw new Error('域名无法解析');
  if (records.some((item) => isPrivateIp(item.address))) throw new Error('不能抓取内网地址');
  return url;
}

export async function fetchPublicPage(raw) {
  let current = await assertPublicHttpUrl(raw);
  for (let hop = 0; hop < 3; hop++) {
    const res = await fetch(current, {
      redirect: 'manual',
      headers: { 'User-Agent': 'ai-knowledge-demo/1.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new Error('网页重定向缺少地址');
      current = await assertPublicHttpUrl(new URL(location, current).href);
      continue;
    }
    if (!res.ok) throw new Error(`网页返回 HTTP ${res.status}`);
    const length = Number(res.headers.get('content-length') || 0);
    if (length > 2_000_000) throw new Error('网页超过 2MB，未抓取');
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > 2_000_000) throw new Error('网页超过 2MB，未抓取');
    return { url: current.href, buffer, contentType: res.headers.get('content-type') || '' };
  }
  throw new Error('网页重定向次数过多');
}

const REPO_EXT = new Set(['md', 'txt', 'markdown', 'html', 'htm', 'pdf', 'docx', 'pptx', 'csv']);
const SKIP_DIR = new Set(['.git', 'node_modules', 'dist', 'build', 'vendor', '.next', 'coverage']);

export async function cloneRepoFiles(repoUrl, branch = '') {
  const url = await assertPublicHttpUrl(repoUrl);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-repo-'));
  const args = ['clone', '--depth', '1', '--single-branch'];
  if (branch) args.push('--branch', branch);
  args.push(url.href, dir);
  try {
    await runGit(args);
    const files = [];
    await walk(dir, dir, files);
    if (files.length === 0) throw new Error('仓库里没有可解析的文本文件（md、txt、html、pdf、docx、pptx）');
    return files.slice(0, 40);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function walk(root, current, out) {
  if (out.length >= 40) return;
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (out.length >= 40) return;
    if (SKIP_DIR.has(entry.name)) continue;
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await walk(root, full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).slice(1).toLowerCase();
    if (!REPO_EXT.has(ext)) continue;
    const stat = await fs.stat(full);
    if (stat.size > 1_500_000) continue;
    const relative = path.relative(root, full);
    out.push({ relative, filename: entry.name, buffer: await fs.readFile(full) });
  }
}

function runGit(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('克隆仓库超时'));
    }, 60000);
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err.code === 'ENOENT' ? new Error('服务器未安装 git，无法克隆仓库') : err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim().slice(0, 300) || `git 退出码 ${code}`));
    });
  });
}

function isPrivateIp(address) {
  const ip = net.isIP(address);
  if (ip === 4) {
    const [a, b] = address.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (ip === 6) {
    const lower = address.toLowerCase();
    if (lower.startsWith('::ffff:')) return isPrivateIp(lower.slice('::ffff:'.length));
    return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
  }
  return true;
}
