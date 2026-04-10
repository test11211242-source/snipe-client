const { BrowserWindow } = require('electron');
const path = require('path');

/**
 * WindowManager - Базовый класс для управления окнами Electron
 * Предоставляет общую функциональность для всех типов окон
 */
class WindowManager {
    constructor(appManager = null, eventBus = null) {
        this.appManager = appManager;
        this.eventBus = eventBus;
        this.windows = new Map(); // Хранилище всех окон
        
        console.log('🪟 WindowManager инициализирован');
    }

    // === Установка зависимостей ===
    
    setAppManager(appManager) {
        this.appManager = appManager;
        console.log('🔗 AppManager подключен к WindowManager');
    }

    setEventBus(eventBus) {
        this.eventBus = eventBus;
        console.log('🔗 EventBus подключен к WindowManager');
        
        // Подписываемся на события для управления окнами
        this.setupEventListeners();
    }

    // === Настройка обработчиков событий ===
    
    setupEventListeners() {
        if (!this.eventBus) return;

        // События для создания окон
        this.eventBus.on('window:create:auth', () => this.createAuthWindow());
        this.eventBus.on('window:create:main', () => this.createMainWindow());
        this.eventBus.on('window:create:setup', (context) => this.createSetupWindow(context));
        this.eventBus.on('widget:toggle', (data) => this.toggleWidget(data.playerData));
        
        // События для закрытия окон
        this.eventBus.on('window:close:auth', () => this.closeWindow('auth'));
        this.eventBus.on('window:close:main', () => this.closeWindow('main'));
        this.eventBus.on('window:close:setup', () => this.closeWindow('setup'));
        this.eventBus.on('widget:close', () => this.closeWindow('widget'));

        console.log('📡 WindowManager подписан на события');
    }

    // === Базовые методы для работы с окнами ===

    /**
     * Создает базовое окно с общими настройками
     */
    createBaseWindow(windowId, config, htmlFile) {
        // Проверяем, что окно уже не существует
        if (this.windows.has(windowId)) {
            console.warn(`⚠️ Окно "${windowId}" уже существует`);
            this.focusWindow(windowId);
            return this.windows.get(windowId);
        }

        // Создаем окно с базовой конфигурацией
        const window = new BrowserWindow({
            ...config,
            icon: path.join(__dirname, '../../build/icon.png'),
            webPreferences: {
                preload: path.join(__dirname, '../../preload.js'),
                nodeIntegration: false,
                contextIsolation: true,
                ...config.webPreferences
            }
        });

        // Загружаем HTML файл
        window.loadFile(path.join(__dirname, `../../renderer/${htmlFile}`));

        // Добавляем в хранилище
        this.windows.set(windowId, window);

        // Настраиваем обработчики событий окна
        this.setupWindowHandlers(windowId, window);

        console.log(`🪟 Создано окно "${windowId}"`);
        return window;
    }

    /**
     * Настраивает обработчики событий для окна
     */
    setupWindowHandlers(windowId, window) {
        window.on('closed', () => {
            console.log(`🔒 Окно "${windowId}" закрыто`);
            this.windows.delete(windowId);
            
            // Эмитируем событие закрытия
            if (this.eventBus) {
                this.eventBus.emit(`window:closed:${windowId}`);
            }
            
            // Специальная логика для критических окон
            this.handleWindowClosed(windowId);
        });

        window.on('ready-to-show', () => {
            console.log(`✅ Окно "${windowId}" готово к показу`);
            
            if (this.eventBus) {
                this.eventBus.emit(`window:ready:${windowId}`);
            }
        });

        window.webContents.on('did-finish-load', () => {
            console.log(`📄 Контент окна "${windowId}" загружен`);
            
            if (this.eventBus) {
                this.eventBus.emit(`window:loaded:${windowId}`, { window });
            }
        });
    }

    /**
     * Обработка закрытия критических окон
     */
    handleWindowClosed(windowId) {
        if (windowId === 'main') {
            // Если закрыто главное окно - выходим из приложения
            const { app } = require('electron');
            app.quit();
        } else if (windowId === 'auth' && !this.isAuthenticated()) {
            // Если закрыто окно авторизации без входа - выходим
            const { app } = require('electron');
            app.quit();
        }
    }

