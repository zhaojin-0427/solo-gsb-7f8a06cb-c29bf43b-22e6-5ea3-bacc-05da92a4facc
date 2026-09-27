# 焦点审计 API（Focus Audit API）

用 **Node.js + Express + parse5** 实现的可访问性审计服务，提供五个接口：

- `POST /audit`：提交一段 HTML 片段，返回其中可聚焦控件的 Tab 顺序、从 1 起的元素序号以及可访问性风险
- `POST /accessible-names`：计算片段中控件与带 `role` 元素的可访问名称（accessible name），并报告缺失/循环引用与无名称元素
- `POST /implicit-submit`：判定片段中每个 `<input>` 聚焦后按 Enter 能否触发[隐式提交（implicit submission）](https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#implicit-submission)，返回表单归属、默认按钮、结果与原因
- `POST /table-headers`：审计片段中各 `<table>` 数据格（`<td>`）的显式表头关联，返回每个 td 关联到的表头、表格序号与问题
- `POST /ownership-tree`：按 `aria-owns` 重挂元素树，返回各节点最终父子关系、根列表、最终先序遍历与认领冲突问题

## 审计规则

### 纳入 Tab 计算的元素

- `a[href]`
- `button`
- 非 `hidden` 类型的 `input`
- `select`、`textarea`
- 任何显式设置了 `tabindex` 属性的元素

### 排除条件（自身或祖先满足任一即排除整棵子树）

- 带 `hidden` 或 `inert` 属性
- 内联样式 `display: none`
- 内联样式 `visibility: hidden`
- 控件自身带 `disabled` 属性（`button` / `input` / `select` / `textarea`）

### Tab 顺序

1. 正 `tabindex`（≥ 1）：按数值升序；数值相同按文档顺序
2. 随后是 `tabindex="0"` 与无 `tabindex` 的原生控件：统一按文档顺序
3. 负 `tabindex` 不参与 Tab 顺序（会列入 `skipped`）
4. 无法解析为整数的非法 `tabindex`：浏览器忽略该属性，同时报一条 `INVALID_TABINDEX` 风险（非原生元素因此不可聚焦）

### radio 分组

- 按**最近的 `<form>` 祖先**分组；不在任何 form 内则以文档根为分组作用域
- 同一作用域内再按 `name` 分组
- 组内选中（`checked`）成员中的**最后一个**作为代表参与 Tab 顺序；没有选中项时取**第一个可用**成员；其余成员列入 `skipped`
- 没有 `name` 的 radio 各自独立，不参与分组

### 风险（risks）

- `FOCUSABLE_IN_ARIA_HIDDEN`：元素位于 `aria-hidden="true"` 子树内（自身显式声明优先），却仍可通过 Tab 聚焦
- `INVALID_TABINDEX`：`tabindex` 属性值不是合法整数

每个结果元素都带：

- `dom`：从 1 起的**文档序**元素号
- `seq`：在 Tab 顺序中的**从 1 起序号**（仅 `tabOrder`/入序风险含此字段）

## 启动

### Docker Compose 一键启动（推荐）

```bash
docker compose up --build
```

服务启动后监听 <http://localhost:3000>。

### Docker

```bash
docker build -t focus-audit .
docker run --rm -p 3000:3000 focus-audit
```

### 本地 Node.js 直接运行（需要 Node.js ≥ 20）

```bash
npm install
npm start
```

默认地址：<http://localhost:3000>

可用环境变量 `PORT`（默认 3000）、`HOST`（默认 `0.0.0.0`）修改监听配置。

## 使用

### `POST /audit`

请求体支持两种形式：

1. 直接发送 HTML 片段（`Content-Type: text/html`）
2. JSON：`{ "html": "<片段>" }`（`Content-Type: application/json`）

```bash
curl -X POST http://localhost:3000/audit \
  -H 'Content-Type: text/html' \
  --data-binary '<button>提交</button>
<div aria-hidden="true"><a href="/help">帮助</a></div>
<form>
  <input type="radio" name="color" value="r">
  <input type="radio" name="color" value="g" checked>
</form>
<div tabindex="wat">坏 tabindex</div>'
```

返回示例（节选）：

```json
{
  "count": { "candidates": 5, "tabOrder": 3, "skipped": 2, "risks": 2 },
  "tabOrder": [
    { "dom": 1, "tag": "button", "text": "提交", "seq": 1 },
    { "dom": 2, "tag": "a", "href": "/help", "ariaHidden": true, "text": "帮助", "seq": 2 },
    {
      "dom": 4, "tag": "input", "type": "radio", "name": "color",
      "checked": true, "seq": 3,
      "radioGroup": { "name": "color", "size": 2, "checked": true }
    }
  ],
  "skipped": [
    { "reason": "radio-group", "dom": 3, "tag": "input", "repDom": 4, "...": "..." },
    { "reason": "invalid-tabindex", "dom": 5, "tag": "div", "tabindex": "wat", "...": "..." }
  ],
  "risks": [
    { "type": "FOCUSABLE_IN_ARIA_HIDDEN", "dom": 2, "seq": 2, "...": "..." },
    { "type": "INVALID_TABINDEX", "dom": 5, "tabindex": "wat", "...": "..." }
  ]
}
```

`skipped.reason` 取值：

- `negative-tabindex`：负 `tabindex`，不参与 Tab 顺序
- `radio-group`：radio 组内的非代表成员（`repDom` 指向代表元素的 dom 号）
- `invalid-tabindex`：非法 `tabindex` 导致非原生元素不可聚焦

### `POST /accessible-names`

请求体形式与 `/audit` 相同：直接发送 HTML 片段（`Content-Type: text/html`），或 JSON `{ "html": "<片段>" }`。

纳入计算的元素（与文档序一致，`dom` 从 1 起）：

- `button`、`a[href]`、非 `hidden` 类型的 `input`、`select`、`textarea`
- 任何带非空 `role` 属性的元素

名称按以下优先级计算（所有文本统一折叠空白，即连续空白合并为单个空格并去除首尾空白）：

1. **`aria-labelledby`**：属性值按空白拆成 id 令牌，按令牌顺序解析并拼接；被引用元素若自身也带 `aria-labelledby`，则**递归展开**，否则贡献其文本内容
2. **`aria-label`**：折叠空白后非空时生效
3. **关联 `<label>`**（仅 `button` / `input` / `select` / `textarea`）：在 `for` 指向本控件 id 的 label 与包裹本控件（且 `for` 未指向别处）的 label 中，取**文档序最靠前**的一个；label 文本会剔除其中嵌套的控件子树
4. **自身文本内容**

四步都得不到文本时该元素没有可访问名称（`source: null`），并报告一条 `UNNAMED` 问题。此外：

- `MISSING_REFERENCE`：`aria-labelledby` 引用了片段中不存在的 id（`refId` 指出缺失的 id）
- `CIRCULAR_REFERENCE`：`aria-labelledby` 引用成环，`chain` 给出 id 环（如 `["c1", "c2", "c1"]`，自引用为 `["x", "x"]`）

出现缺失或循环引用时仍会继续向下一级来源回退。所有 `issues` 按 `dom`、类型稳定排序。

```bash
curl -X POST http://localhost:3000/accessible-names \
  -H 'Content-Type: text/html' \
  --data-binary '<span id="first">名</span><span id="last">字</span>
<input id="name" aria-labelledby="last first">
<button aria-label="  保存   更改 ">x</button>
<label for="mail">邮箱 <span>*</span></label><input id="mail">
<a href="/help">帮助中心</a>
<div role="button" aria-labelledby="ghost"></div>'
```

返回示例：

```json
{
  "count": { "elements": 5, "named": 4, "unnamed": 1, "issues": 2 },
  "elements": [
    { "dom": 1, "tag": "input", "id": "name", "name": "字 名", "source": "aria-labelledby" },
    { "dom": 2, "tag": "button", "name": "保存 更改", "source": "aria-label" },
    { "dom": 3, "tag": "input", "id": "mail", "name": "邮箱 *", "source": "label" },
    { "dom": 4, "tag": "a", "href": "/help", "name": "帮助中心", "source": "content" },
    { "dom": 5, "tag": "div", "role": "button", "name": "", "source": null }
  ],
  "issues": [
    { "type": "MISSING_REFERENCE", "dom": 5, "refId": "ghost",
      "detail": "第 5 号元素 <div>的 aria-labelledby 引用了不存在的 id \"ghost\"" },
    { "type": "UNNAMED", "dom": 5, "detail": "第 5 号元素 <div> 没有可访问名称" }
  ]
}
```

`source` 取值：`aria-labelledby`、`aria-label`、`label`、`content`，无名称时为 `null`。

### `POST /implicit-submit`

请求体形式与其他接口相同：直接发送 HTML 片段（`Content-Type: text/html`），或 JSON `{ "html": "<片段>" }`。

按**文档序**返回片段中的**每一个 `<input>`**（包括无归属、失效、`type=hidden` 等），逐一判定聚焦后按 Enter 能否提交表单。`dom` 是该 input 在全部元素中文档序从 1 起的编号（非 input 元素也占位）。

#### 表单归属（form owner）

- input 带 `form` 属性时，取文档序**首个拥有该 id 的元素**；只有它是 `<form>` 时归属才成立。id 不存在、`form=""`、或首个同 id 元素不是 form（即使后面还有同 id 的 form）都属于**无归属**，且不会回退到祖先 form
- 未设置 `form` 属性时，取最近的 `<form>` 祖先
- 结果中 `form` 为 `{ dom, id? }` 或 `null`；带 `form` 属性时另附原始值 `formAttr` 与布尔值 `formAttrValid`

#### 失效（disabled）

- input 自身带 `disabled` 属性，或位于 `disabled <fieldset>` 的后代中，均视为失效（`disabled: true`）
- **例外**：fieldset 的第一个 `<legend>` 元素子树内的后代不受该 fieldset 影响；嵌套时内层 legend 只能解除内层 fieldset，无法解除外层
- 失效 input 仍保留其表单归属与默认按钮信息，但 Enter 不提交

#### 默认按钮（default button）

默认按钮是所属 form 的**文档序第一个提交按钮**，即使该按钮失效也**不会改选**为后面的按钮。提交按钮包括：

- `<button>` 无 `type` 或 `type=submit`（无 type 时按 submit 处理）
- `<input>` `type=submit` 或 `type=image`

提交按钮自身的 `form` 属性同样用于决定它属于哪个 form。

#### Enter 提交判定

只有**阻止型 input**（无 `type`，或 `type=text/search/url/tel/email/password/number`，大小写不敏感）才会触发隐式提交；`checkbox`、`hidden`、`date`、`submit`、`image` 等其他类型（包括空 `type=""` 与未知类型）均不触发。对阻止型 input：

1. 无归属 / 自身失效 → 不提交
2. 所属 form 存在默认按钮 → 默认按钮可用则提交；**默认按钮失效则不提交**（不会改选，也不适用下面的兜底规则）
3. 所属 form 没有任何提交按钮 → 该 form 中**可用的阻止型 input 不超过一个**时才提交（失效 input 与非阻止型 input 不计入）

`reason` 取值：

| reason | 含义 | `submits` |
| --- | --- | --- |
| `default-button` | 默认按钮可用，Enter 触发它提交 | `true` |
| `single-blocking-input` | 无提交按钮且可用阻止型输入仅此一个，Enter 直接提交 | `true` |
| `default-button-disabled` | 默认按钮失效且不改选 | `false` |
| `multiple-blocking-inputs` | 无提交按钮且有多个可用阻止型输入 | `false` |
| `not-blocking-type` | 非阻止型 input，不参与隐式提交 | `false` |
| `no-form-owner` | 无表单归属（无 form 祖先 / `form` 属性无效） | `false` |
| `disabled` | 自身带 `disabled` 属性 | `false` |
| `disabled-fieldset` | 位于 disabled fieldset 后代中 | `false` |

```bash
curl -X POST http://localhost:3000/implicit-submit \
  -H 'Content-Type: text/html' \
  --data-binary '<form id="f1">
  <input name="q">
  <button type="submit" disabled>失效按钮</button>
  <button type="submit">不会改选我</button>
</form>
<form id="f2">
  <input type="text">
  <input type="email">
</form>
<input form="ghost">'
```

返回示例（节选）：

```json
{
  "count": { "inputs": 4, "blocking": 4, "submits": 0, "noFormOwner": 1, "disabled": 0 },
  "inputs": [
    {
      "dom": 2, "tag": "input", "name": "q", "type": "text", "typeMissing": true,
      "blocking": true, "form": { "dom": 1, "id": "f1" },
      "disabled": false, "inDisabledFieldset": false,
      "defaultButton": { "dom": 3, "tag": "button", "type": "submit", "disabled": true, "text": "失效按钮" },
      "submits": false, "reason": "default-button-disabled",
      "detail": "所属 form 的默认按钮是第 3 号 <button>，但它已失效且不会改选其他按钮，Enter 不提交",
      "location": { "line": 2, "column": 3 }
    }
  ]
}
```

### `POST /table-headers`

请求体形式与其他接口相同：直接发送 HTML 片段（`Content-Type: text/html`），或 JSON `{ "html": "..." }`。

审计片段中**每个 `<table>`** 的数据格（`<td>`）与表头（`<th>`）的显式关联，按**文档序**返回每个 td 的结果；`dom` 是该 td 在全部元素中文档序从 1 起的编号。

#### 建网格（每个 table 独立）

- 只计本表**直属 `tr`** 及 `thead` / `tbody` / `tfoot` 下的 `tr`（解析器为裸 `tr` 补出的隐式 `tbody` 同样计入）；**嵌套表另算**，外表行中不包含内表的行
- 按文档序逐行放置每个 `tr` 直属的 `th`、`td`，放置前先跳过被跨行占用的格
- `rowspan`、`colspan` 仅接受 **1～20 的十进制整数**（允许前后空白）；`0`、负数、`21` 及以上、非数字等一律按 `1`
- 表头覆盖其跨越的全部格（按矩形的行/列区间求交）

#### 表头关联

- **带 `headers` 属性的 td**：把属性值按空白拆成令牌，按令牌顺序关联**本表首个同 id 的 `<th>`**，同一表头按首次出现去重；引用不到（id 不存在、指向非 `th`、指向其他表）按令牌去重后报 `INVALID_HEADER_REFERENCE`。存在该属性时**不再自动推断**（属性为空串等同显式声明空关联）
- **其余 td** 自动推断：
  - 上方（表头起始行严格更小）**列区间相交**的 `scope="col"` 表头；
  - 左侧（表头起始列严格更小）**行区间相交**的 `scope="row"` 表头；
  - 按表头文档序去重；`scope` 的其他取值（`colgroup`、`rowgroup`、空值、非法值）一律不处理
- 任何 td 关联不到有效表头时报 `NO_HEADER`（带 `headers` 且令牌全部无效时，先列无效引用、再列 `NO_HEADER`）

返回中 `headers` 是关联到的表头的全局 `dom` 编号数组；`table` 是该 td 所属表格按文档序从 1 起的编号；每个 td 的 `issues` 同时汇总在顶层 `issues` 中。

```bash
curl -X POST http://localhost:3000/table-headers \
  -H 'Content-Type: text/html' \
  --data-binary '<table>
  <thead>
    <tr><th scope="col" id="name" colspan="2">名称</th><th scope="col" id="qty">数量</th></tr>
    <tr><th scope="col" id="cn">中文</th><th scope="col" id="en">英文</th></tr>
  </thead>
  <tbody>
    <tr><th scope="row" rowspan="2">水果</th><td>苹果</td><td headers="qty">2</td></tr>
    <tr><td>香蕉</td><td>3</td></tr>
  </tbody>
</table>'
```

返回示例（节选）：

```json
{
  "count": { "tables": 1, "cells": 4, "withHeaders": 4, "noHeader": 0, "invalidReferences": 0, "issues": 0 },
  "cells": [
    {
      "dom": 12, "table": 1,
      "headers": [4, 8, 11],
      "issues": [],
      "location": { "line": 7, "column": 44 }
    },
    {
      "dom": 13, "table": 1,
      "headers": [5],
      "issues": []
    }
  ],
  "issues": []
}
```

问题类型：

| type | 含义 |
| --- | --- |
| `INVALID_HEADER_REFERENCE` | `headers` 属性的某个令牌在本表中找不到同 id 的 `<th>`（不存在 / 指向非 th / 指向其他表），`refId` 给出该令牌 |
| `NO_HEADER` | 该 td 最终没有关联到任何表头 |

### `POST /ownership-tree`

请求体形式与其他接口相同：直接发送 HTML 片段（`Content-Type: text/html`），或 JSON `{ "html": "..." }`。

按 **[`aria-owns`](https://www.w3.org/TR/wai-aria-1.2/#aria-owns) 的所有权语义**重挂元素树，输出最终所有权树。

#### 初始化与编号

- 以 **parse5 元素树**初始化；**忽略 `<template>` 内容**（解析器把 template 子树放进独立的 content 片段）；**不按样式筛选**（`display:none` 等照常参与）
- `dom` 沿用全部元素的全局**先序（文档序）编号**，从 1 起；同一元素在结果中的位置始终保持原文档序

#### 处理规则

按**原文档序**处理每个带 `aria-owns` 的元素：

1. 属性值按**空白分词**；**同一元素的重复令牌忽略**（只按首次出现处理）
2. id 解析取文档中**首个同名元素**
3. 每个令牌依次检查，任一失败即**拒绝**并记录问题（报告拥有者 `owner`、令牌 `token` 与原因 `reason`），**拒绝不改变树**：

   | reason | 含义 |
   | --- | --- |
   | `missing-target` | 目标缺失：片段中没有该 id 的元素（含位于 template 内） |
   | `self-reference` | 自指：目标就是拥有者自身 |
   | `already-claimed` | 目标此前**已被成功认领**（仅成功认领才占用目标，失败不占用） |
   | `cycle` | 重挂成环：目标在**此前修改后的树**中是拥有者的祖先，移动会形成环 |

4. 接受时，把**目标及其当前子树**移到拥有者子列表的**末尾**；目标**原为直接子节点也同样移到末尾**（即兄弟重排）

#### 返回

- `nodes`：按**原文档序**给出每个节点的 `dom`、最终父编号 `parent`（根为 `null`）与有序子编号 `children`（附 `tag`、`id`、`location`）
- `roots`：最终根节点编号，**根间按原文档序**
- `preOrder`：最终树的**先序遍历**（依次遍历根及其有序子节点）
- `issues`：冲突问题，**按处理顺序**（拥有者文档序，再按令牌顺序）排列

#### 重排示例（原为直接子节点也移到末尾）

```bash
curl -X POST http://localhost:3000/ownership-tree \
  -H 'Content-Type: text/html' \
  --data-binary '<div id="toolbar" aria-owns="save">
  <button id="save">保存</button>
  <button id="cancel">取消</button>
</div>'
```

`save` 本是 `toolbar` 的直接子节点，认领后移到子列表末尾，最终先序变为 `toolbar → cancel → save`：

```json
{
  "count": { "elements": 3, "owners": 1, "tokens": 1, "claims": 1, "issues": 0 },
  "roots": [1],
  "nodes": [
    { "dom": 1, "tag": "div", "id": "toolbar", "parent": null, "children": [3, 2] },
    { "dom": 2, "tag": "button", "id": "save", "parent": 1, "children": [] },
    { "dom": 3, "tag": "button", "id": "cancel", "parent": 1, "children": [] }
  ],
  "preOrder": [1, 3, 2],
  "issues": []
}
```

#### 冲突示例（目标已被成功认领）

```bash
curl -X POST http://localhost:3000/ownership-tree \
  -H 'Content-Type: text/html' \
  --data-binary '<div id="a" aria-owns="x"></div>
<div id="b" aria-owns="x y"></div>
<span id="x"></span>
<span id="y"></span>'
```

按文档序先处理 `a`：成功认领 `x`；再处理 `b`：令牌 `x` 已被成功认领而拒绝，令牌 `y` 正常认领。拒绝不改树，最终先序为 `a → x → b → y`：

```json
{
  "count": { "elements": 4, "owners": 2, "tokens": 3, "claims": 2, "issues": 1 },
  "roots": [1, 2],
  "nodes": [
    { "dom": 1, "tag": "div", "id": "a", "parent": null, "children": [3] },
    { "dom": 2, "tag": "div", "id": "b", "parent": null, "children": [4] },
    { "dom": 3, "tag": "span", "id": "x", "parent": 1, "children": [] },
    { "dom": 4, "tag": "span", "id": "y", "parent": 2, "children": [] }
  ],
  "preOrder": [1, 3, 2, 4],
  "issues": [
    {
      "owner": 2,
      "token": "x",
      "reason": "already-claimed",
      "detail": "第 2 号元素 <div>#b的 aria-owns 令牌 \"x\" 指向的第 3 号元素 <span>#x已被成功认领"
    }
  ]
}
```

### `GET /health`

健康检查，返回 `{"status":"ok"}`。

## 测试

```bash
npm test
```

使用 Node.js 内置测试运行器，覆盖排序、排除、radio 分组、风险判定，可访问名称的优先级、递归展开、缺失/循环引用、label 关联，隐式提交的表单归属、默认按钮（含失效不改选）、阻止型输入计数、disabled fieldset 与 legend 例外，表头关联的独立网格/嵌套表、跨行跨列占位与覆盖、`headers` 显式关联与无效引用、`scope` 推断，aria-owns 所有权树的重挂重排、缺失/自指/重复认领/成环冲突与失败不占目标，以及 HTTP 端点接线等 87 个用例。

## 项目结构

```
src/
  audit.js             # 焦点顺序审计逻辑（parse5 解析 + 规则判定）
  accessible-names.js  # 可访问名称计算（aria-labelledby 递归展开、label 关联等）
  implicit-submit.js   # Enter 隐式提交判定（表单归属、默认按钮、disabled fieldset 等）
  table-headers.js     # HTML 表格表头关联审计（独立网格、跨行跨列、headers/scope 关联等）
  ownership-tree.js    # aria-owns 所有权树（文档序处理、冲突拒绝、子树重挂、先序遍历）
  app.js               # Express 应用（/audit、/accessible-names、/implicit-submit、/table-headers、/ownership-tree、/health）
  server.js            # 启动入口
test/
  audit.test.js
  accessible-names.test.js
  implicit-submit.test.js
  table-headers.test.js
  ownership-tree.test.js
Dockerfile
docker-compose.yml
```
