// --- START OF FILE dark-server.js ---

const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const { EventEmitter } = require('events');

class OpenAIAdapter {
    constructor(requestHandler) {
        this.requestHandler = requestHandler;
        this.logger = requestHandler.logger;
    }

    async handleChatCompletion(req, res) {
        this.logger.info('处理 OpenAI Chat Completion 请求');
        const { connectionRegistry } = this.requestHandler;

        if (!connectionRegistry.hasActiveConnections()) {
            return this.requestHandler._sendErrorResponse(res, 503, '没有可用的浏览器连接');
        }

        const requestId = this.requestHandler._generateRequestId();
        const messageQueue = connectionRegistry.createMessageQueue(requestId);

        try {
            const geminiRequest = this._convertOpenAIToGemini(req.body);
            const proxyRequest = this._buildProxyRequest(geminiRequest, requestId, req.headers, req.body.model);

            await this.requestHandler._forwardRequest(proxyRequest);
            await this._streamOpenAIResponse(res, messageQueue, req.body.model);

        } catch (error) {
            this.logger.error(`OpenAI 适配器错误: ${error.message}`);
            if (!res.headersSent) {
                this.requestHandler._handleRequestError(error, res);
            } else {
                res.end();
            }
        } finally {
            connectionRegistry.removeMessageQueue(requestId);
        }
    }

    async _streamOpenAIResponse(res, messageQueue, model) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        const fakeId = `chatcmpl-${this.requestHandler._generateRequestId()}`;
        const created = Math.floor(Date.now() / 1000);

        try {
            const headerMessage = await messageQueue.dequeue(300000);
            if (headerMessage.event_type === 'error') {
                throw new Error(`代理错误: ${headerMessage.message}`);
            }

            const bodyMessage = await messageQueue.dequeue(300000);

            if (bodyMessage.event_type === 'chunk' && bodyMessage.data) {
                const geminiResponse = JSON.parse(bodyMessage.data);
                
                const contentChunk = this._convertGeminiToOpenAIChunk(geminiResponse, fakeId, created, model);
                if (contentChunk.choices[0].delta.content) {
                   res.write(`data: ${JSON.stringify(contentChunk)}\n\n`);
                   // 在控制台实时打印AI回复
                   process.stdout.write(contentChunk.choices[0].delta.content);
                }

                const stopChunk = {
                    id: fakeId,
                    object: "chat.completion.chunk",
                    created: created,
                    model: model,
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
                };
                res.write(`data: ${JSON.stringify(stopChunk)}\n\n`);

            } else {
                this.logger.warn('未收到预期的响应体数据块。');
            }

            await messageQueue.dequeue(300000);
            process.stdout.write('\n');

        } catch (error) {
            this.logger.error(`流式响应转换出错: ${error.message}`);
            const errorChunk = {
                id: fakeId,
                object: "chat.completion.chunk",
                created: created,
                model: model,
                choices: [{ index: 0, delta: { content: `\n\n[ERROR: ${error.message}]` }, finish_reason: 'error' }]
            };
            if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
            }
        } finally {
            if (!res.writableEnded) {
                res.write('data: [DONE]\n\n');
                res.end();
                this.logger.info('OpenAI 响应流已关闭。');
            }
        }
    }

    _convertGeminiToOpenAIChunk(geminiChunk, id, created, model) {
        let text = '';
        if (geminiChunk.candidates && geminiChunk.candidates[0].content && geminiChunk.candidates[0].content.parts) {
            // 将所有 part 的文本内容合并
            text = geminiChunk.candidates[0].content.parts.map(part => part.text).join('');
        }

        return {
            id: id,
            object: "chat.completion.chunk",
            created: created,
            model: model,
            choices: [{
                index: 0,
                delta: { content: text },
                finish_reason: null 
            }]
        };
    }

    _convertOpenAIToGemini(openaiBody) {
        // 1. Process messages to handle complex content (text and file_content)
        const processedMessages = openaiBody.messages.map(msg => {
            let combinedContent = '';
            if (typeof msg.content === 'string') {
                combinedContent = msg.content;
            } else if (Array.isArray(msg.content)) {
                combinedContent = msg.content.map(part => {
                    if (part.type === 'text') {
                        return part.text;
                    }
                    if (part.type === 'file_content') {
                        return `--- 文件: ${part.file_path} ---\n${part.content}`;
                    }
                    return '';
                }).join('\n');
            }
            return { ...msg, content: combinedContent };
        });

        // 2. Filter out empty messages and map roles
        const initialContents = processedMessages
            .filter(msg => msg.content && msg.content.trim() !== '')
            .map(msg => ({
                role: msg.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: msg.content }]
            }));

        // 3. Merge consecutive messages of the same role
        const mergedContents = [];
        if (initialContents.length > 0) {
            let currentRole = initialContents[0].role;
            let currentParts = [];

            for (const msg of initialContents) {
                if (msg.role === currentRole) {
                    currentParts.push(msg.parts[0].text);
                } else {
                    mergedContents.push({ role: currentRole, parts: [{ text: currentParts.join('\n') }] });
                    currentRole = msg.role;
                    currentParts = [msg.parts[0].text];
                }
            }
            mergedContents.push({ role: currentRole, parts: [{ text: currentParts.join('\n') }] });
        }

        // 4. Ensure the conversation starts with a 'user' role by prepending a dummy user turn if needed.
        let finalContents = mergedContents;
        if (finalContents.length > 0 && finalContents[0].role !== 'user') {
            finalContents.unshift({ role: 'user', parts: [{ text: '(Context)' }] });
        }
        
        const generationConfig = {};
        if (openaiBody.max_tokens) {
            generationConfig.maxOutputTokens = openaiBody.max_tokens;
        }
        if (openaiBody.temperature) {
            generationConfig.temperature = openaiBody.temperature;
        }
        if (openaiBody.top_p) {
            generationConfig.topP = openaiBody.top_p;
        }
        // Explicitly ignore other unsupported parameters from various clients.

        return {
            contents: finalContents,
            generationConfig: generationConfig,
            safetySettings: [
                { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
            ]
        };
    }

    _buildProxyRequest(geminiRequest, requestId, originalHeaders, modelId) {
        // 从原始请求头中提取关键信息，例如授权
        const headers = {
            'content-type': 'application/json',
            'authorization': originalHeaders.authorization || ''
        };

        const effectiveModelId = modelId || 'gemini-2.5-pro-preview-06-05';

        return {
            path: `v1beta/models/${effectiveModelId}:generateContent`,
            method: 'POST',
            headers: headers,
            query_params: {}, // 移除 alt: 'sse'
            body: JSON.stringify(geminiRequest),
            request_id: requestId,
            streaming_mode: this.requestHandler.serverSystem.streamingMode // 使用服务器的默认模式
        };
    }
}

