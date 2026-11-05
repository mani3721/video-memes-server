import test from 'node:test'
import assert from 'node:assert/strict'
import { entryNameFor, sanitizeEntryName, uniqueEntryName } from './zipEntries.js'

test('sanitizeEntryName blocks path traversal and empty names', () => {
  assert.equal(sanitizeEntryName('../../etc/passwd'), '_.._etc_passwd')
  assert.equal(sanitizeEntryName('a\\b/c.mp4'), 'a_b_c.mp4')
  assert.equal(sanitizeEntryName(''), 'file')
  assert.equal(sanitizeEntryName(null), 'file')
})

test('entryNameFor falls back from filename to key to id', () => {
  assert.equal(entryNameFor({ filename: 'cat.mp4', spaces_key: 'x/y.mp4', id: '1' }), 'cat.mp4')
  assert.equal(entryNameFor({ spaces_key: 'videos/2024/dog.gif', id: '1' }), 'dog.gif')
  assert.equal(entryNameFor({ id: 'abc' }), 'abc')
})

test('uniqueEntryName de-duplicates case-insensitively and keeps the extension', () => {
  const used = new Set()
  assert.equal(uniqueEntryName('clip.mp4', used), 'clip.mp4')
  assert.equal(uniqueEntryName('CLIP.mp4', used), 'CLIP (2).mp4')
  assert.equal(uniqueEntryName('clip.mp4', used), 'clip (3).mp4')
  assert.equal(uniqueEntryName('noext', used), 'noext')
  assert.equal(uniqueEntryName('noext', used), 'noext (2)')
})
