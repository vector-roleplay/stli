// ========================================
// 酒馆联机扩展 v2.2
// 服务器: wss://chu.zeabur.app
// 核心改动: 
//   - MutationObserver 劫持 DOM
//   - 在酒馆助手处理前捕获干净 HTML
//   - 详细调试日志和弹窗
// ========================================

import { eventSource, event_types } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';

// ========== 扩展配置 ==========
const extensionName = 'stli';
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

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

// ========== 调试模式 ==========
const DEBUG_MODE = true;  // 开启调试弹窗
const DEBUG_POPUP = true; // 手机端弹窗调试

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

// ========== DOM 劫持相关变量 ==========
let capturedHtml = null;
let capturedMessageId = null;
let chatObserver = null;

// ========== 远程消息保护器 ==========
const remoteMessageObservers = new Map();

// ========== 世界书同步变量 ==========
let pendingReferenceSet = null;
let remoteWorldInfoCache = new Map();

// ========== 工具函数 ==========
function log(msg) {
  console.log('[酒馆联机] ' + msg);
}

function logSync(category, data) {
  console.log('%c[同步日志] ' + category, 'color: #4ade80; font-weight: bold;');
  console.log(data);
}

function logDebug(title, data) {
  console.log('%c[调试] ' + title, 'color: #f59e0b; font-weight: bold;');
  console.log(data);
  
  // 手机端弹窗调试
  if (DEBUG_POPUP) {
    let msg = title + '\n';
    if (typeof data === 'object') {
      for (const [key, value] of Object.entries(data)) {
        msg += key + ': ' + value + '\n';
      }
    } else {
      msg += String(data);
    }
    // 使用非阻塞的通知
    showDebugToast(msg);
  }
}

