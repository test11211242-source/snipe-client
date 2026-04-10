// Безопасный импорт Electron модулей
let ipcMain, Notification, screen, desktopCapturer;
try {
    const electron = require('electron');
    ipcMain = electron.ipcMain;
    Notification = electron.Notification;
    screen = electron.screen;
    desktopCapturer = electron.desktopCapturer;
} catch (error) {
    // Работаем в тестовом режиме без Electron
    console.log('⚠️ Electron не доступен, работаем в тестовом режиме');
    ipcMain = null;
    Notification = null;
    screen = null;
    desktopCapturer = null;
}

const path = require('path');
const { exec } = require('child_process');

/**
 * 🆕 ЭТАП 2.1: Класс кэширования списка окон для производительности
 */
class WindowsCache {
    constructor() {
        this.cache = new Map();
        this.lastUpdate = 0;
        this.updateInterval = 30000; // 30 секунд
        this.isUpdating = false;
        
        console.log('📋 WindowsCache инициализирован');
    }
    
    async getAvailableWindows(forceRefresh = false) {
        const now = Date.now();
        
        // Проверяем нужно сть обновления
        if (!forceRefresh && 
            (now - this.lastUpdate) < this.updateInterval && 
            this.cache.size > 0 && 
            !this.isUpdating) {
            console.log('📋 Используем кэш окон (сохранено ' + this.cache.size + ' окон)');
            return Array.from(this.cache.values());
        }
        
        // Предотвращаем одновременные обновления
        if (this.isUpdating) {
            console.log('⌚ Обновление списка окон уже выполняется...');
            return Array.from(this.cache.values());
        }
        
        this.isUpdating = true;
        
        try {
            console.log('🔄 Обновляем список окон...');
            
            if (!desktopCapturer) {
                throw new Error('desktopCapturer недоступен');
            }
            
            const sources = await desktopCapturer.getSources({
                types: ['window'],
                thumbnailSize: { width: 200, height: 150 }
            });
            
            // Фильтруем и обогащаем данные
            const windows = await Promise.all(
                sources
                    .filter(this.filterSystemWindows)
                    .map(async (source) => {
                        const executableName = await this.getExecutableName(source.id);
                        return {
                            id: source.id,
                            name: source.name,
                            thumbnail: source.thumbnail.toDataURL(),
                            executableName: executableName,
                            processId: this.extractProcessId(source.id),
                            timestamp: now
                        };
                    })
            );
            
            // Обновляем кэш
            this.cache.clear();
            windows.forEach(window => this.cache.set(window.id, window));
            this.lastUpdate = now;
            
            console.log(`✅ Список окон обновлен: ${windows.length} окон`);
            
            return windows;
            
        } catch (error) {
            console.error('❌ Ошибка обновления списка окон:', error);
            return Array.from(this.cache.values()); // Возвращаем старые данные
        } finally {
            this.isUpdating = false;
        }
    }
    
    filterSystemWindows(source) {
        return source.name && 
               source.name.trim() !== '' &&
               !source.name.includes('Program Manager') &&
               !source.name.includes('Desktop Window Manager') &&
               !source.name.includes('Task Manager') &&
               !source.name.includes('Windows Input Experience') &&
               !source.name.includes('Microsoft Text Input Application') &&
               source.name !== 'Settings';
    }
    
    extractProcessId(windowId) {
        // Пытаемся извлечь processId из windowId
        // Формат windowId обычно: "window:PID:HWND"
        try {
            const parts = windowId.split(':');
            if (parts.length >= 2) {
                const pid = parseInt(parts[1]);
                return isNaN(pid) ? null : pid;
            }
        } catch (error) {
            console.warn('⚠️ Не удалось извлечь processId из', windowId);
        }
        return null;
    }
    
    async getExecutableName(windowId) {
        try {
            const processId = this.extractProcessId(windowId);
            if (!processId) return null;
            
            // Используем wmic на Windows для получения executable name
            return new Promise((resolve) => {
                exec(`wmic process where processid=${processId} get executablepath /value`, 
                    { timeout: 2000 }, // 2 секунды timeout
                    (error, stdout) => {
                        if (error) {
                            resolve(null);
                            return;
                        }
                        
                        try {
                            const match = stdout.match(/ExecutablePath=(.+)/i);
                            if (match && match[1]) {
                                const fullPath = match[1].trim();
                                const executableName = path.basename(fullPath);
                                resolve(executableName);
                            } else {
                                resolve(null);
                            }
                        } catch (parseError) {
                            resolve(null);
                        }
                    });
            });
        } catch (error) {
            console.warn('⚠️ Не удалось получить executable name:', error);
            return null;
        }
    }
    
    clearCache() {
        this.cache.clear();
        this.lastUpdate = 0;
        console.log('🗑️ Кэш окон очищен');
    }
    
    getStats() {
        return {
            cacheSize: this.cache.size,
            lastUpdate: this.lastUpdate,
            age: Date.now() - this.lastUpdate,
            isUpdating: this.isUpdating
        };
    }
}

/**
 * IpcManager - Централизованное управление IPC обработчиками
 * Отделяет IPC коммуникацию от бизнес-логики
 */
class IpcManager {
    constructor() {
        this.appManager = null;
        this.windowManager = null;
        this.eventBus = null;
        this.handlers = new Map();
        this.isInitialized = false;
        
        // 🆕 ЭТАП 2.1: Инициализация кэша окон
        this.windowsCache = new WindowsCache();
        
        console.log('📡 IpcManager инициализирован');
    }

    // === Установка зависимостей ===
    
    setAppManager(appManager) {
        this.appManager = appManager;
        console.log('🔗 AppManager подключен к IpcManager');
    }

    setWindowManager(windowManager) {
        this.windowManager = windowManager;
        console.log('🔗 WindowManager подключен к IpcManager');
    }

