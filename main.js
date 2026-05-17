(function() {
    'use strict';

    // ============================================================
    // Chat Capture - Instagram DM 实时聊天记录捕捉器 v3
    //
    // 发送方判断（多策略组合）：
    //   1. 有头像链接 a[aria-label^="Open the profile page"] → 对方
    //   2. role="presentation" 含 class x88qbow → 对方
    //   3. role="presentation" 含 class x5slmwz → 我
    //   4. 有 role="presentation" 但无上述特征 → 我（fallback）
    //
    // 虚拟滚动适配：
    //   只处理 opacity:1 的可见消息，忽略 opacity:0 的占位符
    //   容器变化时自动检测会话切换
    // ============================================================

    var capturedNodes = new WeakSet();
    var orderedLog = [];
    var excluded = new Set();
    var chatContainer = null;
    var paused = false;

    // --- 定位聊天列表容器 ---
    function findChatContainer() {
        // 策略：从 role="group" 往上找 children 最多的那层
        var groups = document.querySelectorAll('[role="group"][tabindex="-1"]');
        if (groups.length === 0) return null;
        // 取第一个 group 的祖先
        var p = groups[0];
        var best = null;
        var bestCount = 0;
        for (var i = 0; i < 10; i++) {
            if (!p.parentElement) break;
            p = p.parentElement;
            if (p.children.length > bestCount) {
                bestCount = p.children.length;
                best = p;
            }
        }
        return (bestCount > 3) ? best : null;
    }

    // --- 获取可见消息元素 ---
    function getVisibleMessages() {
        if (!chatContainer) return [];
        var messages = [];
        var children = chatContainer.children;
        for (var i = 0; i < children.length; i++) {
            var child = children[i];
            // 虚拟滚动：只处理 opacity:1 的（可见的）
            var inner = child.querySelector('.x13dflua');
            if (inner) {
                var opacity = inner.style.opacity;
                if (opacity === '0') continue;
            }
            // 必须包含 role="group" 才是消息（排除加载动画等）
            if (!child.querySelector('[role="group"]')) continue;
            messages.push({ element: child, containerIndex: i });
        }
        return messages;
    }

    // --- 判断发送方（多策略组合）---
    function parseSender(element) {
        // 策略1：头像链接（群聊或显示头像的私聊）
        var profileLink = element.querySelector('a[aria-label^="Open the profile page"]');
        if (profileLink) return '对方';

        // 策略2：presentation 元素的 class 名
        var presentation = element.querySelector('[role="presentation"]');
        if (presentation) {
            var cls = presentation.className;
            if (cls.indexOf('x88qbow') !== -1) return '对方';
            if (cls.indexOf('x5slmwz') !== -1) return '我';
            // fallback：有 presentation 但没有已知 class，默认为我
            return '我';
        }

        // 策略3：没有 presentation 也没有头像链接
        // 视频分享/图片等多媒体消息可能没有 presentation
        // 判断依据：对方消息一定有头像链接或 x88qbow，没有的就是我的
        var hasContent = element.querySelector('[role="group"]');
        if (hasContent) return '我';

        return null;
    }

    // --- 多媒体内容解析 ---
    function parseContent(container) {
        // 语音
        var waveform = container.querySelector('svg[aria-label*="aveform"], svg[aria-label*="波形"]');
        if (waveform) {
            var timer = container.querySelector('[role="timer"]');
            var duration = timer ? timer.textContent.trim() : '?';
            return { type: 'audio', text: '[语音消息 ' + duration + ']', media: null };
        }

        // 视频/Reels
        var reelsIcon = container.querySelector('svg[aria-label="片段"], svg[aria-label="Reels"], svg[aria-label*="eel"]');
        if (reelsIcon) {
            var link = container.querySelector('a[href^="/"]:not([aria-label])');
            var img = container.querySelector('img:not([alt="user-profile-picture"])');
            var author = '';
            if (link) {
                var match = link.getAttribute('href').match(/^\/([^/]+)\/?$/);
                if (match) author = '@' + match[1];
            }
            var thumbSrc = img ? img.getAttribute('src') : null;
            return { type: 'shared_video', text: '[分享视频' + (author ? ' from ' + author : '') + ']', media: thumbSrc };
        }

        // 图片
        var images = container.querySelectorAll('img');
        var contentImages = [];
        for (var i = 0; i < images.length; i++) {
            var img = images[i];
            if (img.getAttribute('alt') === 'user-profile-picture') continue;
            var h = parseInt(img.getAttribute('height') || '0');
            var w = parseInt(img.getAttribute('width') || '0');
            if (h > 50 && w > 50) {
                contentImages.push(img.getAttribute('src'));
            }
        }
        if (contentImages.length > 0) {
            var textContent = getTextOnly(container);
            if (textContent) {
                return { type: 'image_with_text', text: textContent + ' [图片x' + contentImages.length + ']', media: contentImages };
            }
            return { type: 'image', text: '[图片' + (contentImages.length > 1 ? 'x' + contentImages.length : '') + ']', media: contentImages };
        }

        // 纯文本
        var text = getTextOnly(container) || (container.innerText ? container.innerText.trim() : '');
        return { type: 'text', text: text, media: null };
    }

    function getTextOnly(container) {
        var spans = container.querySelectorAll('span[dir="auto"]');
        var texts = [];
        for (var i = 0; i < spans.length; i++) {
            var span = spans[i];
            // 排除头像链接内的文字
            if (span.closest('a[aria-label^="Open the profile page"]')) continue;
            if (span.closest('a[role="link"]')) continue;
            if (span.closest('[role="button"]')) continue;
            var t = span.textContent.trim();
            if (t && t.length > 0) texts.push(t);
        }
        var unique = [];
        texts.forEach(function(t) {
            if (unique.indexOf(t) === -1) unique.push(t);
        });
        return unique.join(' ');
    }

    // --- 排序 ---
    function rebuildOrder() {
        if (!chatContainer) return;
        var children = chatContainer.children;
        var positionMap = new Map();
        for (var i = 0; i < children.length; i++) {
            positionMap.set(children[i], i);
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

    // --- 会话切换检测 ---
    function checkSessionSwitch() {
        var newContainer = findChatContainer();
        if (!newContainer) return false;
        if (chatContainer && newContainer !== chatContainer) return true;
        return false;
    }

    function showSwitchPrompt() {
        paused = true;
        body.innerHTML = '';
        var prompt = document.createElement('div');
        prompt.style.cssText = 'padding:20px;text-align:center';

        var msg = document.createElement('div');
        msg.style.cssText = 'color:#ff0;font-size:14px;margin-bottom:15px';
        msg.textContent = '检测到新会话';

        var sub = document.createElement('div');
        sub.style.cssText = 'color:#aaa;font-size:11px;margin-bottom:20px';
        sub.textContent = '当前已捕获 ' + orderedLog.length + ' 条消息';

        var btnStart = document.createElement('button');
        btnStart.textContent = '开始捕获新会话';
        btnStart.style.cssText = 'background:#0ff;color:#000;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-weight:bold;font-size:13px;margin-right:10px';

        var btnIgnore = document.createElement('button');
        btnIgnore.textContent = '忽略';
        btnIgnore.style.cssText = 'background:#555;color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:13px';

        var btnExportFirst = document.createElement('button');
        btnExportFirst.textContent = '先导出再切换';
        btnExportFirst.style.cssText = 'background:#333;color:#0ff;border:1px solid #0ff5;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:13px;margin-top:10px;display:block;width:100%';

        btnStart.onclick = function() { startNewSession(); };
        btnIgnore.onclick = function() {
            paused = false;
            renderList();
            setStatus('🟢 继续捕获当前会话');
        };
        btnExportFirst.onclick = function() {
            var ts = new Date().toISOString().slice(0,10);
            downloadFile(toJSON(), 'chat_' + ts + '.json', 'application/json');
            setTimeout(function() { startNewSession(); }, 200);
        };

        prompt.appendChild(msg);
        prompt.appendChild(sub);
        prompt.appendChild(btnStart);
        prompt.appendChild(btnIgnore);
        prompt.appendChild(btnExportFirst);
        body.appendChild(prompt);
        setStatus('⏸️ 已暂停 - 检测到会话切换');
    }

    function startNewSession() {
        capturedNodes = new WeakSet();
        orderedLog = [];
        excluded.clear();
        chatContainer = findChatContainer();
        paused = false;
        scan();
        setStatus('🟢 新会话捕获中');
    }

    // --- 扫描 ---
    function scan() {
        if (paused) return 0;

        if (chatContainer && checkSessionSwitch()) {
            showSwitchPrompt();
            return 0;
        }

        if (!chatContainer) {
            chatContainer = findChatContainer();
            if (!chatContainer) {
                setStatus('⚠️ 未找到聊天容器');
                return 0;
            }
        }

        var visibleMessages = getVisibleMessages();
        var newMessages = [];

        for (var i = 0; i < visibleMessages.length; i++) {
            var item = visibleMessages[i];
            var el = item.element;

            if (capturedNodes.has(el)) continue;

            var sender = parseSender(el);
            if (!sender) continue;

            var content = parseContent(el);
            if (!content.text) continue;

            capturedNodes.add(el);
            var entry = {
                node: el,
                sender: sender,
                type: content.type,
                text: content.text,
                media: content.media,
                domIndex: item.containerIndex
            };
            orderedLog.push(entry);
            newMessages.push(entry);
        }

        if (newMessages.length === 0) return 0;

        rebuildOrder();
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

    var body = document.createElement('div');
    body.style.cssText = [
        'flex:1', 'overflow-y:auto', 'padding:8px 10px',
        'word-break:break-all', 'line-height:1.5'
    ].join(';');

    var statusBar = document.createElement('div');
    statusBar.style.cssText = 'padding:6px 14px;background:#16213e;border-radius:0 0 10px 10px;color:#0f0;font-size:11px;border-top:1px solid #0ff3';
    statusBar.textContent = '就绪';

    panel.appendChild(header);
    panel.appendChild(toolbar);
    panel.appendChild(body);
    panel.appendChild(statusBar);
    document.body.appendChild(panel);

    function setStatus(text) { statusBar.textContent = text; }

    function updateCount() {
        var el = document.getElementById('_cc_num');
        var active = orderedLog.length - excluded.size;
        if (el) el.textContent = active + '/' + orderedLog.length;
    }

    function typeIcon(type) {
        switch(type) {
            case 'audio': return '\u{1F3A4}';
            case 'shared_video': return '\u{1F3AC}';
            case 'image': return '\u{1F5BC}';
            case 'image_with_text': return '\u{1F5BC}';
            default: return '\u{1F4AC}';
        }
    }

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
                if (this.checked) { excluded.delete(i); }
                else { excluded.add(i); }
                updateCount();
            });

            var label = document.createElement('span');
            label.style.cssText = 'color:' + (entry.sender === '我' ? '#7df' : '#fd7');
            label.textContent = typeIcon(entry.type) + ' [' + entry.sender + '] ' + entry.text.substring(0, 150);

            row.appendChild(cb);
            row.appendChild(label);
            body.appendChild(row);
        });
        body.scrollTop = body.scrollHeight;
    }

    // --- 导出 ---
    function getFilteredData() {
        var result = [];
        orderedLog.forEach(function(entry, idx) {
            if (!excluded.has(idx)) {
                var item = { sender: entry.sender, type: entry.type, text: entry.text };
                if (entry.media) item.media = entry.media;
                result.push(item);
            }
        });
        return result;
    }

    function toJSON() { return JSON.stringify(getFilteredData(), null, 2); }

    function toPlainText() {
        return getFilteredData().map(function(msg) {
            return msg.sender + ': ' + msg.text;
        }).join('\n\n');
    }

    function copyToClipboard(text, label) {
        window._chatExportData = text;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function() {
                setStatus('✅ ' + label + ' 已复制 (' + getFilteredData().length + '条)');
            }, function() { fallbackCopy(text, label); });
        } else { fallbackCopy(text, label); }
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
            setStatus('⚠️ 复制失败，数据在 window._chatExportData');
        }
        document.body.removeChild(ta);
    }

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
        setStatus('✅ 已下载 ' + filename);
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
    btnSelectAll.onclick = function() { excluded.clear(); renderList(); updateCount(); setStatus('已全选'); };
    btnDeselectAll.onclick = function() {
        orderedLog.forEach(function(_, idx) { excluded.add(idx); });
        renderList(); updateCount(); setStatus('已全不选');
    };

    // --- 最小化 ---
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
        } else {
            toolbar.style.display = '';
            body.style.display = '';
            statusBar.style.display = '';
            panel.style.height = '500px';
            panel.style.width = '420px';
            minBtn.textContent = '—';
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
    document.addEventListener('mouseup', function() { dragging = false; });

    // --- MutationObserver ---
    var observer = new MutationObserver(function() {
        clearTimeout(observer._debounce);
        observer._debounce = setTimeout(scan, 300);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // 首次扫描
    scan();
    setStatus('🟢 启动完成，滚动聊天自动捕获');

    // 全局 API
    window.chatCapture = {
        scan: scan,
        getData: getFilteredData,
        getAll: function() { return orderedLog.map(function(e) { return { sender: e.sender, type: e.type, text: e.text, media: e.media }; }); },
        getCount: function() { return orderedLog.length; },
        stop: function() { observer.disconnect(); setStatus('🔴 已停止'); },
        reset: function() { startNewSession(); }
    };

})();
