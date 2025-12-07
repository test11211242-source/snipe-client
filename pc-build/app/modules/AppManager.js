const ConfigManager = require('./core/ConfigManager');
const StoreManager = require('./core/StoreManager');
const EventBus = require('./core/EventBus');
const IpcManager = require('./core/IpcManager');
const ServerManager = require('./network/ServerManager');
const ApiManager = require('./network/ApiManager');
const WebSocketManager = require('./network/WebSocketManager');
const AuthManager = require('./auth/AuthManager');
const InviteManager = require('./auth/InviteManager');
const UpdateManager = require('./features/UpdateManager');
const OcrManager = require('./features/OcrManager');
const MonitorManager = require('./features/MonitorManager');
const StreamerManager = require('./features/StreamerManager');
const AppWindowManager = require('./windows/AppWindowManager');
const SetupWindow = require('./windows/SetupWindow');

/**
 * AppManager - Главный координатор приложения
 */
class AppManager {
    constructor() {
        this.modules = {};
        this.initialized = false;
    }

    async initialize() {
        console.log('🚀 Инициализация AppManager...');
        
        try {
            // 1. Инициализация базовых модулей
            this.modules.config = new ConfigManager();
            this.modules.store = new StoreManager();
            this.modules.eventBus = new EventBus();
            this.modules.server = new ServerManager();
            
            console.log('✅ Базовые модули инициализированы');
            
            // 2. Инициализация сетевых модулей
            this.modules.api = new ApiManager();
            this.modules.websocket = new WebSocketManager();
            
            console.log('✅ Сетевые модули инициализированы');
            
            // 3. Инициализация модулей авторизации
            this.modules.auth = new AuthManager(this.modules.api);
            this.modules.invite = new InviteManager(this.modules.api);
            
            // Устанавливаем связи между модулями
            this.modules.auth.setApiManager(this.modules.api);
            this.modules.invite.setApiManager(this.modules.api);
            
            console.log('✅ Модули авторизации инициализированы');
            
            // 4. Инициализация функциональных модулей
            this.modules.update = new UpdateManager(this.modules.api);
            this.modules.update.setApiManager(this.modules.api);
            this.modules.ocr = new OcrManager(this.modules.api, this.modules.eventBus);
            this.modules.monitor = new MonitorManager(this.modules.eventBus, this.modules.store, this.modules.api);
            this.modules.streamer = new StreamerManager(this.modules.eventBus, this.modules.store, this.modules.api, this.modules.monitor);
            this.modules.windowManager = new AppWindowManager(this, this.modules.eventBus);
            this.modules.setupWindow = new SetupWindow(this, this.modules.eventBus);
            
            console.log('✅ Функциональные модули инициализированы');
            
            // 5. Инициализация IPC менеджера
            this.modules.ipc = new IpcManager();
            this.modules.ipc.setAppManager(this);
            this.modules.ipc.setEventBus(this.modules.eventBus);
            
            // Инициализируем IPC обработчики
            this.modules.ipc.initialize();
            
            console.log('✅ IPC Manager инициализирован');
            
            // 6. Настройка связей между модулями
            this.setupModuleConnections();
            
            this.initialized = true;
            console.log('🎉 AppManager полностью инициализирован');
            
            // Выводим отладочную информацию
            this.debugInfo();
            
        } catch (error) {
            console.error('❌ Ошибка инициализации AppManager:', error);
            throw error;
        }
    }

    // === Настройка связей между модулями ===
    