class LoggingService {
  constructor(serviceName = 'ProxyServer') {
    this.serviceName = serviceName;
  }
  
  _formatMessage(level, message) {
    const timestamp = new Date().toISOString();
    return `[${level}] ${timestamp} [${this.serviceName}] - ${message}`;
  }
  
  info(message) {
    console.log(this._formatMessage('INFO', message));
  }
  
  error(message) {
    console.error(this._formatMessage('ERROR', message));
  }
  
  warn(message) {
    console.warn(this._formatMessage('WARN', message));
  }
  
  debug(message) {
    console.debug(this._formatMessage('DEBUG', message));
  }
}

class MessageQueue extends EventEmitter {
  constructor(timeoutMs = 600000) {
    super();
    this.messages = [];
    this.waitingResolvers = [];
    this.defaultTimeout = timeoutMs;
    this.closed = false;
  }
  
  enqueue(message) {
    if (this.closed) return;
    
    if (this.waitingResolvers.length > 0) {
      const resolver = this.waitingResolvers.shift();
      resolver.resolve(message);
    } else {
      this.messages.push(message);
    }
  }
  
  async dequeue(timeoutMs = this.defaultTimeout) {
    if (this.closed) {
      throw new Error('Queue is closed');
    }
    
    return new Promise((resolve, reject) => {
      if (this.messages.length > 0) {
        resolve(this.messages.shift());
        return;
      }
      
      const resolver = { resolve, reject };
      this.waitingResolvers.push(resolver);
      
      const timeoutId = setTimeout(() => {
        const index = this.waitingResolvers.indexOf(resolver);
        if (index !== -1) {
          this.waitingResolvers.splice(index, 1);
          reject(new Error('Queue timeout'));
        }
      }, timeoutMs);
      
      resolver.timeoutId = timeoutId;
    });
  }
  
