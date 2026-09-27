'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ownershipTree } = require('../src/ownership-tree');
const app = require('../src/app');

// 按 dom 取出节点条目
function nodeOf(result, dom) {
  const found = result.nodes.filter((n) => n.dom === dom);
  assert.equal(found.length, 1, `应恰好存在 dom=${dom} 的节点`);
  return found[0];
}

test('无 aria-owns：按原文档序给出各节点父子关系、根列表与先序', () => {
  const r = ownershipTree('<div id="a"><span id="b">x</span><span id="c">y</span></div><p id="d"></p>');
  assert.equal(r.count.elements, 4);
  assert.equal(r.count.owners, 0);
  assert.equal(r.count.tokens, 0);
  assert.equal(r.count.claims, 0);
  assert.equal(r.count.issues, 0);

  assert.deepEqual(r.roots, [1, 4]);
  assert.deepEqual(
    r.nodes.map((n) => [n.dom, n.parent, n.children]),
    [
      [1, null, [2, 3]],
      [2, 1, []],
      [3, 1, []],
      [4, null, []],
    ]
  );
  assert.deepEqual(r.preOrder, [1, 2, 3, 4]);
  assert.deepEqual(r.issues, []);
  // 节点带标签与 id 便于阅读
  assert.equal(nodeOf(r, 1).tag, 'div');
  assert.equal(nodeOf(r, 1).id, 'a');
});

test('忽略 template 内容（不编号、不可被认领）；不按样式筛选', () => {
  const html = `<template><div id="inside"></div></template>
<div style="display:none" id="h"><button id="b">x</button></div>
<div id="o" aria-owns="inside b"></div>`;
  const r = ownershipTree(html);

  // template 内的 div 不参与编号：template=1, div#h=2, button#b=3, div#o=4
  assert.equal(r.count.elements, 4);
  // display:none 子树照常参与；template 内的 id 视为缺失
  assert.deepEqual(
    r.issues.map((i) => [i.owner, i.token, i.reason]),
    [[4, 'inside', 'missing-target']]
  );
  assert.equal(r.issues[0].detail, '第 4 号元素 <div>#o的 aria-owns 引用了不存在的 id "inside"');
  // display:none 中的 button 仍被成功认领
  assert.equal(nodeOf(r, 3).parent, 4);
  assert.deepEqual(nodeOf(r, 4).children, [3]);
  assert.deepEqual(r.roots, [1, 2, 4]);
  assert.deepEqual(r.preOrder, [1, 2, 4, 3]);
  assert.equal(r.count.claims, 1);
});

test('成功认领：目标及当前子树移到拥有者末尾，可跨层级、连续移动', () => {
  const html = `<section id="s1" aria-owns="item2">
  <div id="item1"><span id="inner">x</span></div>
</section>
<section id="s2" aria-owns="item1 inner"></section>
<div id="item2"></div>`;
  const r = ownershipTree(html);

  assert.equal(r.count.issues, 0);
  assert.equal(r.count.claims, 3);
  // item2 挂到 s1 末尾；item1 与 inner 先后挂到 s2 末尾
  assert.deepEqual(
    r.nodes.map((n) => [n.dom, n.parent, n.children]),
    [
      [1, null, [5]],
      [2, 4, []],
      [3, 4, []],
      [4, null, [2, 3]],
      [5, 1, []],
    ]
  );
  assert.deepEqual(r.roots, [1, 4]);
  assert.deepEqual(r.preOrder, [1, 5, 4, 2, 3]);
});

test('重排：原为直接子节点也移到拥有者末尾', () => {
  const html = `<div id="toolbar" aria-owns="save">
  <button id="save">保存</button>
  <button id="cancel">取消</button>
</div>`;
  const r = ownershipTree(html);

  assert.equal(r.count.claims, 1);
  assert.deepEqual(nodeOf(r, 1).children, [3, 2]);
  assert.equal(nodeOf(r, 2).parent, 1);
  assert.deepEqual(r.preOrder, [1, 3, 2]);
  assert.deepEqual(r.issues, []);
});

test('冲突：仅成功认领占用目标，后到拥有者报 already-claimed', () => {
  const html = `<div id="a" aria-owns="x"></div>
<div id="b" aria-owns="x y"></div>
<span id="x"></span>
<span id="y"></span>`;
  const r = ownershipTree(html);

  assert.equal(r.count.claims, 2);
  assert.equal(r.count.tokens, 3);
  assert.deepEqual(
    r.issues.map((i) => [i.owner, i.token, i.reason]),
    [[2, 'x', 'already-claimed']]
  );
  assert.deepEqual(nodeOf(r, 1).children, [3]);
  assert.deepEqual(nodeOf(r, 2).children, [4]);
  assert.deepEqual(r.roots, [1, 2]);
  assert.deepEqual(r.preOrder, [1, 3, 2, 4]);
});

