// ========================================
// 酒馆联机扩展 v1.0.0
// 服务器: wss://chu.zeabur.app
// ========================================

import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';

// ========== 扩展配置 ==========
const extensionName = 'tavern-multiplayer';
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

// ========== 世界书同步变量 ==========
let pendingReferenceSet = null;  // 完整对照组
let remoteWorldInfoCache = new Map();
// key: odId (玩家ID)
// value: { userName, syncContent: [...], timestamp }

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

function simpleMarkdown(text) {
  if (!text) return '';
  let escaped = escapeHtml(text);
  escaped = escaped.replace(/\n/g, '<br>');
  escaped = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  escaped = escaped.replace(/\*(.+?)\*/g, '<em>$1</em>');
  escaped = escaped.replace(/`(.+?)`/g, '<code>$1</code>');
  return escaped;
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
// 第2部分：世界书提取和对照逻辑
// ========================================

// ========== 特殊标签（防止重复同步）==========
const REMOTE_SYNC_TAG = '【联机同步内容-请勿重复同步】';

// ========== 获取所有激活的世界书条目 ==========
async function getAllWorldInfoEntries() {
  const entries = [];
  
  // 方法1：使用 getSortedEntries（最完整）
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
  
  // 方法2：手动从各来源加载
  
  // 2.1 全局世界书
  try {
    const selected = window.selected_world_info || [];
    const loadWorldInfo = window.loadWorldInfo;
    
    if (selected.length > 0 && typeof loadWorldInfo === 'function') {
      for (const worldName of selected) {
        try {
          const data = await loadWorldInfo(worldName);
          if (data && data.entries) {
            Object.values(data.entries).forEach(entry => {
              if (!entry.disable && entry.content) {
                entries.push({
                  ...entry,
                  world: worldName,
                  source: 'global'
                });
              }
            });
          }
        } catch(e) {}
      }
    }
  } catch(e) {
    log('全局世界书获取失败: ' + e);
  }
  
  // 2.2 角色绑定的世界书
  try {
    const ctx = getContext();
    const char = ctx.characters && ctx.characters[ctx.characterId];
    
    if (char && char.data && char.data.extensions && char.data.extensions.world) {
      const charWorldName = char.data.extensions.world;
      const loadWorldInfo = window.loadWorldInfo;
      
      if (typeof loadWorldInfo === 'function') {
        const data = await loadWorldInfo(charWorldName);
        if (data && data.entries) {
          Object.values(data.entries).forEach(entry => {
            if (!entry.disable && entry.content) {
              entries.push({
                ...entry,
                world: charWorldName,
                source: 'character'
              });
            }
          });
        }
      }
    }
    
    // 角色卡内嵌的世界书
    if (char && char.data && char.data.character_book && char.data.character_book.entries) {
      char.data.character_book.entries.forEach(entry => {
        if (entry.enabled !== false && entry.content) {
          entries.push({
            ...entry,
            world: 'embedded',
            source: 'character_embedded'
          });
        }
      });
    }
  } catch(e) {
    log('角色世界书获取失败: ' + e);
  }
  
  // 2.3 聊天世界书
  try {
    const chat_metadata = window.chat_metadata;
    if (chat_metadata && chat_metadata.world_info) {
      const chatWorldName = chat_metadata.world_info;
      const loadWorldInfo = window.loadWorldInfo;
      
      if (typeof loadWorldInfo === 'function') {
        const data = await loadWorldInfo(chatWorldName);
        if (data && data.entries) {
          Object.values(data.entries).forEach(entry => {
            if (!entry.disable && entry.content) {
              entries.push({
                ...entry,
                world: chatWorldName,
                source: 'chat'
              });
            }
          });
        }
      }
    }
  } catch(e) {
    log('聊天世界书获取失败: ' + e);
  }
  
  log('世界书总计: ' + entries.length + ' 条');
  return entries;
}

// ========== 获取角色卡信息 ==========
function getCharacterInfo() {
  try {
    const ctx = getContext();
    const char = ctx.characters && ctx.characters[ctx.characterId];
    
    if (!char) {
      log('未找到当前角色');
      return null;
    }
    
    return {
      name: char.name || '',
      description: char.description || '',
      personality: char.personality || '',
      scenario: char.scenario || '',
      first_mes: char.first_mes || '',
      mes_example: char.mes_example || '',
      character_book: (char.data && char.data.character_book && char.data.character_book.entries) || []
    };
  } catch(e) {
    log('获取角色卡失败: ' + e);
    return null;
  }
}

// ========== 获取聊天历史（用于对照）==========
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
    log('获取聊天历史失败: ' + e);
    return [];
  }
}

