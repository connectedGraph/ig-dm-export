# Instagram Chat Capture

一个浏览器端的 Instagram DM 聊天记录实时捕捉工具。粘贴到控制台即可运行，通过悬浮面板实时展示捕获进度，支持导出为 JSON。

同时也是一个**数据结构练手项目**——用真实场景演示 WeakSet、Map、有序数组重建等结构如何协作解决实际问题。

## 使用方式

1. 打开 Instagram 网页版，进入某个 DM 对话
2. 打开浏览器开发者工具（F12）→ Console
3. 粘贴 `chat-capture.js` 的全部内容，回车
4. 右上角出现悬浮面板，滚动聊天即可自动捕获
5. 点击「导出」按钮，JSON 数据复制到剪贴板

控制台 API：

```javascript
chatCapture.scan()      // 手动触发一次扫描
chatCapture.export()    // 导出并复制
chatCapture.getData()   // 获取数据数组
chatCapture.getCount()  // 当前捕获条数
chatCapture.stop()      // 停止监听
```

## 它解决了什么问题

Instagram 网页版的 DM 使用虚拟滚动——DOM 中只保留当前可视区域附近的消息节点，滚过去的会被销毁。这意味着：

- 你无法一次性拿到所有聊天记录
- 向上翻滚时，新消息从 DOM 顶部插入
- 向下翻滚时，新消息从 DOM 底部插入
- 用户可能真的连发了多条相同内容的消息

传统的「用文本内容去重」方案在这里会丢数据。

## 数据结构设计

### 1. WeakSet\<Node\> —— 节点级去重

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

### 2. Map\<Node, number\> —— 位置索引映射

```
positionMap: Map<HTMLElement, number>
```

每次扫描时，对当前 DOM 中所有消息容器建立「节点 → 位置索引」的映射。这是一个临时结构，用于 O(1) 查找任意节点的当前位置。

```
DOM 快照: [Node_A, Node_B, Node_C, Node_D]
positionMap: { Node_A→0, Node_B→1, Node_C→2, Node_D→3 }
```

### 3. 有序数组 + 重建排序 —— 处理双向插入

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

**对于已被虚拟滚动回收的节点**（不在当前 DOM 中），保留它们上次记录的 domIndex。由于聊天是线性时间序列，历史位置关系不会改变，排序结果依然正确。

### 4. MutationObserver + 防抖 —— 事件驱动

```
observer → DOM 变化 → 300ms 防抖 → scan()
```

不用定时器轮询，不用监听滚动事件（Instagram 的滚动容器不是 document）。直接观察 DOM 子树变化，有新节点插入就触发扫描。防抖避免虚拟滚动批量更新时重复扫描。

### 5. 导出：三层 Fallback

```
navigator.clipboard.writeText()  →  成功则结束
        ↓ 失败
document.execCommand('copy')     →  成功则结束
        ↓ 失败
window._chatExportData = json    →  用户手动 copy()
```

浏览器安全策略对剪贴板 API 限制各不相同，三层兜底确保总能拿到数据。

## 数据结构协作流程

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
│            orderedLog (有序结果)                   │
│                                                  │
│  导出时 → map 为 [{sender, text}, ...]           │
│         → JSON.stringify                         │
│         → clipboard / window 挂载                │
└─────────────────────────────────────────────────┘
```

## 复杂度分析

| 操作 | 时间复杂度 | 说明 |
|------|-----------|------|
| 单次扫描 | O(n) | n = 当前 DOM 中的消息节点数 |
| WeakSet 查找 | O(1) | 哈希结构 |
| Map 构建 | O(n) | 遍历当前 DOM 节点 |
| rebuildOrder | O(m log m) | m = 累计捕获的消息总数 |
| 导出 | O(m) | 线性遍历 |

实际使用中，单次对话通常在几百到几千条消息，排序开销可忽略。

## 局限性

- 依赖 Instagram 当前的 DOM 结构（class 名 `x5slmwz` / `x88qbow`），页面改版后需要更新选择器
- 虚拟滚动回收的节点如果被 GC，WeakSet 中的记录会消失——但这不影响已经存入 orderedLog 的数据
- 需要用户手动滚动完整个对话才能拿到全部记录

## License

MIT
