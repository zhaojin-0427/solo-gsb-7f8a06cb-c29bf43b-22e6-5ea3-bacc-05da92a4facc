'use strict';

const parse5 = require('parse5');

/**
 * 计算一段 HTML 片段的 aria-owns 所有权树。
 *
 * 初始化：
 *  - 以 parse5 元素树为准；忽略 template 内容（parse5 把 <template> 的子节点
 *    放进独立的 content 片段，childNodes 天然为空，遍历即忽略）；
 *  - 不按样式筛选（display:none 等不影响归属）；
 *  - dom 为全部元素的全局先序（文档序）编号，从 1 起。
 *
 * 处理（按原文档序处理带 aria-owns 的元素）：
 *  - 属性值按空白分词；同一元素内的重复令牌忽略；id 取文档中首个同名元素；
 *  - 每个令牌依次检查：目标缺失（missing-target）、自指（self-reference）、
 *    已被成功认领（already-claimed）、重挂成环（cycle，判环使用此前修改后的树）；
 *  - 失败即拒绝并记录问题，不改变树；仅成功认领才占用目标；
 *  - 接受时把目标及其当前子树移到拥有者子列表末尾（原为直接子节点也移到末尾）。
 *
 * 返回：nodes 按原文档序给出各节点的 dom、最终父编号 parent（根为 null）与
 * 有序子编号 children；roots 为最终根列表（根间按原文档序）；preOrder 为最终
 * 先序遍历；issues 按处理顺序排列。
 *
 * @param {string} html
 * @returns {{count: object, roots: number[], nodes: object[], preOrder: number[], issues: object[]}}
 */
function ownershipTree(html) {
  const fragment = parse5.parseFragment(html, { sourceCodeLocationInfo: true });

  // ---- 建镜像树（后续重挂只改镜像，不动 parse5 树）----
  const nodes = []; // 全部节点，下标 = dom - 1
  const byId = new Map(); // id -> 文档中首个同名元素
  const owners = []; // 带 aria-owns 的元素（文档序）
  const rootList = []; // 顶层节点（只减不增，始终保持原文档序）

  build(fragment, null);

  function build(container, parent) {
    for (const child of container.childNodes || []) {
      if (!child.tagName) continue; // 文本、注释等
      const node = {
        dom: nodes.length + 1,
        tag: child.tagName.toLowerCase(),
        id: hasAttr(child, 'id') ? getAttr(child, 'id') : null,
        parent,
        children: [],
        source: child,
      };
      nodes.push(node);
      if (parent) parent.children.push(node);
      else rootList.push(node);

      if (node.id && !byId.has(node.id)) byId.set(node.id, node);
      if (hasAttr(child, 'aria-owns')) owners.push({ node, raw: getAttr(child, 'aria-owns') });

      build(child, node);
    }
  }

  // ---- 按原文档序处理 aria-owns ----
  const claimed = new Set(); // 已被成功认领的目标节点
  const issues = [];
  let tokens = 0;
  let claims = 0;

  for (const { node: owner, raw } of owners) {
    const seen = new Set(); // 同一元素的重复令牌忽略
    for (const token of tokenize(raw)) {
      if (seen.has(token)) continue;
      seen.add(token);
      tokens += 1;

      const target = byId.get(token);

      // 1. 目标缺失
      if (!target) {
        issues.push({
          owner: owner.dom,
          token,
          reason: 'missing-target',
          detail: `${describeNode(owner)}的 aria-owns 引用了不存在的 id ${JSON.stringify(token)}`,
        });
        continue;
      }

      // 2. 自指
      if (target === owner) {
        issues.push({
          owner: owner.dom,
          token,
          reason: 'self-reference',
          detail: `${describeNode(owner)}的 aria-owns 令牌 ${JSON.stringify(token)} 指向自身`,
        });
        continue;
      }

      // 3. 已被成功认领（失败的认领不占用目标）
      if (claimed.has(target)) {
        issues.push({
          owner: owner.dom,
          token,
          reason: 'already-claimed',
          detail: `${describeNode(owner)}的 aria-owns 令牌 ${JSON.stringify(token)} 指向的${describeNode(target)}已被成功认领`,
        });
        continue;
      }

      // 4. 重挂成环：目标在当前（此前修改后的）树中是拥有者的祖先
      if (isAncestorOf(target, owner)) {
        issues.push({
          owner: owner.dom,
          token,
          reason: 'cycle',
          detail: `${describeNode(owner)}的 aria-owns 令牌 ${JSON.stringify(token)} 指向的${describeNode(target)}是其祖先，重挂会形成循环`,
        });
        continue;
      }

      // 接受：目标及当前子树移到拥有者末尾（原为直接子节点也移到末尾）
      detach(target);
      target.parent = owner;
      owner.children.push(target);
      claimed.add(target);
      claims += 1;
    }
  }

  /** 把节点从当前父的子列表（或根列表）中摘下。 */
  function detach(node) {
    const list = node.parent ? node.parent.children : rootList;
    const idx = list.indexOf(node);
    if (idx !== -1) list.splice(idx, 1);
  }

  // ---- 汇总输出 ----
  const nodeEntries = nodes.map((node) => {
    const entry = {
      dom: node.dom,
      tag: node.tag,
    };
    if (node.id) entry.id = node.id;
    entry.parent = node.parent ? node.parent.dom : null;
    entry.children = node.children.map((c) => c.dom);

    const loc = node.source.sourceCodeLocation;
    if (loc && typeof loc.startLine === 'number') {
      entry.location = { line: loc.startLine, column: loc.startCol };
    }
    return entry;
  });

  // 最终先序遍历；rootList 只减不增，根间天然保持原文档序
  const preOrder = [];
  function collect(node) {
    preOrder.push(node.dom);
    for (const child of node.children) collect(child);
  }
  for (const root of rootList) collect(root);

  return {
    count: {
      elements: nodes.length,
      owners: owners.length,
      tokens,
      claims,
      issues: issues.length,
    },
    roots: rootList.map((n) => n.dom),
    nodes: nodeEntries,
    preOrder,
    issues,
  };
}

/** ancestor 是否为 node 的祖先（沿当前父链向上查，用于判环）。 */
function isAncestorOf(ancestor, node) {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (cur === ancestor) return true;
  }
  return false;
}

function tokenize(value) {
  const s = String(value).trim();
  return s ? s.split(/\s+/) : [];
}

function describeNode(node) {
  return `第 ${node.dom} 号元素 <${node.tag}>${node.id ? `#${node.id}` : ''}`;
}

function getAttr(node, name) {
  const attr = node.attrs.find((a) => a.name === name);
  return attr ? attr.value : '';
}

function hasAttr(node, name) {
  return node.attrs.some((a) => a.name === name);
}

module.exports = { ownershipTree };
