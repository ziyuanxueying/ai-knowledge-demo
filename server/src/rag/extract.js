/**
 * 把上传文件或网页 HTML 抽成纯文本。不调用模型。
 */
import { createRequire } from 'node:module';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import * as cheerio from 'cheerio';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'json', 'html', 'htm']);

export function extensionOf(filename) {
  const match = /\.([a-z0-9]+)$/i.exec(String(filename || ''));
  return match ? match[1].toLowerCase() : '';
}

export async function extractText(filename, buffer) {
  const ext = extensionOf(filename);
  if (ext === 'pdf') {
    const parsed = await pdfParse(buffer);
    return clean(parsed.text);
  }
  if (ext === 'docx') {
    const parsed = await mammoth.extractRawText({ buffer });
    return clean(parsed.value);
  }
  if (ext === 'pptx') return clean(await pptxText(buffer));
  if (ext === 'html' || ext === 'htm') return htmlToText(buffer.toString('utf8')).text;
  if (TEXT_EXT.has(ext) || ext === '') return clean(buffer.toString('utf8'));
  if (ext === 'doc') {
    throw new Error('暂不支持旧版 .doc，请在 Word 里另存为 .docx 后再上传');
  }
  throw new Error(`暂不支持 .${ext}。目前可以解析 pdf、docx、pptx、html、md、txt、csv`);
}

export function htmlToText(html) {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg').remove();
  const title = $('title').first().text().trim();
  const body = $('body').text() || $.root().text();
  return { title, text: clean(body) };
}

async function pptxText(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => slideNo(a) - slideNo(b));
  const slides = [];
  for (const name of names) {
    const xml = await zip.files[name].async('string');
    const bits = [...xml.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)].map((m) => decodeXml(m[1]));
    if (bits.length) slides.push(bits.join(''));
  }
  return slides.join('\n\n');
}

function slideNo(name) {
  const match = /slide(\d+)/i.exec(name);
  return match ? Number(match[1]) : 0;
}

function decodeXml(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function clean(text) {
  return String(text || '')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