// ========== 构建对照组 ==========
async function buildReferenceSet() {
  const referenceSet = {
    worldInfo: [],
    characterInfo: null,
    chatHistory: []
  };
  
  // 1. 世界书
  referenceSet.worldInfo = await getAllWorldInfoEntries();
  log('对照组-世界书: ' + referenceSet.worldInfo.length + ' 条');
  
  // 2. 角色卡
  referenceSet.characterInfo = getCharacterInfo();
  log('对照组-角色卡: ' + (referenceSet.characterInfo ? referenceSet.characterInfo.name : '无'));
  
  // 3. 聊天历史
  referenceSet.chatHistory = getChatHistory();
  log('对照组-聊天历史: ' + referenceSet.chatHistory.length + ' 条');
  
  return referenceSet;
}

// ========== 检查内容是否匹配对照组 ==========
function matchesReference(packetContent, referenceSet) {
  if (!packetContent || !packetContent.trim()) {
    return { matched: false, type: 'empty' };
  }
  
  // 0. 跳过带有联机标签的内容（防止重复同步）
  if (packetContent.includes(REMOTE_SYNC_TAG)) {
    return { matched: false, type: 'remote_injection' };
  }
  
  // 1. 匹配世界书
  if (referenceSet.worldInfo && referenceSet.worldInfo.length > 0) {
    for (const entry of referenceSet.worldInfo) {
      if (entry.content && entry.content.trim()) {
        // 使用前200字符做模糊匹配（应对格式化）
        const sample = entry.content.substring(0, 200);
        if (packetContent.includes(sample)) {
          return { matched: true, type: 'worldInfo' };
        }
        if (packetContent.includes(entry.content)) {
          return { matched: true, type: 'worldInfo' };
        }
      }
    }
  }
  
  // 2. 匹配角色卡
  if (referenceSet.characterInfo) {
    const charFields = ['description', 'personality', 'scenario', 'first_mes', 'mes_example'];
    for (const field of charFields) {
      const fieldContent = referenceSet.characterInfo[field];
      if (fieldContent && fieldContent.trim()) {
        const sample = fieldContent.substring(0, 200);
        if (packetContent.includes(sample)) {
          return { matched: true, type: 'character' };
        }
        if (packetContent.includes(fieldContent)) {
          return { matched: true, type: 'character' };
        }
      }
    }
  }
  
  // 3. 匹配聊天历史
  if (referenceSet.chatHistory && referenceSet.chatHistory.length > 0) {
    for (const chatMsg of referenceSet.chatHistory) {
      if (chatMsg.content && chatMsg.content.trim()) {
        if (packetContent.includes(chatMsg.content)) {
          return { matched: true, type: 'chatHistory' };
        }
      }
    }
  }
  
  // 没有匹配 = 预设，剔除
  return { matched: false, type: 'preset' };
}

// ========== 从数据包提取需要同步的内容（优化版）==========
function extractSyncContent(dataPacket, referenceSet) {
  const syncContent = [];
  
  if (!dataPacket || !Array.isArray(dataPacket)) {
    log('数据包无效');
    return syncContent;
  }
  
  let matchedCount = 0;
  let skippedPreset = 0;
  let skippedRemote = 0;
  let skippedUserMsg = 0;
  
  for (const msg of dataPacket) {
    const content = msg.content || '';
    if (!content.trim()) continue;
    
    // 跳过用户消息（已通过 remoteUserMessage 同步到主界面）
    if (msg.role === 'user') {
      skippedUserMsg++;
      continue;
    }
    
    // 跳过 assistant 消息（通过流式同步）
    if (msg.role === 'assistant') {
      continue;
    }
    
    // 系统消息需要对照
    const match = matchesReference(content, referenceSet);
    
    if (match.type === 'remote_injection') {
      skippedRemote++;
      continue;
    }
    
    if (match.matched) {
      syncContent.push({
        type: match.type,
        content: content,
        role: msg.role
      });
      matchedCount++;
    } else {
      skippedPreset++;
    }
  }
  
  log('同步提取: 匹配' + matchedCount + '条, 剔除预设' + skippedPreset + '条, 跳过用户消息' + skippedUserMsg + '条, 跳过联机内容' + skippedRemote + '条');
  return syncContent;
}

// ========== 临时存储远程世界书 ==========
function storeRemoteWorldInfo(senderId, senderName, syncContent, timestamp) {
  if (!syncContent || syncContent.length === 0) return;
  
  remoteWorldInfoCache.set(senderId, {
    userName: senderName,
    syncContent: syncContent,
    timestamp: timestamp
  });
  
  log('已缓存 ' + senderName + ' 的同步内容，共 ' + syncContent.length + ' 条');
}

// ========== 清空远程世界书缓存 ==========
function clearRemoteWorldInfoCache() {
  remoteWorldInfoCache.clear();
  log('已清空远程世界书缓存');
}

// ========================================
// 第3部分：注入逻辑和发送按钮控制
// ========================================

// ========== extensionPrompt 常量（硬编码）==========
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