    setEventBus(eventBus) {
        this.eventBus = eventBus;
        console.log('🔗 EventBus подключен к IpcManager');
    }

    // === Инициализация всех обработчиков ===

    initialize() {
        if (this.isInitialized) {
            console.warn('⚠️ IpcManager уже инициализирован');
            return;
        }

        // Проверка доступности Electron
        if (!ipcMain) {
            console.log('⚠️ Electron IPC недоступен, работаем в тестовом режиме');
            this.isInitialized = true;
            console.log('✅ IpcManager инициализирован в тестовом режиме');
            return;
        }

        console.log('⚡ Регистрация всех IPC обработчиков...');

        this.registerAuthHandlers();
        this.registerInviteHandlers();
        this.registerServerHandlers();
        this.registerOcrHandlers();
        this.registerWindowHandlers(); // 🆕 ЭТАП 2.1: Обработчики для работы с окнами
        this.registerMonitorHandlers();
        this.registerWidgetHandlers();
        this.registerUpdateHandlers();
        this.registerSettingsHandlers();
        this.registerHotkeyHandlers();
        this.registerCacheHandlers(); // 🆕 Обработчики для кеша изображений карт
        this.registerAppHandlers();

        // 🆕 ЭТАП 2.1: Настройка EventBus обработчиков
        this.setupEventBusHandlers();

        this.isInitialized = true;
        console.log('✅ Все IPC обработчики зарегистрированы');
        console.log(`📊 Всего обработчиков: ${this.handlers.size}`);
    }

    // === Авторизация ===

    registerAuthHandlers() {
        this.registerHandler('auth:login', async (event, credentials) => {
            console.log('🔐 IPC: Вход в систему');
            return await this.appManager.login(credentials);
        });

        this.registerHandler('auth:register', async (event, userData) => {
            console.log('📝 IPC: Регистрация');
            return await this.appManager.register(userData);
        });

        this.registerHandler('auth:logout', async () => {
            console.log('🚪 IPC: Выход из системы');
            
            const result = await this.appManager.logout();
            
            // Эмитируем событие для WindowManager
            if (this.eventBus) {
                this.eventBus.emit('auth:logout:success', result);
            }
            
            return result;
        });

        this.registerHandler('auth:success', async () => {
            console.log('✅ IPC: Успешная авторизация');
            
            // Эмитируем событие для WindowManager
            if (this.eventBus) {
                this.eventBus.emit('auth:success');
            }
            
            return { success: true };
        });

        // Добавляем обработчик для получения токенов пользователя
        this.registerHandler('tokens:getUser', async () => {
            console.log('🔑 IPC: Получение токенов пользователя');
            
            try {
                const store = this.appManager.getStore();
                const tokens = store.getTokens();
                const user = store.getUser();
                
                if (tokens && tokens.access_token) {
                    return {
                        success: true,
                        tokens: tokens,
                        user: user
                    };
                } else {
                    return {
                        success: false,
                        error: 'Токены не найдены'
                    };
                }
            } catch (error) {
                console.error('❌ Ошибка получения токенов:', error);
                return {
                    success: false,
                    error: error.message
                };
            }
        });

        console.log('🔐 Обработчики авторизации зарегистрированы');
    }

    // === Инвайт-ключи ===

    registerInviteHandlers() {
        this.registerHandler('invite:get-hwid', async () => {
            return this.appManager.getInvite().getHWID();
        });

        this.registerHandler('invite:check-access', async () => {
            return await this.appManager.getInvite().checkAccess();
        });

        this.registerHandler('invite:validate-key', async (event, inviteCode) => {
            return await this.appManager.validateInviteKey(inviteCode);
        });

        this.registerHandler('invite:get-key-info', async () => {
            return await this.appManager.getInvite().getKeyInfo();
        });

        console.log('🎫 Обработчики инвайт-ключей зарегистрированы');
    }

    // === Серверы ===

    registerServerHandlers() {
        this.registerHandler('server:get-current', async () => {
            const server = this.appManager.getServer().getCurrentServer();
            return {
                success: true,
                server: {
                    mode: server.mode,
                    url: server.url,
                    available: this.appManager.getServer().getServerStatus().available
                }
            };
        });

        this.registerHandler('server:switch', async (event, mode) => {
            console.log(`🔄 IPC: Переключение на ${mode} сервер`);
            
            const result = await this.appManager.switchServer(mode);
            
            // Эмитируем событие для уведомлений и UI
            if (result.success && this.eventBus) {
                const serverName = mode === 'global' ? '🌍 Global' : '🧪 Test';
                
                this.eventBus.emit('server:switched', {
                    mode,
                    serverName,
                    result
                });

                // Показываем уведомление
                if (Notification) {
                    new Notification({
                        title: 'Сервер переключен',
                        body: `Подключен к ${serverName}`,
                        icon: path.join(__dirname, '../../build/icon.png')
                    }).show();
                } else {
                    console.log(`🔔 Уведомление (тестовый режим): Сервер переключен - Подключен к ${serverName}`);
                }
            }
            
            return result;
        });

        this.registerHandler('server:check', async () => {
            return await this.appManager.getServer().checkServerConnection();
        });

        console.log('🌐 Обработчики серверов зарегистрированы');
    }

    // === OCR и настройки областей ===

