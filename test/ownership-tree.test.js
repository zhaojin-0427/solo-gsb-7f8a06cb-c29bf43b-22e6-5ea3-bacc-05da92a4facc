'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ownershipTree } = require('../src/ownership-tree');
const app = require('../src/app');

// 按 id 取出对应节点的结果条目
function nodeById(result, id) {
  const found = result.nodes.filter((n) => n.id === id);
  assert.equal(found.length, 1, `应恰好存在 id=${id} 的节点`);
  return found[0];
}

test('基本认领：目标及其子树移到拥有者末尾', () => {
  const html = `
    <div id="owner" aria-owns="menu"></div>
    <ul id="menu"><li id="item">项</li></ul>
  `;
  const r = ownershipTree(html);
  assert.equal(r.count.elements, 3);
  assert.equal(r.count.owners, 1);
  assert.equal(r.count.claimed, 1);
  assert.deepEqual(r.issues, []);

  const owner = nodeById(r, 'owner');
  const menu = nodeById(r, 'menu');
  const item = nodeById(r, 'item');
  assert.equal(owner.parent, null);
  assert.deepEqual(owner.children, [menu.dom]);
  assert.equal(menu.parent, owner.dom);
  assert.deepEqual(menu.children, [item.dom]);
  assert.equal(item.parent, menu.dom);
  assert.deepEqual(r.preorder, [owner.dom, menu.dom, item.dom]);
});

test('重排：原为拥有者直接子节点的目标也移到末尾', () => {
  const html = `
    <div id="owner" aria-owns="a">
      <span id="a"></span>
      <span id="b"></span>
    </div>
  `;
  const r = ownershipTree(html);
  const owner = nodeById(r, 'owner');
  const a = nodeById(r, 'a');
  const b = nodeById(r, 'b');
  // a 被移到末尾，b 升到前面
  assert.deepEqual(owner.children, [b.dom, a.dom]);
  assert.deepEqual(r.preorder, [owner.dom, b.dom, a.dom]);
});

test('同一拥有者按令牌顺序依次认领多个目标，均追加到末尾', () => {
  const html = `
    <div id="owner" aria-owns="x y"><span id="keep"></span></div>
    <span id="x"></span>
    <span id="y"></span>
  `;
  const r = ownershipTree(html);
  const owner = nodeById(r, 'owner');
  assert.deepEqual(owner.children, [nodeById(r, 'keep').dom, nodeById(r, 'x').dom, nodeById(r, 'y').dom]);
  assert.equal(r.count.claimed, 2);
});

test('目标缺失：报 missing-target，树不变', () => {
  const html = '<div id="o" aria-owns="ghost"></div><span id="sib"></span>';
  const r = ownershipTree(html);
  assert.equal(r.count.claimed, 0);
  assert.deepEqual(
    r.issues.map((i) => [i.reason, i.owner, i.token]),
    [['missing-target', 1, 'ghost']],
  );
  assert.equal(nodeById(r, 'sib').parent, null);
  assert.deepEqual(nodeById(r, 'o').children, []);
});

test('自指：报 self-reference', () => {
  const html = '<div id="o" aria-owns="o"></div>';
  const r = ownershipTree(html);
  assert.equal(r.count.claimed, 0);
  assert.deepEqual(
    r.issues.map((i) => [i.reason, i.owner, i.token]),
    [['self-reference', 1, 'o']],
  );
  assert.equal(nodeById(r, 'o').parent, null);
});

test('冲突：已被成功认领的目标报 already-claimed；仅成功认领才占用目标', () => {
  const html = `
    <div id="o1" aria-owns="x"></div>
    <div id="o2" aria-owns="x y"></div>
    <span id="x"></span>
    <span id="y"></span>
  `;
  const r = ownershipTree(html);
  // o1 先认领 x 成功；o2 认领 x 被拒，但 y 仍可被 o2 认领
  assert.equal(nodeById(r, 'x').parent, nodeById(r, 'o1').dom);
  assert.equal(nodeById(r, 'y').parent, nodeById(r, 'o2').dom);
  assert.deepEqual(
    r.issues.map((i) => [i.reason, i.owner, i.token]),
    [['already-claimed', nodeById(r, 'o2').dom, 'x']],
  );
  assert.equal(r.count.claimed, 2);
});