    setupModuleConnections() {
        console.log('🔗 Настройка связей между модулями...');
        
        // Подключаем EventBus к модулям (если поддерживается)
        if (this.modules.api.setEventBus) {
            this.modules.api.setEventBus(this.modules.eventBus);
        }
        if (this.modules.websocket.setEventBus) {
            this.modules.websocket.setEventBus(this.modules.eventBus);
        }
        if (this.modules.auth.setEventBus) {
            this.modules.auth.setEventBus(this.modules.eventBus);
        }

        // 🆕 ЭТАП 3.2: Подключаем WindowManager к IpcManager
        this.modules.ipc.setWindowManager(this.modules.windowManager);
        
        // === Настройка EventBus подписок ===
        
        // API Manager события
        this.modules.eventBus.on('api:auth:failed', () => {
            console.log('🚪 API сигнализирует о неудачной авторизации');
            this.handleAuthFailure();
        });
        
        // WebSocket события
        this.modules.eventBus.on('websocket:token:expired', () => {
            console.log('🔑 WebSocket сигнализирует об истечении токена');
            this.handleTokenExpiration();
        });
        
        this.modules.eventBus.on('websocket:ocr:reprocessed', (data) => {
            console.log('🔄 WebSocket получил данные переобработки OCR');
            // Передаем в UI через IPC события
        });
        
        // Auth события
        this.modules.eventBus.on('auth:login:success', (data) => {
            console.log('✅ Успешная авторизация');
            // Подключаемся к WebSocket после успешной авторизации
            this.modules.websocket.connect();
        });
        
        this.modules.eventBus.on('auth:logout:complete', () => {
            console.log('🚪 Выход из системы завершен');
            // Отключаемся от WebSocket при выходе
            this.modules.websocket.disconnect();
            
            // Переходим к окну авторизации
            this.handleLogoutComplete();
        });
        
        // Обработка успешного logout из IpcManager
        this.modules.eventBus.on('auth:logout:success', () => {
            console.log('🚪 Logout успешно завершен - переход к авторизации');
            
            // Переходим к окну авторизации
            this.handleLogoutComplete();
        });
        
        // Обработка успешной авторизации из UI
        this.modules.eventBus.on('auth:success', () => {
            console.log('🎉 Авторизация завершена - создание главного окна');
            // Закрываем окно авторизации и открываем главное
            this.closeWindow('auth');
            this.createWindow('main');
        });
        
        // OCR события
        this.modules.eventBus.on('ocr:regions:updated', (data) => {
            console.log('👁️ OCR области обновлены');
        });
        
        // Monitor события
        this.modules.eventBus.on('monitor:player-found', (data) => {
            console.log('🎯 Игрок найден:', data.playerData);
            // Передаем в UI через IPC
            this.emitAppEvent('player_found', data.playerData);
        });
        
        this.modules.eventBus.on('monitor:ocr-reprocessed', (data) => {
            console.log('🔄 OCR переобработан:', data);
            // Передаем в UI через IPC
            this.emitAppEvent('ocr_reprocessed', data);
        });
        
        this.modules.eventBus.on('monitor:status', (status) => {
            // Показываем только важные статусы, не спам кадров  
            console.log('📊 Monitor status:', status);
            this.emitAppEvent('monitor_status', status);
        });
        
        this.modules.eventBus.on('monitor:error', (error) => {
            console.log('❌ Monitor error:', error);
            this.emitAppEvent('monitor_error', error);
        });
        
        this.modules.eventBus.on('monitor:started', () => {
            console.log('▶️ Monitor запущен');
            this.emitAppEvent('monitor_started');
        });
        
        this.modules.eventBus.on('monitor:stopped', () => {
            console.log('⏹️ Monitor остановлен');
            this.emitAppEvent('monitor_stopped');
        });
        
        // Window события
        this.modules.eventBus.on('window:create:setup', () => {
            console.log('⚙️ Создание окна настройки OCR областей');
            this.createWindow('setup');
        });
        
        // Fallback callbacks для старых модулей
        this.setupFallbackCallbacks();
        
        console.log('✅ Связи между модулями настроены');
        console.log('📡 EventBus подписки активированы');
    }
    
    // === Fallback callbacks для модулей без EventBus ===
    
    setupFallbackCallbacks() {
        // API Manager - callback при неудачной авторизации (если EventBus не поддерживается)
        if (this.modules.api.setAuthFailureCallback) {
            this.modules.api.setAuthFailureCallback(() => {
                console.log('🚪 API Manager сигнализирует о неудачной авторизации (fallback)');
                this.handleAuthFailure();
            });
        }
        
        // WebSocket Manager - callbacks для событий (если EventBus не поддерживается)
        if (this.modules.websocket.setEventCallback) {
            this.modules.websocket.setEventCallback('token_expired', () => {
                console.log('🔑 WebSocket сигнализирует об истечении токена (fallback)');
                this.handleTokenExpiration();
            });
            
            this.modules.websocket.setEventCallback('ocr_reprocessed', (data) => {
                console.log('🔄 WebSocket получил данные переобработки OCR (fallback)');
            });
        }
        
        // Auth Manager - callback для событий авторизации (если EventBus не поддерживается)
        if (this.modules.auth.setAuthEventCallback) {
            this.modules.auth.setAuthEventCallback((event, data) => {
                console.log(`🔔 Auth событие: ${event} (fallback)`);
                
                if (event === 'login_success') {
                    this.modules.websocket.connect();
                } else if (event === 'logout') {
                    this.modules.websocket.disconnect();
                }
            });
        }
    }

    // === Обработчики событий модулей ===
    
    handleAuthFailure() {
        console.log('🚪 Обработка неудачной авторизации');
        // TODO: Уведомить UI о необходимости повторного входа
        this.emitAppEvent('auth_failure');
    }
    
