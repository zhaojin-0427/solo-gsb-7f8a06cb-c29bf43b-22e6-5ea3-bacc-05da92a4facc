'use strict';

const parse5 = require('parse5');

/**
 * 计算一段 HTML 片段的 aria-owns 所有权树。
 *
 * 初始化：
 *  - 以 parse5 元素树为准，忽略 template 内容（parse5 将其放在 template.content，
 *    不进入 childNodes），不按样式筛选（display:none、hidden 等不影响树的构建）；
 *  - 全部元素按文档序（先序）从 1 起编号（dom），沿用全局元素序号。
 *
 * 认领（按原文档序处理带 aria-owns 的元素）：
 *  - 属性值按空白分词，同一元素的重复令牌忽略，id 取文档序首个同名元素；
 *  - 每个令牌依次检查：目标缺失（missing-target）、自指（self-reference）、
 *    已被成功认领（already-claimed）、重挂成环（cycle，判环使用此前修改后的树，
 *    即目标子树在当前树中包含拥有者）；
 *  - 失败即拒绝并报告拥有者、令牌与原因，拒绝不改变树；
 *  - 接受时将目标及其当前子树移到拥有者子节点末尾（原为直接子节点也移到末尾），
 *    仅成功认领才占用目标。
 *
 * 返回：
 *  - nodes：按原文档序给出各节点 dom、最终父编号 parent（根为 null）与有序子编号 children；
 *  - preorder：最终树的先序遍历（根间按原文档序）；
 *  - issues：按处理顺序排列。
 *
 * @param {string} html
 * @returns {{count: object, nodes: object[], preorder: number[], issues: object[]}}
 */
function ownershipTree(html) {
  const fragment = parse5.parseFragment(html, { sourceCodeLocationInfo: true });

  // ---- 第一遍：以 parse5 元素树初始化，全局元素按文档序从 1 编号 ----
  const entries = []; // 全部元素条目，下标 + 1 即 dom
  const domOf = new Map(); // 元素节点 -> dom
  const byId = new Map(); // id -> 文档序首个同名元素
  const parentOf = new Map(); // 元素节点 -> 父元素节点（根为 null）
  const childrenOf = new Map(); // 元素节点 -> 有序子元素数组（随认领变化）
  const roots = []; // 当前根元素（fragment 的直接元素子节点；只会被认领移走，保持文档序）

  walk(fragment, null);

  function walk(container, parent) {
    for (const child of container.childNodes || []) {
      if (!child.tagName) continue; // 文本、注释等
      const tag = child.tagName.toLowerCase();
      const dom = entries.length + 1;
      entries.push({ node: child, dom, tag });
      domOf.set(child, dom);

      const id = getAttr(child, 'id');
      if (id && !byId.has(id)) byId.set(id, child);

      parentOf.set(child, parent);
      childrenOf.set(child, []);
      if (parent === null) roots.push(child);
      else childrenOf.get(parent).push(child);

      if (tag !== 'template') walk(child, child); // 忽略 template 内容
    }
  }

  // ---- 第二遍：按原文档序处理带 aria-owns 的元素（entries 已按 dom 升序）----
  const claimed = new Set(); // 已被成功认领的目标元素
  const issues = [];
  let ownerCount = 0;

  for (const entry of entries) {
    if (!hasAttr(entry.node, 'aria-owns')) continue;
    ownerCount += 1;

    const seen = new Set(); // 同一元素的重复令牌忽略
    for (const token of tokenize(getAttr(entry.node, 'aria-owns'))) {
      if (seen.has(token)) continue;
      seen.add(token);
      processToken(entry, token);
    }
  }

  /**
   * 处理拥有者的单个 id 令牌：依次检查缺失、自指、已被认领、成环，
   * 全部通过则把目标及其当前子树移到拥有者末尾。
   */
  function processToken(owner, token) {
    const reject = (reason, detail) => {
      issues.push({ reason, owner: owner.dom, token, detail });
    };

    const target = byId.get(token);
    if (!target) {
      return reject(
        'missing-target',
        `${describe(owner)}的 aria-owns 引用了不存在的 id ${JSON.stringify(token)}`,
      );
    }
    if (target === owner.node) {
      return reject(
        'self-reference',
        `${describe(owner)}的 aria-owns 引用了自身 id ${JSON.stringify(token)}`,
      );
    }
    if (claimed.has(target)) {
      return reject(
        'already-claimed',
        `${describe(owner)}的 aria-owns 引用的 id ${JSON.stringify(token)} 已被成功认领`,
      );
    }
    // 判环使用此前修改后的树：目标子树当前包含拥有者时，重挂即成环
    if (isAncestorOf(target, owner.node)) {
      return reject(
        'cycle',
        `${describe(owner)}的 aria-owns 引用了其祖先 id ${JSON.stringify(token)}，重挂会形成循环`,
      );
    }

    // 接受：目标及当前子树移到拥有者末尾（原为直接子节点也移到末尾）
    const parent = parentOf.get(target);
    const siblings = parent === null ? roots : childrenOf.get(parent);
    siblings.splice(siblings.indexOf(target), 1);
    childrenOf.get(owner.node).push(target);
    parentOf.set(target, owner.node);
    claimed.add(target);
    return undefined;
  }

  /** 在当前（可能已被认领修改的）树中，判断 ancestor 是否为 node 的严格祖先。 */
  function isAncestorOf(ancestor, node) {
    let cur = parentOf.get(node);
    while (cur) {
      if (cur === ancestor) return true;
      cur = parentOf.get(cur);
    }
    return false;
  }

  // ---- 输出：按原文档序给出各节点最终父编号与有序子编号 ----
  const nodes = entries.map((entry) => {
    const parent = parentOf.get(entry.node);
    const out = {
      dom: entry.dom,
      tag: entry.tag,
    };
    const id = getAttr(entry.node, 'id');
    if (id) out.id = id;
    out.parent = parent === null ? null : domOf.get(parent);
    out.children = childrenOf.get(entry.node).map((child) => domOf.get(child));

    const loc = entry.node.sourceCodeLocation;
    if (loc && typeof loc.startLine === 'number') {
      out.location = { line: loc.startLine, column: loc.startCol };
    }
    return out;
  });

  // 最终先序遍历：根间按原文档序，子节点按最终顺序
  const preorder = [];
  const visit = (node) => {
    preorder.push(domOf.get(node));
    for (const child of childrenOf.get(node)) visit(child);
  };
  for (const root of roots) visit(root);

  return {
    count: {
      elements: entries.length,
      owners: ownerCount,
      claimed: claimed.size,
      issues: issues.length,
    },
    nodes,
    preorder,
    issues,
  };
}

function describe(entry) {
  const id = getAttr(entry.node, 'id');
  return `第 ${entry.dom} 号元素 <${entry.tag}>${id ? `#${id}` : ''}`;
}

function tokenize(value) {
  const s = String(value).trim();
  return s ? s.split(/\s+/) : [];
}

function getAttr(node, name) {
  const attr = node.attrs.find((a) => a.name === name);
  return attr ? attr.value : '';
}

function hasAttr(node, name) {
  return node.attrs.some((a) => a.name === name);
}

module.exports = { ownershipTree };
