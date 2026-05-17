# Instagram Chat Capture

[English](#english) | [中文](#中文)

**Install from Greasy Fork:** [https://greasyfork.org/scripts/XXXXX](https://greasyfork.org/scripts/XXXXX)

---

<a id="中文"></a>

## 中文

一个浏览器端的 Instagram DM 聊天记录实时捕捉工具。粘贴到控制台即可运行，通过悬浮面板实时展示捕获进度，支持选择性剔除、复制和下载。

同时也是一个**数据结构练手项目**——用真实场景演示 WeakSet、Map、有序数组重建等结构如何协作解决实际问题。

### 功能

- 实时捕获：MutationObserver 监听 DOM 变化，滚动即捕获
- 可选剔除：每条消息带 checkbox，取消勾选即排除在导出之外
- 四种导出：复制 JSON / 复制纯文本 / 下载 .json / 下载 .txt
- 悬浮面板：可拖拽、可最小化，不会被误关
- 双向滚动：向上翻历史、向下翻新消息，都能正确排序
- 真实重复保留：相同文本的不同消息不会被错误去重

### 使用方式

1. 打开 Instagram 网页版，进入某个 DM 对话
2. 打开浏览器开发者工具（F12）→ Console
3. 粘贴 `chat-capture.js` 的全部内容，回车
4. 右上角出现悬浮面板，滚动聊天即可自动捕获
5. 取消勾选不需要的消息
6. 点击对应按钮导出

控制台 API：

```javascript
chatCapture.scan()      // 手动触发一次扫描
chatCapture.getData()   // 获取过滤后的数据数组
chatCapture.getAll()    // 获取全部数据（含被剔除的）
chatCapture.getCount()  // 当前捕获总条数
chatCapture.stop()      // 停止监听
```

### 数据结构设计

#### 1. WeakSet\<Node\> —— 节点级去重

```
capturedNodes: WeakSet<HTMLElement>
```

**为什么用 WeakSet 而不是 Set\<string\>？**

核心矛盾：用户可能连发两条一模一样的「哈哈」，它们是不同的消息，必须都保留。但同一个 DOM 节点被反复扫描时，不能重复记录。

解决方案：用 DOM 节点本身（引用）做唯一标识，而非文本内容。

```
消息A "哈哈" → DOM Node #1 → WeakSet 记录 Node #1 ✓
消息B "哈哈" → DOM Node #2 → WeakSet 记录 Node #2 ✓（不同节点，正确保留）
再次扫描   → DOM Node #1 → WeakSet 已存在，跳过 ✓（同一节点，正确去重）
```

**为什么是 Weak？** 虚拟滚动会销毁滚出视口的 DOM 节点。WeakSet 持有弱引用，节点被 GC 回收后自动从集合中消失，不会内存泄漏。

#### 2. Map\<Node, number\> —— 位置索引映射

```
positionMap: Map<HTMLElement, number>
```

每次扫描时，对当前 DOM 中所有消息容器建立「节点 → 位置索引」的映射。这是一个临时结构，用于 O(1) 查找任意节点的当前位置。

```
DOM 快照: [Node_A, Node_B, Node_C, Node_D]
positionMap: { Node_A→0, Node_B→1, Node_C→2, Node_D→3 }
```

#### 3. 有序数组 + 重建排序 —— 处理双向插入

```
orderedLog: Array<{ node, sender, text, domIndex }>
```

**问题：** 向上翻滚时新消息出现在 DOM 前面，向下翻时出现在后面。简单的 push 无法保证顺序。

**方案：rebuildOrder**

每次有新消息进入时，重新读取所有已知节点在当前 DOM 快照中的实际位置，然后对整个数组排序：

```
第一次扫描（屏幕中间）:
  orderedLog: [msg_50, msg_51, msg_52]  (domIndex: 0,1,2)

向上翻滚，DOM 顶部出现新节点:
  当前 DOM: [msg_48, msg_49, msg_50, msg_51, msg_52]
  新增: msg_48(idx:0), msg_49(idx:1)
  已有节点重新标记: msg_50(idx:2), msg_51(idx:3), msg_52(idx:4)
  排序后 orderedLog: [msg_48, msg_49, msg_50, msg_51, msg_52] ✓

向下翻滚，DOM 底部出现新节点:
  新增: msg_53(idx:5)
  排序后 orderedLog: [..., msg_52, msg_53] ✓
```

对于已被虚拟滚动回收的节点（不在当前 DOM 中），保留它们上次记录的 domIndex。由于聊天是线性时间序列，历史位置关系不会改变，排序结果依然正确。

#### 4. Set\<number\> —— 剔除索引集合

```
excluded: Set<number>
```

用户通过 checkbox 取消勾选的消息，其在 orderedLog 中的索引被加入 excluded。导出时过滤掉这些索引对应的条目。

选择 Set 而非数组的原因：`has()` 查找是 O(1)，导出时对每条消息做一次判断，总体 O(m)。

#### 5. MutationObserver + 防抖 —— 事件驱动

```
observer → DOM 变化 → 300ms 防抖 → scan()
```

不用定时器轮询，不用监听滚动事件（Instagram 的滚动容器不是 document）。直接观察 DOM 子树变化，有新节点插入就触发扫描。防抖避免虚拟滚动批量更新时重复扫描。

#### 6. 导出：三层 Fallback + 文件下载

```
复制路径:
  navigator.clipboard.writeText()  →  成功则结束
          ↓ 失败
  document.execCommand('copy')     →  成功则结束
          ↓ 失败
  window._chatExportData = json    →  用户手动 copy()

下载路径:
  new Blob() → URL.createObjectURL() → <a>.click() → 自动下载
```

### 数据结构协作流程

```
┌─────────────────────────────────────────────────┐
│              MutationObserver                     │
│         (监听 DOM childList 变化)                  │
└──────────────────────┬──────────────────────────┘
                       │ 触发 (防抖 300ms)
                       ▼
┌─────────────────────────────────────────────────┐
│                   scan()                         │
│                                                  │
│  1. querySelectorAll 获取当前所有消息节点          │
│  2. 逐个检查 WeakSet → 跳过已处理 / 记录新节点    │
│  3. 新节点 push 进 orderedLog                     │
│  4. 调用 rebuildOrder()                          │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│              rebuildOrder()                       │
│                                                  │
│  1. 建立 Map<Node, index> 位置映射               │
│  2. 更新 orderedLog 中每个条目的 domIndex         │
│  3. Array.sort() 按 domIndex 升序                │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│         renderList() + 导出                       │
│                                                  │
│  渲染时: orderedLog 逐条生成 checkbox + 文本      │
│  导出时: 过滤 excluded Set → JSON / TXT          │
└─────────────────────────────────────────────────┘
```

### 复杂度分析

| 操作 | 时间复杂度 | 说明 |
|------|-----------|------|
| 单次扫描 | O(n) | n = 当前 DOM 中的消息节点数 |
| WeakSet 查找 | O(1) | 哈希结构 |
| Map 构建 | O(n) | 遍历当前 DOM 节点 |
| rebuildOrder | O(m log m) | m = 累计捕获的消息总数 |
| excluded 判断 | O(1) | Set.has() |
| 导出 | O(m) | 线性遍历 + 过滤 |
| renderList | O(m) | 重建 DOM 列表 |

### 局限性

- 依赖 Instagram 当前的 DOM 结构（class 名 `x5slmwz` / `x88qbow`），页面改版后需要更新选择器
- 虚拟滚动回收的节点如果被 GC，WeakSet 中的记录会消失——但不影响已存入 orderedLog 的数据
- 需要用户手动滚动完整个对话才能拿到全部记录

---

<a id="english"></a>

## English

A browser-based real-time Instagram DM chat capture tool. Paste into the console to run, with a floating panel showing capture progress in real time. Supports selective exclusion, clipboard copy, and file download.

Also a **data structure practice project** — demonstrating how WeakSet, Map, sorted arrays, and Set work together to solve real-world problems.

### Features

- Real-time capture: MutationObserver watches DOM changes, captures on scroll
- Selective exclusion: Each message has a checkbox, uncheck to exclude from export
- Four export modes: Copy JSON / Copy plain text / Download .json / Download .txt
- Floating panel: Draggable, minimizable, cannot be accidentally destroyed
- Bidirectional scroll: Scrolling up for history or down for new messages both sort correctly
- True duplicate preservation: Identical text from different messages won't be incorrectly deduplicated

### Usage

1. Open Instagram web, enter a DM conversation
2. Open DevTools (F12) → Console
3. Paste the entire content of `chat-capture.js`, press Enter
4. A floating panel appears at top-right, scroll the chat to auto-capture
5. Uncheck messages you don't need
6. Click the corresponding button to export

Console API:

```javascript
chatCapture.scan()      // Manually trigger a scan
chatCapture.getData()   // Get filtered data array
chatCapture.getAll()    // Get all data (including excluded)
chatCapture.getCount()  // Total captured count
chatCapture.stop()      // Stop observing
```

### Data Structure Design

#### 1. WeakSet\<Node\> — Node-level Deduplication

```
capturedNodes: WeakSet<HTMLElement>
```

**Why WeakSet instead of Set\<string\>?**

The core conflict: A user might send two identical "haha" messages — they are different messages and must both be preserved. But the same DOM node scanned repeatedly must not be recorded twice.

Solution: Use the DOM node reference itself as the unique identifier, not text content.

```
Message A "haha" → DOM Node #1 → WeakSet records Node #1 ✓
Message B "haha" → DOM Node #2 → WeakSet records Node #2 ✓ (different node, correctly kept)
Re-scan        → DOM Node #1 → WeakSet already has it, skip ✓ (same node, correctly deduped)
```

**Why Weak?** Virtual scrolling destroys DOM nodes that leave the viewport. WeakSet holds weak references — when a node is GC'd, it automatically disappears from the set. No memory leaks.

#### 2. Map\<Node, number\> — Position Index Mapping

```
positionMap: Map<HTMLElement, number>
```

On each scan, builds a "node → position index" mapping for all message containers currently in the DOM. A temporary structure enabling O(1) position lookup for any node.

```
DOM snapshot: [Node_A, Node_B, Node_C, Node_D]
positionMap: { Node_A→0, Node_B→1, Node_C→2, Node_D→3 }
```

#### 3. Sorted Array + Rebuild — Handling Bidirectional Insertion

```
orderedLog: Array<{ node, sender, text, domIndex }>
```

**Problem:** Scrolling up inserts new messages at the top of the DOM; scrolling down inserts at the bottom. A simple push cannot guarantee order.

**Solution: rebuildOrder**

Whenever new messages arrive, re-read the actual position of all known nodes in the current DOM snapshot, then sort the entire array:

```
First scan (middle of screen):
  orderedLog: [msg_50, msg_51, msg_52]  (domIndex: 0,1,2)

Scroll up, new nodes appear at DOM top:
  Current DOM: [msg_48, msg_49, msg_50, msg_51, msg_52]
  New: msg_48(idx:0), msg_49(idx:1)
  Existing re-indexed: msg_50(idx:2), msg_51(idx:3), msg_52(idx:4)
  After sort: [msg_48, msg_49, msg_50, msg_51, msg_52] ✓

Scroll down, new nodes appear at DOM bottom:
  New: msg_53(idx:5)
  After sort: [..., msg_52, msg_53] ✓
```

For nodes already recycled by virtual scrolling (no longer in DOM), their last recorded domIndex is preserved. Since chat is a linear time series, historical position relationships don't change — sort results remain correct.

#### 4. Set\<number\> — Exclusion Index Set

```
excluded: Set<number>
```

Messages unchecked by the user have their orderedLog index added to excluded. Export filters out entries at these indices.

Why Set over Array: `has()` lookup is O(1). During export, one check per message, O(m) total.

#### 5. MutationObserver + Debounce — Event-driven

```
observer → DOM mutation → 300ms debounce → scan()
```

No polling timers, no scroll event listeners (Instagram's scroll container isn't document). Directly observes DOM subtree changes — triggers scan when new nodes are inserted. Debounce prevents redundant scans during virtual scrolling batch updates.

#### 6. Export: Triple Fallback + File Download

```
Copy path:
  navigator.clipboard.writeText()  →  done if success
          ↓ fail
  document.execCommand('copy')     →  done if success
          ↓ fail
  window._chatExportData = json    →  user manually copy()

Download path:
  new Blob() → URL.createObjectURL() → <a>.click() → auto download
```

### Architecture Flow

```
┌─────────────────────────────────────────────────┐
│              MutationObserver                     │
│       (watches DOM childList changes)            │
└──────────────────────┬──────────────────────────┘
                       │ fires (debounced 300ms)
                       ▼
┌─────────────────────────────────────────────────┐
│                   scan()                         │
│                                                  │
│  1. querySelectorAll for all message nodes       │
│  2. Check WeakSet → skip processed / record new  │
│  3. Push new nodes into orderedLog               │
│  4. Call rebuildOrder()                           │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│              rebuildOrder()                       │
│                                                  │
│  1. Build Map<Node, index> position mapping      │
│  2. Update domIndex for each orderedLog entry    │
│  3. Array.sort() by domIndex ascending           │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│         renderList() + Export                     │
│                                                  │
│  Render: orderedLog → checkbox + text per entry  │
│  Export: filter by excluded Set → JSON / TXT     │
└─────────────────────────────────────────────────┘
```

### Complexity Analysis

| Operation | Time Complexity | Notes |
|-----------|----------------|-------|
| Single scan | O(n) | n = message nodes currently in DOM |
| WeakSet lookup | O(1) | Hash structure |
| Map construction | O(n) | Iterate current DOM nodes |
| rebuildOrder | O(m log m) | m = total captured messages |
| excluded check | O(1) | Set.has() |
| Export | O(m) | Linear traversal + filter |
| renderList | O(m) | Rebuild DOM list |

### Limitations

- Depends on Instagram's current DOM structure (class names `x5slmwz` / `x88qbow`), needs selector updates after page redesigns
- Nodes recycled by virtual scrolling may be GC'd from WeakSet — but data already in orderedLog is unaffected
- Requires manual scrolling through the entire conversation to capture all messages

## License

MIT