    handleLogoutComplete() {
        console.log('🚪 Обработка завершения logout - переход к окну авторизации');
        
        try {
            // Закрываем главное окно если открыто
            if (this.modules.windowManager && this.modules.windowManager.hasWindow('main')) {
                console.log('🔒 Закрываем главное окно');
                this.closeWindow('main');
            }
            
            // Закрываем виджет если открыт
            if (this.modules.windowManager && this.modules.windowManager.hasWindow('widget')) {
                console.log('🔒 Закрываем виджет');
                this.closeWindow('widget');
            }
            
            // Закрываем окно настроек если открыто
            if (this.modules.windowManager && this.modules.windowManager.hasWindow('setup')) {
                console.log('🔒 Закрываем окно настроек');
                this.closeWindow('setup');
            }
            
            // Открываем окно авторизации
            console.log('🔐 Открываем окно авторизации');
            this.createWindow('auth');
            
        } catch (error) {
            console.error('❌ Ошибка при обработке logout:', error);
            
            // В случае ошибки все равно пытаемся открыть окно авторизации
            try {
                this.createWindow('auth');
            } catch (createError) {
                console.error('❌ Критическая ошибка создания окна авторизации:', createError);
            }
        }
    }
    
    async handleTokenExpiration() {
        console.log('🔑 Обработка истечения токена');
        
        const refreshResult = await this.modules.auth.refreshToken();
        
        if (refreshResult.success) {
            console.log('✅ Токен успешно обновлен');
            // Переподключаем WebSocket с новым токеном
            await this.modules.websocket.updateTokenAndReconnect();
            this.emitAppEvent('token_refreshed');
        } else {
            console.log('❌ Не удалось обновить токен');
            this.handleAuthFailure();
        }
    }

    // === Инициализация при запуске приложения ===
    
    async initializeOnStartup() {
        try {
            console.log('🚀 Полная инициализация при запуске...');
            
            // 1. Инициализация серверов
            console.log('🌐 Инициализация серверов...');
            const serverResult = await this.modules.server.initializeOnStartup();
            
            if (!serverResult.success) {
                console.warn('⚠️ Проблемы с серверами:', serverResult.error);
            }
            
            // 2. Проверка инвайт-доступа
            console.log('🎫 Проверка инвайт-доступа...');
            const inviteResult = await this.modules.invite.checkStartupAccess();
            
            if (!inviteResult.success) {
                return {
                    success: false,
                    error: inviteResult.error,
                    stage: 'invite_check'
                };
            }
            
            if (!inviteResult.accessGranted) {
                return {
                    success: true,
                    requiresInvite: true,
                    message: inviteResult.message
                };
            }
            
            // 3. Проверка авторизации
            console.log('🔐 Проверка авторизации...');
            const authResult = await this.modules.auth.initializeOnStartup();
            
            if (!authResult.authenticated) {
                return {
                    success: true,
                    authenticated: false,
                    reason: authResult.reason
                };
            }
            
            // 4. Подключение WebSocket
            console.log('🔌 Подключение WebSocket...');
            const wsResult = await this.modules.websocket.connect();
            
            if (!wsResult.success) {
                console.warn('⚠️ WebSocket подключение неудачно:', wsResult.error);
            }
            
            console.log('🎉 Приложение полностью инициализировано');
            
            return {
                success: true,
                authenticated: true,
                user: authResult.user,
                server: serverResult,
                websocket: wsResult
            };
            
        } catch (error) {
            console.error('❌ Ошибка инициализации при запуске:', error);
            return {
                success: false,
                error: error.message,
                stage: 'startup'
            };
        }
    }

    // === Проверка состояния авторизации ===
    
    isAuthenticated() {
        return this.modules.auth?.isAuthenticated() || false;
    }

    // === Получение состояния приложения ===
    
    getAppState() {
        if (!this.initialized) {
            return { initialized: false };
        }
        
        // Проверяем, доступен ли Electron
        let electronInfo = { version: '0.0.0', packaged: false };
        try {
            const electronApp = require('electron').app;
            if (electronApp) {
                electronInfo = {
                    version: electronApp.getVersion(),
                    packaged: electronApp.isPackaged
                };
            }
        } catch (error) {
            // Работаем в тестовом режиме без Electron
            electronInfo = { version: 'test-mode', packaged: false };
        }

        return {
            initialized: this.initialized,
            app: electronInfo,
            auth: this.modules.auth?.getAuthState(),
            server: this.modules.server?.getServerStatus(),
            websocket: this.modules.websocket?.getStatus(),
            store: this.modules.store?.getAppState(),
            update: this.modules.update?.getStatus()
        };
    }

