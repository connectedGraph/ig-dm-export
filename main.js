(function() {
    'use strict';

    // ============================================================
    // Chat Capture - Instagram DM 实时聊天记录捕捉器
    // 特性：
    //   1. MutationObserver 实时监听，无需手动触发
    //   2. 用 WeakSet<DOM Node> 做去重，允许相同文本的不同消息共存
    //   3. 按 DOM 顺序维护有序数组，向上/向下翻滚都能正确插入
    //   4. 悬浮面板：可选中剔除、最小化、拖拽
    //   5. 导出：复制JSON / 复制纯文本 / 下载JSON / 下载TXT
    // ============================================================

    // --- 核心数据结构 ---
    var capturedNodes = new WeakSet();
    var orderedLog = [];
    // excluded: Set<index> 记录被用户剔除的条目索引
    var excluded = new Set();

    function getMessageSelector() {
        return 'div[role="presentation"]';
    }

    function parseSender(container) {
        if (container.classList.contains('x5slmwz')) return '我';
        if (container.classList.contains('x88qbow')) return '对方';
        return null;
    }

    // 根据当前 DOM 快照重建消息顺序
    function rebuildOrder(allContainers) {
        var positionMap = new Map();
        for (var i = 0; i < allContainers.length; i++) {
            positionMap.set(allContainers[i], i);
        }
        orderedLog.forEach(function(entry) {
            var pos = positionMap.get(entry.node);
            if (pos !== undefined) {
                entry.domIndex = pos;
            }
        });
        orderedLog.sort(function(a, b) {
            return a.domIndex - b.domIndex;
        });
    }

    // 扫描
    function scan() {
        var allContainers = document.querySelectorAll(getMessageSelector());
        var newMessages = [];

        for (var i = 0; i < allContainers.length; i++) {
            var container = allContainers[i];
            if (capturedNodes.has(container)) continue;

            var text = container.innerText ? container.innerText.trim() : '';
            if (!text) continue;

            var sender = parseSender(container);
            if (!sender) continue;

            capturedNodes.add(container);
            var entry = {
                node: container,
                sender: sender,
                text: text,
                domIndex: i
            };
            orderedLog.push(entry);
            newMessages.push(entry);
        }

        if (newMessages.length === 0) return 0;

        rebuildOrder(allContainers);
        renderList();
        updateCount();
        return newMessages.length;
    }

    // --- 面板 UI ---
    var panel = document.createElement('div');
    panel.id = '_chat_capture_panel';
    panel.style.cssText = [
        'position:fixed', 'top:10px', 'right:10px',
        'width:420px', 'height:500px',
        'background:#1a1a2e', 'color:#0ff',
        'font-size:12px', 'font-family:Consolas,monospace',
        'z-index:2147483647', 'border-radius:10px',
        'display:flex', 'flex-direction:column',
        'box-shadow:0 4px 20px rgba(0,255,255,0.2)',
        'border:1px solid #0ff3'
    ].join(';');

    // Header
    var header = document.createElement('div');
    header.style.cssText = [
        'padding:10px 14px', 'background:#16213e',
        'border-radius:10px 10px 0 0',
        'display:flex', 'justify-content:space-between',
        'align-items:center', 'cursor:move',
        'border-bottom:1px solid #0ff3'
    ].join(';');

    var titleSpan = document.createElement('span');
    titleSpan.innerHTML = '&#x1F4E1; Chat Capture | <b id="_cc_num">0</b> msgs';
    titleSpan.style.color = '#0ff';

    var minBtn = document.createElement('button');
    minBtn.textContent = '—';
    minBtn.title = '最小化';
    minBtn.style.cssText = 'background:#ff0;color:#000;border:none;padding:3px 8px;border-radius:4px;cursor:pointer;font-weight:bold';

    header.appendChild(titleSpan);
    header.appendChild(minBtn);

    // Toolbar
    var toolbar = document.createElement('div');
    toolbar.style.cssText = 'padding:8px 14px;background:#16213e;display:flex;gap:6px;flex-wrap:wrap;border-bottom:1px solid #0ff3';

    var btnStyle = 'background:#333;color:#0ff;border:1px solid #0ff5;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:11px';

    var btnCopyJSON = document.createElement('button');
    btnCopyJSON.textContent = '复制 JSON';
    btnCopyJSON.style.cssText = btnStyle;

    var btnCopyTXT = document.createElement('button');
    btnCopyTXT.textContent = '复制 TXT';
    btnCopyTXT.style.cssText = btnStyle;

    var btnDownJSON = document.createElement('button');
    btnDownJSON.textContent = '下载 JSON';
    btnDownJSON.style.cssText = btnStyle;

    var btnDownTXT = document.createElement('button');
    btnDownTXT.textContent = '下载 TXT';
    btnDownTXT.style.cssText = btnStyle;

    var btnSelectAll = document.createElement('button');
    btnSelectAll.textContent = '全选';
    btnSelectAll.style.cssText = btnStyle;

    var btnDeselectAll = document.createElement('button');
    btnDeselectAll.textContent = '全不选';
    btnDeselectAll.style.cssText = btnStyle;

    toolbar.appendChild(btnCopyJSON);
    toolbar.appendChild(btnCopyTXT);
    toolbar.appendChild(btnDownJSON);
    toolbar.appendChild(btnDownTXT);
    toolbar.appendChild(btnSelectAll);
    toolbar.appendChild(btnDeselectAll);

    // Body (消息列表)
    var body = document.createElement('div');
    body.style.cssText = [
        'flex:1', 'overflow-y:auto', 'padding:8px 10px',
        'word-break:break-all', 'line-height:1.5'
    ].join(';');

    // Status bar
    var statusBar = document.createElement('div');
    statusBar.style.cssText = 'padding:6px 14px;background:#16213e;border-radius:0 0 10px 10px;color:#0f0;font-size:11px;border-top:1px solid #0ff3';
    statusBar.textContent = '就绪';

    panel.appendChild(header);
    panel.appendChild(toolbar);
    panel.appendChild(body);
    panel.appendChild(statusBar);
    document.body.appendChild(panel);

    function setStatus(text) {
        statusBar.textContent = text;
    }

    function updateCount() {
        var el = document.getElementById('_cc_num');
        if (el) el.textContent = orderedLog.length;
    }

    // --- 渲染消息列表（带 checkbox）---
    function renderList() {
        body.innerHTML = '';
        orderedLog.forEach(function(entry, idx) {
            var row = document.createElement('label');
            row.style.cssText = 'display:flex;align-items:flex-start;gap:6px;padding:4px 0;border-bottom:1px solid #ffffff10;cursor:pointer';

            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !excluded.has(idx);
            cb.style.cssText = 'margin-top:2px;flex-shrink:0';
            cb.dataset.idx = idx;
            cb.addEventListener('change', function() {
                var i = parseInt(this.dataset.idx);
                if (this.checked) {
                    excluded.delete(i);
                } else {
                    excluded.add(i);
                }
                updateCount();
            });

            var label = document.createElement('span');
            label.style.cssText = 'color:' + (entry.sender === '我' ? '#7df' : '#fd7');
            label.textContent = '[' + entry.sender + '] ' + entry.text.substring(0, 150);

            row.appendChild(cb);
            row.appendChild(label);
            body.appendChild(row);
        });
        body.scrollTop = body.scrollHeight;
    }

    // --- 获取过滤后的数据 ---
    function getFilteredData() {
        var result = [];
        orderedLog.forEach(function(entry, idx) {
            if (!excluded.has(idx)) {
                result.push({ sender: entry.sender, text: entry.text });
            }
        });
        return result;
    }

    function toJSON() {
        return JSON.stringify(getFilteredData(), null, 2);
    }

    function toPlainText() {
        return getFilteredData().map(function(msg) {
            return msg.sender + ': ' + msg.text;
        }).join('\n\n');
    }

    // --- 复制到剪贴板 ---
    function copyToClipboard(text, label) {
        window._chatExportData = text;

        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function() {
                setStatus('✅ ' + label + ' 已复制到剪贴板 (' + getFilteredData().length + '条)');
            }, function() {
                fallbackCopy(text, label);
            });
        } else {
            fallbackCopy(text, label);
        }
    }

    function fallbackCopy(text, label) {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta);
        ta.select();
        try {
            document.execCommand('copy');
            setStatus('✅ ' + label + ' 已复制 (fallback)');
        } catch(e) {
            setStatus('⚠️ 复制失败，数据已存入 window._chatExportData');
        }
        document.body.removeChild(ta);
    }

    // --- 下载文件 ---
    function downloadFile(content, filename, mime) {
        var blob = new Blob([content], { type: mime });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(function() {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
        setStatus('✅ 已下载 ' + filename + ' (' + getFilteredData().length + '条)');
    }

    // --- 按钮事件 ---
    btnCopyJSON.onclick = function() { copyToClipboard(toJSON(), 'JSON'); };
    btnCopyTXT.onclick = function() { copyToClipboard(toPlainText(), 'TXT'); };
    btnDownJSON.onclick = function() {
        var ts = new Date().toISOString().slice(0,10);
        downloadFile(toJSON(), 'chat_' + ts + '.json', 'application/json');
    };
    btnDownTXT.onclick = function() {
        var ts = new Date().toISOString().slice(0,10);
        downloadFile(toPlainText(), 'chat_' + ts + '.txt', 'text/plain');
    };
    btnSelectAll.onclick = function() {
        excluded.clear();
        renderList();
        setStatus('已全选');
    };
    btnDeselectAll.onclick = function() {
        orderedLog.forEach(function(_, idx) { excluded.add(idx); });
        renderList();
        setStatus('已全不选');
    };

    // --- 最小化/展开 ---
    var minimized = false;
    minBtn.onclick = function() {
        minimized = !minimized;
        if (minimized) {
            toolbar.style.display = 'none';
            body.style.display = 'none';
            statusBar.style.display = 'none';
            panel.style.height = 'auto';
            panel.style.width = '220px';
            minBtn.textContent = '+';
            minBtn.title = '展开';
        } else {
            toolbar.style.display = '';
            body.style.display = '';
            statusBar.style.display = '';
            panel.style.height = '500px';
            panel.style.width = '420px';
            minBtn.textContent = '—';
            minBtn.title = '最小化';
            body.scrollTop = body.scrollHeight;
        }
    };

    // --- 拖拽 ---
    var dragging = false, dx = 0, dy = 0;
    header.addEventListener('mousedown', function(e) {
        if (e.target.tagName === 'BUTTON') return;
        dragging = true;
        dx = e.clientX - panel.offsetLeft;
        dy = e.clientY - panel.offsetTop;
        e.preventDefault();
    });
    document.addEventListener('mousemove', function(e) {
        if (!dragging) return;
        panel.style.left = (e.clientX - dx) + 'px';
        panel.style.right = 'auto';
        panel.style.top = (e.clientY - dy) + 'px';
    });
    document.addEventListener('mouseup', function() {
        dragging = false;
    });

    // --- MutationObserver ---
    var observer = new MutationObserver(function() {
        clearTimeout(observer._debounce);
        observer._debounce = setTimeout(scan, 300);
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    // 首次扫描
    scan();
    setStatus('🟢 启动完成，滚动聊天自动捕获');

    // 全局 API
    window.chatCapture = {
        scan: scan,
        getData: getFilteredData,
        getAll: function() { return orderedLog.map(function(e) { return { sender: e.sender, text: e.text }; }); },
        getCount: function() { return orderedLog.length; },
        stop: function() {
            observer.disconnect();
            setStatus('🔴 已停止监听');
        }
    };

})();
