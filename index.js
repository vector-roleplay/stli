// ========================================
// 酒馆联机扩展 v2.9.0
// 服务器: wss://chu.zeabur.app
// 核心改动:
//   - 删除追踪系统，代码瘦身
//   - 内部沙箱渲染器（模仿酒馆助手）
//   - 完整清理酒馆助手痕迹
//   - 等待酒馆助手处理完再捕获
//   - 零延迟保护器
//   - 函数锁防护
// ========================================

import { eventSource, event_types } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';

// ========== 扩展配置 ==========
const extensionName = 'stli';
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// ========== 版本信息 ==========
const CURRENT_VERSION = '2.9.0';

const defaultSettings = {
  serverUrl: 'wss://chu.zeabur.app',
  enabled: true,
  autoReconnect: true
};

// ========== 常量配置 ==========
const SERVER_URL = 'wss://chu.zeabur.app';
const RECONNECT_TIMEOUT = 30 * 60 * 1000;
const STREAM_THROTTLE_MS = 150;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_INTERVAL = 3000;

// ========== 连接状态变量 ==========
let ws = null;
let isConnected = false;
let odId = null;
let userToken = null;
let userName = '';
let reconnectAttempts = 0;
let reconnectTimer = null;
let heartbeatTimer = null;

// ========== 房间状态变量 ==========
let currentRoom = null;
let currentRoomName = '';
let roomUsers = [];
let onlineUsers = [];
let chatMessages = [];
let onlineListExpanded = false;

// ========== 断连类型标记 ==========
let isNormalDisconnect = false;
let isInactiveKick = false;
let isReconnecting = false;

// ========== 发言轮次系统变量 ==========
let turnState = {
  currentSpeaker: null,
  speakerName: null,
  speakerPhase: null,
  remainingTime: 0,
  localReceivedTime: null,
  queue: [],
  isMyTurn: false,
  myPosition: -1
};
let countdownInterval = null;
let isSendBlocked = false;

// ========== 消息同步相关变量 ==========
let processedMsgCache = new Set();
let remoteStreamMap = new Map();
let isGenerating = false;

// ========== DOM 观察器 ==========
let chatObserver = null;

// ========== 远程上下文缓存 ==========
let remoteContextCache = new Map();

// ========== 工具函数 ==========

function log(msg) {
  console.log('[酒馆联机] ' + msg);
}