    registerOcrHandlers() {
        this.registerHandler('ocr:setup', async (event, context = null) => {
            console.log('⚙️ IPC: Запуск настройки OCR областей', context ? `(режим: ${context.mode})` : '(полноэкранный режим)');
            
            // Эмитируем событие для WindowManager с контекстом
            if (this.eventBus) {
                this.eventBus.emit('window:create:setup', context);
            }
            
            return { success: true };
        });

        this.registerHandler('ocr:create-screenshot', async () => {
            console.log('📸 IPC: Создание скриншота для OCR');
            
            if (!this.appManager.getOcr) {
                return {
                    success: false,
                    error: 'OcrManager не подключен'
                };
            }

            return await this.appManager.getOcr().createSetupScreenshot();
        });

        this.registerHandler('ocr:save-regions', async (event, regions) => {
            console.log('💾 IPC: Сохранение OCR областей');
            
            if (!this.appManager.getOcr) {
                // Fallback к старому методу через store + api
                try {
                    this.appManager.getStore().setOcrRegions(regions);
                    
                    const result = await this.appManager.getApi().post('/api/user/me/ocr-regions', regions);
                    
                    // Эмитируем события для UI
                    if (this.eventBus) {
                        this.eventBus.emit('ocr:regions:saved', { regions, result });
                        this.eventBus.emit('window:close:setup');
                    }
                    
                    return { success: result.success };
                } catch (error) {
                    console.error('❌ Ошибка сохранения областей:', error);
                    return {
                        success: false,
                        error: error.message
                    };
                }
            }

            const result = await this.appManager.getOcr().saveRegions(regions);
            
            // Эмитируем события
            if (result.success && this.eventBus) {
                this.eventBus.emit('ocr:regions:saved', { regions, result });
                this.eventBus.emit('window:close:setup');
            }
            
            return result;
        });

        this.registerHandler('ocr:get-regions', async () => {
            console.log('📋 IPC: Получение OCR областей');
            
            if (!this.appManager.getOcr) {
                // Fallback к API
                const result = await this.appManager.getApi().get('/api/user/me/ocr-regions');
                
                if (result.success) {
                    this.appManager.getStore().setOcrRegions(result.data);
                }
                
                return {
                    success: result.success,
                    regions: result.data,
                    error: result.error
                };
            }

            const regions = this.appManager.getOcr().getRegions();
            
            // Попытка загрузить с сервера если локально нет
            if (!regions) {
                const serverResult = await this.appManager.getOcr().loadRegionsFromServer();
                return {
                    success: serverResult.success,
                    regions: serverResult.regions,
                    error: serverResult.error
                };
            }
            
            return {
                success: true,
                regions: regions
            };
        });

        this.registerHandler('ocr:validate-regions', async (event, regions) => {
            console.log('✅ IPC: Валидация OCR областей');
            
            if (!this.appManager.getOcr) {
                return {
                    success: false,
                    error: 'OcrManager не подключен'
                };
            }

            // Временно устанавливаем области для валидации
            const currentRegions = this.appManager.getOcr().getRegions();
            this.appManager.getOcr().regions = regions;
            
            const validation = this.appManager.getOcr().validateRegions();
            
            // Возвращаем старые области
            this.appManager.getOcr().regions = currentRegions;
            
            return {
                success: true,
                validation
            };
        });

        // 🆕 Анализ персональных профилей
        this.registerHandler('ocr:analyze-profile', async (event, profileData) => {
            console.log('🧬 IPC: Анализ персонального профиля триггера');
            
            if (!this.appManager.getOcr) {
                return {
                    success: false,
                    error: 'OcrManager не подключен'
                };
            }

            return await this.appManager.getOcr().analyzePersonalProfile(profileData);
        });

        console.log('👁️ Обработчики OCR зарегистрированы');
    }

    // 🆕 ЭТАП 2.1: === РАБОТА С ОКНАМИ ===
    
