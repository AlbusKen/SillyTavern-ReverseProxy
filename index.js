// 从酒馆的核心脚本中导入弹窗API
import { callGenericPopup } from '../../../../../scripts/popup.js';

// 等待DOM加载完毕
$(document).ready(function () {
    
    // 将脚本内容直接硬编码为字符串
    const scriptContent = `const Logger = {
  enabled: true,
  
  output(...messages) {
    if (!this.enabled) return;
    
    const timestamp = this._getTimestamp();
    const logElement = document.createElement('div');
    logElement.textContent = \`[\${timestamp}] \${messages.join(' ')}\`;
    document.body.appendChild(logElement);
  },
  
  _getTimestamp() {
    const now = new Date();
    const time = now.toLocaleTimeString('zh-CN', { hour12: false });
    const ms = now.getMilliseconds().toString().padStart(3, '0');
    return \`\${time}.\${ms}\`;
  }
};

class ConnectionManager extends EventTarget {
  constructor(endpoint = 'ws://127.0.0.1:9998') {
    super();
    this.endpoint = endpoint;
    this.socket = null;
    this.isConnected = false;
    this.reconnectDelay = 5000;
    this.maxReconnectAttempts = Infinity;
    this.reconnectAttempts = 0;
  }
  
  async establish() {
    if (this.isConnected) {
      Logger.output('[ConnectionManager] 连接已存在');
      return Promise.resolve();
    }
    
    Logger.output('[ConnectionManager] 建立连接:', this.endpoint);
    
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(this.endpoint);
      
      this.socket.addEventListener('open', () => {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        Logger.output('[ConnectionManager] 连接建立成功');
        this.dispatchEvent(new CustomEvent('connected'));
        resolve();
      });
      
      this.socket.addEventListener('close', () => {
        this.isConnected = false;
        Logger.output('[ConnectionManager] 连接断开，准备重连');
        this.dispatchEvent(new CustomEvent('disconnected'));
        this._scheduleReconnect();
      });
      
      this.socket.addEventListener('error', (error) => {
        Logger.output('[ConnectionManager] 连接错误:', error);
        this.dispatchEvent(new CustomEvent('error', { detail: error }));
        if (!this.isConnected) reject(error);
      });
      
      this.socket.addEventListener('message', (event) => {
        this.dispatchEvent(new CustomEvent('message', { detail: event.data }));
      });
    });
  }
  
  transmit(data) {
    if (!this.isConnected || !this.socket) {
      Logger.output('[ConnectionManager] 无法发送数据：连接未建立');
      return false;
    }
    
    this.socket.send(JSON.stringify(data));
    return true;
  }
  
  _scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      Logger.output('[ConnectionManager] 达到最大重连次数');
      return;
    }
    
    this.reconnectAttempts++;
    setTimeout(() => {
      Logger.output(\`[ConnectionManager] 重连尝试 \${this.reconnectAttempts}\`);
      this.establish().catch(() => {});
    }, this.reconnectDelay);
  }
}

class RequestProcessor {
  constructor() {
    this.activeOperations = new Map();
    this.targetDomain = 'generativelanguage.googleapis.com';
  }
  
  async execute(requestSpec, operationId) {
    Logger.output('[RequestProcessor] 执行请求:', requestSpec.method, requestSpec.path);
    
    try {
      const abortController = new AbortController();
      this.activeOperations.set(operationId, abortController);
      
      const requestUrl = this._constructUrl(requestSpec);
      const requestConfig = this._buildRequestConfig(requestSpec, abortController.signal);
      
      const response = await fetch(requestUrl, requestConfig);
      
      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(\`HTTP \${response.status}: \${response.statusText}. Body: \${errorBody}\`);
      }
      
      return response;
    } catch (error) {
      Logger.output('[RequestProcessor] 请求执行失败:', error.message);
      throw error;
    } finally {
      this.activeOperations.delete(operationId);
    }
  }
  
  cancelOperation(operationId) {
    const controller = this.activeOperations.get(operationId);
    if (controller) {
      controller.abort();
      this.activeOperations.delete(operationId);
      Logger.output('[RequestProcessor] 操作已取消:', operationId);
    }
  }
  
  cancelAllOperations() {
    this.activeOperations.forEach((controller, id) => {
      controller.abort();
      Logger.output('[RequestProcessor] 取消操作:', id);
    });
    this.activeOperations.clear();
  }
  
  _constructUrl(requestSpec) {
    const pathSegment = requestSpec.path.startsWith('/') ? 
      requestSpec.path.substring(1) : requestSpec.path;
    
    const queryParams = new URLSearchParams(requestSpec.query_params);
    const queryString = queryParams.toString();
    
    return \`https://\${this.targetDomain}/\${pathSegment}\${queryString ? '?' + queryString : ''}\`;
  }
  
  _generateRandomString(length) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }
  _buildRequestConfig(requestSpec, signal) {
    const config = {
      method: requestSpec.method,
      headers: this._sanitizeHeaders(requestSpec.headers),
      signal
    };
    
    if (['POST', 'PUT', 'PATCH'].includes(requestSpec.method) && requestSpec.body) {
      try {
        const bodyObj = JSON.parse(requestSpec.body);
        
        if (bodyObj.contents && Array.isArray(bodyObj.contents) && bodyObj.contents.length > 0) {
          const lastContent = bodyObj.contents[bodyObj.contents.length - 1];
          if (lastContent.parts && Array.isArray(lastContent.parts) && lastContent.parts.length > 0) {
            const lastPart = lastContent.parts[lastContent.parts.length - 1];
            if (lastPart.text && typeof lastPart.text === 'string') {
              const decoyString = this._generateRandomString(5);
              lastPart.text += \`\\n\\n[sig:\${decoyString}]\`; 
              Logger.output('[RequestProcessor] 已成功向提示文本末尾添加伪装字符串。');
            }
          }
        }
        
        config.body = JSON.stringify(bodyObj);

      } catch (e) {
        Logger.output('[RequestProcessor] 请求体不是JSON，按原样发送。');
        config.body = requestSpec.body;
      }
    }
    
    return config;
  }
  
  _sanitizeHeaders(headers) {
    const sanitized = { ...headers };
    const forbiddenHeaders = [
      'host', 'connection', 'content-length', 'origin',
      'referer', 'user-agent', 'sec-fetch-mode',
      'sec-fetch-site', 'sec-fetch-dest'
    ];
    
    forbiddenHeaders.forEach(header => delete sanitized[header]);
    return sanitized;
  }
}

class ProxySystem extends EventTarget {
  constructor(websocketEndpoint) {
    super();
    this.connectionManager = new ConnectionManager(websocketEndpoint);
    this.requestProcessor = new RequestProcessor();
    this._setupEventHandlers();
  }
  
  async initialize() {
    Logger.output('[ProxySystem] 系统初始化中...');
    try {
      await this.connectionManager.establish();
      Logger.output('[ProxySystem] 系统初始化完成');
      this.dispatchEvent(new CustomEvent('ready'));
    } catch (error) {
      Logger.output('[ProxySystem] 系统初始化失败:', error.message);
      this.dispatchEvent(new CustomEvent('error', { detail: error }));
      throw error;
    }
  }
  
  _setupEventHandlers() {
    this.connectionManager.addEventListener('message', (event) => {
      this._handleIncomingMessage(event.detail);
    });
    
    this.connectionManager.addEventListener('disconnected', () => {
      this.requestProcessor.cancelAllOperations();
    });
  }
  
  async _handleIncomingMessage(messageData) {
    let requestSpec = {};
    try {
      requestSpec = JSON.parse(messageData);
      Logger.output('[ProxySystem] 收到请求:', requestSpec.method, requestSpec.path);
      Logger.output(\`[ProxySystem] 服务器模式为: \${requestSpec.streaming_mode || 'fake'}\`);
      
      await this._processProxyRequest(requestSpec);
    } catch (error) {
      Logger.output('[ProxySystem] 消息处理错误:', error.message);
      const operationId = requestSpec.request_id;
      this._sendErrorResponse(error, operationId);
    }
  }
  
  async _processProxyRequest(requestSpec) {
    const operationId = requestSpec.request_id;
    const mode = requestSpec.streaming_mode || 'fake';

    try {
      const response = await this.requestProcessor.execute(requestSpec, operationId);
      this._transmitHeaders(response, operationId);

      if (mode === 'real') {
        Logger.output('[ProxySystem] 以真流式模式处理响应...');
        const reader = response.body.getReader();
        const textDecoder = new TextDecoder();
        
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            Logger.output('[ProxySystem] 真流式读取完成。');
            break;
          }
          const textChunk = textDecoder.decode(value, { stream: true });
          this._transmitChunk(textChunk, operationId);
        }

      } else {
        Logger.output('[ProxySystem] 以假流式模式处理响应...');
        const fullBody = await response.text();
        Logger.output('[ProxySystem] 已获取完整响应体，长度:', fullBody.length);
        this._transmitChunk(fullBody, operationId);
      }

      this._transmitStreamEnd(operationId);

    } catch (error) {
      if (error.name === 'AbortError') {
        Logger.output('[ProxySystem] 请求被中止');
      } else {
        this._sendErrorResponse(error, operationId);
      }
    }
  }
  
  _transmitHeaders(response, operationId) {
    const headerMap = {};
    response.headers.forEach((value, key) => {
      headerMap[key] = value;
    });
    
    const headerMessage = {
      request_id: operationId,
      event_type: 'response_headers',
      status: response.status,
      headers: headerMap
    };
    
    this.connectionManager.transmit(headerMessage);
    Logger.output('[ProxySystem] 响应头已传输');
  }

  _transmitChunk(chunk, operationId) {
    if (!chunk) return;
    const chunkMessage = {
      request_id: operationId,
      event_type: 'chunk',
      data: chunk
    };
    this.connectionManager.transmit(chunkMessage);
  }

  _transmitStreamEnd(operationId) {
    const endMessage = {
      request_id: operationId,
      event_type: 'stream_close'
    };
    this.connectionManager.transmit(endMessage);
    Logger.output('[ProxySystem] 流结束信号已传输');
  }
  
  _sendErrorResponse(error, operationId) {
    if (!operationId) {
      Logger.output('[ProxySystem] 无法发送错误响应：缺少操作ID');
      return;
    }
    
    const errorMessage = {
      request_id: operationId,
      event_type: 'error',
      status: 500,
      message: \`代理系统错误: \${error.message || '未知错误'}\`
    };
    
    this.connectionManager.transmit(errorMessage);
    Logger.output('[ProxySystem] 错误响应已发送');
  }
}

async function initializeProxySystem() {
  const proxySystem = new ProxySystem();
  
  try {
    await proxySystem.initialize();
    console.log('浏览器代理系统已成功启动');
  } catch (error) {
    console.error('代理系统启动失败:', error);
  }
}

initializeProxySystem();`;

    // 封装所有操作的函数
    function performActions() {
        // 1. 打开新网页
        window.open('https://aistudio.google.com/app/apps/bundled/blank?showPreview=true&showCode=true', '_blank');

        // 2. 准备一个相对于SillyTavern根目录的、用户易于理解的相对路径
        const folderPath = 'public\\extensions\\third-party\\SillyTavern-ReverseProxy\\fangdai';
        
        // 3. 创建并显示包含完整分步指南的弹窗
        const popupHtml = `
            <div id="final-instructions-popup" style="padding: 20px; text-align: left; max-width: 600px; margin: auto;">
                <h3 style="text-align:center; color: #d9534f;">请按以下两步操作</h3>
                <hr>

                <h4>第一步：启动后台服务</h4>
                <p>请在您的 <strong>SillyTavern 根目录</strong>下，根据以下相对路径找到文件夹，然后在其中双击运行 <strong>打开反代服务.bat</strong> 文件。</p>
                <div style="display:flex; margin-top:10px;">
                    <input id="folder-path-to-copy" type="text" style="width: 80%; font-family: monospace; padding: 5px;" value="${folderPath}" readonly>
                    <div id="copy-path-button" class="menu_button menu_button_primary" style="margin-left:5px;">复制相对路径</div>
                </div>
                
                <hr style="margin-top:25px;">

                <h4>第二步：复制前端脚本</h4>
                <p>请将以下代码完整复制，并粘贴到已打开的Google AI Studio网页的左侧代码框中。</p>
                <textarea id="script-to-copy" style="width: 98%; height: 150px; margin: 10px auto; font-family: monospace; white-space: pre; overflow-wrap: normal; overflow-x: scroll;" readonly>${scriptContent}</textarea>
                <div id="copy-script-button" class="menu_button menu_button_primary" style="display:block; text-align:center; margin:10px auto;">复制脚本</div>
            </div>
        `;
        callGenericPopup(popupHtml, 'html');

        // 绑定复制路径按钮事件
        $('#copy-path-button').on('click', function() {
            const pathInput = $('#folder-path-to-copy');
            pathInput.select();
            document.execCommand('copy');
            $(this).text('已复制!');
            setTimeout(() => $(this).text('复制相对路径'), 2000);
        });

        // 绑定复制脚本按钮事件
        $('#copy-script-button').on('click', function() {
            const textarea = $('#script-to-copy');
            textarea.select();
            document.execCommand('copy');
            $(this).text('已复制!');
            setTimeout(() => $(this).text('复制脚本'), 2000);
        });
    }

    // **【UI注入】**
    const mainButtonHTML = `
        <div id="one-click-proxy-button" class="menu_button" style="background-color: #3498db; color: white; margin-left: 10px; padding: 5px 10px; border-radius: 5px; font-weight: bold; cursor: pointer;">
            一键反代
        </div>
    `;

    const topBar = $('#top-bar');
    if (topBar.length > 0) {
        const mainButton = $(mainButtonHTML);
        mainButton.on('click', performActions);
        topBar.append(mainButton);
    } else {
        console.error("反代插件: 致命错误，无法找到 #top-bar 元素!");
    }
});
