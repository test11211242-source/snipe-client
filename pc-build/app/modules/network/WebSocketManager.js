const WebSocket = require('ws');
const ConfigManager = require('../core/ConfigManager');
const StoreManager = require('../core/StoreManager');

/**
 * WebSocketManager - Управление WebSocket соединениями
 */
class WebSocketManager {
    constructor() {
        this.config = new ConfigManager();
        this.store = new StoreManager();
        this.ws = null;
        this.reconnectTimeout = null;
        this.messageHandlers = new Map();
        this.isConnecting = false;
        this.shouldReconnect = true;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = -1; // Бесконечные попытки
        
        this.initialize();
    }

    initialize() {
        console.log('🔌 Инициализация WebSocketManager...');
        
        // Регистрируем базовые обработчики сообщений
        this.registerDefaultHandlers();
        
        console.log('✅ WebSocketManager инициализирован');
    }

    // === Регистрация базовых обработчиков ===
    
    registerDefaultHandlers() {
        // Обработчик подтверждения соединения
        this.onMessage('connection', (message) => {
            if (message.status === 'connected') {
                console.log('🤝 Сервер подтвердил WebSocket-подключение');
                this.reconnectAttempts = 0; // Сбрасываем счетчик попыток
            }
        });

        // Обработчик переобработки OCR
        this.onMessage('ocr_reprocessed', (message) => {
            console.log('🔄 Получены данные переобработки OCR');
            this.emitEvent('ocr_reprocessed', message);
        });
    }

    // === Подключение к WebSocket ===
    
    async connect() {
        // Восстанавливаем auto-reconnect при явном вызове connect()
        // (мог быть сброшен через disconnect() при смене сервера)
        this.shouldReconnect = true;
        
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            console.log('🔌 WebSocket уже подключен или подключается');
            return { success: true, status: 'already_connected' };
        }

        if (this.isConnecting) {
            console.log('🔌 Подключение уже в процессе');
            return { success: true, status: 'connecting' };
        }

        const tokens = this.store.getTokens();
        const serverUrl = this.store.getServerUrl();

        if (!tokens?.access_token || !serverUrl) {
            console.log('🔌 Невозможно подключиться: нет токена или URL сервера');
            return { 
                success: false, 
                error: 'Нет токена авторизации или URL сервера' 
            };
        }