    registerWindowHandlers() {
        this.registerHandler('window:get-available', async (event, forceRefresh = false) => {
            console.log('🪟 IPC: Получение списка доступных окон');
            
            try {
                const windows = await this.windowsCache.getAvailableWindows(forceRefresh);
                
                return { 
                    success: true, 
                    windows: windows,
                    stats: this.windowsCache.getStats()
                };
                
            } catch (error) {
                console.error('❌ Ошибка получения списка окон:', error);
                return { 
                    success: false, 
                    error: error.message,
                    windows: []
                };
            }
        });

        this.registerHandler('window:save-selection', async (event, windowInfo) => {
            console.log('💾 IPC: Сохранение выбранного окна:', windowInfo.name);
            
            try {
                if (!this.appManager.getStore) {
                    throw new Error('StoreManager недоступен');
                }
                
                const store = this.appManager.getStore();
                store.set('lastSelectedWindow', {
                    id: windowInfo.id,
                    name: windowInfo.name,
                    executableName: windowInfo.executableName,
                    timestamp: new Date().toISOString()
                });
                
                return { success: true };
                
            } catch (error) {
                console.error('❌ Ошибка сохранения выбранного окна:', error);
                return { 
                    success: false, 
                    error: error.message 
                };
            }
        });

        this.registerHandler('window:get-last-selected', async () => {
            console.log('📋 IPC: Получение последнего выбранного окна');
            
            try {
                if (!this.appManager.getStore) {
                    throw new Error('StoreManager недоступен');
                }
                
                const store = this.appManager.getStore();
                const lastWindow = store.get('lastSelectedWindow', null);
                
                // Проверяем свежесть данных (не старше 1 часа)
                if (lastWindow && lastWindow.timestamp) {
                    const age = Date.now() - new Date(lastWindow.timestamp).getTime();
                    if (age > 3600000) { // 1 час
                        return { success: true, window: null };
                    }
                }
                
                return { 
                    success: true, 
                    window: lastWindow 
                };
                
            } catch (error) {
                console.error('❌ Ошибка получения последнего окна:', error);
                return { 
                    success: false, 
                    error: error.message,
                    window: null
                };
            }
        });

        this.registerHandler('window:clear-cache', async () => {
            console.log('🗑️ IPC: Очистка кэша окон');
            
            try {
                this.windowsCache.clearCache();
                return { success: true };
                
            } catch (error) {
                console.error('❌ Ошибка очистки кэша окон:', error);
                return { 
                    success: false, 
                    error: error.message 
                };
            }
        });

        this.registerHandler('window:capture-screenshot', async (event, windowInfo) => {
            console.log('📸 IPC: Захват скриншота окна:', windowInfo.name);
            
            try {
                // Используем метод из SetupWindow для захвата скриншота окна
                if (!this.windowManager || !this.windowManager.getSetupWindow) {
                    throw new Error('WindowManager или SetupWindow недоступен');
                }
                
                const setupWindow = this.windowManager.getSetupWindow();
                const screenshot = await setupWindow.captureWindowScreenshot(windowInfo);
                
                if (!screenshot) {
                    throw new Error('Не удалось захватить скриншот окна');
                }
                
                return {
                    success: true,
                    screenshot: screenshot.dataURL,
                    bounds: screenshot.bounds,
                    windowName: screenshot.windowName
                };
                
            } catch (error) {
                console.error('❌ Ошибка захвата скриншота окна:', error);
                return { 
                    success: false, 
                    error: error.message 
                };
            }
        });

        this.registerHandler('window:validate-existence', async (event, windowName) => {
            console.log('✅ IPC: Проверка существования окна:', windowName);
            
            try {
                const windows = await this.windowsCache.getAvailableWindows();
                const exists = windows.some(window => 
                    window.name === windowName || 
                    window.name.includes(windowName)
                );
                
                return { 
                    success: true, 
                    exists: exists 
                };
                
            } catch (error) {
                console.error('❌ Ошибка проверки существования окна:', error);
                return { 
                    success: false, 
                    error: error.message,
                    exists: false
                };
            }
        });

        // === 🆕 ЭТАП 2.2 + 2.3: IPC Обработчики для профилей окон ===

        this.registerHandler('window:save-profile', async (event, executableName, profile) => {
            console.log('💾 IPC: Сохранение профиля окна для:', executableName);
            
            try {
                if (!this.appManager.getStore) {
                    throw new Error('StoreManager недоступен');
                }
                
                const store = this.appManager.getStore();
                store.setWindowProfile(executableName, profile);

                const mainWindow = this.windowManager?.getWindow?.('main');
                if (mainWindow?.webContents) {
                    mainWindow.webContents.send('window-profile-updated', { executableName });
                }
                 
                return { success: true };
                
            } catch (error) {
                console.error('❌ Ошибка сохранения профиля окна:', error);
                return { 
                    success: false, 
                    error: error.message 
                };
            }
        });

        this.registerHandler('window:get-profile', async (event, executableName) => {
            console.log('📋 IPC: Получение профиля окна для:', executableName);
            
            try {
                if (!this.appManager.getStore) {
                    throw new Error('StoreManager недоступен');
                }
                
                const store = this.appManager.getStore();
                const profile = store.getWindowProfile(executableName);
                
                return { 
                    success: true, 
                    profile: profile 
                };
                
            } catch (error) {
                console.error('❌ Ошибка получения профиля окна:', error);
                return { 
                    success: false, 
                    error: error.message,
                    profile: null
                };
            }
        });

        this.registerHandler('window:get-all-profiles', async () => {
            console.log('📂 IPC: Получение всех профилей окон');
            
            try {
                if (!this.appManager.getStore) {
                    throw new Error('StoreManager недоступен');
                }
                
                const store = this.appManager.getStore();
                const profiles = store.getWindowProfiles();
                const executables = store.getWindowProfileExecutables();
                
                return { 
                    success: true, 
                    profiles: profiles,
                    executables: executables 
                };
                
            } catch (error) {
                console.error('❌ Ошибка получения профилей окон:', error);
                return { 
                    success: false, 
                    error: error.message,
                    profiles: {},
                    executables: []
                };
            }
        });

        this.registerHandler('window:delete-profile', async (event, executableName) => {
            console.log('🗑️ IPC: Удаление профиля окна для:', executableName);
            
            try {
                if (!this.appManager.getStore) {
                    throw new Error('StoreManager недоступен');
                }
                
                const store = this.appManager.getStore();
                store.deleteWindowProfile(executableName);
                
                return { success: true };
                
            } catch (error) {
                console.error('❌ Ошибка удаления профиля окна:', error);
                return { 
                    success: false, 
                    error: error.message 
                };
            }
        });

        this.registerHandler('window:cleanup-old-profiles', async () => {
            console.log('🧹 IPC: Очистка старых профилей окон');
            
            try {
                if (!this.appManager.getStore) {
                    throw new Error('StoreManager недоступен');
                }
                
                const store = this.appManager.getStore();
                store.cleanupOldWindowProfiles();
                
                return { success: true };
                
            } catch (error) {
                console.error('❌ Ошибка очистки профилей окон:', error);
                return { 
                    success: false, 
                    error: error.message 
                };
            }
        });
        
        console.log('🪟 Window обработчики зарегистрированы');
    }

    // === Мониторинг ===