    // === Методы для создания конкретных окон (будут переопределены в наследниках) ===

    createAuthWindow() {
        throw new Error('createAuthWindow() должен быть реализован в наследнике');
    }

    createMainWindow() {
        throw new Error('createMainWindow() должен быть реализован в наследнике');
    }

    createSetupWindow() {
        throw new Error('createSetupWindow() должен быть реализован в наследнике');
    }

    createWidget(playerData) {
        throw new Error('createWidget() должен быть реализован в наследнике');
    }

    // === Управление окнами ===

    /**
     * Получает окно по ID
     */
    getWindow(windowId) {
        return this.windows.get(windowId);
    }

    /**
     * Проверяет существование окна
     */
    hasWindow(windowId) {
        return this.windows.has(windowId);
    }

    /**
     * Фокусирует окно
     */
    focusWindow(windowId) {
        const window = this.windows.get(windowId);
        if (window) {
            window.show();
            window.focus();
            console.log(`👀 Окно "${windowId}" получило фокус`);
            return true;
        }
        return false;
    }

    /**
     * Закрывает окно
     */
    closeWindow(windowId) {
        const window = this.windows.get(windowId);
        if (window) {
            window.close();
            console.log(`🔒 Закрыто окно "${windowId}"`);
            return true;
        }
        return false;
    }

    /**
     * Переключает видимость виджета
     */
    toggleWidget(playerData) {
        if (this.hasWindow('widget')) {
            if (playerData) {
                this.createWidget(playerData);
            } else {
                this.closeWindow('widget');
            }
        } else {
            this.createWidget(playerData);
        }
    }

    /**
     * Отправляет данные в окно
     */
    sendToWindow(windowId, channel, data) {
        const window = this.windows.get(windowId);
        if (window && window.webContents) {
            window.webContents.send(channel, data);
            console.log(`📤 Отправлены данные в окно "${windowId}" по каналу "${channel}"`);
            return true;
        }
        return false;
    }

    // === Вспомогательные методы ===

    /**
     * Проверяет авторизацию пользователя
     */
    isAuthenticated() {
        return this.appManager?.isAuthenticated() || false;
    }

    /**
     * Получает конфигурацию окна
     */
    getWindowConfig(windowType) {
        return this.appManager?.getConfig()?.getWindowConfig(windowType) || {};
    }

    /**
     * Получает размеры экрана
     */
    getScreenSize() {
        try {
            const { screen } = require('electron');
            const display = screen.getPrimaryDisplay();
            return display.workAreaSize;
        } catch (error) {
            // Fallback для тестового режима
            return { width: 1920, height: 1080 };
        }
    }

    // === Получение информации ===

    /**
     * Получает список всех окон
     */
    getAllWindows() {
        return Array.from(this.windows.keys());
    }

    /**
     * Получает количество открытых окон
     */
    getWindowCount() {
        return this.windows.size;
    }

    /**
     * Получает статус WindowManager
     */
    getStatus() {
        return {
            initialized: true,
            hasAppManager: !!this.appManager,
            hasEventBus: !!this.eventBus,
            windowCount: this.windows.size,
            openWindows: this.getAllWindows()
        };
    }

    /**
     * Получает отладочную информацию
     */
    getDebugInfo() {
        const windowsInfo = {};
        
        this.windows.forEach((window, id) => {
            windowsInfo[id] = {
                isVisible: window.isVisible(),
                isFocused: window.isFocused(),
                isMinimized: window.isMinimized(),
                bounds: window.getBounds()
            };
        });

        return {
            status: this.getStatus(),
            windows: windowsInfo,
            eventListeners: !!this.eventBus
        };
    }

    // === Очистка ресурсов ===

    cleanup() {
        console.log('🧹 Очистка WindowManager...');
        
        // Закрываем все окна
        for (const [windowId, window] of this.windows) {
            try {
                if (!window.isDestroyed()) {
                    window.close();
                }
            } catch (error) {
                console.error(`❌ Ошибка закрытия окна "${windowId}":`, error);
            }
        }
        
        this.windows.clear();
        
        console.log('✅ WindowManager очищен');
    }
}

module.exports = WindowManager;
