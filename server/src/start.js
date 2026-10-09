/**
 * 本地启动入口：若 .env 配置了 SSH_HOST，先把本机端口转发到远端数据库，再启动 app.js。
 * 线上镜像的启动命令仍是 node src/app.js，不会走到这里。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(serverRoot, '.env') });

const watch = process.argv.includes('--watch');
const localPort = Number.parseInt(process.env.PGPORT || '5432', 10);

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function waitForPort(port, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      portOpen(port).then((open) => {
        if (open) {
          resolve();
          return;
        }
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`SSH 隧道在 ${timeoutMs}ms 内没有监听到 127.0.0.1:${port}`));
          return;
        }
        setTimeout(tryOnce, 200);
      });
    };
    tryOnce();
  });
}

function createAskpass() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-ssh-'));
  const file = path.join(dir, 'askpass.sh');
  fs.writeFileSync(file, '#!/bin/sh\nprintf \'%s\\n\' "$SSH_TUNNEL_PASSWORD"\n');
  fs.chmodSync(file, 0o700);
  return { dir, file };
}

async function openTunnel() {
  const sshHost = process.env.SSH_HOST;
  if (!sshHost) return null;

  const remoteHost = process.env.SSH_REMOTE_DB_HOST || '127.0.0.1';
  const remotePort = process.env.SSH_REMOTE_DB_PORT || '5432';
  const sshPort = process.env.SSH_PORT || '22';
  const sshUser = process.env.SSH_USER || 'root';
  const forward = `127.0.0.1:${localPort} -> ${remoteHost}:${remotePort}`;

  if (await portOpen(localPort)) {
    console.log(`[SSH] 本机 ${localPort} 已在监听，沿用现有隧道（期望 ${forward}）`);
    return null;
  }

  if (!process.env.SSH_PASSWORD) {
    throw new Error('已配置 SSH_HOST，但缺少 SSH_PASSWORD');
  }

  const askpass = createAskpass();
  const ssh = spawn(
    'ssh',
    [
      '-N',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ConnectTimeout=15',
      '-L', `127.0.0.1:${localPort}:${remoteHost}:${remotePort}`,
      '-p', sshPort,
      `${sshUser}@${sshHost}`,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SSH_ASKPASS: askpass.file,
        SSH_ASKPASS_REQUIRE: 'force',
        SSH_TUNNEL_PASSWORD: process.env.SSH_PASSWORD,
        DISPLAY: process.env.DISPLAY || ':0',
      },
    }
  );

  let stderr = '';
  ssh.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  let exited = false;
  ssh.once('exit', () => {
    exited = true;
  });

  try {
    await waitForPort(localPort, 15000);
  } catch (err) {
    if (!ssh.killed) ssh.kill('SIGTERM');
    fs.rmSync(askpass.dir, { recursive: true, force: true });
    const detail = stderr.trim();
    throw new Error(detail ? `${err.message}\n${detail}` : err.message);
  }

  if (exited) {
    fs.rmSync(askpass.dir, { recursive: true, force: true });
    throw new Error(stderr.trim() || 'SSH 隧道进程已退出');
  }

  console.log(`[SSH] 隧道已建立 ${forward}`);
  ssh.once('exit', () => {
    fs.rmSync(askpass.dir, { recursive: true, force: true });
  });
  return ssh;
}

function startApp() {
  const args = watch ? ['--watch', 'src/app.js'] : ['src/app.js'];
  return spawn(process.execPath, args, {
    cwd: serverRoot,
    stdio: 'inherit',
  });
}

const ssh = await openTunnel();
const app = startApp();

function shutdown(signal) {
  if (app.exitCode === null && app.signalCode === null) app.kill(signal);
  if (ssh && ssh.exitCode === null && ssh.signalCode === null) ssh.kill(signal);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

app.on('exit', (code, signal) => {
  if (ssh && ssh.exitCode === null && ssh.signalCode === null) ssh.kill('SIGTERM');
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
