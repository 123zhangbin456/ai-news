/**
 * 生成 PWA 图标。
 *
 * 不引入任何图形库：直接按像素画好再手工封装成 PNG。
 * 图形很简单（渐变圆角方块 + 四角星 + 两条横杠），纯算式画出来
 * 比依赖一套渲染工具链更省事，也不用把二进制设计源文件塞进仓库。
 *
 * 改完样式重新跑：node scripts/make-icons.js
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../pipeline/util.js';

const OUT_DIR = join(ROOT, 'web', 'icons');
const SS = 4; // 超采样倍数，用来得到平滑边缘

/* ---------- 图形定义，坐标统一用 0-1 ---------- */

const GRAD_FROM = [74, 124, 255];   // #4A7CFF
const GRAD_TO = [139, 92, 246];     // #8B5CF6
const CORNER = 0.2237;              // iOS 图标的圆角比例

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 圆角矩形：返回该点是否在形内 */
function inRoundedRect(x, y, r) {
  const dx = Math.max(r - x, 0, x - (1 - r));
  const dy = Math.max(r - y, 0, y - (1 - r));
  return dx * dx + dy * dy <= r * r;
}

/** 四角星（星形线）：|x|^(2/3) + |y|^(2/3) <= s^(2/3) */
function inStar(x, y, cx, cy, s) {
  const p = 2 / 3;
  return Math.abs(x - cx) ** p + Math.abs(y - cy) ** p <= s ** p;
}

function inBar(x, y, cx, cy, w, h) {
  const r = h / 2;
  const left = cx - w / 2 + r;
  const right = cx + w / 2 - r;
  if (Math.abs(y - cy) > r) return false;
  if (x >= left && x <= right) return true;
  const nx = x < left ? left : right;
  return (x - nx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** 返回该采样点的 RGBA */
function sample(x, y) {
  if (!inRoundedRect(x, y, CORNER)) return [0, 0, 0, 0];

  const t = clamp01((x + y) / 2);
  const bg = [
    Math.round(lerp(GRAD_FROM[0], GRAD_TO[0], t)),
    Math.round(lerp(GRAD_FROM[1], GRAD_TO[1], t)),
    Math.round(lerp(GRAD_FROM[2], GRAD_TO[2], t)),
  ];

  const isMark =
    inStar(x, y, 0.5, 0.375, 0.2) ||
    inBar(x, y, 0.5, 0.675, 0.42, 0.075) ||
    inBar(x, y, 0.5, 0.8, 0.27, 0.075);

  return isMark ? [255, 255, 255, 255] : [...bg, 255];
}

/* ---------- 光栅化 ---------- */

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const step = 1 / (size * SS);

  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [cr, cg, cb, ca] = sample(
            (pxi * SS + sx + 0.5) * step,
            (py * SS + sy + 0.5) * step
          );
          const w = ca / 255;
          r += cr * w; g += cg * w; b += cb * w; a += ca;
        }
      }
      const n = SS * SS;
      const alpha = a / n;
      const norm = a === 0 ? 0 : 255 / a;
      const o = (py * size + pxi) * 4;
      px[o] = Math.round(r * norm);
      px[o + 1] = Math.round(g * norm);
      px[o + 2] = Math.round(b * norm);
      px[o + 3] = Math.round(alpha);
    }
  }
  return px;
}

/* ---------- 最小 PNG 封装 ---------- */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function toPng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // 位深
  ihdr[9] = 6;  // RGBA
  // 10-12 保持 0：默认压缩、滤波、非隔行

  // 每行前面加一个滤波类型字节，这里统一用 0（不滤波）
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- SVG 版本，浏览器标签页和高分屏用 ---------- */

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4A7CFF"/>
      <stop offset="1" stop-color="#8B5CF6"/>
    </linearGradient>
  </defs>
  <rect width="100" height="100" rx="22.37" fill="url(#g)"/>
  <path d="M50 17.5 C52.5 33 57 37.5 70 37.5 C57 37.5 52.5 42 50 57.5 C47.5 42 43 37.5 30 37.5 C43 37.5 47.5 33 50 17.5 Z" fill="#fff"/>
  <rect x="29" y="63.75" width="42" height="7.5" rx="3.75" fill="#fff"/>
  <rect x="36.5" y="76.25" width="27" height="7.5" rx="3.75" fill="#fff"/>
</svg>
`;

/* ---------- 输出 ---------- */

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'icon.svg'), svg);

for (const size of [180, 192, 512]) {
  writeFileSync(join(OUT_DIR, `icon-${size}.png`), toPng(size, render(size)));
  console.log(`✓ icons/icon-${size}.png`);
}
console.log('✓ icons/icon.svg');
