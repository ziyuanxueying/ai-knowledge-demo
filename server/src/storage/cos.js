/**
 * 腾讯云 COS。原文放对象存储，解析后的正文仍在 Postgres。
 */
import COS from 'cos-nodejs-sdk-v5';
import { config } from '../config/index.js';

export function missingCosEnv() {
  const missing = [];
  if (!config.cos.secretId) missing.push('COS_SECRET_ID');
  if (!config.cos.secretKey) missing.push('COS_SECRET_KEY');
  if (!config.cos.bucket) missing.push('COS_BUCKET');
  if (!config.cos.region) missing.push('COS_REGION');
  return missing;
}

export function assertCosConfig() {
  const missing = missingCosEnv();
  if (missing.length > 0) {
    throw new Error(`未配置腾讯云 COS：请在 server/.env 填写 ${missing.join('、')}`);
  }
}

function client() {
  assertCosConfig();
  return new COS({
    SecretId: config.cos.secretId,
    SecretKey: config.cos.secretKey,
  });
}

export function buildObjectKey(entryId, filename) {
  const safe = String(filename || 'file')
    .replace(/[/\\]/g, '_')
    .replace(/[^\w.\-\u4e00-\u9fff]+/g, '_')
    .slice(0, 120);
  const prefix = config.cos.prefix.endsWith('/') ? config.cos.prefix : `${config.cos.prefix}/`;
  return `${prefix}${entryId}/${safe}`;
}

export function putObject(key, body, contentType = 'application/octet-stream') {
  const cos = client();
  return new Promise((resolve, reject) => {
    cos.putObject(
      {
        Bucket: config.cos.bucket,
        Region: config.cos.region,
        Key: key,
        Body: body,
        ContentType: contentType,
      },
      (err, data) => (err ? reject(err) : resolve(data))
    );
  });
}

export function getObjectBuffer(key) {
  const cos = client();
  return new Promise((resolve, reject) => {
    cos.getObject(
      {
        Bucket: config.cos.bucket,
        Region: config.cos.region,
        Key: key,
      },
      (err, data) => {
        if (err) reject(err);
        else resolve(Buffer.from(data.Body));
      }
    );
  });
}

export function deleteObject(key) {
  if (!key || missingCosEnv().length > 0) return Promise.resolve();
  const cos = client();
  return new Promise((resolve, reject) => {
    cos.deleteObject(
      {
        Bucket: config.cos.bucket,
        Region: config.cos.region,
        Key: key,
      },
      (err, data) => (err ? reject(err) : resolve(data))
    );
  });
}