  close() {
    this.closed = true;
    this.waitingResolvers.forEach(resolver => {
      clearTimeout(resolver.timeoutId);
      resolver.reject(new Error('Queue closed'));
    });
    this.waitingResolvers = [];
    this.messages = [];
  }
}

class ConnectionRegistry extends EventEmitter {
  constructor(logger) {
    super();
    this.logger = logger;
    this.connections = new Set();
    this.messageQueues = new Map();
  }
  
  addConnection(websocket, clientInfo) {
    this.connections.add(websocket);
    this.logger.info(`新客户端连接: ${clientInfo.address}`);
    
    websocket.on('message', (data) => {
      this._handleIncomingMessage(data.toString());
    });
    
    websocket.on('close', () => {
      this._removeConnection(websocket);
    });
    
    websocket.on('error', (error) => {
      this.logger.error(`WebSocket连接错误: ${error.message}`);
    });
    
    this.emit('connectionAdded', websocket);
  }
  
  _removeConnection(websocket) {
    this.connections.delete(websocket);
    this.logger.info('客户端连接断开');
    
    this.messageQueues.forEach(queue => queue.close());
    this.messageQueues.clear();
    
    this.emit('connectionRemoved', websocket);
  }
  
  _handleIncomingMessage(messageData) {
    try {
      const parsedMessage = JSON.parse(messageData);
      const requestId = parsedMessage.request_id;
      
      if (!requestId) {
        this.logger.warn('收到无效消息：缺少request_id');
        return;
      }
      
      const queue = this.messageQueues.get(requestId);
      if (queue) {
        this._routeMessage(parsedMessage, queue);
      } else {
        this.logger.warn(`收到未知请求ID的消息: ${requestId}`);
      }
    } catch (error) {
      this.logger.error('解析WebSocket消息失败');
    }
  }
  
  _routeMessage(message, queue) {
    const { event_type } = message;
    
    switch (event_type) {
      case 'response_headers':
      case 'chunk':
      case 'error':
        queue.enqueue(message);
        break;
      case 'stream_close':
        queue.enqueue({ type: 'STREAM_END' });
        break;
      default:
        this.logger.warn(`未知的事件类型: ${event_type}`);
    }
  }
  
  hasActiveConnections() {
    return this.connections.size > 0;
  }
  
  getFirstConnection() {
    return this.connections.values().next().value;
  }
  
  createMessageQueue(requestId) {
    const queue = new MessageQueue();
    this.messageQueues.set(requestId, queue);
    return queue;
  }
  
  removeMessageQueue(requestId) {
    const queue = this.messageQueues.get(requestId);
    if (queue) {
      queue.close();
      this.messageQueues.delete(requestId);
    }
  }
}

class RequestHandler {
  constructor(serverSystem, connectionRegistry, logger) {
    this.serverSystem = serverSystem;
    this.connectionRegistry = connectionRegistry;
    this.logger = logger;
  }
  
  async processRequest(req, res) {
    this.logger.info(`处理请求: ${req.method} ${req.path}`);
    
    if (!this.connectionRegistry.hasActiveConnections()) {
      return this._sendErrorResponse(res, 503, '没有可用的浏览器连接');
    }
    
    const requestId = this._generateRequestId();
    const proxyRequest = this._buildProxyRequest(req, requestId);
    
    const messageQueue = this.connectionRegistry.createMessageQueue(requestId);
    
    try {
      await this._forwardRequest(proxyRequest);
      await this._handleResponse(messageQueue, req, res);
    } catch (error) {
      this._handleRequestError(error, res);
    } finally {
      this.connectionRegistry.removeMessageQueue(requestId);
    }
  }
  
