// ========================================
// 酒馆联机扩展 v2.7
// 服务器: wss://chu.zeabur.app
// 核心改动: 
//   - 添加全方位追踪系统
//   - 劫持所有DOM修改API
//   - 追踪未知函数的调用栈
// ========================================

import { eventSource, event_types } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';

// ========== 扩展配置 ==========
const extensionName = 'stli';
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// ========== 版本信息 ==========
const CURRENT_VERSION = '2.7.0';

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
const DEBUG_MODE = true;
const DEBUG_POPUP = true;

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

// ========== 发送方捕获状态 ==========
let pendingCapture = {
  enabled: false,
  messageId: null,
  captured: false,
  html: null
};

// ========== DOM 观察器 ==========
let chatObserver = null;

// ========== 远程消息保护器 ==========
const remoteMessageObservers = new Map();

// ========== 远程上下文缓存 ==========
let remoteContextCache = new Map();

// ========================================
// 🕵️ 全方位追踪系统
// ========================================

const TraceSystem = {
  // 配置
  enabled: false,
  installed: false,
  
  // 存储原始函数引用
  originals: {
    // 原生 DOM API
    innerHTMLSetter: null,
    outerHTMLSetter: null,
    textContentSetter: null,
    appendChild: null,
    insertBefore: null,
    replaceChild: null,
    removeChild: null,
    append: null,
    prepend: null,
    replaceWith: null,
    replaceChildren: null,
    insertAdjacentHTML: null,
    
    // jQuery
    jQueryHtml: null,
    jQueryText: null,
    jQueryAppend: null,
    jQueryPrepend: null,
    jQueryAfter: null,
    jQueryBefore: null,
    jQueryReplaceWith: null,
    jQueryEmpty: null,
    
    // 事件系统
    eventSourceEmit: null,
    
    // 酒馆函数
    messageFormatting: null,
    updateMessageBlock: null,
    addOneMessage: null,
  },
  
  // 追踪日志
  logs: [],
  maxLogs: 500,
  
  // 追踪的远程消息ID集合
  trackedMessageIds: new Set(),
  
  // 快照存储
  snapshots: new Map(),
  
  // 统计
  stats: {
    totalModifications: 0,
    byMethod: {},
    byFile: {},
    corruptions: 0,
  },
  
  // ========== 工具函数 ==========
  
  // 解析调用栈
parseStack: function(stack) {
  if (!stack) return [];
  
  const lines = stack.split('\n');
  const result = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line === 'Error') continue;
    
    // 匹配格式: "at functionName (file:line:column)"
    let match = line.match(/at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/);
    if (match) {
      result.push({
        function: match[1],
        file: this.extractFileName(match[2]),
        fullPath: match[2],
        line: parseInt(match[3]),
        column: parseInt(match[4]),
        raw: line
      });
      continue;
    }
    
    // 匹配格式: "at file:line:column"
    match = line.match(/at\s+(.+?):(\d+):(\d+)/);
    if (match) {
      result.push({
        function: '(anonymous)',
        file: this.extractFileName(match[1]),
        fullPath: match[1],
        line: parseInt(match[2]),
        column: parseInt(match[3]),
        raw: line
      });
      continue;
    }
    
    // 匹配格式: "at functionName (native code)" 或 "at functionName (file)"
    match = line.match(/at\s+(.+?)\s+\((.+?)\)/);
    if (match) {
      result.push({
        function: match[1],
        file: match[2],
        fullPath: match[2],
        line: null,
        column: null,
        raw: line
      });
      continue;
    }
    
    // 匹配格式: "at functionName"
    match = line.match(/at\s+(.+)/);
    if (match) {
      result.push({
        function: match[1],
        file: 'unknown',
        fullPath: 'unknown',
        line: null,
        column: null,
        raw: line
      });
    }
  }
  
  return result;
},
  
  // 从路径提取文件名
  extractFileName: function(path) {
    if (!path) return 'unknown';
    
    // 移除查询参数
    path = path.split('?')[0];
    
    // 提取最后的文件名
    const parts = path.split('/');
    return parts[parts.length - 1] || path;
  },
  
  // 检查元素是否是我们追踪的远程消息
  isTrackedElement: function(element) {
    if (!element || !element.closest) return false;
    
    const mesElement = element.closest('.mes[data-remote="true"]');
    if (!mesElement) return false;
    
    // 检查是否是 .mes_text 或其子元素
    const mesText = mesElement.querySelector('.mes_text');
    if (!mesText) return false;
    
    return element === mesText || mesText.contains(element);
  },
  
  // 获取元素所属的消息ID
  getMessageId: function(element) {
    if (!element || !element.closest) return null;
    const mesElement = element.closest('.mes');
    if (!mesElement) return null;
    return parseInt(mesElement.getAttribute('mesid'));
  },
  
  // 创建快照
  createSnapshot: function(element) {
    if (!element) return null;
    return {
      innerHTML: element.innerHTML,
      textContent: element.textContent,
      length: element.innerHTML?.length || 0,
      timestamp: Date.now()
    };
  },
  
  // 格式化时间
  formatTime: function(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('zh-CN', { 
      hour12: false, 
      hour: '2-digit', 
      minute: '2-digit', 
      second: '2-digit',
      fractionalSecondDigits: 3
    });
  },
  
  // 记录日志
  log: function(entry) {
    // 添加序号和时间
    entry.seq = this.logs.length + 1;
    entry.time = Date.now();
    entry.timeReadable = this.formatTime(entry.time);
    
    // 解析调用栈
    if (entry.stack) {
      entry.callChain = this.parseStack(entry.stack);
      
      // 找出关键调用者（跳过我们自己的代码和原生代码）
      const dominated = ['innerHTML setter', 'outerHTML setter', 'appendChild wrapper', 
                        'insertBefore wrapper', 'jQuery.html wrapper', 'traceSystem'];
      
      for (const call of entry.callChain) {
        if (!dominated.some(d => call.function?.includes(d)) && 
            call.file !== 'unknown' && 
            !call.file.includes('native code')) {
          entry.triggerFunction = call.function;
          entry.triggerFile = call.file;
          entry.triggerLine = call.line;
          break;
        }
      }
    }
    
    // 判断是否是污染
    if (entry.contentBefore && entry.contentAfter) {
      const lenBefore = entry.contentBefore.length;
      const lenAfter = entry.contentAfter.length;
      
      // 如果内容大幅缩短，可能是污染
      if (lenBefore > 100 && lenAfter < lenBefore * 0.1) {
        entry.isCorruption = true;
        entry.severity = 'critical';
        this.stats.corruptions++;
      } else if (entry.contentAfter.includes('[远程消息]') || 
                 entry.contentAfter.includes('<p>…</p>')) {
        entry.isCorruption = true;
        entry.severity = 'high';
        this.stats.corruptions++;
      }
    }
    
    // 更新统计
    this.stats.totalModifications++;
    this.stats.byMethod[entry.method] = (this.stats.byMethod[entry.method] || 0) + 1;
    if (entry.triggerFile) {
      this.stats.byFile[entry.triggerFile] = (this.stats.byFile[entry.triggerFile] || 0) + 1;
    }
    
    // 添加到日志
    this.logs.push(entry);
    
    // 限制日志数量
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }
    
    // 实时输出
    this.printEntry(entry);
    
    return entry;
  },
  
  // 打印单条日志
  printEntry: function(entry) {
    const prefix = entry.isCorruption ? '🔴' : '📝';
    const severity = entry.isCorruption ? 'color: #ff4444; font-weight: bold;' : 'color: #4ade80;';
    
    console.groupCollapsed(
      `%c${prefix} [追踪 #${entry.seq}] ${entry.method} @ ${entry.timeReadable} | 消息#${entry.messageId}`,
      severity
    );
    
    console.log('方法:', entry.method);
    console.log('消息ID:', entry.messageId);
    console.log('是否远程消息:', entry.isRemote);
    
    if (entry.triggerFunction) {
      console.log('%c触发函数: ' + entry.triggerFunction, 'color: #f59e0b; font-weight: bold;');
      console.log('%c触发文件: ' + entry.triggerFile + ':' + entry.triggerLine, 'color: #f59e0b;');
    }
    
    if (entry.contentBefore !== undefined) {
      console.log('内容变化:', entry.contentBefore?.length, '→', entry.contentAfter?.length);
      if (entry.contentBefore?.length < 500) {
        console.log('之前:', entry.contentBefore?.substring(0, 200));
      }
      if (entry.contentAfter?.length < 500) {
        console.log('之后:', entry.contentAfter?.substring(0, 200));
      }
    }
    
    if (entry.isCorruption) {
      console.log('%c⚠️ 检测到污染！严重程度: ' + entry.severity, 'color: #ff4444; font-weight: bold; font-size: 14px;');
    }
    
    if (entry.callChain && entry.callChain.length > 0) {
      console.groupCollapsed('调用栈 (' + entry.callChain.length + ' 层)');
      entry.callChain.forEach((call, i) => {
        const highlight = (call.function === entry.triggerFunction) ? 'background: #f59e0b; color: #000; padding: 2px 4px;' : '';
        console.log(`%c#${i + 1} ${call.function} @ ${call.file}:${call.line}`, highlight);
      });
      console.groupEnd();
    }
    
    console.groupEnd();
  },
  
  // ========== 劫持函数 ==========
  
  // 安装追踪系统
  install: function() {
    if (this.installed) {
      console.log('[追踪系统] 已安装，跳过');
      return;
    }
    
    console.log('%c[追踪系统] 开始安装...', 'color: #4ade80; font-weight: bold; font-size: 14px;');
    
    const self = this;
    
    // ========== 劫持原生 DOM API ==========
    
    // innerHTML setter
    const innerHTMLDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    this.originals.innerHTMLSetter = innerHTMLDescriptor.set;
    
    Object.defineProperty(Element.prototype, 'innerHTML', {
      set: function(value) {
        const messageId = self.getMessageId(this);
        const isRemote = this.closest?.('.mes[data-remote="true"]') !== null;
        const isMesText = this.classList?.contains('mes_text');
        
        if (isRemote && isMesText && self.enabled) {
          const before = this.innerHTML;
          self.originals.innerHTMLSetter.call(this, value);
          const after = this.innerHTML;
          
          self.log({
            method: 'innerHTML',
            messageId: messageId,
            isRemote: true,
            element: '.mes_text',
            contentBefore: before,
            contentAfter: after,
            stack: new Error().stack
          });
        } else {
          self.originals.innerHTMLSetter.call(this, value);
        }
      },
      get: innerHTMLDescriptor.get,
      configurable: true
    });
    
    // outerHTML setter
    const outerHTMLDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'outerHTML');
    this.originals.outerHTMLSetter = outerHTMLDescriptor.set;
    
    Object.defineProperty(Element.prototype, 'outerHTML', {
      set: function(value) {
        const messageId = self.getMessageId(this);
        const isRemote = this.closest?.('.mes[data-remote="true"]') !== null;
        const isMesText = this.classList?.contains('mes_text');
        
        if (isRemote && isMesText && self.enabled) {
          const before = this.outerHTML;
          self.originals.outerHTMLSetter.call(this, value);
          
          self.log({
            method: 'outerHTML',
            messageId: messageId,
            isRemote: true,
            element: '.mes_text',
            contentBefore: before,
            contentAfter: value,
            stack: new Error().stack
          });
        } else {
          self.originals.outerHTMLSetter.call(this, value);
        }
      },
      get: outerHTMLDescriptor.get,
      configurable: true
    });
    
    // textContent setter
    const textContentDescriptor = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
    this.originals.textContentSetter = textContentDescriptor.set;
    
    Object.defineProperty(Node.prototype, 'textContent', {
      set: function(value) {
        const messageId = self.getMessageId(this);
        const isRemote = this.closest?.('.mes[data-remote="true"]') !== null;
        const isMesText = this.classList?.contains('mes_text');
        
        if (isRemote && isMesText && self.enabled) {
          const before = this.textContent;
          self.originals.textContentSetter.call(this, value);
          
          self.log({
            method: 'textContent',
            messageId: messageId,
            isRemote: true,
            element: '.mes_text',
            contentBefore: before,
            contentAfter: value,
            stack: new Error().stack
          });
        } else {
          self.originals.textContentSetter.call(this, value);
        }
      },
      get: textContentDescriptor.get,
      configurable: true
    });
    
    // appendChild
    this.originals.appendChild = Node.prototype.appendChild;
    Node.prototype.appendChild = function(node) {
      const messageId = self.getMessageId(this);
      const isRemote = this.closest?.('.mes[data-remote="true"]') !== null;
      const isMesText = this.classList?.contains('mes_text');
      
      if (isRemote && isMesText && self.enabled) {
        const before = this.innerHTML;
        const result = self.originals.appendChild.call(this, node);
        const after = this.innerHTML;
        
        self.log({
          method: 'appendChild',
          messageId: messageId,
          isRemote: true,
          element: '.mes_text',
          contentBefore: before,
          contentAfter: after,
          appendedNode: node.nodeName,
          stack: new Error().stack
        });
        
        return result;
      }
      return self.originals.appendChild.call(this, node);
    };
    
    // insertBefore
    this.originals.insertBefore = Node.prototype.insertBefore;
    Node.prototype.insertBefore = function(newNode, refNode) {
      const messageId = self.getMessageId(this);
      const isRemote = this.closest?.('.mes[data-remote="true"]') !== null;
      const isMesText = this.classList?.contains('mes_text');
      
      if (isRemote && isMesText && self.enabled) {
        const before = this.innerHTML;
        const result = self.originals.insertBefore.call(this, newNode, refNode);
        const after = this.innerHTML;
        
        self.log({
          method: 'insertBefore',
          messageId: messageId,
          isRemote: true,
          element: '.mes_text',
          contentBefore: before,
          contentAfter: after,
          stack: new Error().stack
        });
        
        return result;
      }
      return self.originals.insertBefore.call(this, newNode, refNode);
    };
    
    // replaceChild
    this.originals.replaceChild = Node.prototype.replaceChild;
    Node.prototype.replaceChild = function(newChild, oldChild) {
      const messageId = self.getMessageId(this);
      const isRemote = this.closest?.('.mes[data-remote="true"]') !== null;
      const isMesText = this.classList?.contains('mes_text');
      
      if (isRemote && isMesText && self.enabled) {
        const before = this.innerHTML;
        const result = self.originals.replaceChild.call(this, newChild, oldChild);
        const after = this.innerHTML;
        
        self.log({
          method: 'replaceChild',
          messageId: messageId,
          isRemote: true,
          element: '.mes_text',
          contentBefore: before,
          contentAfter: after,
          stack: new Error().stack
        });
        
        return result;
      }
      return self.originals.replaceChild.call(this, newChild, oldChild);
    };
    
    // insertAdjacentHTML
    this.originals.insertAdjacentHTML = Element.prototype.insertAdjacentHTML;
    Element.prototype.insertAdjacentHTML = function(position, text) {
      const messageId = self.getMessageId(this);
      const isRemote = this.closest?.('.mes[data-remote="true"]') !== null;
      const isMesText = this.classList?.contains('mes_text');
      
      if (isRemote && isMesText && self.enabled) {
        const before = this.innerHTML;
        self.originals.insertAdjacentHTML.call(this, position, text);
        const after = this.innerHTML;
        
        self.log({
          method: 'insertAdjacentHTML',
          messageId: messageId,
          isRemote: true,
          element: '.mes_text',
          position: position,
          contentBefore: before,
          contentAfter: after,
          stack: new Error().stack
        });
      } else {
        self.originals.insertAdjacentHTML.call(this, position, text);
      }
    };
    
    // Element.append
    this.originals.append = Element.prototype.append;
    Element.prototype.append = function(...nodes) {
      const messageId = self.getMessageId(this);
      const isRemote = this.closest?.('.mes[data-remote="true"]') !== null;
      const isMesText = this.classList?.contains('mes_text');
      
      if (isRemote && isMesText && self.enabled) {
        const before = this.innerHTML;
        self.originals.append.apply(this, nodes);
        const after = this.innerHTML;
        
        self.log({
          method: 'Element.append',
          messageId: messageId,
          isRemote: true,
          element: '.mes_text',
          contentBefore: before,
          contentAfter: after,
          stack: new Error().stack
        });
      } else {
        self.originals.append.apply(this, nodes);
      }
    };
    
    // Element.prepend
    this.originals.prepend = Element.prototype.prepend;
    Element.prototype.prepend = function(...nodes) {
      const messageId = self.getMessageId(this);
      const isRemote = this.closest?.('.mes[data-remote="true"]') !== null;
      const isMesText = this.classList?.contains('mes_text');
      
      if (isRemote && isMesText && self.enabled) {
        const before = this.innerHTML;
        self.originals.prepend.apply(this, nodes);
        const after = this.innerHTML;
        
        self.log({
          method: 'Element.prepend',
          messageId: messageId,
          isRemote: true,
          element: '.mes_text',
          contentBefore: before,
          contentAfter: after,
          stack: new Error().stack
        });
      } else {
        self.originals.prepend.apply(this, nodes);
      }
    };
    
    // Element.replaceChildren
    if (Element.prototype.replaceChildren) {
      this.originals.replaceChildren = Element.prototype.replaceChildren;
      Element.prototype.replaceChildren = function(...nodes) {
        const messageId = self.getMessageId(this);
        const isRemote = this.closest?.('.mes[data-remote="true"]') !== null;
        const isMesText = this.classList?.contains('mes_text');
        
        if (isRemote && isMesText && self.enabled) {
          const before = this.innerHTML;
          self.originals.replaceChildren.apply(this, nodes);
          const after = this.innerHTML;
          
          self.log({
            method: 'replaceChildren',
            messageId: messageId,
            isRemote: true,
            element: '.mes_text',
            contentBefore: before,
            contentAfter: after,
            stack: new Error().stack
          });
        } else {
          self.originals.replaceChildren.apply(this, nodes);
        }
      };
    }
    
    // ========== 劫持 jQuery 方法 ==========
    
    if (typeof $ !== 'undefined' && $.fn) {
      // $.fn.html
      this.originals.jQueryHtml = $.fn.html;
      $.fn.html = function(value) {
        if (arguments.length === 0) {
          return self.originals.jQueryHtml.call(this);
        }
        
        this.each(function() {
          const messageId = self.getMessageId(this);
          const isRemote = this.closest?.('.mes[data-remote="true"]') !== null;
          const isMesText = this.classList?.contains('mes_text');
          
          if (isRemote && isMesText && self.enabled) {
            const before = this.innerHTML;
            self.originals.jQueryHtml.call($(this), value);
            const after = this.innerHTML;
            
            self.log({
              method: 'jQuery.html()',
              messageId: messageId,
              isRemote: true,
              element: '.mes_text',
              contentBefore: before,
              contentAfter: after,
              stack: new Error().stack
            });
          } else {
            self.originals.jQueryHtml.call($(this), value);
          }
        });
        
        return this;
      };
      
      // $.fn.text
      this.originals.jQueryText = $.fn.text;
      $.fn.text = function(value) {
        if (arguments.length === 0) {
          return self.originals.jQueryText.call(this);
        }
        
        this.each(function() {
          const messageId = self.getMessageId(this);
          const isRemote = this.closest?.('.mes[data-remote="true"]') !== null;
          const isMesText = this.classList?.contains('mes_text');
          
          if (isRemote && isMesText && self.enabled) {
            const before = this.textContent;
            self.originals.jQueryText.call($(this), value);
            const after = this.textContent;
            
            self.log({
              method: 'jQuery.text()',
              messageId: messageId,
              isRemote: true,
              element: '.mes_text',
              contentBefore: before,
              contentAfter: after,
              stack: new Error().stack
            });
          } else {
            self.originals.jQueryText.call($(this), value);
          }
        });
        
        return this;
      };
      
      // $.fn.append
      this.originals.jQueryAppend = $.fn.append;
      $.fn.append = function(...args) {
        this.each(function() {
          const messageId = self.getMessageId(this);
          const isRemote = this.closest?.('.mes[data-remote="true"]') !== null;
          const isMesText = this.classList?.contains('mes_text');
          
          if (isRemote && isMesText && self.enabled) {
            const before = this.innerHTML;
            self.originals.jQueryAppend.apply($(this), args);
            const after = this.innerHTML;
            
            self.log({
              method: 'jQuery.append()',
              messageId: messageId,
              isRemote: true,
              element: '.mes_text',
              contentBefore: before,
              contentAfter: after,
              stack: new Error().stack
            });
          } else {
            self.originals.jQueryAppend.apply($(this), args);
          }
        });
        
        return this;
      };
      
      // $.fn.prepend
      this.originals.jQueryPrepend = $.fn.prepend;
      $.fn.prepend = function(...args) {
        this.each(function() {
          const messageId = self.getMessageId(this);
          const isRemote = this.closest?.('.mes[data-remote="true"]') !== null;
          const isMesText = this.classList?.contains('mes_text');
          
          if (isRemote && isMesText && self.enabled) {
            const before = this.innerHTML;
            self.originals.jQueryPrepend.apply($(this), args);
            const after = this.innerHTML;
            
            self.log({
              method: 'jQuery.prepend()',
              messageId: messageId,
              isRemote: true,
              element: '.mes_text',
              contentBefore: before,
              contentAfter: after,
              stack: new Error().stack
            });
          } else {
            self.originals.jQueryPrepend.apply($(this), args);
          }
        });
        return this;
      };
      
      // $.fn.empty
      this.originals.jQueryEmpty = $.fn.empty;
      $.fn.empty = function() {
        this.each(function() {
          const messageId = self.getMessageId(this);
          const isRemote = this.closest?.('.mes[data-remote="true"]') !== null;
          const isMesText = this.classList?.contains('mes_text');
          
          if (isRemote && isMesText && self.enabled) {
            const before = this.innerHTML;
            self.originals.jQueryEmpty.call($(this));
            
            self.log({
              method: 'jQuery.empty()',
              messageId: messageId,
              isRemote: true,
              element: '.mes_text',
              contentBefore: before,
              contentAfter: '',
              stack: new Error().stack
            });
          } else {
            self.originals.jQueryEmpty.call($(this));
          }
        });
        
        return this;
      };
      
      // $.fn.replaceWith
      this.originals.jQueryReplaceWith = $.fn.replaceWith;
      $.fn.replaceWith = function(newContent) {
        this.each(function() {
          const messageId = self.getMessageId(this);
          const isRemote = this.closest?.('.mes[data-remote="true"]') !== null;
          const isMesText = this.classList?.contains('mes_text');
          
          if (isRemote && isMesText && self.enabled) {
            const before = this.outerHTML;
            
            self.log({
              method: 'jQuery.replaceWith()',
              messageId: messageId,
              isRemote: true,
              element: '.mes_text',
              contentBefore: before,
              contentAfter: typeof newContent === 'string' ? newContent : '[DOM Node]',
              stack: new Error().stack
            });
          }
        });
        
        return self.originals.jQueryReplaceWith.call(this, newContent);
      };
      
      console.log('[追踪系统] jQuery 方法劫持完成');
    }
    
    // ========== 劫持事件系统 ==========
    
    const ctx = getContext();
    if (ctx && ctx.eventSource && ctx.eventSource.emit) {
      this.originals.eventSourceEmit = ctx.eventSource.emit.bind(ctx.eventSource);
      
      ctx.eventSource.emit = async function(eventType, ...args) {
        const criticalEvents = [
          'MESSAGE_RECEIVED',
          'MESSAGE_UPDATED',
          'MESSAGE_EDITED',
          'MESSAGE_SWIPED',
          'CHARACTER_MESSAGE_RENDERED',
          'USER_MESSAGE_RENDERED',
        ];
        
        const eventName = typeof eventType === 'string' ? eventType : eventType?.toString();
        
        if (self.enabled && criticalEvents.some(e => eventName?.includes(e))) {
          const messageId = args[0];
          let snapshotBefore = null;
          
          // 如果是远程消息，记录事件前的快照
          if (typeof messageId === 'number') {
            const mesText = document.querySelector(`.mes[mesid="${messageId}"][data-remote="true"] .mes_text`);
            if (mesText) {
              snapshotBefore = self.createSnapshot(mesText);
            }
          }
          
          // 调用原事件
          const result = await self.originals.eventSourceEmit(eventType, ...args);
          
          // 比较变化
          if (snapshotBefore && typeof messageId === 'number') {
            const mesText = document.querySelector(`.mes[mesid="${messageId}"][data-remote="true"] .mes_text`);
            if (mesText) {
              const snapshotAfter = self.createSnapshot(mesText);
              
              if (snapshotBefore.innerHTML !== snapshotAfter.innerHTML) {
                self.log({
                  method: 'Event: ' + eventName,
                  messageId: messageId,
                  isRemote: true,
                  element: '.mes_text',
                  eventType: eventName,
                  eventArgs: args,
                  contentBefore: snapshotBefore.innerHTML,
                  contentAfter: snapshotAfter.innerHTML,
                  stack: new Error().stack,
                  note: '事件处理期间内容发生变化'
                });
              }
            }
          }
          
          return result;
        }
        
        return self.originals.eventSourceEmit(eventType, ...args);
      };
      
      console.log('[追踪系统] 事件系统劫持完成');
    }
    
    // ========== 劫持酒馆核心函数 ==========
    
    // 劫持 messageFormatting
    if (typeof window.messageFormatting === 'function') {
      this.originals.messageFormatting = window.messageFormatting;
      window.messageFormatting = function(...args) {
        const messageId = args[4]; // 第5个参数是 messageId
        
        if (self.enabled && typeof messageId === 'number') {
          const chat = getChat();
          const msg = chat[messageId];
          
          if (msg?.extra?.isRemote) {
            self.log({
              method: 'messageFormatting()',
              messageId: messageId,
              isRemote: true,
              inputText: args[0]?.substring?.(0, 100),
              charName: args[1],
              isSystem: args[2],
              isUser: args[3],
              stack: new Error().stack,
              note: '远程消息正在被 messageFormatting 处理！'
            });
          }
        }
        
        return self.originals.messageFormatting.apply(this, args);
      };
      console.log('[追踪系统] messageFormatting 劫持完成');
    }
    
    // 劫持 updateMessageBlock (通过 context)
    if (ctx && typeof ctx.updateMessageBlock === 'function') {
      this.originals.updateMessageBlock = ctx.updateMessageBlock;
      ctx.updateMessageBlock = function(messageId, message, options = {}) {
        if (self.enabled) {
          const chat = getChat();
          const msg = chat[messageId];
          
          if (msg?.extra?.isRemote) {
            const mesText = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
            const before = mesText?.innerHTML;
            
            self.log({
              method: 'updateMessageBlock()',
              messageId: messageId,
              isRemote: true,
              messageData: {
                mes: message?.mes?.substring?.(0, 100),
                displayText: message?.extra?.display_text?.substring?.(0, 100),
              },
              options: options,
              contentBefore: before,
              stack: new Error().stack,
              note: '⚠️ 远程消息正在被 updateMessageBlock 重新渲染！'
            });
          }
        }
        
        return self.originals.updateMessageBlock.call(this, messageId, message, options);
      };
      console.log('[追踪系统] updateMessageBlock 劫持完成');
    }
    
    this.installed = true;
    this.enabled = true;
    
    console.log('%c[追踪系统] ✅ 安装完成！所有陷阱已就位', 'color: #4ade80; font-weight: bold; font-size: 14px;');
    console.log('%c[追踪系统] 使用 mpDebug.trace.show() 查看追踪日志', 'color: #4ade80;');
  },
  
  // 卸载追踪系统
  uninstall: function() {
    if (!this.installed) {
      console.log('[追踪系统] 未安装，无需卸载');
      return;
    }
    
    console.log('[追踪系统] 开始卸载...');
    
    // 恢复原生 DOM API
    if (this.originals.innerHTMLSetter) {
      Object.defineProperty(Element.prototype, 'innerHTML', {
        set: this.originals.innerHTMLSetter,
        get: Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML').get,
        configurable: true
      });
    }
    
    if (this.originals.outerHTMLSetter) {
      Object.defineProperty(Element.prototype, 'outerHTML', {
        set: this.originals.outerHTMLSetter,
        get: Object.getOwnPropertyDescriptor(Element.prototype, 'outerHTML').get,
        configurable: true
      });
    }
    
    if (this.originals.textContentSetter) {
      Object.defineProperty(Node.prototype, 'textContent', {
        set: this.originals.textContentSetter,
        get: Object.getOwnPropertyDescriptor(Node.prototype, 'textContent').get,
        configurable: true
      });
    }
    
    if (this.originals.appendChild) {
      Node.prototype.appendChild = this.originals.appendChild;
    }
    if (this.originals.insertBefore) {
      Node.prototype.insertBefore = this.originals.insertBefore;
    }
    if (this.originals.replaceChild) {
      Node.prototype.replaceChild = this.originals.replaceChild;
    }
    if (this.originals.insertAdjacentHTML) {
      Element.prototype.insertAdjacentHTML = this.originals.insertAdjacentHTML;
    }
    if (this.originals.append) {
      Element.prototype.append = this.originals.append;
    }
    if (this.originals.prepend) {
      Element.prototype.prepend = this.originals.prepend;
    }
    if (this.originals.replaceChildren) {
      Element.prototype.replaceChildren = this.originals.replaceChildren;
    }
    
    // 恢复 jQuery
    if (this.originals.jQueryHtml) {
      $.fn.html = this.originals.jQueryHtml;
    }
    if (this.originals.jQueryText) {
      $.fn.text = this.originals.jQueryText;
    }
    if (this.originals.jQueryAppend) {
      $.fn.append = this.originals.jQueryAppend;
    }
    if (this.originals.jQueryPrepend) {
      $.fn.prepend = this.originals.jQueryPrepend;
    }
    if (this.originals.jQueryEmpty) {
      $.fn.empty = this.originals.jQueryEmpty;
    }
    if (this.originals.jQueryReplaceWith) {
      $.fn.replaceWith = this.originals.jQueryReplaceWith;
    }
    
    // 恢复事件系统
    const ctx = getContext();
    if (this.originals.eventSourceEmit && ctx?.eventSource) {
      ctx.eventSource.emit = this.originals.eventSourceEmit;
    }
    
    // 恢复酒馆函数
    if (this.originals.messageFormatting) {
      window.messageFormatting = this.originals.messageFormatting;
    }
    if (this.originals.updateMessageBlock && ctx) {
      ctx.updateMessageBlock = this.originals.updateMessageBlock;
    }
    
    this.installed = false;
    this.enabled = false;
    
    console.log('%c[追踪系统] ✅ 卸载完成', 'color: #4ade80; font-weight: bold;');
  },
  
  // 启用/禁用追踪
  enable: function() {
    this.enabled = true;
    console.log('[追踪系统] 已启用');
  },
  
  disable: function() {
    this.enabled = false;
    console.log('[追踪系统] 已禁用（陷阱仍在，但不记录）');
  },
  
  // ========== 查看日志 ==========
  
  // 显示所有日志
  show: function(count = 50) {
    console.log('%c═══════════════════════════════════════════════════════════════', 'color: #4ade80;');
    console.log('%c                    📋 追踪日志 (最近 ' + count + ' 条)                    ', 'color: #4ade80; font-weight: bold; font-size: 14px;');
    console.log('%c═══════════════════════════════════════════════════════════════', 'color: #4ade80;');
    
    const recentLogs = this.logs.slice(-count);
    
    if (recentLogs.length === 0) {
      console.log('暂无追踪记录');
      return;
    }
    
    recentLogs.forEach(entry => this.printEntry(entry));
    
    console.log('%c═══════════════════════════════════════════════════════════════', 'color: #4ade80;');
    console.log('总记录数:', this.logs.length);
    console.log('污染事件:', this.stats.corruptions);
  },
  
  // 显示特定消息的日志
  showMessage: function(messageId) {
    const messageLogs = this.logs.filter(e => e.messageId === messageId);
    
    console.log('%c═══════════════════════════════════════════════════════════════', 'color: #4ade80;');
    console.log('%c               📋 消息 #' + messageId + ' 的追踪日志                ', 'color: #4ade80; font-weight: bold; font-size: 14px;');
    console.log('%c═══════════════════════════════════════════════════════════════', 'color: #4ade80;');
    
    if (messageLogs.length === 0) {
      console.log('该消息无追踪记录');
      return;
    }
    
    messageLogs.forEach(entry => this.printEntry(entry));
    
    console.log('共', messageLogs.length, '条记录');
  },
  
  // 显示所有污染事件
  showCorruptions: function() {
    const corruptions = this.logs.filter(e => e.isCorruption);
    
    console.log('%c═══════════════════════════════════════════════════════════════', 'color: #ff4444;');
    console.log('%c                    🔴 污染事件列表                              ', 'color: #ff4444; font-weight: bold; font-size: 14px;');
    console.log('%c═══════════════════════════════════════════════════════════════', 'color: #ff4444;');
    
    if (corruptions.length === 0) {
      console.log('%c✅ 太好了！没有检测到污染事件', 'color: #4ade80; font-weight: bold;');
      return;
    }
    
    corruptions.forEach(entry => {
      console.log('%c────────────────────────────────────────', 'color: #ff4444;');
      this.printEntry(entry);
    });
    
    console.log('%c═══════════════════════════════════════════════════════════════', 'color: #ff4444;');
    console.log('%c共发现 ' + corruptions.length + ' 个污染事件', 'color: #ff4444; font-weight: bold;');
    
    // 分析污染来源
    const sources = {};
    corruptions.forEach(e => {
      const key = e.triggerFile + ':' + e.triggerFunction;
      sources[key] = (sources[key] || 0) + 1;
    });
    
    console.log('\n%c污染来源统计:', 'color: #f59e0b; font-weight: bold;');
    Object.entries(sources)
      .sort((a, b) => b[1] - a[1])
      .forEach(([source, count]) => {
        console.log('  ' + source + ': ' + count + ' 次');
      });
  },
  
  // 显示统计信息
  showStats: function() {
    console.log('%c═══════════════════════════════════════════════════════════════', 'color: #4ade80;');
    console.log('%c                       📊 追踪统计                              ', 'color: #4ade80; font-weight: bold; font-size: 14px;');
    console.log('%c═══════════════════════════════════════════════════════════════', 'color: #4ade80;');
    
    console.log('\n总修改次数:', this.stats.totalModifications);
    console.log('污染事件数:', this.stats.corruptions);
    
    console.log('\n%c按方法统计:', 'color: #f59e0b; font-weight: bold;');
    Object.entries(this.stats.byMethod)
      .sort((a, b) => b[1] - a[1])
      .forEach(([method, count]) => {
        console.log('  ' + method + ': ' + count + ' 次');
      });
    
    console.log('\n%c按文件统计:', 'color: #f59e0b; font-weight: bold;');
    Object.entries(this.stats.byFile)
      .sort((a, b) => b[1] - a[1])
      .forEach(([file, count]) => {
        console.log('  ' + file + ': ' + count + ' 次');
      });
  },
  
  // 导出日志
  export: function() {
    const data = {
      exportTime: new Date().toISOString(),
      stats: this.stats,
      logs: this.logs
    };
    
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'trace-log-' + Date.now() + '.json';
    a.click();
    URL.revokeObjectURL(url);
    
    console.log('[追踪系统] 日志已导出');
  },
  
  // 清除日志
  clear: function() {
    this.logs = [];
    this.stats = {
      totalModifications: 0,
      byMethod: {},
      byFile: {},
      corruptions: 0,
    };
    console.log('[追踪系统] 日志已清除');
  },
  
  // 生成污染报告
  generateReport: function() {
    const corruptions = this.logs.filter(e => e.isCorruption);
    
    if (corruptions.length === 0) {
      console.log('%c✅ 没有发现污染，无需生成报告', 'color: #4ade80; font-weight: bold;');
      return null;
    }
    
    // 分析污染模式
    const patterns = {};
    corruptions.forEach(e => {
      const pattern = {
        triggerFile: e.triggerFile,
        triggerFunction: e.triggerFunction,
        method: e.method,
      };
      const key = JSON.stringify(pattern);
      if (!patterns[key]) {
        patterns[key] = {
          ...pattern,
          count: 0,
          examples: []
        };
      }
      patterns[key].count++;
      if (patterns[key].examples.length < 3) {
        patterns[key].examples.push({
          messageId: e.messageId,
          time: e.timeReadable,
          callChain: e.callChain?.slice(0, 5)
        });
      }
    });
    
    const report = {
      summary: {
        totalCorruptions: corruptions.length,
        uniquePatterns: Object.keys(patterns).length,
        affectedMessages: [...new Set(corruptions.map(e => e.messageId))].length,
      },
      patterns: Object.values(patterns).sort((a, b) => b.count - a.count),
      recommendation: []
    };
    
    // 生成建议
    report.patterns.forEach(p => {
      if (p.triggerFile === 'reasoning.js') {
        report.recommendation.push({
          issue: 'reasoning.js 的 auto_parse 功能触发了 updateMessageBlock',
          solution: '在远程消息上禁用 auto_parse，或者在 updateMessageBlock 劫持中拦截远程消息'
        });
      }
      if (p.method === 'jQuery.html()' || p.method === 'innerHTML') {
        report.recommendation.push({
          issue: p.triggerFunction + ' 直接修改了远程消息的 HTML',
          solution: '在 ' + p.triggerFile + ' 中检查是否是远程消息，如果是则跳过处理'
        });
      }
    });
    
    console.log('%c═══════════════════════════════════════════════════════════════', 'color: #ff4444;');
    console.log('%c                    📋 污染分析报告                              ', 'color: #ff4444; font-weight: bold; font-size: 16px;');
    console.log('%c═══════════════════════════════════════════════════════════════', 'color: #ff4444;');
    
    console.log('\n%c📊 概要:', 'font-weight: bold; font-size: 14px;');
    console.log('  总污染事件:', report.summary.totalCorruptions);
    console.log('  独立模式数:', report.summary.uniquePatterns);
    console.log('  受影响消息:', report.summary.affectedMessages);
    
    console.log('\n%c🔍 污染模式:', 'font-weight: bold; font-size: 14px;');
    report.patterns.forEach((p, i) => {
      console.log('\n  模式 #' + (i + 1) + ' (' + p.count + ' 次):');
      console.log('    触发文件:', p.triggerFile);
      console.log('    触发函数:', p.triggerFunction);
      console.log('    修改方法:', p.method);
      console.log('    示例调用栈:');
      if (p.examples[0]?.callChain) {
        p.examples[0].callChain.forEach((c, j) => {
          console.log('      ' + (j + 1) + '. ' + c.function + ' @ ' + c.file + ':' + c.line);
        });
      }
    });
    
    if (report.recommendation.length > 0) {
      console.log('\n%c💡 修复建议:', 'font-weight: bold; font-size: 14px; color: #4ade80;');
      report.recommendation.forEach((r, i) => {
        console.log('\n  建议 #' + (i + 1) + ':');
        console.log('    问题:', r.issue);
        console.log('    解决:', r.solution);
      });
    }
    
    console.log('%c═══════════════════════════════════════════════════════════════', 'color: #ff4444;');
    
    return report;
  }
};

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
  
  if (DEBUG_POPUP) {
    let msg = title + '\n';
    if (typeof data === 'object') {
      for (const [key, value] of Object.entries(data)) {
        msg += key + ': ' + value + '\n';
      }
    } else {
      msg += String(data);
    }
    showDebugToast(msg);
  }
}

