const WindowManager = require('./WindowManager');

/**
 * MainWindow - Управление главным окном приложения
 * Перенесите сюда функцию createMainWindow() из main_new.js
 */
class MainWindow extends WindowManager {
    constructor(appManager = null, eventBus = null) {
        super(appManager, eventBus);
        console.log('🏠 MainWindow инициализирован');
    }

    /**
     * Создает главное окно приложения
     * РЕАЛЬНАЯ ФУНКЦИЯ ИЗ main.js:631-679 (НЕ из main_new.js!)
     */
    createMainWindow() {
        console.log('🏠 Создание главного окна...');

        // Проверяем, что окно уже не существует
        if (this.hasWindow('main')) {
            console.warn('⚠️ Окно "main" уже существует');
            this.focusWindow('main');
            return this.getWindow('main');
        }

        // ОРИГИНАЛЬНАЯ ЛОГИКА ИЗ main.js:631-646
        const { BrowserWindow, screen } = require('electron');
        const path = require('path');
        
        const { width, height } = screen.getPrimaryDisplay().workAreaSize;
        
        const mainWindow = new BrowserWindow({
            width: Math.min(1200, width * 0.8),
            height: Math.min(800, height * 0.8),
            minWidth: 1000,        // ВАЖНО: было потеряно в упрощенной версии
            minHeight: 600,        // ВАЖНО: было потеряно в упрощенной версии
            autoHideMenuBar: true,
            icon: path.join(__dirname, '../../build/icon.png'),
            webPreferences: {
                preload: path.join(__dirname, '../../preload.js'),
                nodeIntegration: false,
                contextIsolation: true
            }
        });

        mainWindow.loadFile(path.join(__dirname, '../../renderer/app.html'));
        
        // ОРИГИНАЛЬНАЯ ЛОГИКА ЗАКРЫТИЯ ИЗ main.js:650-657
        mainWindow.on('closed', () => {
            console.log('🔒 Главное окно закрыто');
            this.windows.delete('main');
            
            // ВАЖНО: Остановка JavaScript мониторинга (было потеряно!)
            if (typeof stopJavaScriptMonitor === 'function') {
                stopJavaScriptMonitor();
                console.log('🛑 JavaScript мониторинг остановлен');
            }
            
            // ВАЖНО: Закрытие виджета при закрытии главного окна (было потеряно!)
            if (this.hasWindow('widget')) {
                this.closeWindow('widget');
                console.log('🪟 Виджет закрыт вместе с главным окном');
            }
            
            const { app } = require('electron');
            app.quit();
        });
        
        // ОРИГИНАЛЬНАЯ ОТПРАВКА ДАННЫХ ИЗ main.js:660-678 (было потеряно!)
        mainWindow.webContents.on('did-finish-load', () => {
            this.sendFullUserDataToMainWindow();
        });

        // Добавляем в хранилище
        this.windows.set('main', mainWindow);

        // Подписываемся на события для обновления UI
        this.setupMainWindowEvents();

        // Эмитируем событие создания окна
        if (this.eventBus) {
            this.eventBus.emit('window:created:main', { window: mainWindow });
        }

        console.log('✅ Главное окно создано (оригинальная версия)');
        return mainWindow;
    }

    /**
     * Настраивает события для главного окна
     */
    setupMainWindowEvents() {
        if (!this.eventBus) return;

        // События от серверов
        this.eventBus.on('server:switched', (data) => {
            this.sendToWindow('main', 'server-changed', data.result);
        });

        // OCR события
        this.eventBus.on('ocr:regions:saved', (data) => {
            this.sendToWindow('main', 'regions-updated', data.regions);
        });

        // События обновлений
        this.eventBus.on('update:download:progress', (data) => {
            this.sendToWindow('main', 'update-download-progress', data.progress);
        });

        this.eventBus.on('update:downloaded', (data) => {
            this.sendToWindow('main', 'update-downloaded', data);
        });

        this.eventBus.on('update:error', (data) => {
            this.sendToWindow('main', 'update-error', data);
        });

        // Общие события приложения
        this.eventBus.on('app:notification', (data) => {
            this.sendToWindow('main', 'app-notification', data);
        });

        console.log('📡 MainWindow подписан на события');
    }

    /**
     * Отправляет данные состояния приложения в главное окно
     */
    sendAppDataToMainWindow() {
        if (!this.appManager) return;

        const appState = this.appManager.getAppState();
        this.sendToWindow('main', 'app-data', appState);
        
        console.log('📤 Данные приложения отправлены в главное окно');
    }

    /**
     * НОВЫЙ МЕТОД: Отправляет ПОЛНЫЕ данные пользователя как в оригинальном main.js:661-677
     */
    sendFullUserDataToMainWindow() {
        if (!this.appManager) return;

        try {
            // Получаем данные через store или appManager
            const store = this.appManager.getStore ? this.appManager.getStore() : null;
            
            if (!store) {
                console.warn('⚠️ Store не найден, отправляем базовые данные');
                this.sendAppDataToMainWindow();
                return;
            }

            // ОРИГИНАЛЬНАЯ ЛОГИКА main.js:661-677
            const user = store.get('user');
            const regions = store.get('ocrRegions'); 
            const searchMode = store.get('searchMode', 'fast'); // 🔧 ИСПРАВЛЕНИЕ: значение по умолчанию
            const deckMode = store.get('deckMode', 'pol');
            const tokens = store.get('tokens');
            
            // Получаем информацию о сервере через appManager
            const serverInfo = this.appManager.getCurrentServer ? this.appManager.getCurrentServer() : null;
            const serverStatus = this.appManager.getCurrentServerStatus ? this.appManager.getCurrentServerStatus() : {};
            
            const userData = { 
                user, 
                regions, 
                searchMode,
                deckMode,
                tokens,
                server: serverInfo ? {
                    mode: serverInfo.mode,
                    url: serverInfo.url,
                    available: serverStatus.available || false
                } : null
            };

            this.sendToWindow('main', 'user-data', userData);
            console.log('📤 Полные данные пользователя отправлены в главное окно (как в оригинале)');
            
        } catch (error) {
            console.error('❌ Ошибка отправки полных данных пользователя:', error);
            // Fallback: отправляем базовые данные
            this.sendAppDataToMainWindow();
        }
    }

    /**
     * Обновляет данные пользователя в главном окне
     */
    updateUserData(userData) {
        this.sendToWindow('main', 'user-data', userData);
    }

    /**
     * Показать уведомление в главном окне
     */
    showNotification(notification) {
        this.sendToWindow('main', 'notification', notification);
    }

    /**
     * Обновить статус подключения
     */
    updateConnectionStatus(status) {
        this.sendToWindow('main', 'connection-status', status);
    }

    /**
     * Показать прогресс загрузки
     */
    showDownloadProgress(progress) {
        this.sendToWindow('main', 'download-progress', progress);
    }

    /**
     * Обновить данные OCR областей
     */
    updateOcrRegions(regions) {
        this.sendToWindow('main', 'ocr-regions', regions);
    }

    // === Методы из базового класса (перенаправляем через события) ===
    
    createAuthWindow() {
        // MainWindow не создает окно авторизации напрямую
        if (this.eventBus) {
            this.eventBus.emit('window:create:auth');
        }
    }

    createSetupWindow() {
        // Создаем окно настройки OCR
        if (this.eventBus) {
            this.eventBus.emit('window:create:setup');
        }
    }

    createWidget(playerData) {
        // Создаем/переключаем виджет
        if (this.eventBus) {
            this.eventBus.emit('widget:toggle', { playerData });
        }
    }
}

module.exports = MainWindow;