test('判环使用此前修改后的树：a 认领 b 后，b 再认领 a 成环被拒', () => {
  const html = `<div id="a" aria-owns="b">
  <div id="b" aria-owns="a"></div>
</div>`;
  const r = ownershipTree(html);

  assert.equal(r.count.claims, 1);
  assert.deepEqual(
    r.issues.map((i) => [i.owner, i.token, i.reason]),
    [[2, 'a', 'cycle']]
  );
  // 拒绝不改变树
  assert.deepEqual(nodeOf(r, 1).children, [2]);
  assert.equal(nodeOf(r, 2).parent, 1);
  assert.deepEqual(r.preOrder, [1, 2]);
});

test('重复 id 取首个同名元素；首个恰是拥有者自身时报自指', () => {
  const r = ownershipTree('<span id="dup" aria-owns="dup"></span><span id="dup"></span>');

  assert.equal(r.count.claims, 0);
  assert.deepEqual(
    r.issues.map((i) => [i.owner, i.token, i.reason]),
    [[1, 'dup', 'self-reference']]
  );
  assert.deepEqual(r.roots, [1, 2]);
  assert.deepEqual(r.preOrder, [1, 2]);
});

test('拒绝不占用目标：子元素认领祖先成环失败后，他人仍可认领该祖先', () => {
  const html = `<div id="x">
  <button id="c" aria-owns="x">c</button>
</div>
<div id="d" aria-owns="x"></div>`;
  const r = ownershipTree(html);

  assert.deepEqual(
    r.issues.map((i) => [i.owner, i.token, i.reason]),
    [[2, 'x', 'cycle']]
  );
  assert.equal(r.count.claims, 1);
  // x 被子元素 c 认领失败，随后被 d 成功认领（连同 c 一起移动）
  assert.equal(nodeOf(r, 1).parent, 3);
  assert.deepEqual(nodeOf(r, 1).children, [2]);
  assert.deepEqual(nodeOf(r, 3).children, [1]);
  assert.deepEqual(r.roots, [3]);
  assert.deepEqual(r.preOrder, [3, 1, 2]);
});

test('同一元素的重复令牌忽略；空 aria-owns 计入拥有者但无令牌', () => {
  const r = ownershipTree('<div id="o" aria-owns="t  t\tt"></div><div id="e" aria-owns=""></div><p id="t"></p>');

  assert.equal(r.count.owners, 2);
  assert.equal(r.count.tokens, 1);
  assert.equal(r.count.claims, 1);
  assert.deepEqual(nodeOf(r, 1).children, [3]);
  assert.deepEqual(r.issues, []);
});

test('目标缺失不改树；拥有者被移动后仍按原文档序处理（链式认领）', () => {
  const html = `<ul id="l1" aria-owns="c ghost"></ul>
<ul id="l2" aria-owns="l1"></ul>
<li id="c"></li>`;
  const r = ownershipTree(html);

  // l1 先认领 c（ghost 缺失被拒），随后 l2 认领 l1，c 随 l1 一起移动
  assert.deepEqual(
    r.issues.map((i) => [i.owner, i.token, i.reason]),
    [[1, 'ghost', 'missing-target']]
  );
  assert.equal(r.count.claims, 2);
  assert.equal(nodeOf(r, 1).parent, 2);
  assert.deepEqual(nodeOf(r, 1).children, [3]);
  assert.deepEqual(nodeOf(r, 2).children, [1]);
  assert.deepEqual(r.roots, [2]);
  assert.deepEqual(r.preOrder, [2, 1, 3]);
});

test('问题按处理顺序排列（拥有者文档序，再按令牌顺序）', () => {
  const html = `<div id="o1" aria-owns="ghost1"></div>
<div id="o2" aria-owns="ghost2 ghost3"></div>
<div id="o3" aria-owns="o3"></div>`;
  const r = ownershipTree(html);

  assert.deepEqual(
    r.issues.map((i) => [i.owner, i.token, i.reason]),
    [
      [1, 'ghost1', 'missing-target'],
      [2, 'ghost2', 'missing-target'],
      [2, 'ghost3', 'missing-target'],
      [3, 'o3', 'self-reference'],
    ]
  );
  assert.equal(r.count.issues, 4);
});

test('HTTP：POST /ownership-tree 支持 text/html 与 JSON，坏请求 400', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  // text/html 原始片段
  let res = await fetch(`${base}/ownership-tree`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/html' },
    body: '<div id="o" aria-owns="x"></div><span id="x"></span>',
  });
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.equal(body.count.elements, 2);
  assert.equal(body.count.claims, 1);
  assert.deepEqual(body.nodes[0].children, [2]);
  assert.deepEqual(body.preOrder, [1, 2]);

  // JSON { html }
  res = await fetch(`${base}/ownership-tree`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html: '<div id="o" aria-owns="ghost"></div>' }),
  });
  assert.equal(res.status, 200);
  body = await res.json();
  assert.deepEqual(body.issues.map((i) => i.reason), ['missing-target']);

  // 无法解析的请求体 -> 400
  res = await fetch(`${base}/ownership-tree`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nope: 1 }),
  });
  assert.equal(res.status, 400);
  body = await res.json();
  assert.equal(body.error, 'BAD_REQUEST');

  // 既有端点仍正常
  res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
});