function showDebugToast(msg) {
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
  remoteContextCache.clear();
  isGenerating = false;
  pendingCapture = { enabled: false, messageId: null, captured: false, html: null };
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
// 劫持 prepareOpenAIMessages（核心）
// ========================================

function setupPrepareMessagesHijack() {
  if (window._prepareOpenAIMessagesHijacked) {
    log('prepareOpenAIMessages 已劫持，跳过');
    return;
  }
  
  const originalPrepare = window.prepareOpenAIMessages;
  
  if (!originalPrepare) {
    log('⚠️ 无法获取 prepareOpenAIMessages，将使用事件方式');
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

// ========================================
// 收集并发送同步数据
// ========================================

function collectAndSendSyncData(params) {
  const chat = getChat();
  
  const localChatHistory = chat
    .filter(msg => !msg.extra?.isRemote && !msg.is_system)
    .map(msg => ({
      role: msg.is_user ? 'user' : 'assistant',
      content: msg.mes,
      name: msg.name,
    }));
  
  const syncData = {
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
  };
  
  logSync('收集同步数据', {
    '世界书Before长度': syncData.worldInfo.before.length,
    '世界书After长度': syncData.worldInfo.after.length,
    '角色描述长度': syncData.character.description.length,
    '本地聊天条数': localChatHistory.length,
  });
  
  sendWS({
    type: 'syncContext',
    worldInfo: syncData.worldInfo,
    character: syncData.character,
    chatHistory: syncData.chatHistory,
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
  
  log('已发送同步数据');
}

// ========================================
// 注入远程上下文
// ========================================

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
    log('已注入远程世界书，长度: ' + remoteWorldInfo.length);
  }
  
  if (remoteCharacter) {
    params.scenario = (params.scenario || '') + 
      '\n\n【其他玩家的角色信息】' + remoteCharacter;
    log('已注入远程角色卡，长度: ' + remoteCharacter.length);
  }
  
  if (remoteChatHistory.length > 0) {
    params.messages.push(...remoteChatHistory);
    log('已注入远程聊天历史，条数: ' + remoteChatHistory.length);
  }
}

// ========================================
// 处理远程同步上下文
// ========================================

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
// 劫持 updateMessageBlock（发送捕获 + 接收保护）
// ========================================

function hijackUpdateMessageBlock() {
  const ctx = getContext();
  const original = ctx.updateMessageBlock;
  
  if (!original) {
    log('警告：找不到 updateMessageBlock');
    return;
  }
  
  if (ctx._updateMessageBlockHijacked) {
    log('updateMessageBlock 已劫持，跳过');
    return;
  }
  
  ctx.updateMessageBlock = function(messageId, message, options = {}) {
    const chat = getChat();
    const msg = chat[messageId];
    
    // ========== 接收方保护逻辑（在调用原函数之前拦截）==========
    if (msg?.extra?.isRemote && msg?.extra?.remoteFormattedHtml) {
      log('🛡️ 拦截 updateMessageBlock 对远程消息 #' + messageId + ' 的调用');
      
      // 不调用原函数，直接恢复我们的HTML
      setTimeout(() => {
        const element = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
        if (element) {
          // 临时禁用追踪，避免记录我们自己的恢复操作
          const wasEnabled = TraceSystem.enabled;
          TraceSystem.enabled = false;
          element.innerHTML = msg.extra.remoteFormattedHtml;
          TraceSystem.enabled = wasEnabled;
          log('🛡️ 已恢复远程消息 #' + messageId);
        }
      }, 10);
      
      return; // 不调用原函数
    }
    
    const result = original.call(this, messageId, message, options);
    
    // ========== 发送方捕获逻辑 ==========
    if (pendingCapture.enabled && 
        pendingCapture.messageId === messageId && 
        !pendingCapture.captured &&
        msg && !msg.is_user && !msg.extra?.isRemote) {
      
      setTimeout(() => {
        if (pendingCapture.captured) return;
        
        const element = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
        if (element) {
          const html = element.innerHTML;
          
          if (html && html.length > 50 && !html.includes('<p>…</p>')) {
            pendingCapture.captured = true;
            pendingCapture.html = html;
            
            logDebug('📸 updateMessageBlock后捕获', {
              '消息ID': messageId,
              'HTML长度': html.length,
              '前100字符': html.substring(0, 100)
            });
          }
        }
      }, 0);
    }
    
    return result;
  };
  
  ctx._updateMessageBlockHijacked = true;
  log('✅ 已劫持 updateMessageBlock（含远程消息保护）');
}

// ========================================
// 事件拦截器（备用捕获点）
// ========================================

function setupEventInterceptor() {
  const ctx = getContext();
  
  if (ctx.eventSource._mpIntercepted) {
    log('事件拦截器已存在，跳过');
    return;
  }
  
  const originalEmit = ctx.eventSource.emit.bind(ctx.eventSource);
  
  ctx.eventSource.emit = async function(eventType, ...args) {
    
    if (eventType === ctx.eventTypes.CHARACTER_MESSAGE_RENDERED) {
      const messageId = args[0];
      
      // 发送方备用捕获
      if (pendingCapture.enabled && 
          pendingCapture.messageId === messageId && 
          !pendingCapture.captured) {
        
        const chat = getChat();
        const msg = chat[messageId];
        
        if (msg && !msg.is_user && !msg.extra?.isRemote) {
          const mesText = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
          
          if (mesText) {
            const html = mesText.innerHTML;
            
            if (html && html.length > 50 && !html.includes('<p>…</p>')) {
              pendingCapture.captured = true;
              pendingCapture.html = html;
              
              logDebug('📸 事件拦截备用捕获', {
                '消息ID': messageId,
                'HTML长度': html.length
              });
            }
          }
        }
      }
    }
    
    return originalEmit(eventType, ...args);
  };
  
  ctx.eventSource._mpIntercepted = true;
  log('✅ 事件拦截器已设置');
}

// ========================================
// DOM 观察器（备用方案）
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
    if (!currentRoom || !turnState.isMyTurn || !isGenerating) return;
    if (pendingCapture.captured) return;
    
    for (const mutation of mutations) {
      if (mutation.target && mutation.target.classList && 
          mutation.target.classList.contains('mes_text')) {
        
        const mesElement = mutation.target.closest('.mes');
        if (!mesElement) continue;
        
        // 跳过远程消息
        if (mesElement.getAttribute('data-remote') === 'true') continue;
        
        const messageId = parseInt(mesElement.getAttribute('mesid'));
        if (isNaN(messageId)) continue;
        
        if (pendingCapture.enabled && pendingCapture.messageId === messageId && !pendingCapture.captured) {
          const html = mutation.target.innerHTML;
          if (html && html.length > 50 && !html.includes('<p>…</p>')) {
            pendingCapture.captured = true;
            pendingCapture.html = html;
            logDebug('📸 DOM观察器捕获', { '消息ID': messageId, 'HTML长度': html.length });
          }
        }
      }
    }
  });
  
  chatObserver.observe(chatElement, { 
    childList: true, 
    subtree: true,
    characterData: true
  });
  
  log('DOM 观察器已设置');
}

