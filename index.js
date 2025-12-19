// ========================================
// 酒馆联机扩展 v3.2.0
// 服务器: wss://chu.zeabur.app
// 核心改动:
//   - 用户消息同步
//   - 房间边界标记（只同步进房间后的互动）
//   - 使用 WORLD_INFO_ACTIVATED + CHAT_COMPLETION_PROMPT_READY 提取/注入背景
//   - 同步内容查看面板
// ========================================

import { eventSource, event_types } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { getRegexedString, regex_placement } from '../../regex/engine.js';

// ========== 扩展配置 ==========
const extensionName = 'stli';
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// ========== 版本信息 ==========
const CURRENT_VERSION = '3.2.0';

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

// ========== 房间边界标记 ==========
let roomJoinMessageIndex = 0;

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

// ========== 世界书缓存 ==========
let lastActivatedWorldInfo = [];

// ========== 本地同步数据记录（用于查看面板）==========
let lastSentBackground = null;
let lastSentUserMessage = null;

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
  
  createRenderStructure(preElement, htmlContent, messageId, index) {
  const container = document.createElement('div');
  container.className = 'mp-render';
  
  // 把原始代码存到 data 属性（不用 <pre> 标签）
  try {
    container.dataset.originalCode = btoa(encodeURIComponent(htmlContent));
  } catch (e) {
    container.dataset.originalCode = '';
  }
  container.dataset.messageId = String(messageId);
  container.dataset.index = String(index);
  
  // 只创建 iframe，不保留 <pre>
  const iframe = document.createElement('iframe');
  iframe.id = 'mp-message--' + messageId + '--' + index;
  iframe.className = 'mp-iframe';
  iframe.setAttribute('loading', 'lazy');
  iframe.setAttribute('frameborder', '0');
  iframe.style.cssText = 'width: 100%; border: none; min-height: 200px; display: block;';
  iframe.srcdoc = this.wrapHtmlDocument(htmlContent);
  
  // 只添加 iframe
  container.appendChild(iframe);
  
  preElement.parentNode.replaceChild(container, preElement);
  
  return container;
},
  
  render(rawHtml, messageId = 0) {
    if (!rawHtml) return '';
    
    const sandbox = document.createElement('div');
    sandbox.innerHTML = rawHtml;
    
    const preTags = sandbox.querySelectorAll('pre');
    let renderIndex = 0;
    
    preTags.forEach(pre => {
      const code = pre.querySelector('code');
      if (!code) return;
      
      const content = code.textContent;
      if (!isFrontend(content)) return;
      
      this.createRenderStructure(pre, content, messageId, renderIndex);
      renderIndex++;
    });
    
    return sandbox.innerHTML;
  },
  
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
  
  temp.querySelectorAll('iframe[id^="TH-message--"]').forEach(function(iframe) {
    iframe.remove();
  });
  
  temp.querySelectorAll('.TH-collapse-code-block-button').forEach(function(btn) {
    btn.remove();
  });
  
  temp.querySelectorAll('.TH-render').forEach(function(wrapper) {
    const children = wrapper.querySelectorAll(':scope > :not(iframe)');
    const fragment = document.createDocumentFragment();
    
    children.forEach(function(child) {
      child.classList.remove('hidden!');
      fragment.appendChild(child.cloneNode(true));
    });
    
    wrapper.replaceWith(fragment);
  });
  
  temp.querySelectorAll('.mp-render').forEach(function(wrapper) {
    const pre = wrapper.querySelector('pre');
    if (pre) {
      pre.classList.remove('mp-hidden');
      wrapper.replaceWith(pre);
    } else {
      wrapper.remove();
    }
  });
  
  temp.querySelectorAll('iframe[id^="mp-message--"]').forEach(function(iframe) {
    iframe.remove();
  });
  
  temp.querySelectorAll('.mp-collapse-button').forEach(function(btn) {
    btn.remove();
  });
  
  temp.querySelectorAll('*').forEach(function(el) {
    el.classList.remove('hidden!');
    el.classList.remove('mp-hidden');
    el.classList.remove('w-full');
    
    const classes = Array.from(el.classList);
    classes.forEach(function(cls) {
      if (cls.startsWith('TH-') || cls.startsWith('th-') || cls.startsWith('mp-')) {
        el.classList.remove(cls);
      }
    });
    
    Array.from(el.attributes).forEach(function(attr) {
      if (attr.name.startsWith('data-')) {
        el.removeAttribute(attr.name);
      }
    });
  });
  
  temp.querySelectorAll('.code-copy, .fa-copy').forEach(function(btn) {
    btn.remove();
  });
  
  temp.querySelectorAll('.hljs-ln, .hljs-line-numbers').forEach(function(el) {
    el.remove();
  });
  
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
    
    if (el.hasAttribute('style')) {
      let style = el.getAttribute('style');
      style = style.replace(/url\s*$\s*["']?blob:[^)]+["']?\s*$/gi, '');
      style = style.replace(/url\s*$\s*["']?https?:\/\/(localhost|127\.0\.0\.1|192\.168\.[^)]+)["']?\s*$/gi, '');
      if (style.trim()) {
        el.setAttribute('style', style);
      } else {
        el.removeAttribute('style');
      }
    }
  });
  
  temp.querySelectorAll('base, object, embed, script').forEach(function(el) {
    el.remove();
  });
  
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

function hasTavernHelperTraces(element) {
  if (!element) return false;
  return element.querySelector('.TH-render, .TH-collapse-code-block-button, iframe[id^="TH-message--"]') !== null;
}

function hasOurRenderTraces(element) {
  if (!element) return false;
  return element.querySelector('.mp-render, iframe[id^="mp-message--"]') !== null;
}

// ========================================
// 远程消息保护器
// ========================================


const RemoteMessageGuard = {
  protected: new Map(),
  
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
    
    guard.observer = new MutationObserver(function(mutations) {
      if (guard.isRestoring) return;
      
      // 检查是否有酒馆助手的痕迹
      const hasTHTraces = element.querySelector('.TH-render') !== null || 
                           element.querySelector('iframe[id^="TH-message--"]') !== null ||
                           element.querySelector('.TH-collapse-code-block-button') !== null;
      
      if (hasTHTraces) {
        log('🛡️ 检测到酒馆助手痕迹 #' + messageId + '，清除并恢复...');
        
        guard.isRestoring = true;
        element.innerHTML = guard.html;
        InternalRenderer.setupIframeAutoHeight(element);
        
        setTimeout(function() {
          guard.isRestoring = false;
        }, 100);
        return;
      }
      
      // 检查我们的结构是否被破坏
      const hasOurStructure = element.querySelector('.mp-render') !== null || 
                               element.querySelector('iframe.mp-iframe') !== null;
      
      if (hasOurStructure) return;
      
      log('🛡️ 结构被破坏 #' + messageId + '，恢复中...');
      
      guard.isRestoring = true;
      element.innerHTML = guard.html;
      InternalRenderer.setupIframeAutoHeight(element);
      
      setTimeout(function() {
        guard.isRestoring = false;
      }, 100);
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
    this.protected.forEach(function(guard) {
      guard.observer?.disconnect();
    });
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
  roomJoinMessageIndex = 0;
  processedMsgCache.clear();
  remoteStreamMap.clear();
  remoteContextCache.clear();
  lastActivatedWorldInfo = [];
  lastSentBackground = null;
  lastSentUserMessage = null;
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
  
  let tagStyle = '';
  if (type === 'ai') {
    tagStyle = 'background:#6366f1;color:#fff;';
  } else if (type === 'user') {
    tagStyle = 'background:#e94560;color:#fff;';
  } else {
    tagStyle = 'background:#888;color:#fff;';
  }
  
  const tag = $(`<span class="remote-tag" style="${tagStyle}padding:2px 6px;border-radius:4px;font-size:11px;margin-left:6px;">${escapeHtml(labelText)}</span>`);
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
  const maxWait = 40;
  const checkInterval = 50;
  
  function checkAndCapture() {
    waitCount++;
    
    const currentHtml = mesText.innerHTML;
    const isPlaceholder = !currentHtml || 
                          currentHtml.length < 50 || 
                          currentHtml.includes('<p>…</p>') ||
                          currentHtml.includes('<p>...</p>');
    
    if (isPlaceholder && waitCount < maxWait) {
      setTimeout(checkAndCapture, checkInterval);
      return;
    }
    
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
    
    if (hasFrontendCode) {
      const tavernHelperProcessed = hasTavernHelperTraces(mesText);
      
      if (!tavernHelperProcessed && waitCount < 30) {
        setTimeout(checkAndCapture, checkInterval);
        return;
      }
      
      log('酒馆助手已处理: ' + tavernHelperProcessed + '，等待了 ' + (waitCount * checkInterval) + 'ms');
    }
    
    log('开始捕获 #' + messageId + '，等待了 ' + (waitCount * checkInterval) + 'ms');
    
    let html = mesText.innerHTML;
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
  
  const mesElement = document.querySelector(`.mes[mesid="${messageId}"]`);
  if (mesElement) {
    mesElement.setAttribute('data-remote', 'true');
  }
  
  const renderedHtml = InternalRenderer.render(msg.formattedHtml, messageId);
  
  chat[messageId].extra = chat[messageId].extra || {};
  chat[messageId].extra.isRemote = true;
  chat[messageId].extra.isStreaming = false;
  chat[messageId].extra.remoteFormattedHtml = renderedHtml;
  chat[messageId].extra.remoteSenderId = msg.senderId;
  chat[messageId].extra.remoteSenderName = msg.senderName;
  chat[messageId].extra.remoteCharName = msg.charName;
  
  const mesText = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
  if (mesText) {
    mesText.innerHTML = renderedHtml;
    InternalRenderer.setupIframeAutoHeight(mesText);
  }
  
  RemoteMessageGuard.protect(messageId, renderedHtml);
  
  addRemoteTag(messageId, '联机AI', 'ai');
  
  ctx.eventSource.emit(ctx.eventTypes.CHARACTER_MESSAGE_RENDERED, messageId);
  
  if (ctx.saveChat) ctx.saveChat();
  
  log('✅ 远程AI消息完成 #' + messageId + '，渲染后长度: ' + renderedHtml.length);
}

// ========================================
// 处理远程背景同步
// ========================================

function handleRemoteSyncBackground(msg) {
  const { senderId, senderName, background, timestamp } = msg;
  
  remoteContextCache.set(senderId, {
    senderName: senderName,
    background: background,
    timestamp: timestamp
  });
  
  log('收到远程背景，来自: ' + senderName);
}

// ========================================
// 提取并发送本地背景
// ========================================

function extractAndSendBackground() {
  const ctx = getContext();
  
  // 使用 getCharacterCardFields 获取角色卡字段
  const cardFields = ctx.getCharacterCardFields ? ctx.getCharacterCardFields() : {};
  
  // 从缓存的世界书条目中提取内容
  let worldInfoBefore = '';
  let worldInfoAfter = '';
  
  if (lastActivatedWorldInfo && lastActivatedWorldInfo.length > 0) {
    lastActivatedWorldInfo.forEach(entry => {
      if (!entry || !entry.content) return;
      
      if (entry.position === 0) {
        worldInfoBefore += entry.content + '\n';
      } else if (entry.position === 1) {
        worldInfoAfter += entry.content + '\n';
      }
    });
  }
  
  // 从 chat 数组提取本地聊天历史（排除远程消息占位符）
const chat = getChat();
const chatHistory = [];
const chatLength = chat.length;

chat.forEach((msg, index) => {
  // 跳过系统消息
  if (msg.is_system) return;
  
  // 跳过远程消息（占位符）
  if (msg.extra?.isRemote) return;
  
  // 跳过占位符内容
  if (msg.mes === '[远程消息]' || msg.mes === '[远端消息]') return;
  
  // 确定正则类型（用户输入 或 AI输出）
  const regexType = msg.is_user 
    ? regex_placement.USER_INPUT 
    : regex_placement.AI_OUTPUT;
  
  // 计算消息深度（0 = 最新消息）
  const depth = chatLength - index - 1;
  
  // 应用已启用的正则规则处理消息内容
  const cleanedContent = getRegexedString(msg.mes, regexType, {
    isPrompt: true,
    depth: depth
  });
  
  // 提取本地消息
  chatHistory.push({
    role: msg.is_user ? 'user' : 'assistant',
    name: msg.name || (msg.is_user ? ctx.name1 : ctx.name2),
    content: cleanedContent,
    index: index
  });
});
  
  const backgroundData = {
    worldInfoBefore: worldInfoBefore.trim(),
    worldInfoAfter: worldInfoAfter.trim(),
    description: cardFields.description || '',
    personality: cardFields.personality || '',
    scenario: cardFields.scenario || '',
    persona: cardFields.persona || '',
    charName: ctx.name2 || '',
    userName: ctx.name1 || '',
    chatHistory: chatHistory
  };
  
  // 记录发送的背景
  lastSentBackground = {
    ...backgroundData,
    timestamp: Date.now()
  };
  
  sendWS({
    type: 'syncBackground',
    background: backgroundData,
    senderName: userName,
    senderId: odId,
    timestamp: Date.now()
  });
  
  log('已发送背景数据');
  log('  - 世界书Before长度: ' + worldInfoBefore.length);
  log('  - 世界书After长度: ' + worldInfoAfter.length);
  log('  - 角色描述长度: ' + (cardFields.description?.length || 0));
  log('  - 聊天历史条数: ' + chatHistory.length);
}

// ========================================
// 注入远程背景到 messages
// ========================================

function injectRemoteBackground(eventData) {
  // 1. 先移除占位符消息
  const originalLength = eventData.chat.length;
  
  eventData.chat = eventData.chat.filter(msg => {
    // 保留非聊天消息（system 提示词等）
    if (msg.role !== 'user' && msg.role !== 'assistant') return true;
    
    // 移除占位符
    const content = msg.content || '';
    if (content === '[远程消息]' || content === '[远端消息]' || 
        content.trim() === '[远程消息]' || content.trim() === '[远端消息]') {
      log('移除占位符消息');
      return false;
    }
    
    return true;
  });
  
  const removedCount = originalLength - eventData.chat.length;
  if (removedCount > 0) {
    log('已移除 ' + removedCount + ' 条占位符消息');
  }
  
  // 2. 如果没有远程背景缓存，返回
  if (remoteContextCache.size === 0) return;
  
  // 3. 找到合适位置（在聊天历史之前）
  let insertIndex = 3;
  
  for (let i = 0; i < Math.min(eventData.chat.length, 15); i++) {
    const msg = eventData.chat[i];
    if (msg.role === 'user' || msg.role === 'assistant') {
      insertIndex = i;
      break;
    }
  }
  
  // 4. 为每个玩家构建独立的 system 消息
  const injectionMessages = [];
  
  remoteContextCache.forEach((data, odId) => {
    const bg = data.background;
    const playerName = data.senderName || '未知玩家';
    const charName = bg.charName || '角色';
    
    // 构建内容
    let content = '';
    
    // 醒目的开头标记
    content += '╔══════════════════════════════════════════╗\n';
    content += '║  🌐 远程玩家: ' + playerName + ' | 角色: ' + charName + '\n';
    content += '╚══════════════════════════════════════════╝\n\n';
    
    // 世界书
    if (bg.worldInfoBefore) {
      content += '【世界书-前置】\n' + bg.worldInfoBefore + '\n\n';
    }
    if (bg.worldInfoAfter) {
      content += '【世界书-后置】\n' + bg.worldInfoAfter + '\n\n';
    }
    
    // 角色卡
    if (bg.description) {
      content += '【角色描述】\n' + bg.description + '\n\n';
    }
    if (bg.personality) {
      content += '【角色性格】\n' + bg.personality + '\n\n';
    }
    if (bg.scenario) {
      content += '【场景】\n' + bg.scenario + '\n\n';
    }
    
    // 用户人设
    if (bg.persona) {
      content += '【' + playerName + ' 的人设】\n' + bg.persona + '\n\n';
    }
    
    // 聊天历史
    if (bg.chatHistory && bg.chatHistory.length > 0) {
      content += '【聊天历史】\n';
      bg.chatHistory.forEach(msg => {
        const roleTag = msg.role === 'user' ? '[用户]' : '[角色]';
        const msgName = msg.name || (msg.role === 'user' ? playerName : charName);
        content += roleTag + ' ' + msgName + ': ' + msg.content + '\n';
      });
      content += '\n';
    }
    
    // 结束标记
    content += '══════════════ 背景结束 ══════════════';
    
    // 如果有实际内容才添加（不只是框架）
    const hasContent = bg.worldInfoBefore || bg.worldInfoAfter || 
                       bg.description || bg.personality || bg.scenario || 
                       bg.persona || (bg.chatHistory && bg.chatHistory.length > 0);
    
    if (hasContent) {
      // 清理 name 字段（只保留字母数字下划线）
      const safeName = 'REMOTE_' + playerName.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_');
      
      injectionMessages.push({
        role: 'system',
        name: safeName,
        content: content
      });
    }
  });
  
  // 5. 插入所有消息
  if (injectionMessages.length > 0) {
    eventData.chat.splice(insertIndex, 0, ...injectionMessages);
    log('已注入 ' + injectionMessages.length + ' 条远程玩家背景，位置: ' + insertIndex);
  }
}

// ========================================
// 恢复远程消息（刷新后）
// ========================================

function restoreRemoteMessages() {
  const chat = getChat();
  if (!chat || chat.length === 0) return;
  
  let restoredCount = 0;
  
  chat.forEach((msg, messageId) => {
    if (!msg?.extra?.isRemote) return;
    
    const mesText = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
    if (!mesText) return;
    
    const mesElement = mesText.closest('.mes');
    if (mesElement) {
      mesElement.setAttribute('data-remote', 'true');
    }
    
    if (msg.is_user) {
      addRemoteTag(messageId, '用户', 'user');
      restoredCount++;
      return;
    }
    
    if (msg.extra.remoteFormattedHtml) {
      const renderedHtml = InternalRenderer.render(msg.extra.remoteFormattedHtml, messageId);
      msg.extra.remoteFormattedHtml = renderedHtml;
      mesText.innerHTML = renderedHtml;
      InternalRenderer.setupIframeAutoHeight(mesText);
      RemoteMessageGuard.protect(messageId, renderedHtml);
      addRemoteTag(messageId, '联机AI', 'ai');
      restoredCount++;
    }
  });
  
  if (restoredCount > 0) {
    log('✅ 已恢复 ' + restoredCount + ' 条远程消息');
  }
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
    // 目前仅用于监控
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
  setupFunctionLocks();
  
  // ========== 第①步：生成开始 ==========
  eventSource.on(event_types.GENERATION_STARTED, function(type, options, dryRun) {
    if (dryRun) return;
    if (!currentRoom) return;
    
    log('事件: 生成开始');
    isGenerating = true;
    lastActivatedWorldInfo = [];  // 重置世界书缓存
  });
  
  // ========== 第③步：用户消息同步 ==========
  eventSource.on(event_types.MESSAGE_SENT, function(messageIndex) {
    if (!currentRoom) return;
    if (!turnState.isMyTurn) return;
    if (messageIndex < roomJoinMessageIndex) return;
    
    const chat = getChat();
    const message = chat[messageIndex];
    
    if (!message || !message.is_user || message.extra?.isRemote) return;
    
    log('同步用户消息 #' + messageIndex);
    
    lastSentUserMessage = {
      content: message.mes,
      userName: message.name,
      timestamp: Date.now()
    };
    
    sendWS({
      type: 'syncUserMessage',
      content: message.mes,
      userName: message.name,
      messageIndex: messageIndex,
      senderName: userName,
      senderId: odId,
      timestamp: Date.now()
    });
  });
  
  // ========== 第⑥步：缓存世界书 ==========
  eventSource.on(event_types.WORLD_INFO_ACTIVATED, function(activatedEntries) {
    if (!currentRoom) return;
    
    lastActivatedWorldInfo = activatedEntries || [];
    
    log('世界书已激活，条目数: ' + lastActivatedWorldInfo.length);
  });
  
  // ========== 第9.5步：提取 + 注入 ==========
eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, function(eventData) {
  if (!currentRoom) return;
  
  log('事件: CHAT_COMPLETION_PROMPT_READY, dryRun=' + eventData.dryRun);
  
  // 1. 如果是我的回合且正在生成，提取并发送背景（仅在非 dryRun 时）
  if (!eventData.dryRun && turnState.isMyTurn && isGenerating) {
    extractAndSendBackground();
  }
  
  // 2. 如果有远程背景缓存，注入到 messages（dryRun 时也要注入，这样提示词查看器能看到）
  if (remoteContextCache.size > 0) {
    injectRemoteBackground(eventData);
  }
});
  
  // ========== 流式同步 ==========
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
  
  // ========== 生成结束 ==========
  eventSource.on(event_types.GENERATION_ENDED, function(messageCount) {
    if (!currentRoom) return;
    if (!turnState.isMyTurn || !isGenerating) return;
    
    log('事件: 生成结束');
    
    const chat = getChat();
    const messageId = chat.length - 1;
    
    if (messageId < roomJoinMessageIndex) {
      isGenerating = false;
      return;
    }
    
    const lastMsg = chat[messageId];
    
    if (!lastMsg || lastMsg.is_user || lastMsg.extra?.isRemote) {
      isGenerating = false;
      return;
    }
    
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
    lastActivatedWorldInfo = [];
    
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
      roomJoinMessageIndex = getChat().length;
      toast('success', '房间: ' + msg.roomId);
      refreshPanel();
      break;
    
    case 'joinedRoom':
      currentRoom = msg.roomId;
      roomUsers = msg.users || [];
      chatMessages = msg.messages || [];
      roomJoinMessageIndex = getChat().length;
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
    
    case 'remoteSyncBackground':
      handleRemoteSyncBackground(msg);
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
// 同步内容查看面板
// ========================================

function buildSyncViewHTML() {
  let html = '<div class="mp-sync-view">';
  
  // ========== 我发送的背景数据 ==========
  html += '<div class="mp-sync-section">';
  html += '<div class="mp-sync-section-title">📤 我发送的背景数据</div>';
  
  if (lastSentBackground) {
    html += '<div class="mp-sync-meta">时间: ' + new Date(lastSentBackground.timestamp).toLocaleTimeString() + '</div>';
    
    // 世界书(前)
    if (lastSentBackground.worldInfoBefore) {
      html += '<div class="mp-sync-field-wrap">';
      html += '<div class="mp-sync-field-header" data-field="sent-wi-before">';
      html += '<span class="mp-sync-field-name">📖 世界书(前)</span>';
      html += '<span class="mp-sync-field-len">' + lastSentBackground.worldInfoBefore.length + ' 字符</span>';
      html += '<span class="mp-sync-expand-icon">▼</span>';
      html += '</div>';
      html += '<div class="mp-sync-field-content" id="sent-wi-before">' + escapeHtml(lastSentBackground.worldInfoBefore) + '</div>';
      html += '</div>';
    }
    
    // 世界书(后)
    if (lastSentBackground.worldInfoAfter) {
      html += '<div class="mp-sync-field-wrap">';
      html += '<div class="mp-sync-field-header" data-field="sent-wi-after">';
      html += '<span class="mp-sync-field-name">📖 世界书(后)</span>';
      html += '<span class="mp-sync-field-len">' + lastSentBackground.worldInfoAfter.length + ' 字符</span>';
      html += '<span class="mp-sync-expand-icon">▼</span>';
      html += '</div>';
      html += '<div class="mp-sync-field-content" id="sent-wi-after">' + escapeHtml(lastSentBackground.worldInfoAfter) + '</div>';
      html += '</div>';
    }
    
    // 角色描述
    if (lastSentBackground.description) {
      html += '<div class="mp-sync-field-wrap">';
      html += '<div class="mp-sync-field-header" data-field="sent-desc">';
      html += '<span class="mp-sync-field-name">👤 角色描述</span>';
      html += '<span class="mp-sync-field-len">' + lastSentBackground.description.length + ' 字符</span>';
      html += '<span class="mp-sync-expand-icon">▼</span>';
      html += '</div>';
      html += '<div class="mp-sync-field-content" id="sent-desc">' + escapeHtml(lastSentBackground.description) + '</div>';
      html += '</div>';
    }
    
    // 角色性格
    if (lastSentBackground.personality) {
      html += '<div class="mp-sync-field-wrap">';
      html += '<div class="mp-sync-field-header" data-field="sent-personality">';
      html += '<span class="mp-sync-field-name">💭 角色性格</span>';
      html += '<span class="mp-sync-field-len">' + lastSentBackground.personality.length + ' 字符</span>';
      html += '<span class="mp-sync-expand-icon">▼</span>';
      html += '</div>';
      html += '<div class="mp-sync-field-content" id="sent-personality">' + escapeHtml(lastSentBackground.personality) + '</div>';
      html += '</div>';
    }
    
    // 场景
    if (lastSentBackground.scenario) {
      html += '<div class="mp-sync-field-wrap">';
      html += '<div class="mp-sync-field-header" data-field="sent-scenario">';
      html += '<span class="mp-sync-field-name">🎬 场景</span>';
      html += '<span class="mp-sync-field-len">' + lastSentBackground.scenario.length + ' 字符</span>';
      html += '<span class="mp-sync-expand-icon">▼</span>';
      html += '</div>';
      html += '<div class="mp-sync-field-content" id="sent-scenario">' + escapeHtml(lastSentBackground.scenario) + '</div>';
      html += '</div>';
    }
    
    // 用户人设
    if (lastSentBackground.persona) {
      html += '<div class="mp-sync-field-wrap">';
      html += '<div class="mp-sync-field-header" data-field="sent-persona">';
      html += '<span class="mp-sync-field-name">🎭 用户人设</span>';
      html += '<span class="mp-sync-field-len">' + lastSentBackground.persona.length + ' 字符</span>';
      html += '<span class="mp-sync-expand-icon">▼</span>';
      html += '</div>';
      html += '<div class="mp-sync-field-content" id="sent-persona">' + escapeHtml(lastSentBackground.persona) + '</div>';
      html += '</div>';
    }
    
    // 聊天历史
    if (lastSentBackground.chatHistory && lastSentBackground.chatHistory.length > 0) {
      html += '<div class="mp-sync-field-wrap">';
      html += '<div class="mp-sync-field-header" data-field="sent-chat-history">';
      html += '<span class="mp-sync-field-name">💬 聊天历史</span>';
      html += '<span class="mp-sync-field-len">' + lastSentBackground.chatHistory.length + ' 条</span>';
      html += '<span class="mp-sync-expand-icon">▼</span>';
      html += '</div>';
      html += '<div class="mp-sync-field-content" id="sent-chat-history">';
      lastSentBackground.chatHistory.forEach(msg => {
  const roleTag = msg.role === 'user' ? '[用户]' : '[角色]';
  html += '<div class="mp-sync-chat-msg">';
  html += '<div class="mp-sync-chat-role ' + msg.role + '">' + roleTag + '</div>';
  html += '<div class="mp-sync-chat-name">' + escapeHtml(msg.name) + '</div>';
  html += '<div class="mp-sync-chat-content">' + escapeHtml(msg.content) + '</div>';
  html += '</div>';
});
      html += '</div>';
      html += '</div>';
    }
    
    // 如果没有任何内容
    if (!lastSentBackground.worldInfoBefore && !lastSentBackground.worldInfoAfter && 
        !lastSentBackground.description && !lastSentBackground.personality && 
        !lastSentBackground.scenario && !lastSentBackground.persona &&
        (!lastSentBackground.chatHistory || lastSentBackground.chatHistory.length === 0)) {
      html += '<div class="mp-sync-empty">背景数据为空</div>';
    }
    
  } else {
    html += '<div class="mp-sync-empty">暂无发送的背景数据</div>';
  }
  
  html += '</div>';
  
  // ========== 收到的远程背景 ==========
  html += '<div class="mp-sync-section">';
  html += '<div class="mp-sync-section-title">📥 收到的远程背景 (' + remoteContextCache.size + ')</div>';
  
  if (remoteContextCache.size === 0) {
    html += '<div class="mp-sync-empty">暂无收到其他玩家的背景数据</div>';
  } else {
    let playerIndex = 0;
    remoteContextCache.forEach((data, odId) => {
      playerIndex++;
      const bg = data.background;
      const prefix = 'recv-' + playerIndex + '-';
      
      html += '<div class="mp-sync-player">';
      html += '<div class="mp-sync-player-header">';
      html += '<span class="mp-sync-player-name">👤 ' + escapeHtml(data.senderName) + '</span>';
      html += '<span class="mp-sync-player-time">' + new Date(data.timestamp).toLocaleTimeString() + '</span>';
      html += '</div>';
      
      // 世界书(前)
      if (bg.worldInfoBefore) {
        html += '<div class="mp-sync-field-wrap">';
        html += '<div class="mp-sync-field-header" data-field="' + prefix + 'wi-before">';
        html += '<span class="mp-sync-field-name">📖 世界书(前)</span>';
        html += '<span class="mp-sync-field-len">' + bg.worldInfoBefore.length + ' 字符</span>';
        html += '<span class="mp-sync-expand-icon">▼</span>';
        html += '</div>';
        html += '<div class="mp-sync-field-content" id="' + prefix + 'wi-before">' + escapeHtml(bg.worldInfoBefore) + '</div>';
        html += '</div>';
      }
      
      // 世界书(后)
      if (bg.worldInfoAfter) {
        html += '<div class="mp-sync-field-wrap">';
        html += '<div class="mp-sync-field-header" data-field="' + prefix + 'wi-after">';
        html += '<span class="mp-sync-field-name">📖 世界书(后)</span>';
        html += '<span class="mp-sync-field-len">' + bg.worldInfoAfter.length + ' 字符</span>';
        html += '<span class="mp-sync-expand-icon">▼</span>';
        html += '</div>';
        html += '<div class="mp-sync-field-content" id="' + prefix + 'wi-after">' + escapeHtml(bg.worldInfoAfter) + '</div>';
        html += '</div>';
      }
      
      // 角色描述
      if (bg.description) {
        html += '<div class="mp-sync-field-wrap">';
        html += '<div class="mp-sync-field-header" data-field="' + prefix + 'desc">';
        html += '<span class="mp-sync-field-name">👤 角色描述</span>';
        html += '<span class="mp-sync-field-len">' + bg.description.length + ' 字符</span>';
        html += '<span class="mp-sync-expand-icon">▼</span>';
        html += '</div>';
        html += '<div class="mp-sync-field-content" id="' + prefix + 'desc">' + escapeHtml(bg.description) + '</div>';
        html += '</div>';
      }
      
      // 角色性格
      if (bg.personality) {
        html += '<div class="mp-sync-field-wrap">';
        html += '<div class="mp-sync-field-header" data-field="' + prefix + 'personality">';
        html += '<span class="mp-sync-field-name">💭 角色性格</span>';
        html += '<span class="mp-sync-field-len">' + bg.personality.length + ' 字符</span>';
        html += '<span class="mp-sync-expand-icon">▼</span>';
        html += '</div>';
        html += '<div class="mp-sync-field-content" id="' + prefix + 'personality">' + escapeHtml(bg.personality) + '</div>';
        html += '</div>';
      }
      
      // 场景
      if (bg.scenario) {
        html += '<div class="mp-sync-field-wrap">';
        html += '<div class="mp-sync-field-header" data-field="' + prefix + 'scenario">';
        html += '<span class="mp-sync-field-name">🎬 场景</span>';
        html += '<span class="mp-sync-field-len">' + bg.scenario.length + ' 字符</span>';
        html += '<span class="mp-sync-expand-icon">▼</span>';
        html += '</div>';
        html += '<div class="mp-sync-field-content" id="' + prefix + 'scenario">' + escapeHtml(bg.scenario) + '</div>';
        html += '</div>';
      }
      
      // 用户人设
      if (bg.persona) {
        html += '<div class="mp-sync-field-wrap">';
        html += '<div class="mp-sync-field-header" data-field="' + prefix + 'persona">';
        html += '<span class="mp-sync-field-name">🎭 用户人设</span>';
        html += '<span class="mp-sync-field-len">' + bg.persona.length + ' 字符</span>';
        html += '<span class="mp-sync-expand-icon">▼</span>';
        html += '</div>';
        html += '<div class="mp-sync-field-content" id="' + prefix + 'persona">' + escapeHtml(bg.persona) + '</div>';
        html += '</div>';
      }
      
      // 聊天历史
      if (bg.chatHistory && bg.chatHistory.length > 0) {
        html += '<div class="mp-sync-field-wrap">';
        html += '<div class="mp-sync-field-header" data-field="' + prefix + 'chat-history">';
        html += '<span class="mp-sync-field-name">💬 聊天历史</span>';
        html += '<span class="mp-sync-field-len">' + bg.chatHistory.length + ' 条</span>';
        html += '<span class="mp-sync-expand-icon">▼</span>';
        html += '</div>';
        html += '<div class="mp-sync-field-content" id="' + prefix + 'chat-history">';
        bg.chatHistory.forEach(msg => {
  const roleTag = msg.role === 'user' ? '[用户]' : '[角色]';
  html += '<div class="mp-sync-chat-msg">';
  html += '<div class="mp-sync-chat-role ' + msg.role + '">' + roleTag + '</div>';
  html += '<div class="mp-sync-chat-name">' + escapeHtml(msg.name) + '</div>';
  html += '<div class="mp-sync-chat-content">' + escapeHtml(msg.content) + '</div>';
  html += '</div>';
});
        html += '</div>';
        html += '</div>';
      }
      
      // 如果没有任何内容
      if (!bg.worldInfoBefore && !bg.worldInfoAfter && !bg.description && 
          !bg.personality && !bg.scenario && !bg.persona &&
          (!bg.chatHistory || bg.chatHistory.length === 0)) {
        html += '<div class="mp-sync-empty">该玩家的背景数据为空</div>';
      }
      
      html += '</div>';
    });
  }
  
  html += '</div>';
  
  html += '</div>';
  
  return html;
}

function openSyncViewPanel() {
  closeSyncViewPanel();
  
  const overlay = $('<div id="mp-sync-view-overlay"></div>');
  overlay.css({
    'position': 'fixed',
    'top': '0',
    'left': '0',
    'width': '100%',
    'height': '100%',
    'background': 'rgba(0,0,0,0.8)',
    'z-index': '2147483647',
    'display': 'flex',
    'align-items': 'center',
    'justify-content': 'center',
    'padding': '20px',
    'box-sizing': 'border-box'
  });
  
  overlay.on('click', function(e) {
    if (e.target === this) closeSyncViewPanel();
  });
  
  const panel = $('<div id="mp-sync-view-panel"></div>');
panel.css({
  'background': '#1a1a2e',
  'border-radius': '16px',
  'width': '600px',
  'max-width': '95%',
  'max-height': '70vh',
  'overflow': 'hidden',
  'display': 'flex',
  'flex-direction': 'column',
  'margin': 'auto'
});
  
  const header = $('<div class="mp-sync-header"></div>');
  header.css({
    'padding': '16px 20px',
    'border-bottom': '1px solid #333',
    'display': 'flex',
    'justify-content': 'space-between',
    'align-items': 'center',
    'flex-shrink': '0'
  });
  header.html('<div style="color:#e94560;font-size:16px;font-weight:bold;">📊 同步内容查看</div><button id="mp-sync-close" style="background:none;border:none;color:#888;font-size:24px;cursor:pointer;">×</button>');
  
  const content = $('<div class="mp-sync-content"></div>');
content.css({
  'padding': '20px',
  'padding-bottom': '30px',
  'overflow-y': 'auto',
  'overflow-x': 'hidden',
  'flex': '1'
});
  content.html(buildSyncViewHTML());
  
  panel.append(header);
  panel.append(content);
  overlay.append(panel);
  $('body').append(overlay);
  
  // 添加样式
  if (!$('#mp-sync-view-styles').length) {
    const styles = $('<style id="mp-sync-view-styles"></style>');
    styles.text(`
  .mp-sync-view {
    color: #ddd;
    font-size: 13px;
  }
  .mp-sync-section {
    margin-bottom: 20px;
  }
  .mp-sync-section:last-child {
    margin-bottom: 0;
  }
  .mp-sync-section-title {
    color: #4ade80;
    font-size: 14px;
    font-weight: bold;
    margin-bottom: 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid #333;
  }
  .mp-sync-meta {
    color: #666;
    font-size: 11px;
    margin-bottom: 10px;
  }
  .mp-sync-player {
    background: #0f0f1a;
    border-radius: 10px;
    padding: 12px;
    margin-bottom: 12px;
  }
  .mp-sync-player:last-child {
    margin-bottom: 0;
  }
  .mp-sync-player-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
    padding-bottom: 8px;
    border-bottom: 1px solid #333;
  }
  .mp-sync-player-name {
    color: #6366f1;
    font-weight: bold;
  }
  .mp-sync-player-time {
    color: #666;
    font-size: 11px;
  }
  .mp-sync-field-wrap {
    margin-bottom: 8px;
    background: #16213e;
    border-radius: 8px;
    overflow: hidden;
  }
  .mp-sync-field-wrap:last-child {
    margin-bottom: 0;
  }
  .mp-sync-field-header {
    display: flex;
    align-items: center;
    padding: 10px 12px;
    cursor: pointer;
    user-select: none;
    transition: background 0.2s;
  }
  .mp-sync-field-header:hover {
    background: #1a2744;
  }
  .mp-sync-field-name {
    color: #e94560;
    font-weight: bold;
    flex: 1;
  }
  .mp-sync-field-len {
    color: #666;
    font-size: 11px;
    margin-right: 10px;
  }
  .mp-sync-expand-icon {
    color: #888;
    font-size: 10px;
    transition: transform 0.2s;
  }
  .mp-sync-field-wrap.expanded .mp-sync-expand-icon {
    transform: rotate(180deg);
  }
  .mp-sync-field-content {
    display: none;
    padding: 12px;
    background: #0a0a14;
    border-top: 1px solid #333;
    white-space: pre-wrap;
    word-break: break-word;
    overflow-wrap: break-word;
    overflow-x: hidden;
    overflow-y: auto;
    max-height: 300px;
    font-size: 12px;
    line-height: 1.5;
    color: #bbb;
  }
  .mp-sync-field-wrap.expanded .mp-sync-field-content {
    display: block;
  }
  .mp-sync-empty {
    color: #666;
    font-style: italic;
    text-align: center;
    padding: 20px;
    background: #0f0f1a;
    border-radius: 8px;
  }

  /* 聊天历史样式 - 三层结构 */
  .mp-sync-chat-msg {
    padding: 10px;
    margin-bottom: 8px;
    background: #1a1a2e;
    border-radius: 6px;
    border-left: 3px solid #333;
  }
  .mp-sync-chat-msg:last-child {
    margin-bottom: 0;
  }
  .mp-sync-chat-role {
    display: block;
    font-weight: bold;
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 4px;
    margin-bottom: 4px;
    width: fit-content;
  }
  .mp-sync-chat-role.user {
    background: #2563eb;
    color: #fff;
  }
  .mp-sync-chat-role.assistant {
    background: #7c3aed;
    color: #fff;
  }
  .mp-sync-chat-name {
    display: block;
    color: #4ade80;
    font-weight: bold;
    font-size: 13px;
    margin-bottom: 6px;
    word-break: break-word;
  }
  .mp-sync-chat-content {
    display: block;
    color: #ccc;
    font-size: 12px;
    line-height: 1.6;
    word-break: break-word;
    overflow-wrap: break-word;
    white-space: pre-wrap;
  }

  /* 滚动条样式 */
  .mp-sync-content::-webkit-scrollbar,
  .mp-sync-field-content::-webkit-scrollbar {
    width: 6px;
  }
  .mp-sync-content::-webkit-scrollbar-track,
  .mp-sync-field-content::-webkit-scrollbar-track {
    background: #0a0a14;
  }
  .mp-sync-content::-webkit-scrollbar-thumb,
  .mp-sync-field-content::-webkit-scrollbar-thumb {
    background: #333;
    border-radius: 3px;
  }
  .mp-sync-content::-webkit-scrollbar-thumb:hover,
  .mp-sync-field-content::-webkit-scrollbar-thumb:hover {
    background: #444;
  }
`);
    $('head').append(styles);
  }
  
  $('#mp-sync-close').on('click', closeSyncViewPanel);
  
  // 点击展开/收起
  $(document).off('click.syncFieldToggle');
  $(document).on('click.syncFieldToggle', '.mp-sync-field-header', function() {
    const wrap = $(this).closest('.mp-sync-field-wrap');
    wrap.toggleClass('expanded');
  });
}

function closeSyncViewPanel() {
  $('#mp-sync-view-overlay').remove();
  $(document).off('click.syncFieldToggle');
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
    
    html += '<div style="margin-top:15px;display:flex;gap:10px;">';
    html += '<button class="mp-btn mp-btn-purple" id="mp-view-sync-btn" style="flex:1;">📊 查看同步内容</button>';
    html += '</div>';
    
    html += '<div style="margin-top:10px;">';
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
  'z-index': '2147483647',
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
    roomJoinMessageIndex = 0;
    processedMsgCache.clear();
    remoteStreamMap.clear();
    remoteContextCache.clear();
    lastActivatedWorldInfo = [];
    lastSentBackground = null;
    lastSentUserMessage = null;
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
  
  $('#mp-view-sync-btn').on('click', function() {
    openSyncViewPanel();
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
  
  // 添加紫色按钮样式
  if (!$('#mp-extra-styles').length) {
    const styles = $('<style id="mp-extra-styles"></style>');
    styles.text(`
      .mp-btn-purple {
        background: linear-gradient(135deg, #6366f1, #8b5cf6) !important;
        color: #fff !important;
      }
      .mp-btn-purple:hover {
        background: linear-gradient(135deg, #4f46e5, #7c3aed) !important;
      }
    `);
    $('head').append(styles);
  }
  
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
// 调试命令导出
// ========================================

window.mpDebug = {
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
    console.log('世界书缓存条目数:', lastActivatedWorldInfo.length);
    console.log('保护器数量:', RemoteMessageGuard.protected.size);
    console.log('正在生成:', isGenerating);
    console.log('房间边界索引:', roomJoinMessageIndex);
    console.log('最后发送的背景:', lastSentBackground);
    console.log('最后发送的用户消息:', lastSentUserMessage);
    console.log('====================');
  },
  
  connect: connectServer,
  disconnect: normalDisconnect,
  openPanel: openPanel,
  openSyncView: openSyncViewPanel,
  
  restoreRemote: restoreRemoteMessages,
  
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
  
  testRenderer: function(html, messageId) {
    const testHtml = html || '<pre><code class="language-html">&lt;!DOCTYPE html&gt;\n&lt;html&gt;\n&lt;head&gt;&lt;/head&gt;\n&lt;body&gt;&lt;h1&gt;Test&lt;/h1&gt;&lt;/body&gt;\n&lt;/html&gt;</code></pre>';
    const id = messageId || 0;
    
    console.log('===== 测试内部渲染器 =====');
    console.log('输入长度:', testHtml.length);
    
    const rendered = InternalRenderer.render(testHtml, id);
    
    console.log('输出长度:', rendered.length);
    console.log('包含mp-render:', rendered.includes('mp-render'));
    console.log('包含mp-iframe:', rendered.includes('mp-iframe'));
    console.log('==========================');
    
    return rendered;
  },
  
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
    
    $(`.mes[mesid="${messageId}"]`).attr('data-remote', 'true');
    
    const renderedHtml = InternalRenderer.render(testHtml, messageId);
    
    chat[messageId].extra.remoteFormattedHtml = renderedHtml;
    chat[messageId].extra.remoteSender = '测试用户';
    chat[messageId].extra.remoteSenderId = 'test-id';
    chat[messageId].extra.remoteCharName = '测试AI';
    
    const mesText = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
    if (mesText) {
      mesText.innerHTML = renderedHtml;
      InternalRenderer.setupIframeAutoHeight(mesText);
    }
    
    RemoteMessageGuard.protect(messageId, renderedHtml);
    addRemoteTag(messageId, '联机AI', 'ai');
    
    console.log('已创建测试远程消息 #' + messageId);
    
    return messageId;
  },
  
  simulateRemoteUser: function(content) {
    const chat = getChat();
    const ctx = getContext();
    
    const testContent = content || '这是一条测试远程用户消息';
    
    const message = {
      name: '远程用户',
      is_user: true,
      is_system: false,
      send_date: getMessageTimeStamp(),
      mes: testContent,
      extra: {
        isRemote: true,
        remoteSender: '测试用户',
        remoteSenderId: 'test-user-id'
      }
    };
    
    chat.push(message);
    const messageId = chat.length - 1;
    ctx.addOneMessage(message, { forceId: messageId, scroll: true });
    
    addRemoteTag(messageId, '用户', 'user');
    
    console.log('已创建测试远程用户消息 #' + messageId);
    
    return messageId;
  },
  
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
    
    mesText.innerHTML = '<p>这是被污染的内容</p>';
    
    console.log('已尝试污染，等待保护器响应...');
    
    setTimeout(() => {
      console.log('100ms后内容长度:', mesText.innerHTML.length);
      console.log('保护器是否恢复:', mesText.innerHTML.length > 50);
    }, 100);
  },
  
  listProtected: function() {
    console.log('===== 受保护的消息 =====');
    console.log('数量:', RemoteMessageGuard.protected.size);
    RemoteMessageGuard.protected.forEach((guard, messageId) => {
      console.log('  #' + messageId + ': HTML长度=' + guard.html.length);
    });
    console.log('========================');
  },
  
  clearProtectors: function() {
    RemoteMessageGuard.clear();
    console.log('已清除所有保护器');
  },
  
  showRemoteCache: function() {
    console.log('===== 远程上下文缓存 =====');
    console.log('缓存数量:', remoteContextCache.size);
    remoteContextCache.forEach((data, odId) => {
      console.log('\n玩家ID:', odId);
      console.log('  用户名:', data.senderName);
      console.log('  世界书Before:', (data.background?.worldInfoBefore?.substring(0, 100) || '空') + '...');
      console.log('  世界书After:', (data.background?.worldInfoAfter?.substring(0, 100) || '空') + '...');
      console.log('  角色描述:', (data.background?.description?.substring(0, 100) || '空') + '...');
    });
    console.log('==========================');
  },
  
  showWorldInfoCache: function() {
    console.log('===== 世界书缓存 =====');
    console.log('条目数量:', lastActivatedWorldInfo.length);
    lastActivatedWorldInfo.forEach((entry, index) => {
      console.log('\n条目 #' + index + ':');
      console.log('  position:', entry.position);
      console.log('  content:', (entry.content?.substring(0, 100) || '空') + '...');
    });
    console.log('======================');
  },
  
  clearRemoteCache: function() {
    remoteContextCache.clear();
    console.log('已清除远程上下文缓存');
  },
  
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
  
  showSentData: function() {
    console.log('===== 已发送的数据 =====');
    console.log('最后发送的用户消息:', lastSentUserMessage);
    console.log('最后发送的背景:', lastSentBackground);
    console.log('========================');
  },
  
  testExtractBackground: function() {
    console.log('===== 测试提取背景 =====');
    const ctx = getContext();
    console.log('getCharacterCardFields 存在:', !!ctx.getCharacterCardFields);
    
    if (ctx.getCharacterCardFields) {
      const cardFields = ctx.getCharacterCardFields();
      console.log('cardFields:', cardFields);
    }
    
    console.log('世界书缓存条目数:', lastActivatedWorldInfo.length);
    console.log('=========================');
  },
  
  get chat() { return getChat(); },
  get contextCache() { return remoteContextCache; },
  get worldInfoCache() { return lastActivatedWorldInfo; },
  get guard() { return RemoteMessageGuard; },
  get renderer() { return InternalRenderer; },
  get turn() { return turnState; },
  get roomBoundary() { return roomJoinMessageIndex; }
};

log('========================================');
log('调试命令已注册: window.mpDebug');
log('========================================');
log('基础命令:');
log('  mpDebug.state() - 查看联机状态');
log('  mpDebug.connect() - 连接服务器');
log('  mpDebug.disconnect() - 断开连接');
log('  mpDebug.openPanel() - 打开面板');
log('  mpDebug.openSyncView() - 打开同步内容查看');
log('========================================');
log('测试命令:');
log('  mpDebug.testClean(id) - 测试清理函数');
log('  mpDebug.testRenderer(html) - 测试内部渲染器');
log('  mpDebug.testProtector(id) - 测试保护器状态');
log('  mpDebug.simulateRemote(html) - 模拟接收远程AI消息');
log('  mpDebug.simulateRemoteUser(content) - 模拟接收远程用户消息');
log('  mpDebug.triggerCorruption(id) - 触发污染测试');
log('  mpDebug.forceCapture() - 强制捕获当前消息');
log('  mpDebug.testExtractBackground() - 测试提取背景');
log('========================================');
log('保护器命令:');
log('  mpDebug.listProtected() - 列出受保护的消息');
log('  mpDebug.clearProtectors() - 清除所有保护器');
log('  mpDebug.restoreRemote() - 恢复远程消息');
log('========================================');
log('缓存命令:');
log('  mpDebug.showRemoteCache() - 显示远程上下文');
log('  mpDebug.showWorldInfoCache() - 显示世界书缓存');
log('  mpDebug.clearRemoteCache() - 清除远程上下文');
log('  mpDebug.showSentData() - 显示已发送的数据');

log('========================================');












