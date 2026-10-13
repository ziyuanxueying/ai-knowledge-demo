/**
 * 本地启动入口：若 .env 配置了 SSH_HOST，先把本机端口转发到远端数据库，再启动 app.js。
 * 默认监听 src 下的 .js 文件，保存后只重启 app.js，SSH 隧道保持不动。
 * 不需要热更新时加 --no-watch。线上镜像的启动命令仍是 node src/app.js，不会走到这里。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { openDbTunnel } from './sshTunnel.js';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(serverRoot, '.env') });

const watch = !process.argv.includes('--no-watch');

function startApp() {
  return spawn(process.execPath, ['src/app.js'], {
    cwd: serverRoot,
    stdio: 'inherit',
  });
}

const tunnel = await openDbTunnel();
let app = startApp();
let shuttingDown = false;
let restarting = false;
let restartQueued = false;
let restartTimer = null;

function bindApp(child) {
  child.on('exit', (code, signal) => {
    if (shuttingDown || restarting) return;
    if (watch) {
      console.error(`[watch] 服务已退出（${signal || code}）。保存 src 下的 .js 文件后会再次启动`);
      return;
    }
    tunnel?.close();
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

function childAlive(child) {
  return child && child.exitCode === null && child.signalCode === null;
}

function restartApp(filename) {
  if (shuttingDown) return;
  if (restarting) {
    restartQueued = true;
    return;
  }
  if (!childAlive(app)) {
    console.log(`[watch] ${filename} 已变更，正在启动服务`);
    app = startApp();
    bindApp(app);
    return;
  }
  restarting = true;
  console.log(`[watch] ${filename} 已变更，正在重启服务`);
  const previous = app;
  const killTimer = setTimeout(() => {
    if (childAlive(previous)) previous.kill('SIGKILL');
  }, 4000);
  previous.once('exit', () => {
    clearTimeout(killTimer);
    setTimeout(() => {
      restarting = false;
      if (shuttingDown) return;
      app = startApp();
      bindApp(app);
      if (restartQueued) {
        restartQueued = false;
        restartApp('后续变更');
      }
    }, 150);
  });
  previous.kill('SIGTERM');
}

function scheduleRestart(filename) {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => restartApp(filename), 200);
}

bindApp(app);

if (watch) {
  fs.watch(path.join(serverRoot, 'src'), { recursive: true }, (event, filename) => {
    if (!filename || !filename.endsWith('.js')) return;
    scheduleRestart(filename);
  });
  console.log('[watch] 已监听 src 下的 .js 文件，保存后自动重启');
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(restartTimer);
  if (childAlive(app)) app.kill(signal);
  tunnel?.close();
  setTimeout(() => process.exit(0), 300);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