  _generateRequestId() {
    return `${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }
  
  _buildProxyRequest(req, requestId) {
    let requestBody = '';
    if (Buffer.isBuffer(req.body)) {
      requestBody = req.body.toString('utf-8');
    } else if (typeof req.body === 'string') {
        requestBody = req.body;
    } else if (req.body) {
      requestBody = JSON.stringify(req.body);
    }
    
    return {
      path: req.path,
      method: req.method,
      headers: req.headers,
      query_params: req.query,
      body: requestBody,
      request_id: requestId,
      streaming_mode: this.serverSystem.streamingMode
    };
  }
  
  async _forwardRequest(proxyRequest) {
    const connection = this.connectionRegistry.getFirstConnection();
    connection.send(JSON.stringify(proxyRequest));
  }
  
  async _handleResponse(messageQueue, req, res) {
    const headerMessage = await messageQueue.dequeue();
    
    if (headerMessage.event_type === 'error') {
      return this._sendErrorResponse(res, headerMessage.status || 500, headerMessage.message);
    }
    
    this._setResponseHeaders(res, headerMessage);
    
    if (this.serverSystem.streamingMode === 'fake') {
      this.logger.info('当前为假流式模式，开始处理...');
      await this._pseudoStreamResponseData(messageQueue, req, res);
    } else {
      this.logger.info('当前为真流式模式，开始处理...');
      await this._realStreamResponseData(messageQueue, res);
    }
  }
  
  _setResponseHeaders(res, headerMessage) {
    res.status(headerMessage.status || 200);
    
    const headers = headerMessage.headers || {};
    Object.entries(headers).forEach(([name, value]) => {
      const isFakeMode = this.serverSystem.streamingMode === 'fake';
      if (!isFakeMode || name.toLowerCase() !== 'content-length') {
        res.set(name, value);
      }
    });
  }

  async _pseudoStreamResponseData(messageQueue, req, res) {
    let connectionMaintainer = null;
    let fullBody = '';
    let keepAliveChunk = 'data: {}\n\n';
    let apiType = 'Unknown';

    if (req.path.includes('chat/completions')) {
      apiType = 'OpenAI';
      const fakeId = `chatcmpl-${this._generateRequestId()}`;
      const timestamp = Math.floor(Date.now() / 1000);
      const openAIKeepAlivePayload = {
        id: fakeId,
        object: "chat.completion.chunk",
        created: timestamp,
        model: "gpt-4",
        choices: [{ index: 0, delta: {}, finish_reason: null }]
      };
      keepAliveChunk = `data: ${JSON.stringify(openAIKeepAlivePayload)}\n\n`;
    } 
    else if (req.path.includes('generateContent')) {
      apiType = 'Gemini';
      const geminiKeepAlivePayload = {
          candidates: [{ content: { parts: [{ text: "" }], role: "model" }, finishReason: null, index: 0, safetyRatings: [] }]
      };
      keepAliveChunk = `data: ${JSON.stringify(geminiKeepAlivePayload)}\n\n`;
    }

    try {
      this.logger.info(`检测到 ${apiType} API，已启动假流式响应。`);

      connectionMaintainer = setInterval(() => {
        if (!res.writableEnded) { res.write(keepAliveChunk); }
      }, 1000);

      const dataMessage = await messageQueue.dequeue();

      if (dataMessage.type === 'STREAM_END') {
        this.logger.warn('在收到任何数据块前流已关闭');
      } else if (dataMessage.data) {
        fullBody = dataMessage.data;
        this.logger.info(`已收到完整响应体，长度: ${fullBody.length}`);
      }

      const endMessage = await messageQueue.dequeue();
      if (endMessage.type !== 'STREAM_END') {
        this.logger.warn('在数据块之后未收到预期的STREAM_END信号');
      }

    } catch (error) {
        this.logger.error(`假流式响应处理中发生错误: ${error.message}`);
        throw error;
    } finally {
      if (connectionMaintainer) {
        clearInterval(connectionMaintainer);
        this.logger.info('假流式响应的连接维持已停止。');
      }

      if (!res.writableEnded) {
        if (fullBody) { res.write(fullBody); }
        res.end();
        this.logger.info('完整响应已发送，连接已关闭。');
      }
    }
  }

  async _realStreamResponseData(messageQueue, res) {
    try {
        while (true) {
            const dataMessage = await messageQueue.dequeue(30000);
            
            if (dataMessage.type === 'STREAM_END') {
              this.logger.info('收到流结束信号。');
              break;
            }
            
            if (dataMessage.data) {
              res.write(dataMessage.data);
            }
        }
    } catch(error) {
        if (error.message === 'Queue timeout') {
            this.logger.warn('真流式响应超时，可能是流已正常结束但未收到结束信号。');
        } else {
            this.logger.error(`真流式响应处理中发生错误: ${error.message}`);
            throw error;
        }
    } finally {
        if(!res.writableEnded) {
            res.end();
            this.logger.info('真流式响应连接已关闭。');
        }
    }
  }
  
  _handleRequestError(error, res) {
    if (!res.headersSent) {
      if (error.message === 'Queue timeout') {
        this._sendErrorResponse(res, 504, '请求超时');
      } else {
        this.logger.error(`请求处理错误: ${error.message}`);
        this._sendErrorResponse(res, 500, `代理错误: ${error.message}`);
      }
    } else {
        this.logger.error(`请求处理错误（头已发送）: ${error.message}`);
        if(!res.writableEnded) res.end();
    }
  }
  
  _sendErrorResponse(res, status, message) {
    if (!res.headersSent) {
      res.status(status).send(message);
    }
  }
}

class ProxyServerSystem extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = {
      httpPort: 8889,
      wsPort: 9998,
      host: '127.0.0.1',
      ...config
    };
    
    this.streamingMode = 'fake';

    this.logger = new LoggingService('ProxyServer');
    this.connectionRegistry = new ConnectionRegistry(this.logger);
    this.requestHandler = new RequestHandler(this, this.connectionRegistry, this.logger);
    
    this.httpServer = null;
    this.wsServer = null;
  }
  
  async start() {
    try {
      await this._startHttpServer();
      await this._startWebSocketServer();
      
      this.logger.info(`代理服务器系统启动完成，当前模式: ${this.streamingMode}`);
      this.emit('started');
    } catch (error) {
      this.logger.error(`启动失败: ${error.message}`);
      this.emit('error', error);
      throw error;
    }
  }
  
  async _startHttpServer() {
    const app = this._createExpressApp();
    this.httpServer = http.createServer(app);
    
    return new Promise((resolve) => {
      this.httpServer.listen(this.config.httpPort, this.config.host, () => {
        this.logger.info(`HTTP服务器启动: http://${this.config.host}:${this.config.httpPort}`);
        resolve();
      });
    });
  }
  
  _createExpressApp() {
    const app = express();
    this.openAIAdapter = new OpenAIAdapter(this.requestHandler);
    
    app.use(express.json({ limit: '100mb' }));
    app.use(express.urlencoded({ extended: true, limit: '100mb' }));
    app.use(express.raw({ type: '*/*', limit: '100mb' }));

    app.get('/admin/set-mode', (req, res) => {
        const newMode = req.query.mode;
        if (newMode === 'fake' || newMode === 'real') {
            this.streamingMode = newMode;
            const message = `流式响应模式已切换为: ${this.streamingMode}`;
            this.logger.info(message);
            res.status(200).send(message);
        } else {
            const message = '无效的模式。请使用 "fake" 或 "real"。';
            this.logger.warn(message);
            res.status(400).send(message);
        }
    });

    app.get('/admin/get-mode', (req, res) => {
        const message = `当前流式响应模式为: ${this.streamingMode}`;
        res.status(200).send(message);
    });
    
    app.get('/v1/models', (req, res) => {
        const models = [
            "kingfall-ab-test",
            "gemini-2.5-pro-exp-03-25",
            "gemini-2.5-pro-preview-05-06",
            "gemini-2.5-pro-preview-03-25",
            "gemini-2.5-flash-preview-05-20",
            "gemini-2.5-pro-preview-06-05"
        ];

        const response = {
            object: "list",
            data: models.map(modelId => ({
                id: modelId,
                object: "model",
                created: Math.floor(Date.now() / 1000),
                owned_by: "google"
            }))
        };
        
        res.json(response);
    });
    
    app.post('/v1/chat/completions', (req, res) => {
        this.openAIAdapter.handleChatCompletion(req, res);
    });

    app.all(/(.*)/, (req, res) => {
      if (req.path.startsWith('/admin/')) return;
      if (req.path.startsWith('/v1/')) return; // 避免被通用处理器捕获
      this.requestHandler.processRequest(req, res);
    });
    
    return app;
  }
  
  async _startWebSocketServer() {
    this.wsServer = new WebSocket.Server({
      port: this.config.wsPort,
      host: this.config.host
    });
    
    this.wsServer.on('connection', (ws, req) => {
      this.connectionRegistry.addConnection(ws, {
        address: req.socket.remoteAddress
      });
    });
    
    this.logger.info(`WebSocket服务器启动: ws://${this.config.host}:${this.config.wsPort}`);
  }
}

async function initializeServer() {
  const serverSystem = new ProxyServerSystem();
  
  try {
    await serverSystem.start();
  } catch (error) {
    console.error('服务器启动失败:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  initializeServer();
}

module.exports = { ProxyServerSystem, initializeServer };