    // === Вход в систему ===
    
    async login(credentials) {
        console.log('🔐 Вход в систему через AppManager...');
        return await this.modules.auth.login(credentials);
    }

    // === Регистрация ===
    
    async register(userData) {
        console.log('📝 Регистрация через AppManager...');
        return await this.modules.auth.register(userData);
    }

    // === Выход из системы ===
    
    async logout() {
        console.log('🚪 Выход из системы через AppManager...');
        
        // Отключаем WebSocket
        this.modules.websocket?.disconnect();
        
        // Выходим из авторизации
        const result = await this.modules.auth.logout();
        
        this.emitAppEvent('logout_complete');
        
        return result;
    }

    // === Переключение сервера ===
    
    async switchServer(mode) {
        console.log(`🔄 Переключение на ${mode} сервер через AppManager...`);
        
        // Отключаем WebSocket
        this.modules.websocket?.disconnect();
        
        // Переключаем сервер
        const result = await this.modules.server.switchServerMode(mode);
        
        // Обновляем базовый URL в API
        if (result.success) {
            this.modules.api?.updateBaseURL(this.modules.store.getServerUrl());
            
            // Переподключаем WebSocket если авторизованы
            if (this.isAuthenticated()) {
                setTimeout(() => {
                    this.modules.websocket?.connect();
                }, 1000);
            }
        }
        
        return result;
    }

    // === Валидация инвайт-ключа ===
    
    async validateInviteKey(inviteCode) {
        console.log('🎫 Валидация инвайт-ключа через AppManager...');
        return await this.modules.invite.validateInviteKey(inviteCode);
    }

    // === Проверка обновлений ===
    
    async checkForUpdates() {
        console.log('🔄 Проверка обновлений через AppManager...');
        return await this.modules.update.checkForUpdates();
    }

    // === Скачивание обновления ===
    
    async downloadUpdate(type = 'installer') {
        console.log('📥 Скачивание обновления через AppManager...');
        return await this.modules.update.downloadUpdate(type);
    }

    // === Установка обновления ===
    
    async installUpdate(filePath) {
        console.log('🚀 Установка обновления через AppManager...');
        return await this.modules.update.installUpdate(filePath);
    }

    // === Управление мониторингом ===
    
    async startMonitoring() {
        console.log('▶️ Запуск мониторинга через AppManager...');
        return await this.modules.monitor.start();
    }
    
    async stopMonitoring() {
        console.log('⏹️ Остановка мониторинга через AppManager...');
        return await this.modules.monitor.stop();
    }
    
    async restartMonitoring(reason) {
        console.log('🔄 Перезапуск мониторинга через AppManager...');
        return await this.modules.monitor.restart(reason);
    }
    
    async updateSearchMode(mode) {
        console.log(`🔄 Изменение режима поиска на '${mode}' через AppManager...`);
        return await this.modules.monitor.updateSearchMode(mode);
    }
    
    getMonitorStatus() {
        return this.modules.monitor?.getStatus() || { isRunning: false };
    }

    // === 🆕 ЭТАП 2.1: Управление целями захвата ===
    
    async setWindowTarget(windowInfo) {
        console.log('🪟 Установка окна для захвата через AppManager:', windowInfo.name);
        return await this.modules.monitor.setWindowTarget(windowInfo);
    }
    
    async setScreenTarget() {
        console.log('🖥️ Переключение на захват экрана через AppManager');
        return await this.modules.monitor.setScreenTarget();
    }
    
    getCurrentCaptureTarget() {
        return this.modules.monitor?.getCurrentCaptureTarget() || null;
    }

    // === Управление окнами ===
    
    createWindow(windowType, data = {}) {
        console.log(`🪟 Создание окна "${windowType}" через AppManager...`);
        
        if (!this.modules.windowManager) {
            console.error('❌ WindowManager не инициализирован');
            return { success: false, error: 'WindowManager недоступен' };
        }
        
        try {
            let result;
            
            switch (windowType) {
                case 'auth':
                    result = this.modules.windowManager.createAuthWindow();
                    break;
                case 'main':
                    result = this.modules.windowManager.createMainWindow();
                    break;
                case 'setup':
                    result = this.modules.windowManager.createSetupWindow();
                    break;
                case 'widget':
                    result = this.modules.windowManager.createWidget(data);
                    break;
                default:
                    throw new Error(`Неизвестный тип окна: ${windowType}`);
            }
            
            return { success: true, window: result };
            
        } catch (error) {
            console.error(`❌ Ошибка создания окна "${windowType}":`, error);
            return { success: false, error: error.message };
        }
    }
    