function showDebugToast(msg) {
  // 创建调试通知
  let container = document.getElementById('mp-debug-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'mp-debug-container';
    container.style.cssText = 'position:fixed;top:10px;right:10px;z-index:99999;max-width:350px;';
    document.body.appendChild(container);
  }
  
  const toast = document.createElement('div');
  toast.style.cssText = 'background:#1a1a2e;border:1px solid #4ade80;color:#fff;padding:10px;margin-bottom:5px;border-radius:8px;font-size:12px;white-space:pre-wrap;word-break:break-all;max-height:200px;overflow:auto;';
  toast.textContent = msg;
  container.appendChild(toast);
  
  // 5秒后移除
  setTimeout(() => {
    toast.remove();
    if (container.children.length === 0) {
      container.remove();
    }
  }, 5000);
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

// ========== Token 存储管理 ==========
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
  log('已清除所有存储');
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

// ========== 重置所有状态 ==========
function resetAllState() {
  isConnected = false;
  currentRoom = null;
  currentRoomName = '';
  roomUsers = [];
  chatMessages = [];
  processedMsgCache.clear();
  remoteStreamMap.clear();
  remoteWorldInfoCache.clear();
  isGenerating = false;
  pendingReferenceSet = null;
  capturedHtml = null;
  capturedMessageId = null;
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
  // 清理所有保护器
  remoteMessageObservers.forEach(observer => observer.disconnect());
  remoteMessageObservers.clear();
  unblockSendButton();
}

// ========== 获取聊天数组 ==========
function getChat() {
  const ctx = getContext();
  return ctx.chat || [];
}

// ========== 获取用户名 ==========
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
      log('使用默认用户名');
      callback();
      
      const bgRetry = setInterval(() => {
        if (getUserName()) {
          log('后台获取到用户名: ' + userName);
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

// ========== 获取时间戳 ==========
function getMessageTimeStamp() {
  if (typeof humanizedDateTime === 'function') {
    return humanizedDateTime();
  }
  return new Date().toLocaleString();
}

// ========================================
// DOM 劫持系统（核心）
// ========================================

function setupDOMObserver() {
  const chatElement = document.getElementById('chat');
  if (!chatElement) {
    log('警告: 找不到 #chat 元素，稍后重试');
    setTimeout(setupDOMObserver, 1000);
    return;
  }
  
  if (chatObserver) {
    chatObserver.disconnect();
  }
  
  chatObserver = new MutationObserver(function(mutations) {
    // 只在生成中且是自己的回合时捕获
    if (!currentRoom || !turnState.isMyTurn || !isGenerating) return;
    
    for (const mutation of mutations) {
      // 检测新增节点
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;
        
        // 查找消息元素
        let mesElement = null;
        if (node.classList && node.classList.contains('mes')) {
          mesElement = node;
        } else if (node.querySelector) {
          mesElement = node.querySelector('.mes');
        }
        
        if (!mesElement) continue;
        
        const messageId = parseInt(mesElement.getAttribute('mesid'));
        if (isNaN(messageId)) continue;
        
        const chat = getChat();
        const msg = chat[messageId];
        
        // 跳过用户消息和远程消息
        if (!msg || msg.is_user || msg.extra?.isRemote) continue;
        
        const mesText = mesElement.querySelector('.mes_text');
        if (!mesText) continue;
        
        // 立即捕获！此时酒馆助手还没处理
        capturedHtml = mesText.innerHTML;
        capturedMessageId = messageId;
        
        logDebug('DOM捕获成功', {
          '消息ID': messageId,
          'HTML长度': capturedHtml.length,
          '前100字符': capturedHtml.substring(0, 100),
          '包含pre': capturedHtml.includes('<pre') ? '是' : '否',
          '包含iframe': capturedHtml.includes('<iframe') ? '是(问题!)' : '否(正确)',
          '包含TH-render': capturedHtml.includes('TH-render') ? '是(问题!)' : '否(正确)'
        });
      }
      
      // 也检测 .mes_text 的内容变化（针对流式更新完成时）
      if (mutation.target && mutation.target.classList && 
          mutation.target.classList.contains('mes_text')) {
        
        const mesElement = mutation.target.closest('.mes');
        if (!mesElement) continue;
        
        const messageId = parseInt(mesElement.getAttribute('mesid'));
        if (isNaN(messageId)) continue;
        
        const chat = getChat();
        const msg = chat[messageId];
        
        if (!msg || msg.is_user || msg.extra?.isRemote) continue;
        
        // 更新捕获
        capturedHtml = mutation.target.innerHTML;
        capturedMessageId = messageId;
      }
    }
  });
  
  chatObserver.observe(chatElement, { 
    childList: true, 
    subtree: true,
    characterData: true
  });
  
  log('DOM 劫持监听器已设置');
}

// ========================================
// 远程消息保护器（智能版）
// ========================================

function protectRemoteMessage(messageId) {
  // 清理已有的 observer
  if (remoteMessageObservers.has(messageId)) {
    remoteMessageObservers.get(messageId).disconnect();
    remoteMessageObservers.delete(messageId);
  }
  
  const element = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
  if (!element) {
    log('保护器: 找不到DOM元素，消息#' + messageId);
    return;
  }
  
  // 从 chat 数组获取纯净 HTML
  const chat = getChat();
  const msg = chat[messageId];
  
  // 双重确认：必须是远程消息
  if (!msg?.extra?.isRemote) {
    log('保护器: 消息#' + messageId + ' 不是远程消息，跳过');
    return;
  }
  
  // 必须有纯净 HTML
  const pureHtml = msg?.extra?.remoteFormattedHtml;
  if (!pureHtml) {
    log('保护器: 消息#' + messageId + ' 没有纯净HTML，跳过');
    return;
  }
  
  let isRestoring = false;
  
  const observer = new MutationObserver(function() {
    if (isRestoring) return;
    
    const currentHtml = element.innerHTML;
    
    // 检查是否是合法状态
    const hasPreCode = currentHtml.includes('<pre') && currentHtml.includes('<code');
    const hasTHRender = currentHtml.includes('TH-render');
    const hasIframe = currentHtml.includes('<iframe');
    
    // 合法状态：有原始的 <pre><code>，或者酒馆助手已处理（TH-render/iframe）
    const isValidState = hasPreCode || hasTHRender || hasIframe;
    
    if (!isValidState) {
      // 被非法覆盖了！恢复纯净 HTML
      log('保护器: 检测到非法覆盖，恢复纯净HTML，消息#' + messageId);
      
      logDebug('保护器触发', {
        '消息ID': messageId,
        '当前内容前50字': currentHtml.substring(0, 50),
        '恢复HTML长度': pureHtml.length
      });
      
      isRestoring = true;
      element.innerHTML = pureHtml;
      
      setTimeout(function() {
        isRestoring = false;
      }, 100);
    }
    // 如果是合法状态，不做任何处理
  });
  
  observer.observe(element, { 
    childList: true, 
    subtree: true, 
    characterData: true 
  });
  
  remoteMessageObservers.set(messageId, observer);
  log('已设置智能保护器: #' + messageId);
}

function clearRemoteMessageProtection(messageId) {
  if (remoteMessageObservers.has(messageId)) {
    remoteMessageObservers.get(messageId).disconnect();
    remoteMessageObservers.delete(messageId);
  }
}

// ========================================
// 世界书提取和对照逻辑
// ========================================

const REMOTE_SYNC_TAG = '【联机同步内容-请勿重复同步】';

async function getAllWorldInfoEntries() {
  const entries = [];
  
  try {
    if (typeof window.getSortedEntries === 'function') {
      const sorted = await window.getSortedEntries();
      if (sorted && sorted.length > 0) {
        log('通过 getSortedEntries 获取到 ' + sorted.length + ' 条世界书');
        return sorted;
      }
    }
  } catch(e) {
    log('getSortedEntries 失败: ' + e);
  }
  
  const ctx = getContext();
  
  try {
    const selected = window.selected_world_info || [];
    const loadWorldInfo = ctx.loadWorldInfo || window.loadWorldInfo;
    
    if (selected.length > 0 && typeof loadWorldInfo === 'function') {
      for (const worldName of selected) {
        try {
          const data = await loadWorldInfo(worldName);
          if (data && data.entries) {
            Object.values(data.entries).forEach(entry => {
              if (!entry.disable && entry.content) {
                entries.push({ ...entry, world: worldName, source: 'global' });
              }
            });
          }
        } catch(e) {}
      }
    }
  } catch(e) {}
  
  try {
    const charId = ctx.characterId;
    const char = ctx.characters && ctx.characters[charId];
    
    if (char?.data?.extensions?.world) {
      const charWorldName = char.data.extensions.world;
      const loadWorldInfo = ctx.loadWorldInfo || window.loadWorldInfo;
      
      if (typeof loadWorldInfo === 'function') {
        const data = await loadWorldInfo(charWorldName);
        if (data && data.entries) {
          Object.values(data.entries).forEach(entry => {
            if (!entry.disable && entry.content) {
              entries.push({ ...entry, world: charWorldName, source: 'character' });
            }
          });
        }
      }
    }
    
    if (char?.data?.character_book?.entries) {
      char.data.character_book.entries.forEach(entry => {
        if (entry.enabled !== false && entry.content) {
          entries.push({ ...entry, world: 'embedded', source: 'character_embedded' });
        }
      });
    }
  } catch(e) {}
  
  try {
    const chat_metadata = window.chat_metadata || ctx.chatMetadata;
    if (chat_metadata?.world_info) {
      const chatWorldName = chat_metadata.world_info;
      const loadWorldInfo = ctx.loadWorldInfo || window.loadWorldInfo;
      
      if (typeof loadWorldInfo === 'function') {
        const data = await loadWorldInfo(chatWorldName);
        if (data && data.entries) {
          Object.values(data.entries).forEach(entry => {
            if (!entry.disable && entry.content) {
              entries.push({ ...entry, world: chatWorldName, source: 'chat' });
            }
          });
        }
      }
    }
  } catch(e) {}
  
  log('世界书总计: ' + entries.length + ' 条');
  return entries;
}

function getCharacterInfo() {
  try {
    const ctx = getContext();
    const charId = ctx.characterId;
    const char = ctx.characters && ctx.characters[charId];
    
    if (!char) return null;
    
    return {
      name: char.name || '',
      description: char.description || '',
      personality: char.personality || '',
      scenario: char.scenario || '',
      first_mes: char.first_mes || '',
      mes_example: char.mes_example || '',
      character_book: char.data?.character_book?.entries || []
    };
  } catch(e) {
    return null;
  }
}

function getChatHistory() {
  try {
    const chat = getChat();
    if (!chat || chat.length === 0) return [];
    
    return chat.map(msg => ({
      content: msg.mes || '',
      is_user: msg.is_user,
      name: msg.name
    }));
  } catch(e) {
    return [];
  }
}

async function buildReferenceSet() {
  const referenceSet = {
    worldInfo: [],
    characterInfo: null,
    chatHistory: []
  };
  
  referenceSet.worldInfo = await getAllWorldInfoEntries();
  referenceSet.characterInfo = getCharacterInfo();
  referenceSet.chatHistory = getChatHistory();
  
  return referenceSet;
}

function matchesReference(packetContent, referenceSet) {
  if (!packetContent || !packetContent.trim()) {
    return { matched: false, type: 'empty' };
  }
  
  if (packetContent.includes(REMOTE_SYNC_TAG)) {
    return { matched: false, type: 'remote_injection' };
  }
  
  if (referenceSet.worldInfo?.length > 0) {
    for (const entry of referenceSet.worldInfo) {
      if (entry.content?.trim()) {
        const sample = entry.content.substring(0, 200);
        if (packetContent.includes(sample) || packetContent.includes(entry.content)) {
          return { matched: true, type: 'worldInfo', entryName: entry.comment || entry.key?.[0] || '未命名' };
        }
      }
    }
  }
  
  if (referenceSet.characterInfo) {
    const charFields = ['description', 'personality', 'scenario', 'first_mes', 'mes_example'];
    for (const field of charFields) {
      const fieldContent = referenceSet.characterInfo[field];
      if (fieldContent?.trim()) {
        const sample = fieldContent.substring(0, 200);
        if (packetContent.includes(sample) || packetContent.includes(fieldContent)) {
          return { matched: true, type: 'character', field: field };
        }
      }
    }
  }
  
  if (referenceSet.chatHistory?.length > 0) {
    for (const chatMsg of referenceSet.chatHistory) {
      if (chatMsg.content?.trim() && packetContent.includes(chatMsg.content)) {
        return { matched: true, type: 'chatHistory', msgName: chatMsg.name };
      }
    }
  }
  
  return { matched: false, type: 'preset' };
}

function extractSyncContent(dataPacket, referenceSet) {
  const syncContent = [];
  
  if (!dataPacket || !Array.isArray(dataPacket)) return syncContent;
  
  for (const msg of dataPacket) {
    const content = msg.content || '';
    if (!content.trim()) continue;
    if (msg.role === 'user' || msg.role === 'assistant') continue;
    
    const match = matchesReference(content, referenceSet);
    if (match.type === 'remote_injection') continue;
    
    if (match.matched) {
      syncContent.push({ 
        type: match.type, 
        content: content, 
        role: msg.role,
        detail: match.entryName || match.field || match.msgName || ''
      });
    }
  }
  
  return syncContent;
}

function storeRemoteWorldInfo(senderId, senderName, syncContent, timestamp) {
  if (!syncContent || syncContent.length === 0) return;
  
  remoteWorldInfoCache.set(senderId, {
    userName: senderName,
    syncContent: syncContent,
    timestamp: timestamp
  });
  
  logSync('收到远程同步内容 - 来自: ' + senderName, {
    总条数: syncContent.length,
    世界书: syncContent.filter(x => x.type === 'worldInfo').map(x => x.detail),
    角色卡: syncContent.filter(x => x.type === 'character').map(x => x.detail),
    聊天记录: syncContent.filter(x => x.type === 'chatHistory').length + ' 条'
  });
  
  log('已缓存 ' + senderName + ' 的同步内容，共 ' + syncContent.length + ' 条');
}

function clearRemoteWorldInfoCache() {
  remoteWorldInfoCache.clear();
}

// ========================================
// ExtensionPrompt 注入系统
// ========================================

const INJECTION_KEY = 'multiplayer_remote_worldinfo';

const EXTENSION_PROMPT_TYPES = {
  NONE: -1,
  IN_PROMPT: 0,
  IN_CHAT: 1,
  BEFORE_PROMPT: 2
};

const EXTENSION_PROMPT_ROLES = {
  SYSTEM: 0,
  USER: 1,
  ASSISTANT: 2
};

function injectRemoteWorldInfoViaExtensionPrompt() {
  if (remoteWorldInfoCache.size === 0) return;
  
  const playerNames = [];
  const allContents = [];
  
  remoteWorldInfoCache.forEach(function(data, odId) {
    playerNames.push(data.userName);
    
    if (data.syncContent && Array.isArray(data.syncContent)) {
      data.syncContent.forEach(function(item) {
        if (item.type === 'user') return;
        allContents.push({
          from: data.userName,
          type: item.type,
          content: item.content,
          role: item.role || 'system',
          detail: item.detail || ''
        });
      });
    }
  });
  
  if (allContents.length === 0) return;
  
  let fullContent = REMOTE_SYNC_TAG + '\n';
  fullContent += '[联机模式 - 来自其他玩家的设定]\n';
  fullContent += '参与玩家：' + playerNames.join('、') + '\n\n';
  
  const grouped = { worldInfo: [], character: [], chatHistory: [] };
  
  allContents.forEach(function(item) {
    const key = item.type || 'other';
    if (grouped[key]) grouped[key].push(item);
  });
  
  if (grouped.worldInfo.length > 0) {
    fullContent += '=== 世界设定 ===\n';
    grouped.worldInfo.forEach(item => {
      fullContent += '[来自 ' + item.from + ' - ' + item.detail + ']\n' + item.content + '\n\n';
    });
  }
  
  if (grouped.character.length > 0) {
    fullContent += '=== 角色信息 ===\n';
    grouped.character.forEach(item => {
      fullContent += '[来自 ' + item.from + ' - ' + item.detail + ']\n' + item.content + '\n\n';
    });
  }
  
  if (grouped.chatHistory.length > 0) {
    fullContent += '=== 对话上下文 ===\n';
    grouped.chatHistory.forEach(item => {
      fullContent += '[来自 ' + item.from + ']\n' + item.content + '\n\n';
    });
  }
  
  const ctx = getContext();
  const setExtensionPrompt = ctx.setExtensionPrompt;
  
  if (typeof setExtensionPrompt === 'function') {
    try {
      setExtensionPrompt(
        INJECTION_KEY,
        fullContent,
        EXTENSION_PROMPT_TYPES.IN_PROMPT,
        0,
        true,
        EXTENSION_PROMPT_ROLES.SYSTEM
      );
      
      logSync('注入远程内容到AI提示词', {
        来源玩家: playerNames,
        世界书条目: grouped.worldInfo.length,
        角色卡字段: grouped.character.length,
        聊天记录条目: grouped.chatHistory.length,
        总字符数: fullContent.length
      });
      
      log('已注入远程内容');
    } catch(e) {
      log('注入失败: ' + e);
    }
  }
}

function clearInjectedExtensionPrompt() {
  try {
    const ctx = getContext();
    if (typeof ctx.setExtensionPrompt === 'function') {
      ctx.setExtensionPrompt(INJECTION_KEY, '', EXTENSION_PROMPT_TYPES.IN_PROMPT, 0, false);
    }
    if (ctx.extensionPrompts?.[INJECTION_KEY]) {
      delete ctx.extensionPrompts[INJECTION_KEY];
    }
  } catch(e) {}
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
  
  log('发送拦截器已设置');
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

// ========================================
// 简单渲染函数（用于流式显示）
// ========================================

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
// 远程消息处理（核心）
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
  
  if (msg.syncContent?.length > 0) {
    storeRemoteWorldInfo(msg.senderId, msg.senderName, msg.syncContent, msg.timestamp);
  }
  
  logSync('收到远程用户消息', {
    发送者: msg.userName,
    玩家名: msg.senderName,
    消息内容: msg.content?.substring(0, 100) + (msg.content?.length > 100 ? '...' : ''),
    同步内容条数: msg.syncContent?.length || 0
  });
  
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
  
  setTimeout(() => addRemoteTag(messageId, '用户', 'user'), 150);
  
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
    
    remoteStreamMap.set(msg.senderId, {
      messageId: messageId,
      charName: msg.charName
    });
    
    log('创建远程AI占位消息: #' + messageId);
    
    setTimeout(() => {
      const mesText = $(`.mes[mesid="${messageId}"] .mes_text`);
      if (mesText.length) {
        mesText.html(simpleRender(msg.content));
      }
    }, 50);
    
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

  // ===== 调试：检查接收到的HTML =====
  logDebug('接收端收到AI消息', {
    'HTML长度': msg.formattedHtml?.length || 0,
    '前100字符': msg.formattedHtml?.substring(0, 100) || '空',
    '包含pre': msg.formattedHtml?.includes('<pre') ? '是' : '否',
    '包含iframe': msg.formattedHtml?.includes('<iframe') ? '是(问题!)' : '否(正确)',
    '包含TH-render': msg.formattedHtml?.includes('TH-render') ? '是(问题!)' : '否(正确)',
    '流式模式': streamInfo ? '是' : '否'
  });
  
  log('远程AI完成，HTML长度: ' + (msg.formattedHtml?.length || 0));
  
  logSync('收到远程AI消息完成', {
    发送者: msg.senderName,
    角色名: msg.charName,
    HTML长度: msg.formattedHtml?.length || 0,
    包含pre标签: msg.formattedHtml?.includes('<pre') ? '是' : '否',
    流式模式: streamInfo ? '是' : '否'
  });
  
  if (streamInfo) {
    const messageId = streamInfo.messageId;
    
    // 存储到 extra
    if (chat[messageId]) {
      chat[messageId].mes = '[远程消息]';
      chat[messageId].extra = chat[messageId].extra || {};
      chat[messageId].extra.isRemote = true;
      chat[messageId].extra.isStreaming = false;
      chat[messageId].extra.remoteFormattedHtml = msg.formattedHtml;
      chat[messageId].extra.remoteSenderId = msg.senderId;
      chat[messageId].extra.remoteSenderName = msg.senderName;
      chat[messageId].extra.remoteCharName = msg.charName;
    }
    
    // 覆盖 DOM
    const mesText = $(`.mes[mesid="${messageId}"] .mes_text`);
    if (mesText.length) {
      mesText.html(msg.formattedHtml);
      
      logDebug('接收端DOM覆盖完成', {
        '消息ID': messageId,
        'DOM内容前100字': mesText.html().substring(0, 100)
      });
    }
    
    // 触发事件让酒馆助手处理
    setTimeout(() => {
      try {
        ctx.eventSource.emit(ctx.eventTypes.CHARACTER_MESSAGE_RENDERED, messageId);
        log('已触发 CHARACTER_MESSAGE_RENDERED: #' + messageId);
      } catch(e) {
        log('触发事件失败: ' + e);
      }
    }, 100);
    
    // 设置保护器（延迟，等酒馆助手处理完）
    protectRemoteMessage(messageId);
    
    setTimeout(() => addRemoteTag(messageId, '联机AI', 'ai'), 200);
    
    remoteStreamMap.delete(msg.senderId);
    
    if (ctx.saveChat) ctx.saveChat();
    
    log('远程AI消息完成(流式): #' + messageId);
    
  } else {
    // 非流式分支
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
      extra: {
        isRemote: true,
        remoteFormattedHtml: msg.formattedHtml,
        remoteSender: msg.senderName,
        remoteSenderId: msg.senderId,
        remoteCharName: msg.charName
      }
    };
    
    chat.push(message);
    const messageId = chat.length - 1;
    addOneMessage(message, { forceId: messageId, scroll: true });
    
    // 覆盖DOM
    setTimeout(() => {
      const mesText = $(`.mes[mesid="${messageId}"] .mes_text`);
      if (mesText.length) {
        mesText.html(msg.formattedHtml);
        
        logDebug('接收端DOM覆盖完成(非流式)', {
          '消息ID': messageId,
          'DOM内容前100字': mesText.html().substring(0, 100)
        });
      }
    }, 50);
    
    // 触发事件
    setTimeout(() => {
      try {
        ctx.eventSource.emit(ctx.eventTypes.CHARACTER_MESSAGE_RENDERED, messageId);
      } catch(e) {}
    }, 150);
    
    // 设置保护器
    protectRemoteMessage(messageId);
    
    setTimeout(() => addRemoteTag(messageId, '联机AI', 'ai'), 250);
    
    if (ctx.saveChat) ctx.saveChat();
    
    log('远程AI消息完成(直接): #' + messageId);
  }
}

// ========================================
// 恢复远程消息（刷新后）
// ========================================

function restoreRemoteMessages() {
  const chat = getChat();
  if (!chat || chat.length === 0) return;
  
  const ctx = getContext();
  let restoredCount = 0;
  
  log('开始恢复远程消息，chat长度: ' + chat.length);
  
  chat.forEach((msg, messageId) => {
    if (msg?.extra?.isRemote && msg?.extra?.remoteFormattedHtml && !msg?.is_user) {
      log('发现远程消息 #' + messageId + ', remoteFormattedHtml长度: ' + msg.extra.remoteFormattedHtml.length);
      
      const mesText = $(`.mes[mesid="${messageId}"] .mes_text`);
      if (mesText.length) {
        mesText.html(msg.extra.remoteFormattedHtml);
        
        protectRemoteMessage(messageId);
        
        addRemoteTag(messageId, '联机AI', 'ai');
        
        setTimeout(() => {
          try {
            ctx.eventSource.emit(ctx.eventTypes.CHARACTER_MESSAGE_RENDERED, messageId);
          } catch(e) {}
        }, 100);
        
        restoredCount++;
      }
    }
  });
  
  if (restoredCount > 0) {
    log('已恢复 ' + restoredCount + ' 条远程消息');
    
    logSync('恢复远程消息', {
      恢复数量: restoredCount,
      聊天总消息数: chat.length
    });
  }
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
      log('WebSocket已连接，发送认证...');
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
        remoteWorldInfoCache.delete(msg.userId);
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
      log('服务器确认正常断开');
      break;
    
    case 'error':
      toast('error', msg.message || '错误');
      break;
    
    case 'pong':
      break;
  }
}

// ========================================
// 事件监听设置
// ========================================

function setupEventListeners() {
  const ctx = getContext();
  
  // 设置 DOM 劫持监听器
  setupDOMObserver();
  
  // 生成开始
  eventSource.on(event_types.GENERATION_STARTED, function(type, options, dryRun) {
    if (dryRun) return;
    if (!currentRoom) return;
    
    log('事件: 生成开始');
    isGenerating = true;
    capturedHtml = null;
    capturedMessageId = null;
    
    if (remoteWorldInfoCache.size > 0) {
      injectRemoteWorldInfoViaExtensionPrompt();
    }
  });
  
  // 用户消息发送后 - 构建对照组
  eventSource.on(event_types.MESSAGE_SENT, async function(messageId) {
    if (!currentRoom || !turnState.isMyTurn) return;
    
    const chat = getChat();
    const msg = chat[messageId];
    if (!msg || !msg.is_user) return;
    if (msg.extra && msg.extra.isRemote) return;
    
    log('事件: 用户消息发送 #' + messageId);
    
    pendingReferenceSet = await buildReferenceSet();
    
    logSync('构建本地对照组', {
      世界书条目数: pendingReferenceSet.worldInfo?.length || 0,
      角色卡字段: pendingReferenceSet.characterInfo ? Object.keys(pendingReferenceSet.characterInfo).filter(k => pendingReferenceSet.characterInfo[k]).length : 0,
      聊天记录条数: pendingReferenceSet.chatHistory?.length || 0
    });
  });
  
  // 数据包准备完成 - 提取并发送
  eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, function(data) {
    if (data.dryRun) return;
    if (!currentRoom || !turnState.isMyTurn) return;
    if (!pendingReferenceSet) return;
    
    log('事件: 数据包拦截');
    
    const syncContent = extractSyncContent(data.chat, pendingReferenceSet);
    
    logSync('发送同步数据', {
      总条数: syncContent.length,
      世界书: syncContent.filter(x => x.type === 'worldInfo').map(x => x.detail),
      角色卡: syncContent.filter(x => x.type === 'character').map(x => x.detail),
      聊天记录: syncContent.filter(x => x.type === 'chatHistory').length + ' 条'
    });
    
    const chat = getChat();
    const lastUserMsg = chat.filter(m => m.is_user && (!m.extra || !m.extra.isRemote)).pop();
    
    sendWS({
      type: 'syncUserMessage',
      content: lastUserMsg ? lastUserMsg.mes : '',
      userName: lastUserMsg ? lastUserMsg.name : userName,
      senderName: userName,
      syncContent: syncContent,
      timestamp: Date.now()
    });
    
    sendWS({ type: 'userMessageSent' });
    
    log('已发送同步数据: ' + syncContent.length + ' 条内容');
    
    pendingReferenceSet = null;
  });
  
  // 流式token
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
  
  // 生成结束 - 使用 DOM 劫持捕获的 HTML
  eventSource.on(event_types.GENERATION_ENDED, function(messageCount) {
    if (!currentRoom) return;
    
    clearInjectedExtensionPrompt();
    
    if (!turnState.isMyTurn || !isGenerating) return;
    
    clearRemoteWorldInfoCache();
    
    log('事件: 生成结束');
    isGenerating = false;
    
    // 使用劫持捕获到的 HTML
    if (capturedHtml && capturedMessageId !== null) {
      const chat = getChat();
      const lastMsg = chat[capturedMessageId];
      
      if (lastMsg && !lastMsg.is_user && !lastMsg.extra?.isRemote) {
        logDebug('发送端发送HTML', {
          '消息ID': capturedMessageId,
          'HTML长度': capturedHtml.length,
          '前100字符': capturedHtml.substring(0, 100),
          '包含pre': capturedHtml.includes('<pre') ? '是' : '否',
          '包含iframe': capturedHtml.includes('<iframe') ? '是(问题!)' : '否(正确)',
          '包含TH-render': capturedHtml.includes('TH-render') ? '是(问题!)' : '否(正确)'
        });
        
        logSync('发送AI消息 (DOM劫持)', {
          角色名: lastMsg.name,
          HTML长度: capturedHtml.length,
          包含pre标签: capturedHtml.includes('<pre') ? '是' : '否',
          包含iframe: capturedHtml.includes('<iframe') ? '是(问题!)' : '否(正确)',
          包含THrender: capturedHtml.includes('TH-render') ? '是(问题!)' : '否(正确)'
        });
        
        log('发送格式化HTML，长度: ' + capturedHtml.length);
        
        sendWS({
          type: 'syncAiComplete',
          formattedHtml: capturedHtml,
          charName: lastMsg.name,
          senderName: userName,
          timestamp: Date.now()
        });
        
        sendWS({ type: 'aiGenerationEnded' });
      }
    } else {
      log('警告: DOM劫持未捕获到HTML，尝试从DOM直接获取');
      
      // 备用方案：直接从 DOM 获取
      const chat = getChat();
      const lastMsg = chat[chat.length - 1];
      if (lastMsg && !lastMsg.is_user && !lastMsg.extra?.isRemote) {
        const messageId = chat.length - 1;
        const mesText = $(`.mes[mesid="${messageId}"] .mes_text`);
        
        if (mesText.length) {
          let fallbackHtml = mesText.html();
          
          // 如果已被酒馆助手处理，尝试清理
          if (fallbackHtml.includes('TH-render') || fallbackHtml.includes('<iframe')) {
            fallbackHtml = cleanHtmlForSync(fallbackHtml);
          }
          
          logDebug('发送端备用方案', {
            '消息ID': messageId,
            'HTML长度': fallbackHtml.length,
            '前100字符': fallbackHtml.substring(0, 100)
          });
          
          sendWS({
            type: 'syncAiComplete',
            formattedHtml: fallbackHtml,
            charName: lastMsg.name,
            senderName: userName,
            timestamp: Date.now()
          });
          
          sendWS({ type: 'aiGenerationEnded' });
        }
      }
    }
    
    // 清空捕获
    capturedHtml = null;
    capturedMessageId = null;
  });
  
  // 生成停止
  eventSource.on(event_types.GENERATION_STOPPED, function() {
    log('事件: 生成停止');
    isGenerating = false;
    capturedHtml = null;
    capturedMessageId = null;
    clearInjectedExtensionPrompt();
  });
  
  // 聊天切换时恢复远程消息
  eventSource.on(event_types.CHAT_CHANGED, function() {
    log('事件: 聊天切换');
    remoteStreamMap.clear();
    remoteWorldInfoCache.clear();
    isGenerating = false;
    pendingReferenceSet = null;
    capturedHtml = null;
    capturedMessageId = null;
    clearInjectedExtensionPrompt();
    
    // 清理所有保护器
    remoteMessageObservers.forEach(observer => observer.disconnect());
    remoteMessageObservers.clear();
    
    // 重新设置 DOM 监听器
    setTimeout(setupDOMObserver, 500);
    
    // 延迟恢复远程消息
    setTimeout(restoreRemoteMessages, 800);
  });
  
  log('事件监听已设置');
}