// ========== 使用 extensionPrompt 注入远程内容（优化版）==========
function injectRemoteWorldInfoViaExtensionPrompt() {
  if (remoteWorldInfoCache.size === 0) return;
  
  // 收集所有需要注入的内容
  const playerNames = [];
  const allContents = [];
  
  remoteWorldInfoCache.forEach(function(data, odId) {
    playerNames.push(data.userName);
    
    if (data.syncContent && Array.isArray(data.syncContent)) {
      data.syncContent.forEach(function(item) {
        // 跳过 user 类型（用户消息已在主界面显示）
        if (item.type === 'user') return;
        
        allContents.push({
          from: data.userName,
          type: item.type,
          content: item.content,
          role: item.role || 'system'
        });
      });
    }
  });
  
  if (allContents.length === 0) {
    log('没有需要注入的内容');
    return;
  }
  
  // 构建注入内容，添加特殊标签
  let fullContent = REMOTE_SYNC_TAG + '\n';
  fullContent += '[联机模式 - 来自其他玩家的设定]\n';
  fullContent += '以下内容来自联机房间中的其他玩家，请融合理解：\n';
  fullContent += '参与玩家：' + playerNames.join('、') + '\n\n';
  
  // 按类型分组显示
  const grouped = {
    worldInfo: [],
    character: [],
    chatHistory: []
  };
  
  allContents.forEach(function(item) {
    const key = item.type || 'other';
    if (grouped[key]) {
      grouped[key].push(item);
    }
  });
  
  // 添加世界书内容
  if (grouped.worldInfo.length > 0) {
    fullContent += '=== 世界设定 ===\n';
    grouped.worldInfo.forEach(function(item) {
      fullContent += '[来自 ' + item.from + ']\n' + item.content + '\n\n';
    });
  }
  
  // 添加角色卡内容
  if (grouped.character.length > 0) {
    fullContent += '=== 角色信息 ===\n';
    grouped.character.forEach(function(item) {
      fullContent += '[来自 ' + item.from + ']\n' + item.content + '\n\n';
    });
  }
  
  // 添加聊天历史上下文
  if (grouped.chatHistory.length > 0) {
    fullContent += '=== 对话上下文 ===\n';
    grouped.chatHistory.forEach(function(item) {
      fullContent += '[来自 ' + item.from + ']\n' + item.content + '\n\n';
    });
  }
  
  log('准备注入: ' + allContents.length + ' 条内容');
  
  // 获取 setExtensionPrompt
  let setExtensionPrompt = null;
  
  if (typeof window.setExtensionPrompt === 'function') {
    setExtensionPrompt = window.setExtensionPrompt;
  } else if (typeof window.parent?.setExtensionPrompt === 'function') {
    setExtensionPrompt = window.parent.setExtensionPrompt;
  } else {
    try {
      const ctx = getContext();
      if (typeof ctx.setExtensionPrompt === 'function') {
        setExtensionPrompt = ctx.setExtensionPrompt;
      }
    } catch(e) {}
  }
  
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
      log('已注入远程内容: ' + allContents.length + ' 条');
    } catch(e) {
      log('setExtensionPrompt 调用失败: ' + e);
      tryAlternativeInjection(fullContent);
    }
  } else {
    log('setExtensionPrompt 不可用，尝试备用方案');
    tryAlternativeInjection(fullContent);
  }
}

// ========== 备用注入方案 ==========
function tryAlternativeInjection(content) {
  try {
    const ctx = getContext();
    if (ctx.extensionPrompts) {
      ctx.extensionPrompts[INJECTION_KEY] = {
        value: content,
        position: EXTENSION_PROMPT_TYPES.IN_PROMPT,
        depth: 0,
        scan: true,
        role: EXTENSION_PROMPT_ROLES.SYSTEM
      };
      log('备用方案成功：直接写入 extensionPrompts');
      return true;
    }
  } catch(e) {
    log('备用方案失败: ' + e);
  }
  
  log('所有注入方案都失败了');
  return false;
}

// ========== 清除注入 ==========
function clearInjectedExtensionPrompt() {
  try {
    let setExtensionPrompt = null;
    
    if (typeof window.setExtensionPrompt === 'function') {
      setExtensionPrompt = window.setExtensionPrompt;
    } else if (typeof window.parent?.setExtensionPrompt === 'function') {
      setExtensionPrompt = window.parent.setExtensionPrompt;
    } else {
      try {
        const ctx = getContext();
        if (typeof ctx.setExtensionPrompt === 'function') {
          setExtensionPrompt = ctx.setExtensionPrompt;
        }
      } catch(e) {}
    }
    
    if (typeof setExtensionPrompt === 'function') {
      setExtensionPrompt(INJECTION_KEY, '', EXTENSION_PROMPT_TYPES.IN_PROMPT, 0, false);
    }
    
    // 同时清理 extensionPrompts 对象
    try {
      const ctx = getContext();
      if (ctx.extensionPrompts && ctx.extensionPrompts[INJECTION_KEY]) {
        delete ctx.extensionPrompts[INJECTION_KEY];
      }
    } catch(e) {}
    
  } catch(e) {
    log('清除注入失败: ' + e);
  }
}