// ========================================
// 远程消息保护器
// ========================================

function protectRemoteMessage(messageId) {
  if (remoteMessageObservers.has(messageId)) {
    remoteMessageObservers.get(messageId).disconnect();
    remoteMessageObservers.delete(messageId);
  }
  
  const chat = getChat();
  const remoteHtml = chat[messageId]?.extra?.remoteFormattedHtml;
  
  if (!remoteHtml) {
    log('保护器：没有存储的远程HTML，跳过 #' + messageId);
    return;
  }
  
  setTimeout(function() {
    const element = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
    if (!element) return;
    
    let isRestoring = false;
    let restoreCount = 0;
    
    const observer = new MutationObserver(function(mutations) {
      if (isRestoring) return;
      
      // 检查是否真的发生了内容变化
      const currentHtml = element.innerHTML;
      if (currentHtml === remoteHtml) return;
      
      restoreCount++;
      log('🛡️ 检测到远程消息 #' + messageId + ' 被修改（第' + restoreCount + '次），正在恢复...');
      
      // 记录到追踪系统
      if (TraceSystem.enabled) {
        TraceSystem.log({
          method: '保护器检测到修改',
          messageId: messageId,
          isRemote: true,
          element: '.mes_text',
          contentBefore: remoteHtml.substring(0, 100),
          contentAfter: currentHtml.substring(0, 100),
          stack: new Error().stack,
          note: '保护器即将恢复内容'
        });
      }
      
      isRestoring = true;
      
      // 临时禁用追踪
      const wasEnabled = TraceSystem.enabled;
      TraceSystem.enabled = false;
      element.innerHTML = remoteHtml;
      TraceSystem.enabled = wasEnabled;
      
      setTimeout(function() {
        isRestoring = false;
      }, 100);
    });
    
    observer.observe(element, { 
      childList: true, 
      subtree: true, 
      characterData: true 
    });
    
    remoteMessageObservers.set(messageId, observer);
    log('✅ 已设置远程消息保护: #' + messageId);
    
    // 立即检查当前内容是否已被破坏
    const currentHtml = element.innerHTML;
    if (currentHtml !== remoteHtml && (currentHtml.includes('[远程消息]') || currentHtml.length < 100)) {
      log('🛡️ 保护器：DOM已被破坏，立即恢复 #' + messageId);
      
      const wasEnabled = TraceSystem.enabled;
      TraceSystem.enabled = false;
      element.innerHTML = remoteHtml;
      TraceSystem.enabled = wasEnabled;
    }
  }, 200);
}