    closeWindow(windowType) {
        console.log(`🔒 Закрытие окна "${windowType}" через AppManager...`);
        
        if (!this.modules.windowManager) {
            return { success: false, error: 'WindowManager недоступен' };
        }
        
        return this.modules.windowManager.closeWindow(windowType);
    }
    
    sendToWindow(windowType, channel, data) {
        if (!this.modules.windowManager) {
            return false;
        }
        
        return this.modules.windowManager.sendToWindow(windowType, channel, data);
    }
    
    // === Эмиссия событий приложения ===
    
    emitAppEvent(event, data = {}) {
        console.log(`🔔 App событие: ${event}`);
        
        // Используем EventBus для эмиссии событий
        if (this.modules.eventBus) {
            this.modules.eventBus.emit(`app:${event}`, data);
        }
        
        // Fallback для старого callback API
        if (this.appEventCallback) {
            this.appEventCallback(event, data);
        }
    }

    // === Установка callback для событий приложения ===
    
    setAppEventCallback(callback) {
        this.appEventCallback = callback;
    }

    // === Получение конкретного модуля ===
    
    getModule(moduleName) {
        return this.modules[moduleName];
    }

    // === Получение всех модулей ===
    
    getAllModules() {
        return { ...this.modules };
    }

    // === Отладочная информация ===
    
    debugInfo() {
        if (!this.initialized) {
            console.log('🔍 AppManager не инициализирован');
            return;
        }
        
        console.log('🔍 === AppManager Debug Info ===');
        console.log('📋 App State:', JSON.stringify(this.getAppState(), null, 2));
        
        console.log('\n📊 Module Status:');
        Object.keys(this.modules).forEach(moduleName => {
            const module = this.modules[moduleName];
            const debugInfo = module.getDebugInfo ? module.getDebugInfo() : { status: 'no debug info' };
            console.log(`  ${moduleName}:`, debugInfo);
        });
        
        console.log('🔍 ===============================');
    }

    // === Проверка готовности ===
    
    isReady() {
        return this.initialized && 
               this.modules.config && 
               this.modules.store && 
               this.modules.eventBus &&
               this.modules.server && 
               this.modules.api &&
               this.modules.websocket &&
               this.modules.auth &&
               this.modules.invite &&
               this.modules.update &&
               this.modules.ocr &&
               this.modules.monitor &&
               this.modules.windowManager &&
               this.modules.ipc;
    }

    // === Получение статуса инициализации ===
    
    getInitializationStatus() {
        return {
            initialized: this.initialized,
            ready: this.isReady(),
            modules: Object.keys(this.modules).reduce((status, moduleName) => {
                status[moduleName] = !!this.modules[moduleName];
                return status;
            }, {})
        };
    }

    // === Очистка ресурсов ===
    
    async cleanup() {
        console.log('🧹 Очистка ресурсов AppManager...');
        
        try {
            // Останавливаем мониторинг
            if (this.modules.monitor) {
                this.modules.monitor.cleanup();
            }
            
            // Отключаем WebSocket
            if (this.modules.websocket) {
                this.modules.websocket.disconnect();
            }
            
            // Очищаем IPC обработчики
            if (this.modules.ipc) {
                this.modules.ipc.cleanup();
            }
            
            // Очищаем EventBus
            if (this.modules.eventBus) {
                this.modules.eventBus.removeAllListeners();
            }
            
            // Очистка других модулей по необходимости
            // (большинство модулей не требуют специальной очистки)
            
            console.log('✅ Ресурсы AppManager очищены');
            
        } catch (error) {
            console.error('❌ Ошибка очистки ресурсов:', error);
        }
    }

    // === Геттеры для обратной совместимости ===
    
    getConfig() {
        return this.modules.config;
    }

    getStore() {
        return this.modules.store;
    }

    getServer() {
        return this.modules.server;
    }

    getApi() {
        return this.modules.api;
    }

    getAuth() {
        return this.modules.auth;
    }

    getWebSocket() {
        return this.modules.websocket;
    }

    getUpdate() {
        return this.modules.update;
    }

    getInvite() {
        return this.modules.invite;
    }

    getEventBus() {
        return this.modules.eventBus;
    }

    getOcr() {
        return this.modules.ocr;
    }

    getIpc() {
        return this.modules.ipc;
    }

    getMonitor() {
        return this.modules.monitor;
    }

    getSetupWindow() {
        return this.modules.setupWindow;
    }

    getWindowManager() {
        return this.modules.windowManager;
    }
    
    getStreamerManager() {
        return this.modules.streamer;
    }
}

module.exports = AppManager;