test('重挂成环：引用当前树中的祖先报 cycle，拒绝不改变树', () => {
  const html = `
    <div id="a" aria-owns="c">
      <div id="b" aria-owns="a"></div>
      <div id="c"></div>
    </div>
  `;
  const r = ownershipTree(html);
  const a = nodeById(r, 'a');
  const b = nodeById(r, 'b');
  const c = nodeById(r, 'c');
  // a owns c：c 是 a 的直接子节点，移到末尾（顺序不变）；b owns a：a 是 b 的祖先，成环拒绝
  assert.deepEqual(a.children, [b.dom, c.dom]);
  assert.equal(b.parent, a.dom);
  assert.deepEqual(
    r.issues.map((i) => [i.reason, i.owner, i.token]),
    [['cycle', b.dom, 'a']],
  );
  assert.equal(r.count.claimed, 1);
});

test('判环使用此前修改后的树：先被移入子树的目标再引用祖先即成环', () => {
  const html = `
    <div id="a"><div id="b" aria-owns="c"></div></div>
    <div id="c" aria-owns="a"></div>
  `;
  const r = ownershipTree(html);
  const a = nodeById(r, 'a');
  const b = nodeById(r, 'b');
  const c = nodeById(r, 'c');
  // b owns c：c（原为根）移入 b 下；此后 c owns a 时 a 已是 c 的祖先，成环拒绝
  assert.equal(c.parent, b.dom);
  assert.deepEqual(b.children, [c.dom]);
  assert.deepEqual(a.children, [b.dom]);
  assert.deepEqual(
    r.issues.map((i) => [i.reason, i.owner, i.token]),
    [['cycle', c.dom, 'a']],
  );
  assert.deepEqual(r.preorder, [a.dom, b.dom, c.dom]);
});

test('失败的认领不占用目标：后续拥有者仍可认领（子树整体移动）', () => {
  const html = `
    <div id="a" aria-owns="b">
      <div id="b" aria-owns="a"></div>
    </div>
    <div id="c" aria-owns="a"></div>
  `;
  const r = ownershipTree(html);
  const a = nodeById(r, 'a');
  const b = nodeById(r, 'b');
  const c = nodeById(r, 'c');
  // a owns b：b 移到 a 末尾；b owns a：成环拒绝（不占用 a）；c owns a：成功，a 连同 b 移到 c 下
  assert.deepEqual(
    r.issues.map((i) => [i.reason, i.owner, i.token]),
    [['cycle', b.dom, 'a']],
  );
  assert.equal(a.parent, c.dom);
  assert.equal(b.parent, a.dom);
  assert.deepEqual(a.children, [b.dom]);
  assert.deepEqual(c.children, [a.dom]);
  assert.deepEqual(r.preorder, [c.dom, a.dom, b.dom]);
  assert.equal(r.count.claimed, 2);
});

test('同一元素的重复令牌忽略：只处理一次，重复缺失令牌也只报一次', () => {
  const ok = ownershipTree('<div id="o" aria-owns="x x x"></div><span id="x"></span>');
  assert.equal(ok.count.claimed, 1);
  assert.deepEqual(ok.issues, []);
  assert.deepEqual(nodeById(ok, 'o').children, [nodeById(ok, 'x').dom]);

  const missing = ownershipTree('<div id="o" aria-owns="ghost ghost"></div>');
  assert.equal(missing.issues.length, 1);
  assert.equal(missing.issues[0].reason, 'missing-target');
});

test('ID 取首个同名元素：重复 id 只认领文档序第一个', () => {
  const html = `
    <div id="o" aria-owns="dup"></div>
    <span id="dup">一</span>
    <span id="dup">二</span>
  `;
  const r = ownershipTree(html);
  const dups = r.nodes.filter((n) => n.id === 'dup');
  assert.equal(dups.length, 2);
  assert.equal(dups[0].parent, nodeById(r, 'o').dom);
  assert.equal(dups[1].parent, null);
  assert.equal(r.count.claimed, 1);
});

test('忽略 template 内容：内容不参与编号与 id 索引，template 本身占位', () => {
  const html = '<div id="o" aria-owns="inside"></div><template><span id="inside"></span></template>';
  const r = ownershipTree(html);
  assert.equal(r.count.elements, 2); // div + template
  assert.deepEqual(
    r.issues.map((i) => [i.reason, i.owner, i.token]),
    [['missing-target', 1, 'inside']],
  );
  assert.deepEqual(r.nodes.map((n) => n.tag), ['div', 'template']);
  assert.deepEqual(r.preorder, [1, 2]);
});