function clearRemoteMessageProtection(messageId) {
  if (remoteMessageObservers.has(messageId)) {
    remoteMessageObservers.get(messageId).disconnect();
    remoteMessageObservers.delete(messageId);
  }
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
// 清理 HTML 用于远程同步
// ========================================

function cleanHtmlForSync(html) {
  const temp = document.createElement('div');
  temp.innerHTML = html;
  
  // 1. 处理 TH-render 包装器，还原原始 <pre>
  const renders = temp.querySelectorAll('.TH-render');
  renders.forEach(function(render) {
    const pre = render.querySelector('pre');
    if (pre) {
      pre.classList.remove('hidden!');
      render.replaceWith(pre);
    } else {
      render.remove();
    }
  });
  
  // 2. 移除所有 iframe
  const iframes = temp.querySelectorAll('iframe');
  iframes.forEach(function(iframe) {
    iframe.remove();
  });
  
  // 3. 移除折叠按钮
  const buttons = temp.querySelectorAll('.TH-collapse-code-block-button');
  buttons.forEach(function(btn) {
    btn.remove();
  });
  
  // 4. 移除所有酒馆助手相关的元素
  const thElements = temp.querySelectorAll('[class*="TH-"], [class*="th-"]');
  thElements.forEach(function(el) {
    el.remove();
  });
  
  // 5. 清理所有元素的 hidden! class
  const hiddenElements = temp.querySelectorAll('.hidden\\!');
  hiddenElements.forEach(function(el) {
    el.classList.remove('hidden!');
  });
  
  // 6. 移除所有 blob URL
  const allElements = temp.querySelectorAll('*');
  allElements.forEach(function(el) {
    if (el.hasAttribute('src')) {
      const src = el.getAttribute('src');
      if (src && (src.startsWith('blob:') || src.includes('://localhost') || src.includes('://127.0.0.1') || src.includes('://192.168.'))) {
        el.removeAttribute('src');
      }
    }
    
    if (el.hasAttribute('href')) {
      const href = el.getAttribute('href');
      if (href && (href.startsWith('blob:') || href.includes('://localhost') || href.includes('://127.0.0.1') || href.includes('://192.168.'))) {
        el.removeAttribute('href');
      }
    }
    
    if (el.hasAttribute('data')) {
      const data = el.getAttribute('data');
      if (data && (data.startsWith('blob:') || data.includes('://localhost') || data.includes('://127.0.0.1') || data.includes('://192.168.'))) {
        el.removeAttribute('data');
      }
    }
    
    const attrs = Array.from(el.attributes);
    attrs.forEach(function(attr) {
      if (attr.name.startsWith('data-')) {
        el.removeAttribute(attr.name);
      }
    });
  });
  
  // 7. 移除 <base> 标签
  const baseTags = temp.querySelectorAll('base');
  baseTags.forEach(function(base) {
    base.remove();
  });
  
  // 8. 移除 <object> 和 <embed> 标签
  const objectTags = temp.querySelectorAll('object, embed');
  objectTags.forEach(function(obj) {
    obj.remove();
  });
  
  // 9. 清理 style 属性中可能包含的 URL
allElements.forEach(function(el) {
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
  
  return temp.innerHTML;
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
    
    // 标记为远程消息
    $(`.mes[mesid="${messageId}"]`).attr('data-remote', 'true');
    
    remoteStreamMap.set(msg.senderId, {
      messageId: messageId,
      charName: msg.charName
    });
    
    log('创建远程AI占位消息: #' + messageId);
    
    setTimeout(() => {
      const mesText = $(`.mes[mesid="${messageId}"] .mes_text`);
      if (mesText.length) {
        // 临时禁用追踪
        const wasEnabled = TraceSystem.enabled;
        TraceSystem.enabled = false;
        mesText.html(simpleRender(msg.content));
        TraceSystem.enabled = wasEnabled;
      }
    }, 50);
    
  } else {
    const messageId = streamInfo.messageId;
    
    if (chat[messageId]) {
      chat[messageId].mes = msg.content;
    }
    
    const mesText = $(`.mes[mesid="${messageId}"] .mes_text`);
    if (mesText.length) {
      // 临时禁用追踪
      const wasEnabled = TraceSystem.enabled;
      TraceSystem.enabled = false;
      mesText.html(simpleRender(msg.content));
      TraceSystem.enabled = wasEnabled;
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

  logDebug('接收端收到AI消息', {
    'HTML长度': msg.formattedHtml?.length || 0,
    '前100字符': msg.formattedHtml?.substring(0, 100) || '空',
    '包含pre': msg.formattedHtml?.includes('<pre') ? '是' : '否',
    '流式模式': streamInfo ? '是' : '否'
  });
  
  log('远程AI完成，HTML长度: ' + (msg.formattedHtml?.length || 0));
  
  if (streamInfo) {
    const messageId = streamInfo.messageId;
    
    // 存储远程美化HTML到 chat 数组
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
    
    // 覆盖 DOM（临时禁用追踪，因为这是我们自己的操作）
    const mesText = $(`.mes[mesid="${messageId}"] .mes_text`);
    if (mesText.length) {
      const wasEnabled = TraceSystem.enabled;
      TraceSystem.enabled = false;
      mesText.html(msg.formattedHtml);
      TraceSystem.enabled = wasEnabled;
      
      logDebug('接收端DOM覆盖完成', {
        '消息ID': messageId,
        'DOM内容前100字': mesText.html().substring(0, 100)
      });
    }
    
    // 确保标记为远程消息
    $(`.mes[mesid="${messageId}"]`).attr('data-remote', 'true');
    
    // 触发事件让酒馆助手处理
    setTimeout(() => {
      try {
        ctx.eventSource.emit(ctx.eventTypes.CHARACTER_MESSAGE_RENDERED, messageId);
        log('已触发 CHARACTER_MESSAGE_RENDERED: #' + messageId);
      } catch(e) {
        log('触发事件失败: ' + e);
      }
    }, 100);
    
    // 设置保护器
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
    
    // 标记为远程消息
    $(`.mes[mesid="${messageId}"]`).attr('data-remote', 'true');
    
    // 覆盖DOM
    setTimeout(() => {
      const mesText = $(`.mes[mesid="${messageId}"] .mes_text`);
      if (mesText.length) {
        const wasEnabled = TraceSystem.enabled;
        TraceSystem.enabled = false;
        mesText.html(msg.formattedHtml);
        TraceSystem.enabled = wasEnabled;
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
      log('发现远程消息 #' + messageId);
      
      const mesText = $(`.mes[mesid="${messageId}"] .mes_text`);
      if (mesText.length) {
        // 临时禁用追踪
        const wasEnabled = TraceSystem.enabled;
        TraceSystem.enabled = false;
        mesText.html(msg.extra.remoteFormattedHtml);
        TraceSystem.enabled = wasEnabled;
        
        // 标记为远程消息
        $(`.mes[mesid="${messageId}"]`).attr('data-remote', 'true');
        
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
  }
}

// ========================================
// 事件监听设置
// ========================================

function setupEventListeners() {
  const ctx = getContext();
  
  hijackUpdateMessageBlock();
  setupEventInterceptor();
  setupDOMObserver();
  setupPrepareMessagesHijack();
  
  // 安装追踪系统
  TraceSystem.install();
  
  // 生成开始
  eventSource.on(event_types.GENERATION_STARTED, function(type, options, dryRun) {
    if (dryRun) return;
    if (!currentRoom) return;
    
    log('事件: 生成开始');
    isGenerating = true;
    
    pendingCapture = {
      enabled: turnState.isMyTurn,
      messageId: null,
      captured: false,
      html: null
    };
  });
  
  // 流式同步
  const throttledStreamSync = throttle(function(text) {
    if (!currentRoom || !turnState.isMyTurn || !isGenerating) return;
    
    const chat = getChat();
    const lastMsg = chat[chat.length - 1];
    if (!lastMsg || lastMsg.is_user) return;
    
    if (pendingCapture.enabled && pendingCapture.messageId === null) {
      pendingCapture.messageId = chat.length - 1;
    }
    
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
  
  // 生成结束：轮询等待捕获
  eventSource.on(event_types.GENERATION_ENDED, function(messageCount) {
    if (!currentRoom) return;
    if (!turnState.isMyTurn || !isGenerating) return;
    
    log('事件: 生成结束');
    
    const chat = getChat();
    const messageId = chat.length - 1;
    const lastMsg = chat[messageId];
    
    if (!lastMsg || lastMsg.is_user || lastMsg.extra?.isRemote) {
      isGenerating = false;
      pendingCapture.enabled = false;
      return;
    }
    
    pendingCapture.messageId = messageId;
    
    let waitCount = 0;
    const maxWait = 20;
    
    const checkAndSend = () => {
      waitCount++;
      
      if (pendingCapture.captured && pendingCapture.html) {
        let html = cleanHtmlForSync(pendingCapture.html);
        
        logDebug('📤 发送HTML', {
          'HTML长度': html.length,
          '前100字符': html.substring(0, 100)
        });
        
        sendWS({
          type: 'syncAiComplete',
          formattedHtml: html,
          charName: lastMsg.name,
          senderName: userName,
          timestamp: Date.now()
        });
        
        sendWS({ type: 'aiGenerationEnded' });
        log('✅ 已发送HTML，长度: ' + html.length);
        
        isGenerating = false;
        pendingCapture = { enabled: false, messageId: null, captured: false, html: null };
        
      } else if (waitCount >= maxWait) {
        log('⚠️ 捕获超时，直接读取DOM');
        
        const mesText = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
        if (mesText) {
          let html = cleanHtmlForSync(mesText.innerHTML);
          
          if (html && html.length > 50) {
            sendWS({
              type: 'syncAiComplete',
              formattedHtml: html,
              charName: lastMsg.name,
              senderName: userName,
              timestamp: Date.now()
            });
            sendWS({ type: 'aiGenerationEnded' });
            log('✅ 超时后发送HTML，长度: ' + html.length);
          }
        }
        
        isGenerating = false;
        pendingCapture = { enabled: false, messageId: null, captured: false, html: null };
        
      } else {
        setTimeout(checkAndSend, 50);
      }
    };
    
    setTimeout(checkAndSend, 50);
  });
  
  eventSource.on(event_types.GENERATION_STOPPED, function() {
    log('事件: 生成停止');
    isGenerating = false;
    pendingCapture = { enabled: false, messageId: null, captured: false, html: null };
  });
  
  eventSource.on(event_types.CHAT_CHANGED, function() {
    log('事件: 聊天切换');
    remoteStreamMap.clear();
    isGenerating = false;
    pendingCapture = { enabled: false, messageId: null, captured: false, html: null };
    
    remoteMessageObservers.forEach(observer => observer.disconnect());
    remoteMessageObservers.clear();
    
    setTimeout(setupDOMObserver, 500);
    setTimeout(restoreRemoteMessages, 800);
  });
  
  log('事件监听已设置');
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
// 活动监听
// ========================================

function setupActivityListener() {
  $(document).on('click', '#send_but, #send_button, .send_button', function() {
    if (isConnected) {
      sendWS({ type: 'mainActivity' });
    }
  });
  log('活动监听已设置');
}

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
  
  html += '<div class="mp-version-footer" style="margin-top:15px;padding-top:15px;border-top:1px solid #333;text-align:center;font-size:12px;">';
  html += '<div style="color:#666;">酒馆联机 v' + CURRENT_VERSION + '</div>';
  html += '<div style="color:#888;font-size:10px;margin-top:4px;">追踪系统: ' + (TraceSystem.enabled ? '✅ 已启用' : '❌ 未启用') + '</div>';
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
    pendingCapture = { enabled: false, messageId: null, captured: false, html: null };
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
  console.log('远程上下文缓存:', remoteContextCache.size);
  console.log('远程消息保护器:', remoteMessageObservers.size);
  console.log('正在生成:', isGenerating);
  console.log('待捕获状态:', pendingCapture);
  console.log('追踪系统:', TraceSystem.enabled ? '已启用' : '未启用');
  console.log('====================');
}

function debugSyncLog() {
  console.log('%c===== 同步日志汇总 =====', 'color: #4ade80; font-weight: bold; font-size: 14px;');
  
  console.log('\n远程上下文缓存:');
  remoteContextCache.forEach((data, odId) => {
    console.log('  来自:', data.userName);
    console.log('  世界书Before长度:', data.worldInfo?.before?.length || 0);
    console.log('  世界书After长度:', data.worldInfo?.after?.length || 0);
    console.log('  角色描述长度:', data.character?.description?.length || 0);
    console.log('  聊天历史条数:', data.chatHistory?.length || 0);
  });
  
  console.log('\n远程消息保护器:');
  console.log('  保护的消息数:', remoteMessageObservers.size);
  
  console.log('\n待捕获状态:');
  console.log('  enabled:', pendingCapture.enabled);
  console.log('  messageId:', pendingCapture.messageId);
  console.log('  captured:', pendingCapture.captured);
  console.log('  html长度:', pendingCapture.html?.length || 0);
  
  console.log('%c========================', 'color: #4ade80; font-weight: bold;');
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
// 导出调试函数
// ========================================

window.mpDebug = {
  state: debugState,
  syncLog: debugSyncLog,
  connect: connectServer,
  disconnect: normalDisconnect,
  openPanel: openPanel,
  restoreRemote: restoreRemoteMessages,
  
  // 追踪系统命令
  trace: {
    install: () => TraceSystem.install(),
    uninstall: () => TraceSystem.uninstall(),
    enable: () => TraceSystem.enable(),
    disable: () => TraceSystem.disable(),
    show: (count) => TraceSystem.show(count),
    showMessage: (id) => TraceSystem.showMessage(id),
    showCorruptions: () => TraceSystem.showCorruptions(),
    showStats: () => TraceSystem.showStats(),
    export: () => TraceSystem.export(),
    clear: () => TraceSystem.clear(),
    report: () => TraceSystem.generateReport(),
    get logs() { return TraceSystem.logs; },
    get stats() { return TraceSystem.stats; },
    get enabled() { return TraceSystem.enabled; },
  },
  
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
      console.log('包含pre:', mesText.innerHTML.includes('<pre'));
    }
  },
  
  testPendingCapture: function() {
    console.log('===== 待捕获状态 =====');
    console.log('enabled:', pendingCapture.enabled);
    console.log('messageId:', pendingCapture.messageId);
    console.log('captured:', pendingCapture.captured);
    console.log('html长度:', pendingCapture.html?.length || 0);
    if (pendingCapture.html) {
      console.log('html前200字符:', pendingCapture.html.substring(0, 200));
    }
    console.log('======================');
  },
  
  testProtector: function(messageId) {
    const chat = getChat();
    const id = messageId !== undefined ? messageId : chat.length - 1;
    
    console.log('测试保护器 #' + id);
    console.log('chat[].extra.remoteFormattedHtml 长度:', chat[id]?.extra?.remoteFormattedHtml?.length || 0);
    console.log('chat[].extra.isRemote:', chat[id]?.extra?.isRemote);
    console.log('保护器是否存在:', remoteMessageObservers.has(id));
    console.log('data-remote属性:', $(`.mes[mesid="${id}"]`).attr('data-remote'));
    
    if (chat[id]?.extra?.remoteFormattedHtml) {
      console.log('远程HTML前200字符:', chat[id].extra.remoteFormattedHtml.substring(0, 200));
    }
  },
  
  showRemoteCache: function() {
    console.log('===== 远程上下文缓存 =====');
    console.log('缓存数量:', remoteContextCache.size);
    remoteContextCache.forEach((data, odId) => {
      console.log('\n玩家ID:', odId);
      console.log('  用户名:', data.userName);
      console.log('  世界书Before:', data.worldInfo?.before?.substring(0, 100) || '空');
      console.log('  世界书After:', data.worldInfo?.after?.substring(0, 100) || '空');
      console.log('  角色描述:', data.character?.description?.substring(0, 100) || '空');
      console.log('  聊天历史条数:', data.chatHistory?.length || 0);
      console.log('  时间戳:', new Date(data.timestamp).toLocaleString());
    });
    console.log('==========================');
  },
  
  clearRemoteCache: function() {
    remoteContextCache.clear();
    console.log('已清除远程上下文缓存');
  },
  
  forceCapture: function() {
    const chat = getChat();
    if (chat.length === 0) {
      console.log('聊天为空');
      return;
    }
    const lastId = chat.length - 1;
    const mesText = document.querySelector(`.mes[mesid="${lastId}"] .mes_text`);
    if (mesText) {
      const html = mesText.innerHTML;
      console.log('强制捕获:');
      console.log('  消息ID:', lastId);
      console.log('  HTML长度:', html.length);
      console.log('  前200字符:', html.substring(0, 200));
      
      const cleanedHtml = cleanHtmlForSync(html);
      console.log('  清理后长度:', cleanedHtml.length);
      console.log('  清理后前200字符:', cleanedHtml.substring(0, 200));
      
      return cleanedHtml;
    }
  },
  
  // 模拟远程消息接收（用于测试）
  simulateRemote: function(html) {
    const chat = getChat();
    const ctx = getContext();
    
    const message = {
      name: '测试AI',
      is_user: false,
      is_system: false,
      send_date: getMessageTimeStamp(),
      mes: '[远程消息]',
      extra: {
        isRemote: true,
        remoteFormattedHtml: html || '<p>这是一条<strong>测试</strong>远程消息</p>',
        remoteSender: '测试用户',
        remoteSenderId: 'test-id',
        remoteCharName: '测试AI'
      }
    };
    
    chat.push(message);
    const messageId = chat.length - 1;
    ctx.addOneMessage(message, { forceId: messageId, scroll: true });
    
    // 标记为远程消息
    $(`.mes[mesid="${messageId}"]`).attr('data-remote', 'true');
    
    // 覆盖DOM
    setTimeout(() => {
      const mesText = $(`.mes[mesid="${messageId}"] .mes_text`);
      if (mesText.length) {
        const wasEnabled = TraceSystem.enabled;
        TraceSystem.enabled = false;
        mesText.html(message.extra.remoteFormattedHtml);
        TraceSystem.enabled = wasEnabled;
      }
      
      // 设置保护器
      protectRemoteMessage(messageId);
      addRemoteTag(messageId, '联机AI', 'ai');
      
      // 触发事件
      ctx.eventSource.emit(ctx.eventTypes.CHARACTER_MESSAGE_RENDERED, messageId);
      
      console.log('已创建测试远程消息 #' + messageId);
    }, 50);
    
    return messageId;
  },
  
  // 手动触发污染（用于测试追踪系统）
  triggerCorruption: function(messageId) {
    const chat = getChat();
    const id = messageId !== undefined ? messageId : chat.length - 1;
    
    const mesText = document.querySelector(`.mes[mesid="${id}"] .mes_text`);
    if (!mesText) {
      console.log('找不到消息 #' + id);
      return;
    }
    
    console.log('手动触发污染测试...');
    mesText.innerHTML = '<p>这是被污染的内容</p>';
    console.log('已触发，检查追踪日志');
  },
  
  get chat() { return getChat(); },
  get contextCache() { return remoteContextCache; },
  get messageObservers() { return remoteMessageObservers; },
  get pending() { return pendingCapture; },
  get traceSystem() { return TraceSystem; }
};

log('调试命令已注册: window.mpDebug');
log('========================================');
log('基础命令:');
log('  mpDebug.state() - 查看联机状态');
log('  mpDebug.syncLog() - 查看同步日志汇总');
log('  mpDebug.testCapture() - 测试最后一条消息的DOM');
log('  mpDebug.testProtector(id) - 测试保护器状态');
log('  mpDebug.restoreRemote() - 手动恢复远程消息');
log('========================================');
log('🕵️ 追踪系统命令:');
log('  mpDebug.trace.show() - 显示追踪日志');
log('  mpDebug.trace.show(100) - 显示最近100条');
log('  mpDebug.trace.showMessage(42) - 显示消息#42的日志');
log('  mpDebug.trace.showCorruptions() - 显示所有污染事件');
log('  mpDebug.trace.showStats() - 显示统计信息');
log('  mpDebug.trace.report() - 生成污染分析报告');
log('  mpDebug.trace.export() - 导出日志为JSON');
log('  mpDebug.trace.clear() - 清除日志');
log('  mpDebug.trace.disable() - 暂停追踪');
log('  mpDebug.trace.enable() - 恢复追踪');
log('  mpDebug.trace.uninstall() - 卸载追踪系统');
log('========================================');
log('测试命令:');
log('  mpDebug.simulateRemote() - 模拟接收远程消息');
log('  mpDebug.simulateRemote("<p>自定义HTML</p>")');
log('  mpDebug.triggerCorruption() - 手动触发污染测试');
log('========================================');
