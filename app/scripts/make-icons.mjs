// 生成简单的 PWA 图标（无外部依赖）：圆角方块 + 中间一条“卡片”白条。
import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function crc32(buf) {
  let c, crc = 0xffffffff
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y)
      const o = y * (size * 4 + 1) + 1 + x * 4
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}
function draw(size) {
  const r = size * 0.2
  const inRound = (x, y) => {
    const cx = Math.min(Math.max(x, r), size - r), cy = Math.min(Math.max(y, r), size - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
  }
  return png(size, (x, y) => {
    if (!inRound(x + 0.5, y + 0.5)) return [0, 0, 0, 0]
    // 白色“卡片”矩形与一条“公式线”
    const cx = size / 2, cy = size / 2
    const cardW = size * 0.56, cardH = size * 0.4
    const inCard = Math.abs(x - cx) < cardW / 2 && Math.abs(y - cy) < cardH / 2
    if (inCard) {
      const line = Math.abs(y - (cy - cardH * 0.12)) < size * 0.03 && Math.abs(x - cx) < cardW * 0.35
      const line2 = Math.abs(y - (cy + cardH * 0.2)) < size * 0.03 && Math.abs(x - (cx - cardW * 0.1)) < cardW * 0.25
      return line || line2 ? [47, 107, 143, 255] : [255, 255, 255, 255]
    }
    return [47, 107, 143, 255]
  })
}
const out = path.join(__dirname, '..', 'public')
fs.writeFileSync(path.join(out, 'icon-192.png'), draw(192))
fs.writeFileSync(path.join(out, 'icon-512.png'), draw(512))
console.log('icons written')