    registerMonitorHandlers() {
        this.registerHandler('monitor:start', async () => {
            console.log('▶️ IPC: Запуск мониторинга');
            
            if (!this.appManager.startMonitoring) {
                return { success: false, error: 'MonitorManager не подключен' };
            }
            
            return await this.appManager.startMonitoring();
        });

        this.registerHandler('monitor:stop', async () => {
            console.log('⏹️ IPC: Остановка мониторинга');
            
            if (!this.appManager.stopMonitoring) {
                return { success: false, error: 'MonitorManager не подключен' };
            }
            
            return await this.appManager.stopMonitoring();
        });

        this.registerHandler('monitor:restart', async (event, reason) => {
            console.log('🔄 IPC: Перезапуск мониторинга');
            
            if (!this.appManager.restartMonitoring) {
                return { success: false, error: 'MonitorManager не подключен' };
            }
            
            return await this.appManager.restartMonitoring(reason);
        });

        this.registerHandler('monitor:get-status', async () => {
            console.log('📊 IPC: Получение статуса мониторинга');
            
            if (!this.appManager.getMonitorStatus) {
                return { success: false, error: 'MonitorManager не подключен' };
            }
            
            const status = this.appManager.getMonitorStatus();
            return { success: true, status };
        });

        this.registerHandler('streamer:get-result-config', async () => {
            console.log('📍 IPC: Получение конфигурации result-зон стримера');

            try {
                const api = this.appManager.getApi();
                const store = this.appManager.getStore();
                const response = await api.get('/api/streamer/result-config');

                if (response.success && response.data?.success) {
                    const config = {
                        result_trigger_area: response.data.trigger_area || null,
                        result_data_area: response.data.data_area || null
                    };
                    store.setStreamerPredictionConfig(config);

                    return {
                        success: true,
                        config
                    };
                }

                return {
                    success: false,
                    error: response.error || response.userMessage || 'Не удалось получить конфигурацию result-зон',
                    config: store.getStreamerPredictionConfig()
                };
            } catch (error) {
                console.error('❌ Ошибка получения конфигурации result-зон:', error);
                return {
                    success: false,
                    error: error.message,
                    config: this.appManager.getStore().getStreamerPredictionConfig()
                };
            }
        });

        this.registerHandler('streamer:save-result-trigger-area', async (event, area) => {
            console.log('💾 IPC: Сохранение trigger-area результата стримера');

            try {
                const api = this.appManager.getApi();
                const store = this.appManager.getStore();
                const response = await api.post('/api/streamer/result-trigger-area', area);

                if (!response.success || !response.data?.success) {
                    return {
                        success: false,
                        error: response.error || response.userMessage || 'Не удалось сохранить trigger-area результата'
                    };
                }

                const savedArea = response.data.area_data || area;
                store.setStreamerResultTriggerArea(savedArea);

                return {
                    success: true,
                    area: savedArea
                };
            } catch (error) {
                console.error('❌ Ошибка сохранения trigger-area результата:', error);
                return {
                    success: false,
                    error: error.message
                };
            }
        });

        this.registerHandler('streamer:save-result-data-area', async (event, area) => {
            console.log('💾 IPC: Сохранение data-area результата стримера');

            try {
                const api = this.appManager.getApi();
                const store = this.appManager.getStore();
                const response = await api.post('/api/streamer/result-data-area', area);

                if (!response.success || !response.data?.success) {
                    return {
                        success: false,
                        error: response.error || response.userMessage || 'Не удалось сохранить data-area результата'
                    };
                }

                const savedArea = response.data.area_data || area;
                store.setStreamerResultDataArea(savedArea);

                return {
                    success: true,
                    area: savedArea
                };
            } catch (error) {
                console.error('❌ Ошибка сохранения data-area результата:', error);
                return {
                    success: false,
                    error: error.message
                };
            }
        });

        // 🆕 ЭТАП 2.1: Обработчики для управления целью захвата
        this.registerHandler('monitor:set-window-target', async (event, windowInfo) => {
            console.log('🪟 IPC: Установка окна для захвата:', windowInfo.name);
            
            if (!this.appManager.setWindowTarget) {
                return { success: false, error: 'MonitorManager не поддерживает выбор окна' };
            }
            
            return await this.appManager.setWindowTarget(windowInfo);
        });

        this.registerHandler('monitor:set-screen-target', async () => {
            console.log('🖥️ IPC: Переключение на захват экрана');
            
            if (!this.appManager.setScreenTarget) {
                return { success: false, error: 'MonitorManager не поддерживает выбор экрана' };
            }
            
            return await this.appManager.setScreenTarget();
        });

        this.registerHandler('monitor:get-capture-target', async () => {
            console.log('🎯 IPC: Получение текущей цели захвата');
            
            if (!this.appManager.getCurrentCaptureTarget) {
                return { success: false, error: 'MonitorManager не поддерживает запрос цели' };
            }
            
            const target = this.appManager.getCurrentCaptureTarget();
            return { success: true, target };
        });

        console.log('🔍 Обработчики мониторинга зарегистрированы');
    }

    // === Виджет ===