        try {
            this.isConnecting = true;
            
            // Преобразуем http:// в ws://
            const wsUrl = serverUrl.replace(/^http/, 'ws');
            const fullWsUrl = `${wsUrl}/ws/${tokens.access_token}`;
            
            console.log(`🔌 Подключение к WebSocket: ${wsUrl}/ws/***`);
            
            this.ws = new WebSocket(fullWsUrl);
            this.setupEventHandlers();
            
            // Ждем подключения или ошибки
            return new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    resolve({ 
                        success: false, 
                        error: 'Тайм-аут подключения' 
                    });
                }, 10000); // 10 секунд
                
                this.ws.once('open', () => {
                    clearTimeout(timeout);
                    resolve({ success: true, status: 'connected' });
                });
                
                this.ws.once('error', (error) => {
                    clearTimeout(timeout);
                    resolve({ 
                        success: false, 
                        error: error.message 
                    });
                });
            });
            
        } catch (error) {
            this.isConnecting = false;
            console.error('❌ Ошибка создания WebSocket:', error);
            return { 
                success: false, 
                error: error.message 
            };
        }
    }

    // === Настройка обработчиков событий WebSocket ===
    
    setupEventHandlers() {
        if (!this.ws) return;

        this.ws.on('open', () => {
            this.isConnecting = false;
            console.log('✅ WebSocket соединение установлено');
            
            // Сбрасываем таймер переподключения
            this.clearReconnectTimeout();
            
            // Эмитируем событие подключения
            this.emitEvent('connected', { timestamp: new Date().toISOString() });
        });

        this.ws.on('message', (data) => {
            try {
                const message = JSON.parse(data);
                console.log('📥 WebSocket сообщение:', message.type);
                
                this.handleMessage(message);
                
            } catch (error) {
                console.error('❌ Ошибка парсинга WebSocket сообщения:', error);
            }
        });

        this.ws.on('error', (error) => {
            this.isConnecting = false;
            console.error('❌ Ошибка WebSocket:', error.message);
            
            this.emitEvent('error', { error: error.message });
            
            // Проверяем ошибки авторизации
            if (this.isAuthError(error)) {
                console.log('🔄 WebSocket ошибка авторизации - токен истек');
                this.handleTokenExpiration();
            }
        });

        this.ws.on('close', (code, reason) => {
            this.isConnecting = false;
            console.log(`🚫 WebSocket соединение закрыто. Код: ${code}, причина: ${reason}`);
            
            this.ws = null;
            this.emitEvent('disconnected', { code, reason });
            
            // Обработка различных кодов закрытия
            if (code === 403 || code === 1008) { // Forbidden или Policy Violation
                console.log('🔄 WebSocket закрыт с кодом авторизации - обновляем токен');
                this.handleTokenExpiration();
            } else if (this.shouldReconnect) {
                this.scheduleReconnect();
            }
        });
    }

    // === Обработка сообщений ===
    
    handleMessage(message) {
        const handler = this.messageHandlers.get(message.type);
        if (handler) {
            try {
                handler(message);
            } catch (error) {
                console.error(`❌ Ошибка обработчика сообщения ${message.type}:`, error);
            }
        } else {
            console.log(`⚠️ Нет обработчика для сообщения: ${message.type}`);
        }
    }

    // === Проверка ошибки авторизации ===
    
    isAuthError(error) {
        return error.message.includes('403') || 
               error.message.includes('Unauthorized') || 
               error.message.includes('Forbidden');
    }

    // === Обработка истечения токена ===
    
    handleTokenExpiration() {
        console.log('🔑 Обработка истечения токена WebSocket');
        this.emitEvent('token_expired');
    }

    // === Планирование переподключения ===
    
    scheduleReconnect() {
        if (!this.shouldReconnect) {
            console.log('🔌 Переподключение отключено');
            return;
        }

        if (this.maxReconnectAttempts > 0 && this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.log('🔌 Достигнут лимит попыток переподключения');
            this.emitEvent('reconnect_failed');
            return;
        }

        this.clearReconnectTimeout();
        
        this.reconnectAttempts++;
        const delay = Math.min(this.config.websocket.reconnectTimeout * this.reconnectAttempts, 30000); // Максимум 30 секунд
        
        console.log(`🔌 Переподключение через ${delay/1000} секунд (попытка ${this.reconnectAttempts})`);
        
        this.reconnectTimeout = setTimeout(() => {
            console.log('🔄 Попытка переподключения WebSocket...');
            this.connect();
        }, delay);
    }

    // === Отключение ===
    
    disconnect() {
        console.log('🔌 Отключение WebSocket...');
        
        this.shouldReconnect = false;
        this.clearReconnectTimeout();
        
        if (this.ws) {
            this.ws.close(1000, 'Отключение по запросу клиента');
            this.ws = null;
        }
        
        console.log('✅ WebSocket отключен');
    }

    // === Очистка таймера переподключения ===
    
    clearReconnectTimeout() {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
    }

    // === Отправка сообщения ===
    
    send(type, data = {}) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.warn('⚠️ WebSocket не подключен, сообщение не отправлено');
            return { success: false, error: 'WebSocket не подключен' };
        }

        try {
            const message = {
                type,
                data,
                timestamp: new Date().toISOString()
            };
            
            this.ws.send(JSON.stringify(message));
            console.log('📤 WebSocket сообщение отправлено:', type);
            
            return { success: true };
        } catch (error) {
            console.error('❌ Ошибка отправки WebSocket сообщения:', error);
            return { success: false, error: error.message };
        }
    }

    // === Регистрация обработчика сообщений ===
    
    onMessage(type, handler) {
        this.messageHandlers.set(type, handler);
        console.log(`📝 Зарегистрирован обработчик для сообщения: ${type}`);
    }

    // === Удаление обработчика сообщений ===
    
    offMessage(type) {
        this.messageHandlers.delete(type);
        console.log(`🗑️ Удален обработчик для сообщения: ${type}`);
    }

    // === Эмиссия событий (пока простая реализация) ===
    
    emitEvent(event, data = {}) {
        console.log(`🔔 WebSocket событие: ${event}`);
        
        // TODO: Здесь будет использоваться EventBus
        if (this.eventCallbacks && this.eventCallbacks[event]) {
            this.eventCallbacks[event](data);
        }
    }

    // === Установка callback'ов для событий ===
    
    setEventCallback(event, callback) {
        if (!this.eventCallbacks) {
            this.eventCallbacks = {};
        }
        this.eventCallbacks[event] = callback;
    }

    // === Получение состояния ===
    
    getStatus() {
        return {
            connected: this.ws && this.ws.readyState === WebSocket.OPEN,
            connecting: this.isConnecting,
            shouldReconnect: this.shouldReconnect,
            reconnectAttempts: this.reconnectAttempts,
            hasToken: this.store.hasTokens()
        };
    }

    // === Включение/выключение переподключения ===
    
    setReconnectEnabled(enabled) {
        this.shouldReconnect = enabled;
        console.log(`🔌 Переподключение ${enabled ? 'включено' : 'отключено'}`);
    }

    // === Сброс счетчика попыток ===
    
    resetReconnectAttempts() {
        this.reconnectAttempts = 0;
        console.log('🔄 Счетчик попыток переподключения сброшен');
    }

    // === Обновление токена и переподключение ===
    
    async updateTokenAndReconnect() {
        console.log('🔑 Обновление токена и переподключение WebSocket...');
        
        this.disconnect();
        
        // Небольшая задержка перед переподключением
        setTimeout(async () => {
            this.shouldReconnect = true;
            await this.connect();
        }, 1000);
    }

    // === Отладочная информация ===
    
    getDebugInfo() {
        return {
            status: this.getStatus(),
            handlers: Array.from(this.messageHandlers.keys()),
            config: {
                reconnectTimeout: this.config.websocket.reconnectTimeout,
                maxRetries: this.config.websocket.maxRetries
            },
            store: {
                serverUrl: this.store.getServerUrl(),
                hasTokens: this.store.hasTokens()
            }
        };
    }
}

module.exports = WebSocketManager;