// ========== 发送按钮控制 ==========
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
    sendBtn.css({
      'opacity': '',
      'pointer-events': '',
      'cursor': ''
    });
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
    const reason = '等待 ' + (turnState.speakerName || '其他玩家') + ' 的回合...';
    blockSendButton(reason);
  } else {
    unblockSendButton();
  }
}

// ========== 发送拦截器 ==========
function setupSendInterceptor() {
  $(document).off('click.mpIntercept', '#send_but');
  $(document).on('click.mpIntercept', '#send_but', function(e) {
    if (!currentRoom) return true;
    
    if (isSendBlocked || !turnState.isMyTurn) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      toast('warning', '请等待 ' + (turnState.speakerName || '其他玩家') + ' 的回合结束');
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
        toast('warning', '请等待 ' + (turnState.speakerName || '其他玩家') + ' 的回合结束');
        return false;
      }
    }
    return true;
  });
  
  log('发送拦截器已设置');
}

// ========== WebSocket 发送 ==========
function sendWS(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// ========== WebSocket 连接 ==========
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

// ========== 重连逻辑 ==========
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
  reconnectTimer = setTimeout(function() {
    connectServer();
  }, RECONNECT_INTERVAL);
}

// ========== 主动断开 ==========
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

// ========== 心跳 ==========
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

// ========== 活动监听 ==========
function setupActivityListener() {
  $(document).on('click', '#send_but, #send_button, .send_button', function() {
    if (isConnected) {
      sendWS({ type: 'mainActivity' });
    }
  });
  log('活动监听已设置');
}

// ========== 用户名监听 ==========
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
  
  try {
    if (event_types.SETTINGS_UPDATED) {
      eventSource.on(event_types.SETTINGS_UPDATED, function() {
        setTimeout(function() {
          const oldName = userName;
          if (getUserName() && userName !== oldName) {
            log('设置更新，用户名变化: ' + userName);
            if (isConnected) {
              sendWS({ type: 'setUserInfo', name: userName });
            }
            refreshPanel();
          }
        }, 500);
      });
    }
  } catch(e) {}
  
  log('用户名监听已设置');
}

// ========== 添加联机标签 ==========
function addRemoteTag(messageId, labelText, type) {
  const mesEl = $(`.mes[mesid="${messageId}"]`);
  if (!mesEl.length) return;
  
  const nameTextEl = mesEl.find('.ch_name .name_text');
  if (!nameTextEl.length) return;
  
  if (nameTextEl.siblings('.remote-tag').length) return;
  
  const tagClass = type === 'ai' ? 'remote-tag remote-ai-tag' : 'remote-tag';
  const tag = $(`<span class="${tagClass}">${escapeHtml(labelText)}</span>`);
  nameTextEl.after(tag);
}

// ========== 强制停止AI生成 ==========
function forceStopGeneration() {
  try {
    const stopBtn = $('#mes_stop');
    if (stopBtn.length && stopBtn.is(':visible')) {
      stopBtn.trigger('click');
      log('已触发停止生成');
    }
  } catch(e) {
    log('停止生成失败: ' + e);
  }
  isGenerating = false;
}