// ========== 清理 HTML 用于远程同步 ==========
function cleanHtmlForSync(html) {
  const temp = document.createElement('div');
  temp.innerHTML = html;
  
  // 还原 TH-render 为原始的 <pre>
  const renders = temp.querySelectorAll('.TH-render');
  renders.forEach(function(render) {
    const pre = render.querySelector('pre');
    if (pre) {
      pre.classList.remove('hidden!');
      render.replaceWith(pre);
    }
  });
  
  // 移除所有 iframe
  const iframes = temp.querySelectorAll('iframe');
  iframes.forEach(function(iframe) {
    iframe.remove();
  });
  
  return temp.innerHTML;
}

// 活动监听
function setupActivityListener() {
  $(document).on('click', '#send_but, #send_button, .send_button', function() {
    if (isConnected) {
      sendWS({ type: 'mainActivity' });
    }
  });
  log('活动监听已设置');
}

// 用户名监听
let lastKnownUserName = '';

function setupUserNameWatcher() {
  setInterval(function() {
    const oldName = userName;
    if (getUserName() && userName !== oldName && userName !== lastKnownUserName) {
      lastKnownUserName = userName;
      log('检测到用户名变化: ' + oldName + ' -> ' + userName);
      
      if (isConnected) {
        sendWS({ type: 'setUserInfo', name: userName });
      }
      
      refreshPanel();
    }
  }, 3000);
  
  log('用户名监听已设置');
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
    remoteWorldInfoCache.clear();
    isGenerating = false;
    pendingReferenceSet = null;
    capturedHtml = null;
    capturedMessageId = null;
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
    remoteMessageObservers.forEach(observer => observer.disconnect());
    remoteMessageObservers.clear();
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
// 调试函数
// ========================================

function debugState() {
  console.log('===== 联机状态 =====');
  console.log('连接状态:', isConnected);
  console.log('用户ID:', odId);
  console.log('用户名:', userName);
  console.log('当前房间:', currentRoom);
  console.log('房间用户:', roomUsers);
  console.log('轮次状态:', turnState);
  console.log('远程世界书缓存:', remoteWorldInfoCache.size);
  console.log('远程消息保护器:', remoteMessageObservers.size);
  console.log('正在生成:', isGenerating);
  console.log('DOM捕获HTML长度:', capturedHtml?.length || 0);
  console.log('DOM捕获消息ID:', capturedMessageId);
  console.log('====================');
}

function debugSyncLog() {
  console.log('%c===== 同步日志汇总 =====', 'color: #4ade80; font-weight: bold; font-size: 14px;');
  
  console.log('\n远程世界书缓存:');
  remoteWorldInfoCache.forEach((data, odId) => {
    console.log('  来自:', data.userName);
    console.log('  内容条数:', data.syncContent?.length || 0);
    if (data.syncContent) {
      data.syncContent.forEach((item, i) => {
        console.log('    [' + i + '] 类型:' + item.type + ', 详情:' + (item.detail || '无'));
      });
    }
  });
  
  console.log('\n远程消息保护器:');
  console.log('  保护的消息数:', remoteMessageObservers.size);
  remoteMessageObservers.forEach((observer, messageId) => {
    console.log('    消息#' + messageId);
  });
  
  console.log('\nDOM劫持状态:');
  console.log('  capturedHtml长度:', capturedHtml?.length || 0);
  console.log('  capturedMessageId:', capturedMessageId);
  
  console.log('%c========================', 'color: #4ade80; font-weight: bold;');
}

function debugDOMCapture() {
  console.log('%c===== DOM劫持调试 =====', 'color: #f59e0b; font-weight: bold; font-size: 14px;');
  console.log('chatObserver存在:', !!chatObserver);
  console.log('isGenerating:', isGenerating);
  console.log('turnState.isMyTurn:', turnState.isMyTurn);
  console.log('currentRoom:', currentRoom);
  console.log('capturedHtml长度:', capturedHtml?.length || 0);
  console.log('capturedMessageId:', capturedMessageId);
  if (capturedHtml) {
    console.log('capturedHtml前200字符:', capturedHtml.substring(0, 200));
  }
  console.log('%c========================', 'color: #f59e0b; font-weight: bold;');
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
  log('扩展加载中... v2.2 (DOM劫持版)');
  
  // 加载设置
  loadSettings();
  
  // 等待用户名
  waitForUserName(function() {
    lastKnownUserName = userName;
    
    // 创建扩展UI
    createExtensionUI();
    
    // 设置各种监听器
    setupActivityListener();
    setupSendInterceptor();
    setupEventListeners();
    setupUserNameWatcher();
    
    // 检查是否可以自动重连
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
// 导出调试函数
// ========================================

window.mpDebug = {
  state: debugState,
  syncLog: debugSyncLog,
  domCapture: debugDOMCapture,
  connect: connectServer,
  disconnect: normalDisconnect,
  openPanel: openPanel,
  restoreRemote: restoreRemoteMessages,
  
  // 手动测试DOM捕获
  testCapture: function() {
    const chat = getChat();
    if (chat.length === 0) {
      console.log('聊天为空');
      return;
    }
    const lastId = chat.length - 1;
    const mesText = document.querySelector(`.mes[mesid="${lastId}"] .mes_text`);
    if (mesText) {
      console.log('最后一条消息DOM内容:');
      console.log('长度:', mesText.innerHTML.length);
      console.log('前200字符:', mesText.innerHTML.substring(0, 200));
      console.log('包含TH-render:', mesText.innerHTML.includes('TH-render'));
      console.log('包含iframe:', mesText.innerHTML.includes('<iframe'));
    }
  },
  
  get chat() { return getChat(); },
  get worldInfoCache() { return remoteWorldInfoCache; },
  get messageObservers() { return remoteMessageObservers; },
  get captured() { return { html: capturedHtml, messageId: capturedMessageId }; }
};

log('调试命令已注册: window.mpDebug');
log('- mpDebug.state() 查看联机状态');
log('- mpDebug.syncLog() 查看同步日志汇总');
log('- mpDebug.domCapture() 查看DOM劫持状态');
log('- mpDebug.testCapture() 测试最后一条消息的DOM');

log('- mpDebug.restoreRemote() 手动恢复远程消息');