    registerWidgetHandlers() {
        this.registerHandler('widget:toggle', async (event, playerData) => {
            console.log('🪟 IPC: Переключение виджета');
            
            // Эмитируем событие для WindowManager
            if (this.eventBus) {
                this.eventBus.emit('widget:toggle', { playerData });
            }
            
            return { success: true };
        });

        this.registerHandler('widget:close', async () => {
            console.log('🪟 IPC: Закрытие виджета');
            
            // Эмитируем событие для WindowManager
            if (this.eventBus) {
                this.eventBus.emit('widget:close');
            }
            
            return { success: true };
        });

        this.registerHandler('widget:update-data', async (event, playerData) => {
            console.log('🔄 IPC: Обновление данных виджета');
            
            // Эмитируем событие для WindowManager
            if (this.eventBus) {
                this.eventBus.emit('widget:update', { playerData });
            }
            
            return { success: true };
        });

        this.registerHandler('widget:setAlwaysOnTop', async (event, flag) => {
            console.log(`📌 IPC: Установка виджета поверх всех окон: ${flag}`);
            
            try {
                // Получаем окно виджета через WindowManager
                if (!this.windowManager || !this.windowManager.getWindow) {
                    throw new Error('WindowManager недоступен');
                }
                
                const widgetWindow = this.windowManager.getWindow('widget');
                if (!widgetWindow) {
                    throw new Error('Окно виджета не найдено');
                }
                
                widgetWindow.setAlwaysOnTop(!!flag, flag ? 'floating' : 'normal');

                if (this.appManager?.getStore?.()) {
                    this.appManager.getStore().setWidgetState({ alwaysOnTop: !!flag });
                }

                console.log(flag
                    ? '✅ Виджет закреплен поверх окон'
                    : '✅ Виджет откреплен от переднего плана');
                
                return { success: true, alwaysOnTop: flag };
            } catch (error) {
                console.error('❌ Ошибка установки AlwaysOnTop:', error);
                return { success: false, error: error.message };
            }
        });

        this.registerHandler('widget:resize', async (event, width, height) => {
            console.log(`📏 IPC: Изменение размера виджета: ${width}x${height}`);
            
            try {
                // Получаем окно виджета через WindowManager
                if (!this.windowManager || !this.windowManager.getWindow) {
                    throw new Error('WindowManager недоступен');
                }
                
                const widgetWindow = this.windowManager.getWindow('widget');
                if (!widgetWindow) {
                    throw new Error('Окно виджета не найдено');
                }
                
                widgetWindow.setSize(width, height);

                if (this.appManager?.getStore?.()) {
                    this.appManager.getStore().setWidgetState({
                        bounds: widgetWindow.getBounds()
                    });
                }
                
                return { success: true };
            } catch (error) {
                console.error('❌ Ошибка изменения размера виджета:', error);
                return { success: false, error: error.message };
            }
        });

        this.registerHandler('widget:move', async (event, deltaX, deltaY) => {
            // Убрано избыточное логирование для плавности перемещения
            
            try {
                // Получаем окно виджета через WindowManager
                if (!this.windowManager || !this.windowManager.getWindow) {
                    throw new Error('WindowManager недоступен');
                }
                
                const widgetWindow = this.windowManager.getWindow('widget');
                if (!widgetWindow) {
                    throw new Error('Окно виджета не найдено');
                }
                
                // Получаем текущую позицию и вычисляем новую
                const bounds = widgetWindow.getBounds();
                const newX = bounds.x + deltaX;
                const newY = bounds.y + deltaY;
                
                // Устанавливаем новую позицию
                widgetWindow.setPosition(newX, newY);
                
                return { success: true };
            } catch (error) {
                console.error('❌ Ошибка перемещения виджета:', error);
                return { success: false, error: error.message };
            }
        });

        this.registerHandler('widget:get-state', async () => {
            try {
                const store = this.appManager?.getStore?.();
                if (!store) {
                    throw new Error('StoreManager недоступен');
                }

                return {
                    success: true,
                    state: store.getWidgetState()
                };
            } catch (error) {
                return { success: false, error: error.message, state: null };
            }
        });

        this.registerHandler('widget:save-state', async (event, state) => {
            try {
                const store = this.appManager?.getStore?.();
                if (!store) {
                    throw new Error('StoreManager недоступен');
                }

                store.setWidgetState(state || {});
                return { success: true };
            } catch (error) {
                return { success: false, error: error.message };
            }
        });

        console.log('🪟 Обработчики виджета зарегистрированы');
    }

    // === Обновления ===

    registerUpdateHandlers() {
        this.registerHandler('update:check-simple', async () => {
            console.log('🔍 IPC: Проверка обновлений');
            return await this.appManager.checkForUpdates();
        });

        this.registerHandler('update:download', async (event, downloadType = 'installer') => {
            console.log(`📥 IPC: Скачивание обновления (${downloadType})`);
            
            // Устанавливаем callback прогресса через EventBus
            this.appManager.getUpdate().setProgressCallback((progress) => {
                if (this.eventBus) {
                    this.eventBus.emit('update:download:progress', { progress });
                }
            });
            
            return await this.appManager.downloadUpdate(downloadType);
        });

        this.registerHandler('update:install', async (event, filePath) => {
            console.log('🛠️ IPC: Установка обновления');
            return await this.appManager.installUpdate(filePath);
        });

        this.registerHandler('update:open-downloads', async () => {
            return await this.appManager.getUpdate().openDownloadsFolder();
        });

        this.registerHandler('update:open-release', async (event, url) => {
            return await this.appManager.getUpdate().openReleasePage(url);
        });

        console.log('🔄 Обработчики обновлений зарегистрированы');
    }

    // === Настройки ===

    registerSettingsHandlers() {
        this.registerHandler('settings:save-search-mode', async (event, mode) => {
            try {
                console.log(`💾 IPC: Изменение режима поиска на ${mode} с перезапуском мониторинга`);
                
                // Используем MonitorManager для правильного обновления режима
                if (this.appManager.updateSearchMode) {
                    return await this.appManager.updateSearchMode(mode);
                } else {
                    // Fallback к старому способу
                    this.appManager.getStore().setSearchMode(mode);
                    
                    if (this.eventBus) {
                        this.eventBus.emit('settings:search-mode:changed', { mode });
                    }
                    
                    return { success: true };
                }
            } catch (error) {
                console.error('❌ Ошибка смены режима поиска:', error);
                return { success: false, error: error.message };
            }
        });

        this.registerHandler('settings:get-search-mode', async () => {
            try {
                const mode = this.appManager.getStore().getSearchMode();
                return { success: true, mode };
            } catch (error) {
                return { success: false, error: error.message };
            }
        });

        this.registerHandler('settings:save-server-mode', async (event, mode) => {
            try {
                this.appManager.getStore().setServerMode(mode);
                console.log(`💾 IPC: Режим сервера изменен на ${mode}`);
                
                if (this.eventBus) {
                    this.eventBus.emit('settings:server-mode:changed', { mode });
                }
                
                return { success: true };
            } catch (error) {
                return { success: false, error: error.message };
            }
        });

        this.registerHandler('settings:export', async () => {
            console.log('📤 IPC: Экспорт настроек');
            
            const settings = {
                searchMode: this.appManager.getStore().getSearchMode(),
                deckMode: this.appManager.getStore().getDeckMode(),
                serverMode: this.appManager.getStore().getServerMode(),
                ocrRegions: this.appManager.getStore().getOcrRegions(),
                timestamp: new Date().toISOString()
            };
            
            return {
                success: true,
                settings
            };
        });

        this.registerHandler('settings:import', async (event, settings) => {
            console.log('📥 IPC: Импорт настроек');
            
            try {
                if (settings.searchMode) {
                    this.appManager.getStore().setSearchMode(settings.searchMode);
                }

                if (settings.deckMode) {
                    this.appManager.getStore().setDeckMode(settings.deckMode);
                }
                
                if (settings.serverMode) {
                    this.appManager.getStore().setServerMode(settings.serverMode);
                }
                
                if (settings.ocrRegions) {
                    this.appManager.getStore().setOcrRegions(settings.ocrRegions);
                }
                
                if (this.eventBus) {
                    this.eventBus.emit('settings:imported', { settings });
                }
                
                return { success: true };
            } catch (error) {
                return { success: false, error: error.message };
            }
        });

        // === 🎯 Обработчики для прямой работы с хранилищем (для расширенных настроек) ===
        
        this.registerHandler('store:get', async (event, key, defaultValue) => {
            try {
                const store = this.appManager.getStore();
                const result = store.get(key, defaultValue);
                console.log(`📥 IPC[store:get]: ${key} =`, result);
                return result;
            } catch (error) {
                console.error(`❌ Ошибка получения ${key}:`, error);
                return defaultValue;
            }
        });

        this.registerHandler('store:set', async (event, key, value) => {
            try {
                const store = this.appManager.getStore();
                store.set(key, value);
                console.log(`💾 IPC[store:set]: ${key} =`, value);
                return { success: true };
            } catch (error) {
                console.error(`❌ Ошибка сохранения ${key}:`, error);
                throw error; // Пробрасываем ошибку в frontend
            }
        });

        this.registerHandler('store:has', async (event, key) => {
            try {
                const store = this.appManager.getStore();
                const result = store.has(key);
                console.log(`🔍 IPC[store:has]: ${key} =`, result);
                return result;
            } catch (error) {
                console.error(`❌ Ошибка проверки ${key}:`, error);
                return false;
            }
        });

        this.registerHandler('store:delete', async (event, key) => {
            try {
                const store = this.appManager.getStore();
                store.delete(key);
                console.log(`🗑️ IPC[store:delete]: ${key}`);
                return { success: true };
            } catch (error) {
                console.error(`❌ Ошибка удаления ${key}:`, error);
                throw error;
            }
        });

        console.log('⚙️ Обработчики настроек зарегистрированы');
    }