function toast(type, msg) {
  const t = window.toastr || toastr;
  if (t && t[type]) t[type](msg, '联机');
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatTime(ms) {
  if (!ms || ms <= 0) return '0:00';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
}

function throttle(fn, delay) {
  let lastCall = 0;
  return function(...args) {
    const now = Date.now();
    if (now - lastCall >= delay) {
      lastCall = now;
      fn.apply(this, args);
    }
  };
}

function getChat() {
  const ctx = getContext();
  return ctx.chat || [];
}

function getMessageTimeStamp() {
  if (typeof humanizedDateTime === 'function') {
    return humanizedDateTime();
  }
  return new Date().toLocaleString();
}

// ========================================
// 前端代码检测（与酒馆助手相同逻辑）
// ========================================

function isFrontend(content) {
  if (!content) return false;
  return ['html>', '<head>', '<body'].some(tag => content.includes(tag));
}

// ========================================
// 内部沙箱渲染器（模仿酒馆助手效果）
// ========================================

const InternalRenderer = {
  
  /**
   * 包装为完整的 HTML 文档
   */
  wrapHtmlDocument(content) {
    if (!content) return '';
    const trimmed = content.trim().toLowerCase();
    if (trimmed.startsWith('<!doctype') || trimmed.startsWith('<html')) {
      return content;
    }
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; overflow: hidden; max-width: 100%; }
</style>
</head>
<body>
${content}
</body>
</html>`;
  },
  
  /**
   * 在沙箱内创建渲染结构（模仿酒馆助手但用自己的命名）
   */
  createRenderStructure(preElement, htmlContent, messageId, index) {
    // 创建包装容器（类似 TH-render）
    const container = document.createElement('div');
    container.className = 'mp-render';
    
    // 创建折叠按钮
    const collapseBtn = document.createElement('div');
    collapseBtn.className = 'mp-collapse-button mp-hidden';
    collapseBtn.textContent = '显示前端代码块';
    
    // 克隆并隐藏原始 pre
    const hiddenPre = preElement.cloneNode(true);
    hiddenPre.classList.add('mp-hidden');
    
    // 创建 iframe
    const iframe = document.createElement('iframe');
    iframe.id = 'mp-message--' + messageId + '--' + index;
    iframe.className = 'mp-iframe';
    iframe.setAttribute('loading', 'lazy');
    iframe.setAttribute('frameborder', '0');
    iframe.style.cssText = 'width: 100%; border: none; min-height: 200px; display: block;';
    iframe.srcdoc = this.wrapHtmlDocument(htmlContent);
    
    // 组装结构
    container.appendChild(collapseBtn);
    container.appendChild(hiddenPre);
    container.appendChild(iframe);
    
    // 替换原 pre
    preElement.parentNode.replaceChild(container, preElement);
    
    return container;
  },
  
  /**
   * 在内存沙箱中渲染 HTML
   * @param {string} rawHtml - 原始格式化 HTML
   * @param {number} messageId - 消息ID
   * @returns {string} - 渲染后的完整 HTML（包含 iframe）
   */
  render(rawHtml, messageId = 0) {
    if (!rawHtml) return '';
    
    // 创建内存沙箱（不挂载到 DOM）
    const sandbox = document.createElement('div');
    sandbox.innerHTML = rawHtml;
    
    // 查找所有 pre 标签
    const preTags = sandbox.querySelectorAll('pre');
    let renderIndex = 0;
    
    preTags.forEach(pre => {
      const code = pre.querySelector('code');
      if (!code) return;
      
      // 提取内容（.textContent 自动解码 HTML 实体）
      const content = code.textContent;
      if (!isFrontend(content)) return;
      
      // 在沙箱内创建渲染结构
      this.createRenderStructure(pre, content, messageId, renderIndex);
      renderIndex++;
    });
    
    // 返回渲染后的完整 HTML
    return sandbox.innerHTML;
  },
  
  /**
   * 处理 iframe 加载后的高度调整
   * 需要在 DOM 上调用
   */
  setupIframeAutoHeight(container) {
    if (!container) return;
    
    const iframes = container.querySelectorAll('.mp-iframe');
    iframes.forEach(iframe => {
      iframe.onload = function() {
        try {
          const doc = iframe.contentDocument || iframe.contentWindow.document;
          const height = doc.documentElement.scrollHeight || doc.body.scrollHeight;
          iframe.style.height = Math.max(height, 100) + 'px';
        } catch (e) {
          iframe.style.height = '400px';
        }
      };
      
      // 如果已经加载完成，立即调整
      if (iframe.contentDocument && iframe.contentDocument.readyState === 'complete') {
        iframe.onload();
      }
    });
  }
};

// ========================================
// 清理 HTML - 移除酒馆助手所有痕迹
// ========================================

function cleanHtmlForSync(html) {
  const temp = document.createElement('div');
  temp.innerHTML = html;
  
  // ========== 1. 移除酒馆助手的 iframe ==========
  temp.querySelectorAll('iframe[id^="TH-message--"]').forEach(function(iframe) {
    iframe.remove();
  });
  
  // ========== 2. 移除酒馆助手的折叠按钮 ==========
  temp.querySelectorAll('.TH-collapse-code-block-button').forEach(function(btn) {
    btn.remove();
  });
  
  // ========== 3. 解包酒馆助手的 TH-render 容器 ==========
  temp.querySelectorAll('.TH-render').forEach(function(wrapper) {
    const children = wrapper.querySelectorAll(':scope > :not(iframe)');
    const fragment = document.createDocumentFragment();
    
    children.forEach(function(child) {
      // 移除 hidden! class
      child.classList.remove('hidden!');
      fragment.appendChild(child.cloneNode(true));
    });
    
    wrapper.replaceWith(fragment);
  });
  
  // ========== 4. 移除我们自己的渲染容器（如果有） ==========
  temp.querySelectorAll('.mp-render').forEach(function(wrapper) {
    const pre = wrapper.querySelector('pre');
    if (pre) {
      pre.classList.remove('mp-hidden');
      wrapper.replaceWith(pre);
    } else {
      wrapper.remove();
    }
  });
  
  // ========== 5. 移除我们的 iframe ==========
  temp.querySelectorAll('iframe[id^="mp-message--"]').forEach(function(iframe) {
    iframe.remove();
  });
  
  // ========== 6. 移除我们的折叠按钮 ==========
  temp.querySelectorAll('.mp-collapse-button').forEach(function(btn) {
    btn.remove();
  });
  
  // ========== 7. 清理所有元素的特殊 class ==========
  temp.querySelectorAll('*').forEach(function(el) {
    // 移除 hidden! class
    el.classList.remove('hidden!');
    // 移除 mp-hidden class
    el.classList.remove('mp-hidden');
    // 移除 w-full class（酒馆助手 iframe 的 tailwind class）
    el.classList.remove('w-full');
    
    // 移除所有 TH- 开头的 class
    const classes = Array.from(el.classList);
    classes.forEach(function(cls) {
      if (cls.startsWith('TH-') || cls.startsWith('th-') || cls.startsWith('mp-')) {
        el.classList.remove(cls);
      }
    });
    
    // 移除所有 data-* 属性
    Array.from(el.attributes).forEach(function(attr) {
      if (attr.name.startsWith('data-')) {
        el.removeAttribute(attr.name);
      }
    });
  });
  
  // ========== 8. 移除代码复制按钮 ==========
  temp.querySelectorAll('.code-copy, .fa-copy').forEach(function(btn) {
    btn.remove();
  });
  
  // ========== 9. 移除 hljs 行号 ==========
  temp.querySelectorAll('.hljs-ln, .hljs-line-numbers').forEach(function(el) {
    el.remove();
  });
  
  // ========== 10. 清理 blob URL 和本地 URL ==========
  temp.querySelectorAll('*').forEach(function(el) {
    ['src', 'href', 'data', 'poster'].forEach(function(attr) {
      if (el.hasAttribute(attr)) {
        const val = el.getAttribute(attr);
        if (val && (
          val.startsWith('blob:') || 
          val.includes('://localhost') || 
          val.includes('://127.0.0.1') || 
          val.includes('://192.168.')
        )) {
          el.removeAttribute(attr);
        }
      }
    });
    
    // 清理 style 中的 URL
    if (el.hasAttribute('style')) {
      let style = el.getAttribute('style');
      style = style.replace(/url\s*\(\s*["']?blob:[^)]+["']?\s*\)/gi, '');
      style = style.replace(/url\s*\(\s*["']?https?:\/\/(localhost|127\.0\.0\.1|192\.168\.[^)]+)["']?\s*\)/gi, '');
      if (style.trim()) {
        el.setAttribute('style', style);
      } else {
        el.removeAttribute('style');
      }
    }
  });
  
  // ========== 11. 移除危险标签 ==========
  temp.querySelectorAll('base, object, embed, script').forEach(function(el) {
    el.remove();
  });
  
  // ========== 12. 清理空的 class 和 style 属性 ==========
  temp.querySelectorAll('*').forEach(function(el) {
    if (el.hasAttribute('class') && !el.className.trim()) {
      el.removeAttribute('class');
    }
    if (el.hasAttribute('style') && !el.getAttribute('style').trim()) {
      el.removeAttribute('style');
    }
  });
  
  return temp.innerHTML;
}

/**
 * 检测是否有酒馆助手痕迹
 */
function hasTavernHelperTraces(element) {
  if (!element) return false;
  return element.querySelector('.TH-render, .TH-collapse-code-block-button, iframe[id^="TH-message--"]') !== null;
}

/**
 * 检测是否有我们的渲染痕迹
 */
function hasOurRenderTraces(element) {
  if (!element) return false;
  return element.querySelector('.mp-render, iframe[id^="mp-message--"]') !== null;
}

// ========================================
// 远程消息保护器（零延迟）
// ========================================

const RemoteMessageGuard = {
  protected: new Map(),
  
  /**
   * 保护一条消息
   * @param {number} messageId 
   * @param {string} renderedHtml - 已渲染完成的 HTML
   */
  protect(messageId, renderedHtml) {
    this.unprotect(messageId);
    
    const element = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
    if (!element) {
      log('保护器：找不到元素 #' + messageId);
      return;
    }
    
    const guard = {
      html: renderedHtml,
      isRestoring: false,
      observer: null
    };
    
    const self = this;
    
    guard.observer = new MutationObserver(function(mutations) {
      if (guard.isRestoring) return;
      
      const currentHtml = element.innerHTML;
      if (currentHtml === guard.html) return;
      
      log('🛡️ 保护器检测到消息 #' + messageId + ' 被篡改，恢复中...');
      
      guard.isRestoring = true;
      
      // 在内部重新渲染后恢复
      const reRendered = InternalRenderer.render(guard.html, messageId);
      element.innerHTML = reRendered;
      
      // 设置 iframe 自适应高度
      InternalRenderer.setupIframeAutoHeight(element);
      
      // 更新存储
      if (reRendered !== guard.html) {
        guard.html = reRendered;
        const chat = getChat();
        if (chat[messageId]?.extra) {
          chat[messageId].extra.remoteFormattedHtml = reRendered;
        }
      }
      
      guard.isRestoring = false;
    });
    
    guard.observer.observe(element, {
      childList: true,
      subtree: true,
      characterData: true
    });
    
    this.protected.set(messageId, guard);
    log('✅ 保护器已激活 #' + messageId);
  },
  
  unprotect(messageId) {
    const guard = this.protected.get(messageId);
    if (guard) {
      guard.observer?.disconnect();
      this.protected.delete(messageId);
    }
  },
  
  clear() {
    this.protected.forEach(guard => guard.observer?.disconnect());
    this.protected.clear();
  },
  
  isProtected(messageId) {
    return this.protected.has(messageId);
  }
};

// ========================================
// 函数锁
// ========================================

function setupFunctionLocks() {
  const ctx = getContext();
  
  if (ctx._mpFunctionLocksInstalled) {
    log('函数锁已安装，跳过');
    return;
  }
  
  const originalUpdateMessageBlock = ctx.updateMessageBlock;
  
  if (originalUpdateMessageBlock) {
    ctx.updateMessageBlock = function(messageId, message, options = {}) {
      const chat = getChat();
      const msg = chat[messageId];
      
      if (msg?.extra?.isRemote && msg?.extra?.remoteFormattedHtml) {
        log('🔒 函数锁拦截 updateMessageBlock #' + messageId);
        
        const element = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
        if (element) {
          const rendered = InternalRenderer.render(msg.extra.remoteFormattedHtml, messageId);
          element.innerHTML = rendered;
          InternalRenderer.setupIframeAutoHeight(element);
          msg.extra.remoteFormattedHtml = rendered;
        }
        
        return;
      }
      
      return originalUpdateMessageBlock.call(this, messageId, message, options);
    };
    
    log('🔒 已锁定 updateMessageBlock');
  }
  
  ctx._mpFunctionLocksInstalled = true;
}

// ========================================
// Token 存储管理
// ========================================

function saveToken(token) {
  userToken = token;
  try { localStorage.setItem('tavern-mp-token', token); } catch(e) {}
}

function getStoredToken() {
  try { return localStorage.getItem('tavern-mp-token'); } catch(e) { return null; }
}

function saveLastConnected() {
  try { localStorage.setItem('tavern-mp-last-connected', Date.now().toString()); } catch(e) {}
}

function getLastConnected() {
  try {
    const t = localStorage.getItem('tavern-mp-last-connected');
    return t ? parseInt(t, 10) : null;
  } catch(e) { return null; }
}

function clearAllStorage() {
  userToken = null;
  try {
    localStorage.removeItem('tavern-mp-token');
    localStorage.removeItem('tavern-mp-last-connected');
  } catch(e) {}
}

function canAutoReconnect() {
  const token = getStoredToken();
  if (!token) return false;
  const lastConnected = getLastConnected();
  if (!lastConnected) { clearAllStorage(); return false; }
  const elapsed = Date.now() - lastConnected;
  if (elapsed > RECONNECT_TIMEOUT) { clearAllStorage(); return false; }
  return true;
}

// ========================================
// 重置所有状态
// ========================================

function resetAllState() {
  isConnected = false;
  currentRoom = null;
  currentRoomName = '';
  roomUsers = [];
  chatMessages = [];
  processedMsgCache.clear();
  remoteStreamMap.clear();
  remoteContextCache.clear();
  isGenerating = false;
  turnState = {
    currentSpeaker: null,
    speakerName: null,
    speakerPhase: null,
    remainingTime: 0,
    localReceivedTime: null,
    queue: [],
    isMyTurn: false,
    myPosition: -1
  };
  RemoteMessageGuard.clear();
  unblockSendButton();
}

// ========================================
// 获取用户名
// ========================================

function getUserName() {
  const ctx = getContext();
  if (ctx.name1) {
    userName = ctx.name1;
    return true;
  }
  
  const chat = getChat();
  if (chat && chat.length > 0) {
    for (let i = chat.length - 1; i >= 0; i--) {
      if (chat[i].is_user && chat[i].name) {
        userName = chat[i].name;
        return true;
      }
    }
  }
  
  return false;
}

function waitForUserName(callback, maxRetries = 20, interval = 500) {
  let retries = 0;
  
  function tryGet() {
    if (getUserName()) {
      callback();
      return;
    }
    
    retries++;
    if (retries < maxRetries) {
      setTimeout(tryGet, interval);
    } else {
      userName = '用户';
      callback();
      
      const bgRetry = setInterval(() => {
        if (getUserName()) {
          if (isConnected) {
            sendWS({ type: 'setUserInfo', name: userName });
          }
          clearInterval(bgRetry);
        }
      }, 2000);
      
      setTimeout(() => clearInterval(bgRetry), 60000);
    }
  }
  
  tryGet();
}

// ========================================
// 发送按钮控制
// ========================================

function blockSendButton(reason) {
  if (isSendBlocked) return;
  isSendBlocked = true;
  
  const sendBtn = $('#send_but');
  if (sendBtn.length) {
    sendBtn.addClass('disabled mp-blocked');
    sendBtn.css({
      'opacity': '0.5',
      'pointer-events': 'none',
      'cursor': 'not-allowed'
    });
  }
  
  if (!$('#mp-send-block-overlay').length) {
    const overlay = $('<div id="mp-send-block-overlay"></div>');
    overlay.css({
      'position': 'fixed',
      'bottom': '60px',
      'left': '50%',
      'transform': 'translateX(-50%)',
      'background': 'rgba(233, 69, 96, 0.95)',
      'color': '#fff',
      'padding': '8px 16px',
      'border-radius': '20px',
      'font-size': '13px',
      'z-index': '9999',
      'box-shadow': '0 4px 15px rgba(0,0,0,0.3)',
      'white-space': 'nowrap'
    });
    overlay.text(reason);
    $('body').append(overlay);
  } else {
    $('#mp-send-block-overlay').text(reason).show();
  }
}

function unblockSendButton() {
  if (!isSendBlocked) return;
  isSendBlocked = false;
  
  const sendBtn = $('#send_but');
  if (sendBtn.length) {
    sendBtn.removeClass('disabled mp-blocked');
    sendBtn.css({ 'opacity': '', 'pointer-events': '', 'cursor': '' });
  }
  
  $('#mp-send-block-overlay').hide();
}

function updateSendButtonState() {
  if (!currentRoom) {
    unblockSendButton();
    return;
  }
  
  if (turnState.isMyTurn) {
    unblockSendButton();
  } else if (turnState.currentSpeaker) {
    blockSendButton('等待 ' + (turnState.speakerName || '其他玩家') + ' 的回合...');
  } else {
    unblockSendButton();
  }
}

function setupSendInterceptor() {
  $(document).off('click.mpIntercept', '#send_but');
  $(document).on('click.mpIntercept', '#send_but', function(e) {
    if (!currentRoom) return true;
    
    if (isSendBlocked || !turnState.isMyTurn) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      toast('warning', '请等待其他玩家的回合结束');
      return false;
    }
    return true;
  });
  
  $('#send_textarea').off('keydown.mpIntercept');
  $('#send_textarea').on('keydown.mpIntercept', function(e) {
    if (!currentRoom) return true;
    
    if (e.key === 'Enter' && !e.shiftKey) {
      if (isSendBlocked || !turnState.isMyTurn) {
        e.preventDefault();
        e.stopPropagation();
        toast('warning', '请等待其他玩家的回合结束');
        return false;
      }
    }
    return true;
  });
}

function sendWS(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// ========================================
// 消息处理辅助函数
// ========================================

function addRemoteTag(messageId, labelText, type) {
  const mesEl = $(`.mes[mesid="${messageId}"]`);
  if (!mesEl.length) return;
  
  mesEl.attr('data-remote', 'true');
  
  const nameTextEl = mesEl.find('.ch_name .name_text');
  if (!nameTextEl.length) return;
  
  if (nameTextEl.siblings('.remote-tag').length) return;
  
  const tagClass = type === 'ai' ? 'remote-tag remote-ai-tag' : 'remote-tag';
  const tag = $(`<span class="${tagClass}">${escapeHtml(labelText)}</span>`);
  nameTextEl.after(tag);
}

function forceStopGeneration() {
  try {
    const ctx = getContext();
    if (typeof ctx.stopGeneration === 'function') {
      ctx.stopGeneration();
    } else {
      const stopBtn = $('#mes_stop');
      if (stopBtn.length && stopBtn.is(':visible')) {
        stopBtn.trigger('click');
      }
    }
  } catch(e) {}
  isGenerating = false;
}

function deleteTimeoutMessages(phase) {
  try {
    const chat = getChat();
    if (!chat || chat.length === 0) return;
    
    if (phase !== 'aiGenerating') {
      toast('warning', '发言超时，回合已跳过');
      return;
    }
    
    if (chat.length > 0 && !chat[chat.length - 1].is_user) {
      chat.pop();
      $('#chat .mes').last().remove();
    }
    
    if (chat.length > 0 && chat[chat.length - 1].is_user) {
      chat.pop();
      $('#chat .mes').last().remove();
    }
    
    const ctx = getContext();
    if (ctx.saveChat) ctx.saveChat();
    
    toast('warning', '发言超时，消息已撤回');
  } catch(e) {}
}

function simpleRender(text) {
  if (!text) return '';
  
  let result = text;
  result = result.replace(/\n/g, '<br>');
  result = result.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  result = result.replace(/\*(.+?)\*/g, '<em>$1</em>');
  result = result.replace(/`([^`]+)`/g, '<code>$1</code>');
  
  return result;
}

// ========================================
// 等待酒馆助手处理完再捕获
// ========================================

function waitForTavernHelperThenCapture(messageId, lastMsg) {
  const mesText = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
  if (!mesText) {
    log('⚠️ 找不到消息元素');
    finishCapture();
    return;
  }
  
  let waitCount = 0;
  const maxWait = 40; // 最多等待 2 秒
  const checkInterval = 50;
  
  function checkAndCapture() {
    waitCount++;
    
    // 检查内容是否有效（不是占位符）
    const currentHtml = mesText.innerHTML;
    const isPlaceholder = !currentHtml || 
                          currentHtml.length < 50 || 
                          currentHtml.includes('<p>…</p>') ||
                          currentHtml.includes('<p>...</p>');
    
    if (isPlaceholder && waitCount < maxWait) {
      setTimeout(checkAndCapture, checkInterval);
      return;
    }
    
    // 检查是否有前端代码块
    const hasCodeBlock = mesText.querySelector('pre code') !== null;
    let hasFrontendCode = false;
    
    if (hasCodeBlock) {
      const codeBlocks = mesText.querySelectorAll('pre code');
      codeBlocks.forEach(code => {
        if (isFrontend(code.textContent)) {
          hasFrontendCode = true;
        }
      });
    }
    
    // 如果有前端代码，等待酒馆助手处理
    if (hasFrontendCode) {
      const tavernHelperProcessed = hasTavernHelperTraces(mesText);
      
      // 如果酒馆助手还没处理完且没超时，继续等待
      if (!tavernHelperProcessed && waitCount < 30) {
        setTimeout(checkAndCapture, checkInterval);
        return;
      }
      
      log('酒馆助手已处理: ' + tavernHelperProcessed + '，等待了 ' + (waitCount * checkInterval) + 'ms');
    }
    
    // 现在可以捕获了
    log('开始捕获 #' + messageId + '，等待了 ' + (waitCount * checkInterval) + 'ms');
    
    // 获取 HTML 并清理
    let html = mesText.innerHTML;
    
    // 执行清理（移除酒馆助手和我们的所有痕迹）
    html = cleanHtmlForSync(html);
    
    log('清理后HTML长度: ' + html.length);
    
    if (html && html.length > 50) {
      sendWS({
        type: 'syncAiComplete',
        formattedHtml: html,
        charName: lastMsg.name,
        senderName: userName,
        timestamp: Date.now()
      });
      
      sendWS({ type: 'aiGenerationEnded' });
      log('✅ 已发送纯净HTML，长度: ' + html.length);
    } else {
      log('⚠️ HTML内容太短，不发送');
    }
    
    finishCapture();
  }
  
  function finishCapture() {
    isGenerating = false;
  }
  
  // 开始检查（先等100ms让渲染完成）
  setTimeout(checkAndCapture, 100);
}

// ========================================
// 远程消息处理
// ========================================

function handleRemoteUserMessage(msg) {
  const msgKey = msg.senderId + '_' + msg.timestamp;
  if (processedMsgCache.has(msgKey)) return;
  processedMsgCache.add(msgKey);
  
  if (processedMsgCache.size > 100) {
    const arr = Array.from(processedMsgCache);
    processedMsgCache = new Set(arr.slice(-50));
  }
  
  log('收到远程用户消息: ' + msg.userName);
  
  const chat = getChat();
  if (!chat) return;
  
  const ctx = getContext();
  const addOneMessage = ctx.addOneMessage;
  if (!addOneMessage) return;
  
  const message = {
    name: msg.userName,
    is_user: true,
    is_system: false,
    send_date: getMessageTimeStamp(),
    mes: msg.content,
    extra: {
      isRemote: true,
      remoteSender: msg.senderName,
      remoteSenderId: msg.senderId
    }
  };
  
  chat.push(message);
  const messageId = chat.length - 1;
  addOneMessage(message, { forceId: messageId, scroll: true });
  
  addRemoteTag(messageId, '用户', 'user');
  
  if (ctx.saveChat) ctx.saveChat();
}

function handleRemoteAiStream(msg) {
  const chat = getChat();
  if (!chat) return;
  
  let streamInfo = remoteStreamMap.get(msg.senderId);
  
  if (!streamInfo) {
    const ctx = getContext();
    const addOneMessage = ctx.addOneMessage;
    if (!addOneMessage) return;
    
    const message = {
      name: msg.charName,
      is_user: false,
      is_system: false,
      send_date: getMessageTimeStamp(),
      mes: '',
      extra: {
        isRemote: true,
        isStreaming: true,
        remoteSenderId: msg.senderId
      }
    };
    
    chat.push(message);
    const messageId = chat.length - 1;
    addOneMessage(message, { forceId: messageId, scroll: true });
    
    $(`.mes[mesid="${messageId}"]`).attr('data-remote', 'true');
    
    remoteStreamMap.set(msg.senderId, {
      messageId: messageId,
      charName: msg.charName
    });
    
    log('创建远程AI占位消息: #' + messageId);
    
    const mesText = $(`.mes[mesid="${messageId}"] .mes_text`);
    if (mesText.length) {
      mesText.html(simpleRender(msg.content));
    }
    
  } else {
    const messageId = streamInfo.messageId;
    
    if (chat[messageId]) {
      chat[messageId].mes = msg.content;
    }
    
    const mesText = $(`.mes[mesid="${messageId}"] .mes_text`);
    if (mesText.length) {
      mesText.html(simpleRender(msg.content));
    }
  }
  
  try {
    const ctx = getContext();
    if (ctx.scrollChatToBottom) ctx.scrollChatToBottom();
  } catch(e) {}
}

function handleRemoteAiComplete(msg) {
  const chat = getChat();
  const ctx = getContext();
  const streamInfo = remoteStreamMap.get(msg.senderId);
  
  log('远程AI完成，原始HTML长度: ' + (msg.formattedHtml?.length || 0));
  
  let messageId;
  
  if (streamInfo) {
    messageId = streamInfo.messageId;
    remoteStreamMap.delete(msg.senderId);
  } else {
    const msgKey = msg.senderId + '_' + msg.timestamp + '_ai';
    if (processedMsgCache.has(msgKey)) return;
    processedMsgCache.add(msgKey);
    
    const addOneMessage = ctx.addOneMessage;
    if (!addOneMessage) return;
    
    const message = {
      name: msg.charName,
      is_user: false,
      is_system: false,
      send_date: getMessageTimeStamp(),
      mes: '[远程消息]',
      extra: { isRemote: true }
    };
    
    chat.push(message);
    messageId = chat.length - 1;
    addOneMessage(message, { forceId: messageId, scroll: true });
  }
  
  // ========== 核心流程：内部渲染 + 原子覆盖 + 即时保护 ==========
  
  // 1. 标记 DOM
  const mesElement = document.querySelector(`.mes[mesid="${messageId}"]`);
  if (mesElement) {
    mesElement.setAttribute('data-remote', 'true');
  }
  
  // 2. 在插件内部沙箱渲染
  const renderedHtml = InternalRenderer.render(msg.formattedHtml, messageId);
  
  // 3. 存储到 chat 数组
  chat[messageId].extra = chat[messageId].extra || {};
  chat[messageId].extra.isRemote = true;
  chat[messageId].extra.isStreaming = false;
  chat[messageId].extra.remoteFormattedHtml = renderedHtml;
  chat[messageId].extra.remoteSenderId = msg.senderId;
  chat[messageId].extra.remoteSenderName = msg.senderName;
  chat[messageId].extra.remoteCharName = msg.charName;
  
  // 4. 原子性写入 DOM
  const mesText = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
  if (mesText) {
    mesText.innerHTML = renderedHtml;
    
    // 5. 设置 iframe 自适应高度
    InternalRenderer.setupIframeAutoHeight(mesText);
  }
  
  // 6. 立即设置保护器（零延迟）
  RemoteMessageGuard.protect(messageId, renderedHtml);
  
  // 7. 添加远程标签
  addRemoteTag(messageId, '联机AI', 'ai');
  
  // ========== 核心流程结束 ==========
  
  // 触发事件
  ctx.eventSource.emit(ctx.eventTypes.CHARACTER_MESSAGE_RENDERED, messageId);
  
  // 保存聊天
  if (ctx.saveChat) ctx.saveChat();
  
  log('✅ 远程AI消息完成 #' + messageId + '，渲染后长度: ' + renderedHtml.length);
}

// ========================================
// 恢复远程消息（刷新后）
// ========================================

function restoreRemoteMessages() {
  const chat = getChat();
  if (!chat || chat.length === 0) return;
  
  let restoredCount = 0;
  
  chat.forEach((msg, messageId) => {
    if (!msg?.extra?.isRemote || !msg?.extra?.remoteFormattedHtml || msg?.is_user) {
      return;
    }
    
    const mesText = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
    if (!mesText) return;
    
    // 1. 标记 DOM
    const mesElement = mesText.closest('.mes');
    if (mesElement) {
      mesElement.setAttribute('data-remote', 'true');
    }
    
    // 2. 在内部重新渲染
    const renderedHtml = InternalRenderer.render(msg.extra.remoteFormattedHtml, messageId);
    
    // 3. 更新存储
    msg.extra.remoteFormattedHtml = renderedHtml;
    
    // 4. 原子写入 DOM
    mesText.innerHTML = renderedHtml;
    
    // 5. 设置 iframe 高度
    InternalRenderer.setupIframeAutoHeight(mesText);
    
    // 6. 立即设置保护器
    RemoteMessageGuard.protect(messageId, renderedHtml);
    
    // 7. 添加标签
    addRemoteTag(messageId, '联机AI', 'ai');
    
    restoredCount++;
  });
  
  if (restoredCount > 0) {
    log('✅ 已恢复 ' + restoredCount + ' 条远程消息');
  }
}

// ========================================
// 上下文同步
// ========================================

function setupPrepareMessagesHijack() {
  if (window._prepareOpenAIMessagesHijacked) {
    return;
  }
  
  const originalPrepare = window.prepareOpenAIMessages;
  
  if (!originalPrepare) {
    log('⚠️ 无法获取 prepareOpenAIMessages');
    return;
  }
  
  window.prepareOpenAIMessages = async function(params, dryRun) {
    if (!dryRun && currentRoom && turnState.isMyTurn && isGenerating) {
      try {
        collectAndSendSyncData(params);
      } catch (e) {
        log('收集同步数据出错: ' + e);
      }
    }
    
    if (!dryRun && currentRoom && remoteContextCache.size > 0) {
      try {
        injectRemoteContext(params);
      } catch (e) {
        log('注入远程内容出错: ' + e);
      }
    }
    
    return await originalPrepare.call(this, params, dryRun);
  };
  
  window._prepareOpenAIMessagesHijacked = true;
  log('✅ 已劫持 prepareOpenAIMessages');
}

function collectAndSendSyncData(params) {
  const chat = getChat();
  
  const localChatHistory = chat
    .filter(msg => !msg.extra?.isRemote && !msg.is_system)
    .map(msg => ({
      role: msg.is_user ? 'user' : 'assistant',
      content: msg.mes,
      name: msg.name,
    }));
  
  sendWS({
    type: 'syncContext',
    worldInfo: {
      before: params.worldInfoBefore || '',
      after: params.worldInfoAfter || '',
    },
    character: {
      description: params.charDescription || '',
      personality: params.charPersonality || '',
      scenario: params.scenario || '',
    },
    chatHistory: localChatHistory,
    senderName: userName,
    timestamp: Date.now(),
  });
  
  const lastUserMsg = localChatHistory.filter(m => m.role === 'user').pop();
  if (lastUserMsg) {
    sendWS({
      type: 'syncUserMessage',
      content: lastUserMsg.content,
      userName: lastUserMsg.name,
      senderName: userName,
      timestamp: Date.now(),
    });
  }
  
  sendWS({ type: 'userMessageSent' });
}

function injectRemoteContext(params) {
  if (remoteContextCache.size === 0) return;
  
  let remoteWorldInfo = '';
  let remoteCharacter = '';
  let remoteChatHistory = [];
  
  remoteContextCache.forEach((data, odId) => {
    const playerTag = `[来自 ${data.userName}]`;
    
    if (data.worldInfo) {
      const wiBefore = data.worldInfo.before || '';
      const wiAfter = data.worldInfo.after || '';
      if (wiBefore || wiAfter) {
        remoteWorldInfo += `\n${playerTag}\n${wiBefore}${wiAfter ? '\n' + wiAfter : ''}`;
      }
    }
    
    if (data.character) {
      const charContent = [
        data.character.description,
        data.character.personality,
        data.character.scenario,
      ].filter(x => x).join('\n');
      
      if (charContent) {
        remoteCharacter += `\n${playerTag}\n${charContent}`;
      }
    }
    
    if (data.chatHistory && data.chatHistory.length > 0) {
      remoteChatHistory.push(...data.chatHistory);
    }
  });
  
  if (remoteWorldInfo) {
    params.worldInfoAfter = (params.worldInfoAfter || '') + 
      '\n\n【其他玩家的世界设定】' + remoteWorldInfo;
  }
  
  if (remoteCharacter) {
    params.scenario = (params.scenario || '') + 
      '\n\n【其他玩家的角色信息】' + remoteCharacter;
  }
  
  if (remoteChatHistory.length > 0) {
    params.messages.push(...remoteChatHistory);
  }
}

function handleRemoteSyncContext(msg) {
  const { senderId, senderName, worldInfo, character, chatHistory, timestamp } = msg;
  
  remoteContextCache.set(senderId, {
    userName: senderName,
    worldInfo: worldInfo,
    character: character,
    chatHistory: chatHistory,
    timestamp: timestamp,
  });
  
  log('收到远程上下文，来自: ' + senderName);
}

// ========================================
// 事件监听设置
// ========================================

function setupDOMObserver() {
  const chatElement = document.getElementById('chat');
  if (!chatElement) {
    setTimeout(setupDOMObserver, 1000);
    return;
  }
  
  if (chatObserver) {
    chatObserver.disconnect();
  }
  
  chatObserver = new MutationObserver(function(mutations) {
    // 目前仅用于监控，不做额外处理
  });
  
  chatObserver.observe(chatElement, { 
    childList: true, 
    subtree: true,
    characterData: true
  });
}

function setupEventListeners() {
  const ctx = getContext();
  
  setupDOMObserver();
  setupPrepareMessagesHijack();
  setupFunctionLocks();
  
  // 生成开始
  eventSource.on(event_types.GENERATION_STARTED, function(type, options, dryRun) {
    if (dryRun) return;
    if (!currentRoom) return;
    
    log('事件: 生成开始');
    isGenerating = true;
  });
  
  // 流式同步
  const throttledStreamSync = throttle(function(text) {
    if (!currentRoom || !turnState.isMyTurn || !isGenerating) return;
    
    const chat = getChat();
    const lastMsg = chat[chat.length - 1];
    if (!lastMsg || lastMsg.is_user) return;
    
    sendWS({
      type: 'syncAiStream',
      content: text,
      charName: lastMsg.name,
      timestamp: Date.now()
    });
  }, STREAM_THROTTLE_MS);
  
  eventSource.on(event_types.STREAM_TOKEN_RECEIVED, function(text) {
    if (!currentRoom || !turnState.isMyTurn) return;
    isGenerating = true;
    throttledStreamSync(text);
  });
  
  // 生成结束 - 等待酒馆助手处理完再捕获
  eventSource.on(event_types.GENERATION_ENDED, function(messageCount) {
    if (!currentRoom) return;
    if (!turnState.isMyTurn || !isGenerating) return;
    
    log('事件: 生成结束');
    
    const chat = getChat();
    const messageId = chat.length - 1;
    const lastMsg = chat[messageId];
    
    if (!lastMsg || lastMsg.is_user || lastMsg.extra?.isRemote) {
      isGenerating = false;
      return;
    }
    
    // 等待酒馆助手处理完成后再捕获
    waitForTavernHelperThenCapture(messageId, lastMsg);
  });
  
  eventSource.on(event_types.GENERATION_STOPPED, function() {
    log('事件: 生成停止');
    isGenerating = false;
  });
  
  eventSource.on(event_types.CHAT_CHANGED, function() {
    log('事件: 聊天切换');
remoteStreamMap.clear();
    isGenerating = false;
    
    RemoteMessageGuard.clear();
    
    setTimeout(setupDOMObserver, 500);
    setTimeout(restoreRemoteMessages, 800);
  });
  
  log('✅ 事件监听已设置');
}

// ========================================
// WebSocket 连接
// ========================================

function connectServer() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  
  userToken = getStoredToken();
  log('连接: ' + SERVER_URL);
  
  if (reconnectAttempts === 0) {
    toast('info', '正在连接...');
  }
  
  try {
    ws = new WebSocket(SERVER_URL);
    
    ws.onopen = function() {
      log('WebSocket已连接');
      reconnectAttempts = 0;
      isReconnecting = false;
      sendWS({ type: 'auth', token: userToken });
    };
    
    ws.onmessage = function(e) {
      try {
        handleMessage(JSON.parse(e.data));
      } catch(err) {
        log('解析错误: ' + err);
      }
    };
    
    ws.onclose = function() {
      log('连接断开');
      isConnected = false;
      stopHeartbeat();
      
      if (isNormalDisconnect || isInactiveKick) {
        clearAllStorage();
        resetAllState();
        refreshPanel();
      } else {
        attemptReconnect();
      }
    };
    
    ws.onerror = function(e) {
      log('连接错误');
    };
  } catch(e) {
    toast('error', '连接失败');
    attemptReconnect();
  }
}

function attemptReconnect() {
  if (isNormalDisconnect || isInactiveKick) return;
  
  if (!canAutoReconnect()) {
    resetAllState();
    refreshPanel();
    return;
  }
  
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    toast('error', '连接失败，请手动重连');
    reconnectAttempts = 0;
    isReconnecting = false;
    refreshPanel();
    return;
  }
  
  reconnectAttempts++;
  isReconnecting = true;
  toast('info', '重连中... (' + reconnectAttempts + '/' + MAX_RECONNECT_ATTEMPTS + ')');
  
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectServer, RECONNECT_INTERVAL);
}