// ========== 删除超时消息 ==========
function deleteTimeoutMessages(phase) {
  try {
    const chat = getChat();
    if (!chat || chat.length === 0) return;
    
    if (phase !== 'aiGenerating') {
      log('用户未发送消息，不删除任何内容');
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
    
    const saveChatDebounced = window.saveChatDebounced;
    if (saveChatDebounced) saveChatDebounced();
    
    log('已删除超时消息');
    toast('warning', '发言超时，消息已撤回');
  } catch(e) {
    log('删除消息失败: ' + e);
  }
}

// ========================================
// 第4部分：消息处理函数
// ========================================

// ========== 处理远程用户消息 ==========
function handleRemoteUserMessage(msg) {
  const msgKey = msg.senderId + '_' + msg.timestamp;
  if (processedMsgCache.has(msgKey)) {
    log('跳过重复用户消息');
    return;
  }
  processedMsgCache.add(msgKey);
  
  // 限制缓存大小
  if (processedMsgCache.size > 100) {
    const arr = Array.from(processedMsgCache);
    processedMsgCache = new Set(arr.slice(-50));
  }
  
  log('收到远程用户消息: ' + msg.userName);
  
  // 存储远程同步内容（世界书、角色卡、上下文等）
  if (msg.syncContent && msg.syncContent.length > 0) {
    storeRemoteWorldInfo(msg.senderId, msg.senderName, msg.syncContent, msg.timestamp);
  }
  
  const chat = getChat();
  if (!chat || chat.length === undefined) {
    log('无法获取chat');
    return;
  }
  
  // 获取添加消息函数
  let addOneMessage = null;
  let saveChatDebounced = null;
  
  try {
    const ctx = getContext();
    addOneMessage = ctx.addOneMessage || window.addOneMessage;
    saveChatDebounced = ctx.saveChatDebounced || window.saveChatDebounced;
  } catch(e) {}
  
  if (!addOneMessage) {
    log('无法获取 addOneMessage');
    return;
  }
  
  // 创建消息对象
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
  
  // 添加到聊天
  chat.push(message);
  const messageId = chat.length - 1;
  addOneMessage(message, { forceId: messageId, scroll: true });
  
  // 添加联机标签
  setTimeout(function() {
    addRemoteTag(messageId, '用户', 'user');
  }, 150);
  
  // 保存聊天
  if (saveChatDebounced) saveChatDebounced();
  
  log('远程用户消息已显示: #' + messageId);
}

// ========== 处理远程AI流式消息 ==========
function handleRemoteAiStream(msg) {
  const chat = getChat();
  if (!chat) return;
  
  let streamInfo = remoteStreamMap.get(msg.senderId);
  
  if (!streamInfo) {
    // 首次收到，创建占位消息
    let addOneMessage = null;
    try {
      const ctx = getContext();
      addOneMessage = ctx.addOneMessage || window.addOneMessage;
    } catch(e) {}
    
    if (!addOneMessage) return;
    
    const message = {
      name: msg.charName,
      is_user: false,
      is_system: false,
      send_date: getMessageTimeStamp(),
      mes: msg.content,
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
  } else {
    // 更新已有消息
    const messageId = streamInfo.messageId;
    
    if (chat[messageId]) {
      chat[messageId].mes = msg.content;
    }
    
    // 更新DOM
    const mesText = $(`.mes[mesid="${messageId}"] .mes_text`);
    if (mesText.length) {
      mesText.html(simpleMarkdown(msg.content));
    }
  }
  
  // 滚动到底部
  try {
    const scrollFn = window.scrollChatToBottom;
    if (scrollFn) scrollFn();
  } catch(e) {}
}

// ========== 处理远程AI完整消息 ==========
function handleRemoteAiComplete(msg) {
  const chat = getChat();
  const streamInfo = remoteStreamMap.get(msg.senderId);
  
  if (streamInfo) {
    // 完成流式消息
    const messageId = streamInfo.messageId;
    
    if (chat[messageId]) {
      chat[messageId].mes = msg.content;
      chat[messageId].extra.isStreaming = false;
    }
    
    // 更新DOM
    const mesText = $(`.mes[mesid="${messageId}"] .mes_text`);
    if (mesText.length) {
      mesText.html(simpleMarkdown(msg.content));
    }
    
    // 添加联机标签
    setTimeout(function() {
      addRemoteTag(messageId, '联机AI', 'ai');
    }, 150);
    
    remoteStreamMap.delete(msg.senderId);
    
    // 保存聊天
    let saveChatDebounced = null;
    try {
      saveChatDebounced = window.saveChatDebounced;
    } catch(e) {}
    if (saveChatDebounced) saveChatDebounced();
    
    log('远程AI消息完成(流式): #' + messageId);
  } else {
    // 直接创建完整消息（未收到流式的情况）
    const msgKey = msg.senderId + '_' + msg.timestamp + '_ai';
    if (processedMsgCache.has(msgKey)) return;
    processedMsgCache.add(msgKey);
    
    let addOneMessage = null;
    let saveChatDebounced = null;
    try {
      const ctx = getContext();
      addOneMessage = ctx.addOneMessage || window.addOneMessage;
      saveChatDebounced = ctx.saveChatDebounced || window.saveChatDebounced;
    } catch(e) {}
    
    if (!addOneMessage) return;
    
    const message = {
      name: msg.charName,
      is_user: false,
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
    
    setTimeout(function() {
      addRemoteTag(messageId, '联机AI', 'ai');
    }, 150);
    
    if (saveChatDebounced) saveChatDebounced();
    log('远程AI消息完成(直接): #' + messageId);
  }
}

// ========== 处理服务器消息 ==========
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

// ========== 事件监听设置（优化版）==========
function setupEventListeners() {
  
  // ===== 1. 生成开始 - 注入远程内容（最早时机！）=====
  eventSource.on(event_types.GENERATION_STARTED, function(type, options, dryRun) {
    if (dryRun) return;
    if (!currentRoom) return;
    
    log('事件: 生成开始');
    isGenerating = true;
    
    // 如果有缓存的远程内容，立即注入
    if (remoteWorldInfoCache.size > 0) {
      injectRemoteWorldInfoViaExtensionPrompt();
    }
  });
  
  // ===== 2. 用户消息发送后 - 构建对照组 =====
  eventSource.on(event_types.MESSAGE_SENT, async function(messageId) {
    if (!currentRoom || !turnState.isMyTurn) return;
    
    const chat = getChat();
    const msg = chat[messageId];
    if (!msg || !msg.is_user) return;
    if (msg.extra && msg.extra.isRemote) return;
    
    log('事件: 用户消息发送 #' + messageId);
    
    // 构建完整对照组（世界书 + 角色卡 + 聊天历史）
    pendingReferenceSet = await buildReferenceSet();
    
    log('对照组已准备完成');
  });
  
  // ===== 3. 数据包准备完成 - 提取并发送 =====
  eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, function(data) {
    if (data.dryRun) return;
    if (!currentRoom || !turnState.isMyTurn) return;
    if (!pendingReferenceSet) return;
    
    log('事件: 数据包拦截');
    
    // 使用对照组提取需要同步的内容
    const syncContent = extractSyncContent(data.chat, pendingReferenceSet);
    
    // 获取用户消息（用于显示，不用于同步）
    const chat = getChat();
    const lastUserMsg = chat.filter(m => m.is_user && (!m.extra || !m.extra.isRemote)).pop();
    
    // 发送到云端
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
    
    // 清理
    pendingReferenceSet = null;
  });
  
  // ===== 4. 流式token（节流）=====
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
  
  // ===== 5. 生成结束 - 清理 =====
  eventSource.on(event_types.GENERATION_ENDED, function(messageCount) {
    if (!currentRoom) return;
    
    clearInjectedExtensionPrompt();
    
    if (!turnState.isMyTurn || !isGenerating) return;
    
    clearRemoteWorldInfoCache();
    
    log('事件: 生成结束');
    isGenerating = false;
    
    // 延迟100ms确保消息完全更新
    setTimeout(function() {
      const chat = getChat();
      const lastMsg = chat[chat.length - 1];
      if (!lastMsg || lastMsg.is_user) return;
      if (lastMsg.extra && lastMsg.extra.isRemote) return;
      
      sendWS({
        type: 'syncAiComplete',
        content: lastMsg.mes,
        charName: lastMsg.name,
        senderName: userName,
        timestamp: Date.now()
      });
      
      sendWS({ type: 'aiGenerationEnded' });
    }, 100);
  });
  
  // ===== 6. 生成停止 =====
  eventSource.on(event_types.GENERATION_STOPPED, function() {
    log('事件: 生成停止');
    isGenerating = false;
    clearInjectedExtensionPrompt();
  });
  
  // ===== 7. 聊天切换时清理 =====
  eventSource.on(event_types.CHAT_CHANGED, function() {
    log('事件: 聊天切换');
    remoteStreamMap.clear();
    remoteWorldInfoCache.clear();
    isGenerating = false;
    pendingReferenceSet = null;
    clearInjectedExtensionPrompt();
  });
  
  log('事件监听已设置');
}

// ========================================
// 第5部分：UI面板构建
// ========================================

// ========== 倒计时显示 ==========
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

// ========== 构建轮次状态HTML ==========
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
  
  if (turnState.queue && turnState.queue.length > 0) {
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

// ========== 构建房间成员HTML ==========
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

// ========== 构建在线用户HTML ==========
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

// ========== 构建聊天HTML ==========
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

// ========== 构建主面板HTML ==========
function buildPanelHTML() {
  let html = '<div class="mp-header">';
  
  if (currentRoom) {
    html += '<div class="mp-title">房间: ' + escapeHtml(currentRoom) + ' (' + roomUsers.length + '/5)</div>';
  } else {
    html += '<div class="mp-title">酒馆联机</div>';
  }
  
  html += '<button class="mp-close" id="mp-close-btn">×</button>';
  html += '</div>';
  
  // 状态栏
  html += '<div class="mp-status">';
  if (isConnected) {
    html += '<div class="mp-dot" style="background:#4ade80;"></div>';
    html += '<span style="color:#4ade80;">' + (currentRoom ? '已进入房间' : '已连接服务器') + '</span>';
  } else {
    html += '<div class="mp-dot" style="background:#666;"></div>';
    html += '<span style="color:#888;">未连接服务器</span>';
  }
  html += '</div>';
  
  // 内容区
  html += '<div class="mp-content">';
  
  if (!isConnected) {
    // 未连接状态
    html += '<div style="text-align:center;padding:40px 0;">';
    html += '<div style="color:#888;margin-bottom:20px;">点击下方按钮连接服务器</div>';
    html += '<button class="mp-btn mp-btn-green" id="mp-connect-btn">🔌 连接服务器</button>';
    html += '</div>';
  } else if (!currentRoom) {
    // 已连接但未进入房间
    html += '<button class="mp-btn mp-btn-green" id="mp-create-room-btn">➕ 创建房间</button>';
    html += '<div class="mp-divider"></div>';
    html += '<input type="text" class="mp-input" id="mp-room-code-input" placeholder="输入房间代码" maxlength="6" style="text-transform:uppercase;">';
    html += '<button class="mp-btn mp-btn-blue" id="mp-join-room-btn">🚪 加入房间</button>';
    html += '<div style="margin-top:20px;text-align:center;">';
    html += '<button class="mp-btn mp-btn-gray" id="mp-disconnect-btn">断开连接</button>';
    html += '</div>';
  } else {
    // 已进入房间
    html += '<div class="mp-room-info">';
    html += '<div><div style="color:#888;font-size:11px;">房间代码</div>';
    html += '<div class="mp-room-code">' + escapeHtml(currentRoom) + '</div></div>';
    html += '<div style="color:#888;font-size:14px;">' + roomUsers.length + '/5 人</div>';
    html += '</div>';
    
    // 轮次状态
    html += buildTurnStateHTML();
    
    // 房间成员（默认展开）
    html += '<div class="mp-section expanded" id="mp-room-members-section">';
    html += '<div class="mp-section-header" id="mp-room-members-toggle">';
    html += '<span class="mp-section-title">房间成员 (' + roomUsers.length + ')</span>';
    html += '<span style="color:#888;">▲</span>';
    html += '</div>';
    html += '<div class="mp-section-body" id="mp-room-members-list">' + buildRoomMembersHTML() + '</div>';
    html += '</div>';
    
    // 在线用户
    html += '<div class="mp-section' + (onlineListExpanded ? ' expanded' : '') + '" id="mp-online-section">';
    html += '<div class="mp-section-header" id="mp-online-toggle">';
    html += '<span class="mp-section-title">在线用户 (' + onlineUsers.length + ')</span>';
    html += '<span style="color:#888;">' + (onlineListExpanded ? '▲' : '▼') + '</span>';
    html += '</div>';
    html += '<div class="mp-section-body" id="mp-online-list">' + buildOnlineListHTML() + '</div>';
    html += '</div>';
    
    // 聊天区域
    html += '<div class="mp-chat-box" id="mp-chat-box">' + buildChatHTML() + '</div>';
    html += '<div class="mp-chat-input-wrap">';
    html += '<textarea class="mp-chat-input" id="mp-chat-input" placeholder="输入消息..." maxlength="300" rows="1"></textarea>';
    html += '<button class="mp-chat-send" id="mp-chat-send">发送</button>';
    html += '</div>';
    
    // 离开房间按钮
    html += '<div style="margin-top:15px;">';
    html += '<button class="mp-btn mp-btn-red" id="mp-leave-room-btn">🚪 离开房间</button>';
    html += '</div>';
  }
  
  html += '</div>';
  
  return html;
}

// ========== 打开主面板 ==========
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

// ========== 关闭主面板 ==========
function closePanel() {
  $('#mp-main-overlay').remove();
  stopCountdownDisplay();
}

// ========== 刷新面板 ==========
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

// ========== 滚动聊天到底部 ==========
function scrollChatToBottom() {
  const box = document.getElementById('mp-chat-box');
  if (box) box.scrollTop = box.scrollHeight;
}

// ========== 更新在线列表 ==========
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

// ========== 更新聊天UI ==========
function updateChatUI() {
  const box = $('#mp-chat-box');
  if (box.length) {
    box.html(buildChatHTML());
    scrollChatToBottom();
  }
}

// ========== 更新轮次状态UI ==========
function updateTurnStateUI() {
  const turnContainer = $('.mp-turn-state');
  if (turnContainer.length) {
    turnContainer.replaceWith(buildTurnStateHTML());
    
    // 重新绑定跳过按钮事件
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

// ========== 发送房间聊天消息 ==========
function sendChatMessage() {
  const input = $('#mp-chat-input');
  const content = input.val().trim();
  
  if (!content || !currentRoom) return;
  
  sendWS({ type: 'roomChat', content: content });
  input.val('');
  sendWS({ type: 'mainActivity' });
}

// ========== 更新菜单文字 ==========
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
// 第6部分：事件绑定 + 弹窗 + 初始化
// ========================================

// ========== 绑定面板事件 ==========
function bindPanelEvents() {
  // 关闭按钮
  $('#mp-close-btn').on('click', closePanel);
  
  // 连接按钮
  $('#mp-connect-btn').on('click', function() {
    isNormalDisconnect = false;
    isInactiveKick = false;
    connectServer();
  });
  
  // 断开连接按钮
  $('#mp-disconnect-btn').on('click', function() {
    normalDisconnect();
  });
  
  // 创建房间按钮
  $('#mp-create-room-btn').on('click', function() {
    sendWS({ type: 'createRoom', roomName: userName + '的房间' });
  });
  
  // 加入房间按钮
  $('#mp-join-room-btn').on('click', function() {
    const code = $('#mp-room-code-input').val().trim().toUpperCase();
    if (!code || code.length !== 6) {
      toast('warning', '请输入6位房间代码');
      return;
    }
    sendWS({ type: 'joinRoom', roomId: code });
  });
  
  // 房间代码输入框回车
  $('#mp-room-code-input').on('keypress', function(e) {
    if (e.which === 13) {
      $('#mp-join-room-btn').trigger('click');
    }
  });
  
  // 离开房间按钮
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
    unblockSendButton();
    refreshPanel();
    toast('info', '已离开房间');
  });
  
  // 房间成员折叠
  $('#mp-room-members-toggle').on('click', function() {
    $('#mp-room-members-section').toggleClass('expanded');
    const isExp = $('#mp-room-members-section').hasClass('expanded');
    $(this).find('span:last').text(isExp ? '▲' : '▼');
  });
  
  // 在线用户折叠
  $('#mp-online-toggle').on('click', function() {
    onlineListExpanded = !onlineListExpanded;
    $('#mp-online-section').toggleClass('expanded', onlineListExpanded);
    $(this).find('span:last').text(onlineListExpanded ? '▲' : '▼');
  });
  
  // 在线用户点击（邀请/请求加入）
  $('#mp-online-list').on('click', '.mp-user', function() {
    const targetId = $(this).data('userid');
    if (targetId === odId) return;
    
    const targetUser = onlineUsers.find(function(u) {
      return u.id === targetId;
    });
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
  
  // 发送聊天消息按钮
  $('#mp-chat-send').on('click', sendChatMessage);
  
  // 聊天输入框回车
  $('#mp-chat-input').on('keypress', function(e) {
    if (e.which === 13 && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });
  
  // 聊天输入框自动高度
  $('#mp-chat-input').on('input', function() {
    this.style.height = '36px';
    this.style.height = Math.min(this.scrollHeight, 72) + 'px';
  });
  
  // 跳过回合按钮
  $('#mp-skip-turn').on('click', function() {
    showConfirmPopup('跳过回合', '确定要跳过你的发言回合吗？', function() {
      sendWS({ type: 'skipTurn' });
      toast('info', '已跳过回合');
    });
  });
}

// ========== 确认弹窗 ==========
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
    'z-index': '999999',
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
  
  $('#mp-confirm-no').on('click', function() {
    overlay.remove();
  });
  
  $('#mp-confirm-yes').on('click', function() {
    overlay.remove();
    if (onConfirm) onConfirm();
  });
}

// ========== 邀请弹窗 ==========
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
    'z-index': '999999',
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
  
  // 15秒后自动关闭
  const autoClose = setTimeout(function() {
    overlay.remove();
  }, 15000);
  
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

// ========== 创建扩展设置面板UI ==========
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
  
  // 绑定打开面板按钮
  $('#mp-ext-open-btn').on('click', function() {
    openPanel();
  });
  
  // 更新状态显示
  updateMenuText();
  
  log('扩展UI已创建');
}

// ========== 调试函数 ==========
async function debugWorldInfo() {
  console.log('===== 世界书调试信息 =====');
  
  const selected = window.selected_world_info || [];
  console.log('激活的全局世界书:', selected);
  
  const entries = await getAllWorldInfoEntries();
  console.log('世界书条目总数:', entries.length);
  
  entries.slice(0, 10).forEach((e, i) => {
    console.log(`[${i}] ${e.comment || '无标题'} (${e.source}) - ${(e.content || '').substring(0, 50)}...`);
  });
  
  const charInfo = getCharacterInfo();
  console.log('角色卡信息:', charInfo ? charInfo.name : '无');
  
  console.log('远程世界书缓存:', remoteWorldInfoCache.size, '个玩家');
  
  console.log('===========================');
}

// ========== 初始化扩展 ==========
jQuery(async () => {
  log('扩展加载中... v1.0.1');
  
  // 加载设置
  loadSettings();
  
  // 等待用户名获取
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

// ========== 加载设置 ==========
function loadSettings() {
  extension_settings[extensionName] = extension_settings[extensionName] || {};
  if (Object.keys(extension_settings[extensionName]).length === 0) {
    Object.assign(extension_settings[extensionName], defaultSettings);
  }
}

// ========== 导出调试函数 ==========
window.mpDebug = {
  worldInfo: debugWorldInfo,
  state: function() {
    console.log('===== 联机状态 =====');
    console.log('连接状态:', isConnected);
    console.log('用户ID:', odId);
    console.log('用户名:', userName);
    console.log('当前房间:', currentRoom);
    console.log('房间用户:', roomUsers);
    console.log('轮次状态:', turnState);
    console.log('远程世界书缓存:', remoteWorldInfoCache.size);
    console.log('====================');
  },
  cache: function() {
    console.log('===== 远程缓存内容 =====');
    remoteWorldInfoCache.forEach(function(data, odId) {
      console.log('玩家:', data.userName);
      console.log('内容数量:', data.syncContent ? data.syncContent.length : 0);
      if (data.syncContent) {
        data.syncContent.forEach(function(item, idx) {
          console.log(`  [${idx}] type=${item.type}, 长度=${item.content ? item.content.length : 0}`);
        });
      }
    });
    console.log('========================');
  },
  connect: connectServer,
  disconnect: normalDisconnect,
  openPanel: openPanel
};