    registerHotkeyHandlers() {
        this.registerHandler('hotkeys:get-all', async () => {
            try {
                const hotkeys = this.appManager.getHotkeys();
                if (!hotkeys) {
                    return { success: false, error: 'HotkeyManager не инициализирован', profiles: [] };
                }

                return hotkeys.getProfilesWithStates();
            } catch (error) {
                return { success: false, error: error.message, profiles: [] };
            }
        });

        this.registerHandler('hotkeys:save-all', async (event, profiles) => {
            try {
                const hotkeys = this.appManager.getHotkeys();
                if (!hotkeys) {
                    return { success: false, error: 'HotkeyManager не инициализирован', profiles: [] };
                }

                return await hotkeys.saveProfiles(profiles);
            } catch (error) {
                return { success: false, error: error.message, profiles: [] };
            }
        });

        this.registerHandler('hotkeys:test-run', async (event, profile) => {
            try {
                const hotkeys = this.appManager.getHotkeys();
                if (!hotkeys) {
                    return { success: false, error: 'HotkeyManager не инициализирован' };
                }

                const result = await hotkeys.testProfile(profile);
                return {
                    success: true,
                    found: result.found,
                    playerData: result.playerData
                };
            } catch (error) {
                return { success: false, error: error.message };
            }
        });

        this.registerHandler('hotkeys:refresh-registration', async () => {
            try {
                const hotkeys = this.appManager.getHotkeys();
                if (!hotkeys) {
                    return { success: false, error: 'HotkeyManager не инициализирован', profiles: [] };
                }

                return await hotkeys.refreshRegistrations();
            } catch (error) {
                return { success: false, error: error.message, profiles: [] };
            }
        });

        console.log('⌨️ Обработчики hotkeys зарегистрированы');
    }

    // === Кеш изображений карт ===

    registerCacheHandlers() {
        this.registerHandler('cache:get-card-image', async (event, cardName, level) => {
            console.log(`🎴 IPC: Получение пути к изображению карты: ${cardName}, level: ${level}`);

            try {
                const imageCache = this.appManager.modules.imageCache;

                if (!imageCache) {
                    console.warn('⚠️ ImageCacheManager не инициализирован');
                    return null;
                }

                const imagePath = imageCache.getCardImagePath(cardName, level);
                return imagePath;

            } catch (error) {
                console.error('❌ Ошибка получения пути к изображению карты:', error);
                return null;
            }
        });

        this.registerHandler('cache:force-update', async () => {
            console.log('🔄 IPC: Принудительное обновление кеша карт');

            try {
                const imageCache = this.appManager.modules.imageCache;

                if (!imageCache) {
                    return {
                        success: false,
                        error: 'ImageCacheManager не инициализирован'
                    };
                }

                const result = await imageCache.checkAndUpdate(true);
                return result;

            } catch (error) {
                console.error('❌ Ошибка принудительного обновления кеша:', error);
                return {
                    success: false,
                    error: error.message
                };
            }
        });

        this.registerHandler('cache:get-status', async () => {
            console.log('📊 IPC: Получение статуса кеша карт');

            try {
                const imageCache = this.appManager.modules.imageCache;

                if (!imageCache) {
                    return { initialized: false };
                }

                return imageCache.getCacheStatus();

            } catch (error) {
                console.error('❌ Ошибка получения статуса кеша:', error);
                return { error: error.message };
            }
        });

        console.log('🎴 Обработчики кеша изображений зарегистрированы');
    }

    // === Общие обработчики приложения ===