function normalDisconnect() {
  isNormalDisconnect = true;
  isInactiveKick = false;
  sendWS({ type: 'normalDisconnect' });
  
  if (ws) {
    ws.close();
    ws = null;
  }
  
  clearAllStorage();
  resetAllState();
  refreshPanel();
  toast('info', '已断开连接');
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(function() {
    sendWS({ type: 'ping' });
    saveLastConnected();
  }, 30000);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ========================================
// 消息处理
// ========================================

function handleMessage(msg) {
  if (msg.type !== 'remoteAiStream') {
    log('收到: ' + msg.type);
  }
  
  switch(msg.type) {
    case 'connected':
      odId = msg.userId;
      saveToken(msg.token);
      saveLastConnected();
      isConnected = true;
      toast('success', '连接成功！');
      sendWS({ type: 'setUserInfo', name: userName });
      refreshPanel();
      startHeartbeat();
      break;
    
    case 'reconnected':
      odId = msg.userId;
      saveToken(msg.token);
      saveLastConnected();
      isConnected = true;
      currentRoom = msg.roomId;
      roomUsers = msg.users || [];
      chatMessages = msg.messages || [];
      toast('success', '重连成功！');
      sendWS({ type: 'setUserInfo', name: userName });
      refreshPanel();
      startHeartbeat();
      break;
    
    case 'roomCreated':
      currentRoom = msg.roomId;
      roomUsers = msg.users || [];
      chatMessages = [];
      toast('success', '房间: ' + msg.roomId);
      refreshPanel();
      break;
    
    case 'joinedRoom':
      currentRoom = msg.roomId;
      roomUsers = msg.users || [];
      chatMessages = msg.messages || [];
      toast('success', '已加入房间');
      refreshPanel();
      break;
    
    case 'userJoined':
      roomUsers = msg.users || [];
      toast('info', msg.userName + ' 加入');
      refreshPanel();
      break;
    
    case 'userLeft':
      roomUsers = msg.users || [];
      if (msg.userId) {
        remoteContextCache.delete(msg.userId);
      }
      toast('info', msg.userName + ' 离开');
      refreshPanel();
      break;
    
    case 'userOnline':
      roomUsers = msg.users || [];
      toast('info', msg.userName + ' 上线');
      refreshPanel();
      break;
    
    case 'userOffline':
      toast('info', msg.userName + ' 暂时离线');
      break;
    
    case 'onlineUpdate':
      onlineUsers = msg.users || [];
      updateOnlineList();
      break;
    
    case 'roomChat':
      chatMessages.push({
        fromId: msg.fromId,
        fromName: msg.fromName,
        content: msg.content
      });
      if (chatMessages.length > 100) {
        chatMessages = chatMessages.slice(-100);
      }
      updateChatUI();
      break;
    
    case 'inviteReceived':
      showInvitePopup('invite', msg.fromName, msg.fromId, msg.roomId);
      break;
    
    case 'requestReceived':
      showInvitePopup('request', msg.fromName, msg.fromId, null);
      break;
    
    case 'turnState':
      turnState.currentSpeaker = msg.currentSpeaker;
      turnState.speakerName = msg.speakerName;
      turnState.speakerPhase = msg.speakerPhase;
      turnState.remainingTime = msg.remainingTime || 0;
      turnState.localReceivedTime = Date.now();
      turnState.queue = msg.queue || [];
      turnState.isMyTurn = msg.isMyTurn;
      turnState.myPosition = msg.myPosition;
      updateTurnStateUI();
      updateSendButtonState();
      break;
    
    case 'turnTimeout':
      log('发言超时: ' + msg.phase);
      isGenerating = false;
      forceStopGeneration();
      deleteTimeoutMessages(msg.phase);
      break;
    
    case 'turnSkipped':
      log('回合已跳过');
      isGenerating = false;
      break;
    
    case 'removeTimeoutMessages':
      log('用户 ' + msg.userName + ' 超时');
      if (msg.odId && remoteStreamMap.has(msg.odId)) {
        const streamInfo = remoteStreamMap.get(msg.odId);
        const chat = getChat();
        if (streamInfo && chat[streamInfo.messageId]) {
          chat.splice(streamInfo.messageId, 1);
          $(`.mes[mesid="${streamInfo.messageId}"]`).remove();
          $('#chat .mes').each(function(index) {
            $(this).attr('mesid', index);
          });
        }
        remoteStreamMap.delete(msg.odId);
      }
      break;
    
    case 'remoteSyncContext':
      handleRemoteSyncContext(msg);
      break;
    
    case 'remoteUserMessage':
      handleRemoteUserMessage(msg);
      break;
    
    case 'remoteAiStream':
      handleRemoteAiStream(msg);
      break;
    
    case 'remoteAiComplete':
      handleRemoteAiComplete(msg);
      break;
    
    case 'inactiveKick':
      isInactiveKick = true;
      isNormalDisconnect = false;
      toast('warning', msg.message || '长时间不活跃，已断开');
      break;
    
    case 'normalDisconnectAck':
      log('服务器确认断开');
      break;
    
    case 'error':
      toast('error', msg.message || '错误');
      break;
    
    case 'pong':
      break;
  }
}

// ========================================
// 活动监听
// ========================================

function setupActivityListener() {
  $(document).on('click', '#send_but, #send_button, .send_button', function() {
    if (isConnected) {
      sendWS({ type: 'mainActivity' });
    }
  });
}

let lastKnownUserName = '';

function setupUserNameWatcher() {
  setInterval(function() {
    const oldName = userName;
    if (getUserName() && userName !== oldName && userName !== lastKnownUserName) {
      lastKnownUserName = userName;
      log('用户名变化: ' + oldName + ' -> ' + userName);
      
      if (isConnected) {
        sendWS({ type: 'setUserInfo', name: userName });
      }
      
      refreshPanel();
    }
  }, 3000);
}

// ========================================
// UI面板构建
// ========================================

function startCountdownDisplay() {
  stopCountdownDisplay();
  countdownInterval = setInterval(updateCountdownDisplay, 1000);
}

function stopCountdownDisplay() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

function updateCountdownDisplay() {
  const countdownEl = $('#mp-turn-countdown');
  if (!countdownEl.length) return;
  
  if (!turnState.localReceivedTime || !turnState.currentSpeaker || turnState.remainingTime <= 0) {
    countdownEl.text('--:--');
    return;
  }
  
  const elapsed = Date.now() - turnState.localReceivedTime;
  const remaining = turnState.remainingTime - elapsed;
  
  if (remaining <= 0) {
    countdownEl.text('0:00').css('color', '#ff4444');
  } else if (remaining <= 60000) {
    countdownEl.text(formatTime(remaining)).css('color', '#ffaa00');
  } else {
    countdownEl.text(formatTime(remaining)).css('color', '#4ade80');
  }
}

function buildTurnStateHTML() {
  if (!currentRoom) return '';
  
  let html = '<div class="mp-turn-state">';
  
  if (turnState.currentSpeaker) {
    const phaseText = turnState.speakerPhase === 'aiGenerating' ? '等待AI回复...' : '正在发言...';
    html += '<div class="mp-turn-current">';
    html += '<span class="mp-turn-icon">🎤</span>';
    html += '<span class="mp-turn-speaker">' + escapeHtml(turnState.speakerName || '未知') + '</span>';
    html += '<span class="mp-turn-phase">' + phaseText + '</span>';
    html += '</div>';
    html += '<div class="mp-turn-timer">';
    html += '<span class="mp-turn-timer-icon">⏱️</span>';
    html += '<span id="mp-turn-countdown">--:--</span>';
    html += '</div>';
  } else {
    html += '<div class="mp-turn-idle">💬 等待发言...</div>';
  }
  
  if (turnState.queue?.length > 0) {
    html += '<div class="mp-turn-queue">';
    html += '<span class="mp-turn-queue-label">队列:</span>';
    turnState.queue.forEach(function(item, index) {
      const isMe = item.id === odId;
      const isCurrent = item.id === turnState.currentSpeaker;
      let classes = 'mp-turn-queue-item';
      if (isMe) classes += ' mp-queue-me';
      if (isCurrent) classes += ' mp-queue-current';
      html += '<span class="' + classes + '">';
      html += (index + 1) + '.' + escapeHtml(item.name);
      if (isMe) html += '(你)';
      html += '</span>';
    });
    html += '</div>';
  }
  
  if (turnState.isMyTurn) {
    html += '<button class="mp-btn mp-btn-gray mp-skip-btn" id="mp-skip-turn">⏭️ 跳过我的回合</button>';
  }
  
  html += '</div>';
  return html;
}

function buildRoomMembersHTML() {
  if (!roomUsers || roomUsers.length === 0) {
    return '<div style="color:#666;text-align:center;padding:10px;">暂无成员</div>';
  }
  
  let html = '';
  roomUsers.forEach(function(user) {
    const isMe = user.id === odId;
    const isSpeaking = user.id === turnState.currentSpeaker;
    let classes = 'mp-user';
    if (isSpeaking) classes += ' mp-user-speaking';
    
    html += '<div class="' + classes + '">';
    html += '<div class="mp-user-icon" style="background:#0f3460;">' + (isSpeaking ? '🎤' : '👤') + '</div>';
    html += '<div class="mp-user-info">';
    html += '<div class="mp-user-name">' + escapeHtml(user.name) + '</div>';
    html += '<div class="mp-user-status">' + (isMe ? '这是你' : (isSpeaking ? '正在发言' : '房间成员')) + '</div>';
    html += '</div>';
    
    if (isMe) {
      html += '<span class="mp-tag mp-tag-me">我</span>';
    } else if (isSpeaking) {
      html += '<span class="mp-tag" style="background:#e94560;color:#fff;">发言中</span>';
    } else {
      html += '<span class="mp-tag" style="background:#4ade80;color:#000;">成员</span>';
    }
    
    html += '</div>';
  });
  
  return html;
}

function buildOnlineListHTML() {
  if (!onlineUsers || onlineUsers.length === 0) {
    return '<div style="color:#666;text-align:center;padding:10px;">暂无其他用户</div>';
  }
  
  let html = '';
  onlineUsers.forEach(function(user) {
    const isMe = user.id === odId;
    
    html += '<div class="mp-user" data-userid="' + user.id + '">';
    html += '<div class="mp-user-icon">👤</div>';
    html += '<div class="mp-user-info">';
    html += '<div class="mp-user-name">' + escapeHtml(user.name) + '</div>';
    html += '<div class="mp-user-status">';
    
    if (isMe) {
      html += '这是你';
    } else if (user.status === 'online') {
      html += '🟢 在线';
    } else if (user.status === 'inRoom' && user.roomInfo) {
      html += '🚪 房间 ' + user.roomInfo.userCount + '/' + user.roomInfo.maxUsers;
    }
    
    html += '</div></div>';
    
    if (isMe) {
      html += '<span class="mp-tag mp-tag-me">我</span>';
    } else if (user.status === 'online') {
      html += '<span class="mp-tag mp-tag-online">在线</span>';
    } else {
      html += '<span class="mp-tag mp-tag-room">房间中</span>';
    }
    
    html += '</div>';
  });
  
  return html;
}

function buildChatHTML() {
  if (!chatMessages || chatMessages.length === 0) {
    return '<div style="color:#666;text-align:center;padding:20px;">暂无消息</div>';
  }
  
  let html = '';
  chatMessages.forEach(function(msg) {
    const isMe = msg.fromId === odId;
    html += '<div class="mp-chat-msg' + (isMe ? ' mp-chat-me' : '') + '">';
    html += '<div class="mp-chat-name">' + escapeHtml(msg.fromName) + '</div>';
    html += '<div class="mp-chat-text">' + escapeHtml(msg.content) + '</div>';
    html += '</div>';
  });
  
  return html;
}

function updateTurnStateUI() {
  const turnContainer = $('.mp-turn-state');
  if (turnContainer.length) {
    turnContainer.replaceWith(buildTurnStateHTML());
    
    $('#mp-skip-turn').off('click').on('click', function() {
      showConfirmPopup('跳过回合', '确定要跳过你的发言回合吗？', function() {
        sendWS({ type: 'skipTurn' });
        toast('info', '已跳过回合');
      });
    });
  }
  
  const membersList = $('#mp-room-members-list');
  if (membersList.length) {
    membersList.html(buildRoomMembersHTML());
  }
}

function updateOnlineList() {
  const list = $('#mp-online-list');
  if (list.length) {
    list.html(buildOnlineListHTML());
  }
  const title = $('#mp-online-toggle .mp-section-title');
  if (title.length) {
    title.text('在线用户 (' + onlineUsers.length + ')');
  }
}

function updateChatUI() {
  const box = $('#mp-chat-box');
  if (box.length) {
    box.html(buildChatHTML());
    scrollChatToBottom();
  }
}

function scrollChatToBottom() {
  const box = document.getElementById('mp-chat-box');
  if (box) box.scrollTop = box.scrollHeight;
}

function sendChatMessage() {
  const input = $('#mp-chat-input');
  const content = input.val().trim();
  
  if (!content || !currentRoom) return;
  
  sendWS({ type: 'roomChat', content: content });
  input.val('');
  sendWS({ type: 'mainActivity' });
}

function updateMenuText() {
  const $text = $('#mp-menu-text');
  if (!$text.length) return;
  
  let text = '酒馆联机';
  if (isConnected && currentRoom) {
    text = '联机中(' + roomUsers.length + ') 🟢';
  } else if (isConnected) {
    text = '已连接 🔵';
  }
  
  $text.text(text);
}

// ========================================
// 主面板构建
// ========================================

function buildPanelHTML() {
  let html = '<div class="mp-header">';
  
  if (currentRoom) {
    html += '<div class="mp-title">房间: ' + escapeHtml(currentRoom) + ' (' + roomUsers.length + '/5)</div>';
  } else {
    html += '<div class="mp-title">酒馆联机</div>';
  }
  
  html += '<button class="mp-close" id="mp-close-btn">×</button>';
  html += '</div>';
  
  html += '<div class="mp-status">';
  if (isConnected) {
    html += '<div class="mp-dot" style="background:#4ade80;"></div>';
    html += '<span style="color:#4ade80;">' + (currentRoom ? '已进入房间' : '已连接服务器') + '</span>';
  } else {
    html += '<div class="mp-dot" style="background:#666;"></div>';
    html += '<span style="color:#888;">未连接服务器</span>';
  }
  html += '</div>';
  
  html += '<div class="mp-content">';
  
  if (!isConnected) {
    html += '<div style="text-align:center;padding:40px 0;">';
    html += '<div style="color:#888;margin-bottom:20px;">点击下方按钮连接服务器</div>';
    html += '<button class="mp-btn mp-btn-green" id="mp-connect-btn">🔌 连接服务器</button>';
    html += '</div>';
  } else if (!currentRoom) {
    html += '<button class="mp-btn mp-btn-green" id="mp-create-room-btn">➕ 创建房间</button>';
    html += '<div class="mp-divider"></div>';
    html += '<input type="text" class="mp-input" id="mp-room-code-input" placeholder="输入6位数字房间号" maxlength="6" pattern="[0-9]*" inputmode="numeric">';
    html += '<button class="mp-btn mp-btn-blue" id="mp-join-room-btn">🚪 加入房间</button>';
    html += '<div style="margin-top:20px;text-align:center;">';
    html += '<button class="mp-btn mp-btn-gray" id="mp-disconnect-btn">断开连接</button>';
    html += '</div>';
  } else {
    html += '<div class="mp-room-info">';
    html += '<div><div style="color:#888;font-size:11px;">房间号</div>';
    html += '<div class="mp-room-code">' + escapeHtml(currentRoom) + '</div></div>';
    html += '<div style="color:#888;font-size:14px;">' + roomUsers.length + '/5 人</div>';
    html += '</div>';
    
    html += buildTurnStateHTML();
    
    html += '<div class="mp-section expanded" id="mp-room-members-section">';
    html += '<div class="mp-section-header" id="mp-room-members-toggle">';
    html += '<span class="mp-section-title">房间成员 (' + roomUsers.length + ')</span>';
    html += '<span style="color:#888;">▲</span>';
    html += '</div>';
    html += '<div class="mp-section-body" id="mp-room-members-list">' + buildRoomMembersHTML() + '</div>';
    html += '</div>';
    
    html += '<div class="mp-section' + (onlineListExpanded ? ' expanded' : '') + '" id="mp-online-section">';
    html += '<div class="mp-section-header" id="mp-online-toggle">';
    html += '<span class="mp-section-title">在线用户 (' + onlineUsers.length + ')</span>';
    html += '<span style="color:#888;">' + (onlineListExpanded ? '▲' : '▼') + '</span>';
    html += '</div>';
    html += '<div class="mp-section-body" id="mp-online-list">' + buildOnlineListHTML() + '</div>';
    html += '</div>';
    
    html += '<div class="mp-chat-box" id="mp-chat-box">' + buildChatHTML() + '</div>';
    html += '<div class="mp-chat-input-wrap">';
    html += '<textarea class="mp-chat-input" id="mp-chat-input" placeholder="输入消息..." maxlength="300" rows="1"></textarea>';
    html += '<button class="mp-chat-send" id="mp-chat-send">发送</button>';
    html += '</div>';
    
    html += '<div style="margin-top:15px;">';
    html += '<button class="mp-btn mp-btn-red" id="mp-leave-room-btn">🚪 离开房间</button>';
    html += '</div>';
  }
  
  html += '<div class="mp-version-footer" style="margin-top:15px;padding-top:15px;border-top:1px solid #333;text-align:center;font-size:12px;">';
  html += '<div style="color:#666;">酒馆联机 v' + CURRENT_VERSION + '</div>';
  html += '</div>';
  
  html += '</div>';
  
  return html;
}

function openPanel() {
  closePanel();
  
  const overlay = $('<div id="mp-main-overlay"></div>');
  overlay.css({
    'position': 'fixed',
    'top': '0',
    'left': '0',
    'width': '100%',
    'height': '100%',
    'background': 'rgba(0,0,0,0.7)',
    'z-index': '99998',
    'display': 'flex',
    'align-items': 'center',
    'justify-content': 'center',
    'padding': '20px',
    'box-sizing': 'border-box'
  });
  
  overlay.on('click', function(e) {
    if (e.target === this) closePanel();
  });
  
  const panel = $('<div id="mp-main-panel"></div>');
  panel.html(buildPanelHTML());
  
  overlay.append(panel);
  $('body').append(overlay);
  
  bindPanelEvents();
  startCountdownDisplay();
}

function closePanel() {
  $('#mp-main-overlay').remove();
  stopCountdownDisplay();
}

function refreshPanel() {
  const panel = $('#mp-main-panel');
  if (panel.length) {
    panel.html(buildPanelHTML());
    bindPanelEvents();
    scrollChatToBottom();
    startCountdownDisplay();
  }
  updateMenuText();
  updateSendButtonState();
}

function bindPanelEvents() {
  $('#mp-close-btn').on('click', closePanel);
  
  $('#mp-connect-btn').on('click', function() {
    isNormalDisconnect = false;
    isInactiveKick = false;
    connectServer();
  });
  
  $('#mp-disconnect-btn').on('click', normalDisconnect);
  
  $('#mp-create-room-btn').on('click', function() {
    sendWS({ type: 'createRoom', roomName: userName + '的房间' });
  });
  
  $('#mp-join-room-btn').on('click', function() {
    const code = $('#mp-room-code-input').val().trim();
    if (!code || code.length !== 6 || !/^\d{6}$/.test(code)) {
      toast('warning', '请输入6位数字房间号');
      return;
    }
    sendWS({ type: 'joinRoom', roomId: code });
  });
  
  $('#mp-room-code-input').on('keypress', function(e) {
    if (e.which < 48 || e.which > 57) {
      e.preventDefault();
      return false;
    }
    if (e.which === 13) $('#mp-join-room-btn').trigger('click');
  });
  
  $('#mp-room-code-input').on('input', function() {
    this.value = this.value.replace(/\D/g, '');
  });
  
  $('#mp-leave-room-btn').on('click', function() {
    sendWS({ type: 'leaveRoom' });
    currentRoom = null;
    roomUsers = [];
    chatMessages = [];
    processedMsgCache.clear();
    remoteStreamMap.clear();
    remoteContextCache.clear();
    isGenerating = false;
    turnState = {
      currentSpeaker: null,
      speakerName: null,
      speakerPhase: null,
      remainingTime: 0,
      localReceivedTime: null,
      queue: [],
      isMyTurn: false,
      myPosition: -1
    };
    RemoteMessageGuard.clear();
    unblockSendButton();
    refreshPanel();
    toast('info', '已离开房间');
  });
  
  $('#mp-room-members-toggle').on('click', function() {
    $('#mp-room-members-section').toggleClass('expanded');
    const isExp = $('#mp-room-members-section').hasClass('expanded');
    $(this).find('span:last').text(isExp ? '▲' : '▼');
  });
  
  $('#mp-online-toggle').on('click', function() {
    onlineListExpanded = !onlineListExpanded;
    $('#mp-online-section').toggleClass('expanded', onlineListExpanded);
    $(this).find('span:last').text(onlineListExpanded ? '▲' : '▼');
  });
  
  $('#mp-online-list').on('click', '.mp-user', function() {
    const targetId = $(this).data('userid');
    if (targetId === odId) return;
    
    const targetUser = onlineUsers.find(u => u.id === targetId);
    if (!targetUser) return;
    
    if (targetUser.status === 'online' && currentRoom && roomUsers.length < 5) {
      showConfirmPopup('邀请用户', '邀请 ' + targetUser.name + ' 加入房间？', function() {
        sendWS({ type: 'inviteUser', targetId: targetId });
        toast('success', '已发送邀请');
      });
    } else if (targetUser.status === 'inRoom' && targetUser.roomInfo && targetUser.roomInfo.userCount < 5) {
      showConfirmPopup('请求加入', '请求加入 ' + targetUser.name + ' 的房间？', function() {
        sendWS({ type: 'requestJoin', targetId: targetId });
        toast('success', '已发送请求');
      });
    }
  });
  
  $('#mp-chat-send').on('click', sendChatMessage);
  
  $('#mp-chat-input').on('keypress', function(e) {
    if (e.which === 13 && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });
  
  $('#mp-chat-input').on('input', function() {
    this.style.height = '36px';
    this.style.height = Math.min(this.scrollHeight, 72) + 'px';
  });
  
  $('#mp-skip-turn').on('click', function() {
    showConfirmPopup('跳过回合', '确定要跳过你的发言回合吗？', function() {
      sendWS({ type: 'skipTurn' });
      toast('info', '已跳过回合');
    });
  });
}

// ========================================
// 弹窗函数
// ========================================

function showConfirmPopup(title, msg, onConfirm) {
  $('.mp-confirm-overlay').remove();
  
  const overlay = $('<div class="mp-confirm-overlay"></div>');
  overlay.css({
    'position': 'fixed',
    'top': '0',
    'left': '0',
    'right': '0',
    'bottom': '0',
    'width': '100%',
    'height': '100%',
    'background': 'rgba(0,0,0,0.8)',
    'z-index': '2147483647',
    'display': 'flex',
    'align-items': 'center',
    'justify-content': 'center'
  });
  
  overlay.html(`
    <div style="background:#1a1a2e;border-radius:16px;padding:24px;width:300px;max-width:85%;text-align:center;margin:auto;position:relative;">
      <div style="color:#e94560;font-size:16px;font-weight:bold;margin-bottom:12px;">${escapeHtml(title)}</div>
      <div style="color:#ddd;font-size:14px;margin-bottom:20px;">${escapeHtml(msg)}</div>
      <div style="display:flex;gap:10px;">
        <button id="mp-confirm-no" style="flex:1;padding:12px;background:#333;border:none;border-radius:10px;color:#fff;cursor:pointer;">取消</button>
        <button id="mp-confirm-yes" style="flex:1;padding:12px;background:#4ade80;border:none;border-radius:10px;color:#000;font-weight:bold;cursor:pointer;">确定</button>
      </div>
    </div>
  `);
  
  $('body').append(overlay);
  
  $('#mp-confirm-no').on('click', function() { overlay.remove(); });
  $('#mp-confirm-yes').on('click', function() {
    overlay.remove();
    if (onConfirm) onConfirm();
  });
}

function showInvitePopup(type, fromName, fromId, roomId) {
  $('.mp-invite-popup').remove();
  
  const title = type === 'invite' ? '收到邀请' : '收到请求';
  const msg = type === 'invite' 
    ? (fromName + ' 邀请你加入房间') 
    : (fromName + ' 请求加入你的房间');
  
  const overlay = $('<div class="mp-invite-popup"></div>');
  overlay.css({
    'position': 'fixed',
    'top': '0',
    'left': '0',
    'right': '0',
    'bottom': '0',
    'width': '100%',
    'height': '100%',
    'background': 'rgba(0,0,0,0.8)',
    'z-index': '2147483647',
    'display': 'flex',
    'align-items': 'center',
    'justify-content': 'center'
  });
  
  overlay.html(`
    <div style="background:#1a1a2e;border-radius:16px;padding:20px;width:280px;max-width:85%;box-shadow:0 10px 40px rgba(0,0,0,0.8);margin:auto;position:relative;">
      <div style="color:#e94560;font-size:16px;font-weight:bold;margin-bottom:8px;">${title}</div>
      <div style="color:#ddd;font-size:14px;margin-bottom:16px;">${escapeHtml(msg)}</div>
      <div style="display:flex;gap:10px;">
        <button id="mp-invite-no" style="flex:1;padding:10px;background:#333;border:none;border-radius:8px;color:#fff;cursor:pointer;">拒绝</button>
        <button id="mp-invite-yes" style="flex:1;padding:10px;background:#4ade80;border:none;border-radius:8px;color:#000;font-weight:bold;cursor:pointer;">接受</button>
      </div>
    </div>
  `);
  
  $('body').append(overlay);
  
  const autoClose = setTimeout(function() { overlay.remove(); }, 15000);
  
  $('#mp-invite-no').on('click', function() {
    clearTimeout(autoClose);
    overlay.remove();
  });
  
  $('#mp-invite-yes').on('click', function() {
    clearTimeout(autoClose);
    overlay.remove();
    if (type === 'invite') {
      sendWS({ type: 'acceptInvite', roomId: roomId });
    } else {
      sendWS({ type: 'acceptRequest', fromId: fromId });
    }
  });
}

// ========================================
// 扩展设置面板UI
// ========================================

function createExtensionUI() {
  const html = `
    <div id="mp-extension-settings" class="extension-panel">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>酒馆联机</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
        </div>
        <div class="inline-drawer-content">
          <div class="mp-ext-status" id="mp-ext-status">
            <span class="mp-ext-dot"></span>
            <span id="mp-menu-text">未连接</span>
          </div>
          <div id="mp-current-version" style="color:#888;font-size:11px;margin-top:4px;">
            版本: ${CURRENT_VERSION}
          </div>
          <div class="mp-ext-buttons">
            <button id="mp-ext-open-btn" class="menu_button">
              <i class="fa-solid fa-users"></i>
              <span>打开面板</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
  
  $('#extensions_settings').append(html);
  
  $('#mp-ext-open-btn').on('click', openPanel);
  
  updateMenuText();
  
  log('扩展UI已创建');
}

// ========================================
// 初始化扩展
// ========================================

function loadSettings() {
  extension_settings[extensionName] = extension_settings[extensionName] || {};
  if (Object.keys(extension_settings[extensionName]).length === 0) {
    Object.assign(extension_settings[extensionName], defaultSettings);
  }
}

jQuery(async () => {
  log('扩展加载中... v' + CURRENT_VERSION);
  
  loadSettings();
  
  waitForUserName(function() {
    lastKnownUserName = userName;
    
    createExtensionUI();
    
    setupActivityListener();
    setupSendInterceptor();
    setupEventListeners();
    setupUserNameWatcher();
    
    if (canAutoReconnect()) {
      log('检测到有效会话，尝试自动重连');
      setTimeout(function() {
        isNormalDisconnect = false;
        isInactiveKick = false;
        connectServer();
      }, 1000);
    }
    
    log('扩展加载完成');
  });
});

// ========================================
// 调试命令导出（精简版）
// ========================================

window.mpDebug = {
  // 基础状态
  state: function() {
    console.log('===== 联机状态 =====');
    console.log('版本:', CURRENT_VERSION);
    console.log('连接状态:', isConnected);
    console.log('用户ID:', odId);
    console.log('用户名:', userName);
    console.log('当前房间:', currentRoom);
    console.log('房间用户:', roomUsers);
    console.log('轮次状态:', turnState);
    console.log('远程上下文缓存:', remoteContextCache.size);
    console.log('保护器数量:', RemoteMessageGuard.protected.size);
    console.log('正在生成:', isGenerating);
    console.log('====================');
  },
  
  // 连接控制
  connect: connectServer,
  disconnect: normalDisconnect,
  openPanel: openPanel,
  
  // 恢复远程消息
  restoreRemote: restoreRemoteMessages,
  
  // 测试清理函数
  testClean: function(messageId) {
    const chat = getChat();
    const id = messageId !== undefined ? messageId : chat.length - 1;
    
    const mesText = document.querySelector(`.mes[mesid="${id}"] .mes_text`);
    if (!mesText) {
      console.log('找不到消息 #' + id);
      return;
    }
    
    console.log('===== 清理测试 #' + id + ' =====');
        console.log('原始HTML长度:', mesText.innerHTML.length);
    console.log('有酒馆助手痕迹:', hasTavernHelperTraces(mesText));
    console.log('有我们的渲染痕迹:', hasOurRenderTraces(mesText));
    
    const cleaned = cleanHtmlForSync(mesText.innerHTML);
    
    console.log('清理后HTML长度:', cleaned.length);
    console.log('清理后前300字符:', cleaned.substring(0, 300));
    console.log('===========================');
    
    return cleaned;
  },
  
  // 测试内部渲染器
  testRenderer: function(html, messageId) {
    const testHtml = html || '<pre><code class="language-html">&lt;!DOCTYPE html&gt;\n&lt;html&gt;\n&lt;head&gt;&lt;/head&gt;\n&lt;body&gt;&lt;h1&gt;Test&lt;/h1&gt;&lt;/body&gt;\n&lt;/html&gt;</code></pre>';
    const id = messageId || 0;
    
    console.log('===== 测试内部渲染器 =====');
    console.log('输入长度:', testHtml.length);
    console.log('输入前100字符:', testHtml.substring(0, 100));
    
    const rendered = InternalRenderer.render(testHtml, id);
    
    console.log('输出长度:', rendered.length);
    console.log('输出前300字符:', rendered.substring(0, 300));
    console.log('包含mp-render:', rendered.includes('mp-render'));
    console.log('包含mp-iframe:', rendered.includes('mp-iframe'));
    console.log('包含srcdoc:', rendered.includes('srcdoc'));
    console.log('==========================');
    
    return rendered;
  },
  
  // 测试保护器
  testProtector: function(messageId) {
    const chat = getChat();
    const id = messageId !== undefined ? messageId : chat.length - 1;
    
    console.log('===== 保护器状态 #' + id + ' =====');
    console.log('chat[].extra.isRemote:', chat[id]?.extra?.isRemote);
    console.log('chat[].extra.remoteFormattedHtml 长度:', chat[id]?.extra?.remoteFormattedHtml?.length || 0);
    console.log('保护器是否存在:', RemoteMessageGuard.isProtected(id));
    console.log('data-remote属性:', $(`.mes[mesid="${id}"]`).attr('data-remote'));
    console.log('==============================');
  },
  
  // 模拟接收远程消息（测试用）
  simulateRemote: function(html) {
    const chat = getChat();
    const ctx = getContext();
    
    const testHtml = html || '<p>这是一条<strong>测试</strong>远程消息</p><pre><code class="language-html">&lt;!DOCTYPE html&gt;\n&lt;html&gt;\n&lt;head&gt;&lt;title&gt;Test&lt;/title&gt;&lt;/head&gt;\n&lt;body&gt;&lt;h1&gt;Hello World&lt;/h1&gt;&lt;/body&gt;\n&lt;/html&gt;</code></pre>';
    
    const message = {
      name: '测试AI',
      is_user: false,
      is_system: false,
      send_date: getMessageTimeStamp(),
      mes: '[远程消息]',
      extra: { isRemote: true }
    };
    
    chat.push(message);
    const messageId = chat.length - 1;
    ctx.addOneMessage(message, { forceId: messageId, scroll: true });
    
    // 标记
    $(`.mes[mesid="${messageId}"]`).attr('data-remote', 'true');
    
    // 内部渲染
    const renderedHtml = InternalRenderer.render(testHtml, messageId);
    
    // 存储
    chat[messageId].extra.remoteFormattedHtml = renderedHtml;
    chat[messageId].extra.remoteSender = '测试用户';
    chat[messageId].extra.remoteSenderId = 'test-id';
    chat[messageId].extra.remoteCharName = '测试AI';
    
    // 覆盖DOM
    const mesText = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
    if (mesText) {
      mesText.innerHTML = renderedHtml;
      InternalRenderer.setupIframeAutoHeight(mesText);
    }
    
    // 设置保护器
    RemoteMessageGuard.protect(messageId, renderedHtml);
    
    // 添加标签
    addRemoteTag(messageId, '联机AI', 'ai');
    
    console.log('已创建测试远程消息 #' + messageId);
    console.log('渲染后HTML长度:', renderedHtml.length);
    console.log('包含mp-iframe:', renderedHtml.includes('mp-iframe'));
    
    return messageId;
  },
  
  // 手动触发污染测试
  triggerCorruption: function(messageId) {
    const chat = getChat();
    const id = messageId !== undefined ? messageId : chat.length - 1;
    
    const mesText = document.querySelector(`.mes[mesid="${id}"] .mes_text`);
    if (!mesText) {
      console.log('找不到消息 #' + id);
      return;
    }
    
    console.log('手动触发污染测试 #' + id + '...');
    console.log('当前内容长度:', mesText.innerHTML.length);
    
    // 尝试污染
    mesText.innerHTML = '<p>这是被污染的内容</p>';
    
    console.log('已尝试污染，等待保护器响应...');
    
    // 检查保护器是否生效
    setTimeout(() => {
      console.log('100ms后内容长度:', mesText.innerHTML.length);
      console.log('保护器是否恢复:', mesText.innerHTML.length > 50);
    }, 100);
  },
  
  // 列出所有受保护的消息
  listProtected: function() {
    console.log('===== 受保护的消息 =====');
    console.log('数量:', RemoteMessageGuard.protected.size);
    RemoteMessageGuard.protected.forEach((guard, messageId) => {
      console.log('  #' + messageId + ': HTML长度=' + guard.html.length);
    });
    console.log('========================');
  },
  
  // 清除所有保护器
  clearProtectors: function() {
    RemoteMessageGuard.clear();
    console.log('已清除所有保护器');
  },
  
  // 显示远程上下文缓存
  showRemoteCache: function() {
    console.log('===== 远程上下文缓存 =====');
    console.log('缓存数量:', remoteContextCache.size);
    remoteContextCache.forEach((data, odId) => {
      console.log('\n玩家ID:', odId);
      console.log('  用户名:', data.userName);
      console.log('  世界书Before:', (data.worldInfo?.before?.substring(0, 100) || '空') + '...');
      console.log('  世界书After:', (data.worldInfo?.after?.substring(0, 100) || '空') + '...');
      console.log('  角色描述:', (data.character?.description?.substring(0, 100) || '空') + '...');
      console.log('  聊天历史条数:', data.chatHistory?.length || 0);
    });
    console.log('==========================');
  },
  
  // 清除远程上下文缓存
  clearRemoteCache: function() {
    remoteContextCache.clear();
    console.log('已清除远程上下文缓存');
  },
  
  // 强制捕获当前消息
  forceCapture: function() {
    const chat = getChat();
    if (chat.length === 0) {
      console.log('聊天为空');
      return null;
    }
    
    const lastId = chat.length - 1;
    const mesText = document.querySelector(`.mes[mesid="${lastId}"] .mes_text`);
    
    if (!mesText) {
      console.log('找不到消息元素');
      return null;
    }
    
    console.log('===== 强制捕获 #' + lastId + ' =====');
    console.log('原始HTML长度:', mesText.innerHTML.length);
    console.log('有酒馆助手痕迹:', hasTavernHelperTraces(mesText));
    
    const cleaned = cleanHtmlForSync(mesText.innerHTML);
    
    console.log('清理后长度:', cleaned.length);
    console.log('清理后前200字符:', cleaned.substring(0, 200));
    console.log('================================');
    
    return cleaned;
  },
  
  // 获取引用
  get chat() { return getChat(); },
  get contextCache() { return remoteContextCache; },
  get guard() { return RemoteMessageGuard; },
  get renderer() { return InternalRenderer; },
  get turn() { return turnState; }
};

log('========================================');
log('调试命令已注册: window.mpDebug');
log('========================================');
log('基础命令:');
log('  mpDebug.state() - 查看联机状态');
log('  mpDebug.connect() - 连接服务器');
log('  mpDebug.disconnect() - 断开连接');
log('  mpDebug.openPanel() - 打开面板');
log('========================================');
log('测试命令:');
log('  mpDebug.testClean(id) - 测试清理函数');
log('  mpDebug.testRenderer(html) - 测试内部渲染器');
log('  mpDebug.testProtector(id) - 测试保护器状态');
log('  mpDebug.simulateRemote(html) - 模拟接收远程消息');
log('  mpDebug.triggerCorruption(id) - 触发污染测试');
log('  mpDebug.forceCapture() - 强制捕获当前消息');
log('========================================');
log('保护器命令:');
log('  mpDebug.listProtected() - 列出受保护的消息');
log('  mpDebug.clearProtectors() - 清除所有保护器');
log('  mpDebug.restoreRemote() - 恢复远程消息');
log('========================================');
log('缓存命令:');
log('  mpDebug.showRemoteCache() - 显示远程上下文');
log('  mpDebug.clearRemoteCache() - 清除远程上下文');
log('========================================');