test('不按样式筛选：display:none、hidden、inert 的元素照常编号与被认领', () => {
  const html = `
    <div id="o" aria-owns="x" style="display:none"></div>
    <span id="x" hidden></span>
    <span id="y" inert></span>
  `;
  const r = ownershipTree(html);
  assert.equal(r.count.elements, 3);
  assert.equal(nodeById(r, 'x').parent, nodeById(r, 'o').dom);
  assert.equal(nodeById(r, 'y').parent, null);
  assert.equal(r.count.claimed, 1);
});

test('链式认领：认领后的拥有者连同新子树可被继续移动', () => {
  const html = `
    <div id="a" aria-owns="b"></div>
    <div id="b" aria-owns="c"></div>
    <div id="c"></div>
  `;
  const r = ownershipTree(html);
  const a = nodeById(r, 'a');
  const b = nodeById(r, 'b');
  const c = nodeById(r, 'c');
  assert.equal(b.parent, a.dom);
  assert.equal(c.parent, b.dom);
  assert.deepEqual(r.preorder, [a.dom, b.dom, c.dom]);
  assert.equal(r.count.claimed, 2);
});

test('多个根按原文档序输出；根被认领后不再是根', () => {
  const html = `
    <div id="r1"></div>
    <div id="r2" aria-owns="r3"></div>
    <div id="r3"></div>
  `;
  const r = ownershipTree(html);
  const r1 = nodeById(r, 'r1');
  const r2 = nodeById(r, 'r2');
  const r3 = nodeById(r, 'r3');
  assert.equal(r1.parent, null);
  assert.equal(r2.parent, null);
  assert.equal(r3.parent, r2.dom);
  // nodes 按原文档序；根间按原文档序
  assert.deepEqual(r.nodes.map((n) => n.dom), [r1.dom, r2.dom, r3.dom]);
  assert.deepEqual(r.preorder, [r1.dom, r2.dom, r3.dom]);
});

test('问题按处理顺序排列：先按拥有者文档序，再按令牌顺序（重复令牌不报）', () => {
  const html = `
    <div id="o1" aria-owns="ghost1 x ghost1"></div>
    <div id="o2" aria-owns="x ghost2"></div>
    <span id="x"></span>
  `;
  const r = ownershipTree(html);
  assert.deepEqual(
    r.issues.map((i) => [i.owner, i.token, i.reason]),
    [
      [1, 'ghost1', 'missing-target'],
      [2, 'x', 'already-claimed'],
      [2, 'ghost2', 'missing-target'],
    ],
  );
});

test('空 aria-owns 与空片段安全处理', () => {
  const emptyAttr = ownershipTree('<div id="o" aria-owns="  "></div>');
  assert.equal(emptyAttr.count.owners, 1);
  assert.equal(emptyAttr.count.claimed, 0);
  assert.deepEqual(emptyAttr.issues, []);

  const empty = ownershipTree('');
  assert.deepEqual(empty.nodes, []);
  assert.deepEqual(empty.preorder, []);
  assert.deepEqual(empty.issues, []);
  assert.deepEqual(empty.count, { elements: 0, owners: 0, claimed: 0, issues: 0 });
});

test('节点条目带 dom、tag、id、parent、children 与定位信息', () => {
  const html = '<div id="o" aria-owns="x">\n  <span id="x"></span>\n</div>';
  const r = ownershipTree(html);
  const o = nodeById(r, 'o');
  assert.equal(o.dom, 1);
  assert.equal(o.tag, 'div');
  assert.equal(o.parent, null);
  assert.deepEqual(o.children, [2]);
  assert.equal(o.location.line, 1);
  const x = nodeById(r, 'x');
  assert.equal(x.parent, 1);
  assert.equal(x.location.line, 2);
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
  assert.equal(body.count.claimed, 1);
  assert.deepEqual(body.preorder, [1, 2]);
  assert.equal(body.nodes[1].parent, 1);

  // JSON { html }
  res = await fetch(`${base}/ownership-tree`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html: '<div id="o" aria-owns="ghost"></div>' }),
  });
  assert.equal(res.status, 200);
  body = await res.json();
  assert.equal(body.issues.length, 1);
  assert.equal(body.issues[0].reason, 'missing-target');

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