    registerAppHandlers() {
        this.registerHandler('app:get-version', () => {
            const { app } = require('electron');
            try {
                return app.getVersion();
            } catch (error) {
                // Fallback для тестового режима
                return '1.0.0-test';
            }
        });

        this.registerHandler('app:get-state', async () => {
            return this.appManager.getAppState();
        });

        this.registerHandler('app:restart', async () => {
            console.log('🔄 IPC: Перезапуск приложения');
            
            if (this.eventBus) {
                this.eventBus.emit('app:restart:requested');
            }
            
            const { app } = require('electron');
            app.relaunch();
            app.exit();
            
            return { success: true };
        });

        this.registerHandler('app:minimize-to-tray', async () => {
            console.log('📦 IPC: Свернуть в трей');
            
            if (this.eventBus) {
                this.eventBus.emit('app:minimize:tray');
            }
            
            return { success: true };
        });

        this.registerHandler('app:show-notification', async (event, { title, body, icon }) => {
            console.log('🔔 IPC: Показать уведомление');
            
            try {
                if (Notification) {
                    new Notification({
                        title,
                        body,
                        icon: icon || path.join(__dirname, '../../build/icon.png')
                    }).show();
                } else {
                    console.log(`🔔 Уведомление (тестовый режим): ${title} - ${body}`);
                }
                
                return { success: true };
            } catch (error) {
                return { success: false, error: error.message };
            }
        });

        console.log('📱 Общие обработчики приложения зарегистрированы');
    }

    // === 🆕 ЭТАП 2.1: Настройка EventBus обработчиков ===

    setupEventBusHandlers() {
        if (!this.eventBus) {
            console.log('⚠️ EventBus недоступен, пропускаем настройку обработчиков');
            return;
        }

        // Обработчик запроса валидации окна от MonitorManager
        this.eventBus.on('window:validate:request', async ({ windowInfo, callback }) => {
            try {
                console.log('🔍 EventBus: Запрос валидации окна:', windowInfo.name);
                
                const windows = await this.windowsCache.getAvailableWindows();
                const exists = windows.some(window => 
                    window.id === windowInfo.id ||
                    window.name === windowInfo.name ||
                    (windowInfo.executableName && window.executableName === windowInfo.executableName)
                );
                
                console.log(`🔍 Валидация окна "${windowInfo.name}": ${exists ? 'существует' : 'не найдено'}`);
                
                if (callback) {
                    callback(exists);
                }
                
            } catch (error) {
                console.error('❌ Ошибка валидации окна:', error);
                if (callback) {
                    callback(false);
                }
            }
        });
        
        console.log('🔗 EventBus обработчики настроены');
    }

    // === Вспомогательные методы ===

    registerHandler(channel, handler) {
        if (this.handlers.has(channel)) {
            console.warn(`⚠️ Обработчик для канала "${channel}" уже зарегистрирован`);
            return;
        }

        // В тестовом режиме просто сохраняем обработчик
        if (!ipcMain) {
            this.handlers.set(channel, handler);
            console.log(`📡 Зарегистрирован IPC обработчик (тестовый режим): ${channel}`);
            return;
        }

        // Оборачиваем обработчик для логирования и обработки ошибок
        const wrappedHandler = async (...args) => {
            const startTime = Date.now();
            
            try {
                const result = await handler(...args);
                const duration = Date.now() - startTime;
                
                console.log(`✅ IPC[${channel}] выполнен за ${duration}мс`);
                return result;
            } catch (error) {
                const duration = Date.now() - startTime;
                console.error(`❌ IPC[${channel}] ошибка за ${duration}мс:`, error);
                
                return {
                    success: false,
                    error: error.message,
                    stack: error.stack
                };
            }
        };

        ipcMain.handle(channel, wrappedHandler);
        this.handlers.set(channel, handler);
        
        console.log(`📡 Зарегистрирован IPC обработчик: ${channel}`);
    }

    // === Удаление обработчика ===

    removeHandler(channel) {
        if (!this.handlers.has(channel)) {
            console.warn(`⚠️ Обработчик для канала "${channel}" не найден`);
            return false;
        }

        // В Electron режиме удаляем обработчик
        if (ipcMain) {
            ipcMain.removeHandler(channel);
        }
        
        this.handlers.delete(channel);
        
        console.log(`🗑️ Удален IPC обработчик: ${channel}`);
        return true;
    }

    // === Удаление всех обработчиков ===

    removeAllHandlers() {
        console.log('🧹 Удаление всех IPC обработчиков...');
        
        // В Electron режиме удаляем все обработчики
        if (ipcMain) {
            for (const channel of this.handlers.keys()) {
                ipcMain.removeHandler(channel);
            }
        }
        
        const count = this.handlers.size;
        this.handlers.clear();
        
        console.log(`✅ Удалено ${count} IPC обработчиков`);
    }

    // === Получение статуса ===

    getStatus() {
        return {
            initialized: this.isInitialized,
            handlersCount: this.handlers.size,
            hasAppManager: !!this.appManager,
            hasWindowManager: !!this.windowManager,
            hasEventBus: !!this.eventBus
        };
    }

    // === Получение списка обработчиков ===

    getHandlersList() {
        return Array.from(this.handlers.keys()).sort();
    }

    // === Получение статистики ===

    getStats() {
        const stats = {
            totalHandlers: this.handlers.size,
            categories: {}
        };

        // Группируем по категориям
        for (const channel of this.handlers.keys()) {
            const category = channel.split(':')[0];
            if (!stats.categories[category]) {
                stats.categories[category] = 0;
            }
            stats.categories[category]++;
        }

        return stats;
    }

    // === Отладочная информация ===

    getDebugInfo() {
        return {
            status: this.getStatus(),
            handlers: this.getHandlersList(),
            stats: this.getStats(),
            dependencies: {
                appManager: !!this.appManager,
                windowManager: !!this.windowManager,
                eventBus: !!this.eventBus
            }
        };
    }

    // === Очистка ресурсов ===

    cleanup() {
        console.log('🧹 Очистка IpcManager...');
        
        this.removeAllHandlers();
        this.isInitialized = false;
        
        console.log('✅ IpcManager очищен');
    }
}

module.exports = IpcManager;
