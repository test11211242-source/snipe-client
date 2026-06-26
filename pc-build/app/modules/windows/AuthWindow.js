const WindowManager = require('./WindowManager');

/**
 * AuthWindow - Управление окном авторизации
 * Перенесите сюда функцию createAuthWindow() из main_new.js
 */
class AuthWindow extends WindowManager {
    constructor(appManager = null, eventBus = null) {
        super(appManager, eventBus);
        console.log('🔐 AuthWindow инициализирован');
    }

    /**
     * Создает окно авторизации
     * РЕАЛЬНАЯ ФУНКЦИЯ ИЗ main.js:606-628 (НЕ из main_new.js!)
     */
    createAuthWindow() {
        console.log('🔐 Создание окна авторизации...');

        // Проверяем, что окно уже не существует
        if (this.hasWindow('auth')) {
            console.warn('⚠️ Окно "auth" уже существует');
            this.focusWindow('auth');
            return this.getWindow('auth');
        }

        // ОРИГИНАЛЬНЫЕ ПАРАМЕТРЫ ИЗ main.js:607-618
        const { BrowserWindow } = require('electron');
        const path = require('path');
        
        const authWindow = new BrowserWindow({
            width: 500,
            height: 700,
            resizable: false,
            autoHideMenuBar: true,
            icon: path.join(__dirname, '../../build/icon.png'),
            webPreferences: {
                preload: path.join(__dirname, '../../preload.js'),
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true
            }
        });

        authWindow.loadFile(path.join(__dirname, '../../renderer/auth.html'));
        
        // ОРИГИНАЛЬНАЯ ЛОГИКА ЗАКРЫТИЯ ИЗ main.js:622-627
        authWindow.on('closed', () => {
            console.log('🔒 Окно авторизации закрыто');
            this.windows.delete('auth');
            
            // ВАЖНО: Используем глобальную переменную isAuthenticated, как в оригинале
            // НЕ this.isAuthenticated()!
            const isAuthenticated = this.appManager?.isAuthenticated() || false;
            if (!isAuthenticated) {
                const { app } = require('electron');
                app.quit();
            }
        });

        // Добавляем в хранилище
        this.windows.set('auth', authWindow);

        // Эмитируем событие создания окна
        if (this.eventBus) {
            this.eventBus.emit('window:created:auth', { window: authWindow });
        }

        console.log('✅ Окно авторизации создано (оригинальная версия)');
        return authWindow;
    }

    /**
     * Обработка успешной авторизации
     */
    handleAuthSuccess() {
        console.log('✅ Авторизация успешна, закрываем окно авторизации');
        
        // Закрываем окно авторизации
        this.closeWindow('auth');
        
        // Создаем главное окно
        if (this.eventBus) {
            this.eventBus.emit('window:create:main');
        }
        
        return { success: true };
    }

    /**
     * Показать окно с ошибкой авторизации
     */
    showAuthError(error) {
        const authWindow = this.getWindow('auth');
        if (authWindow) {
            this.sendToWindow('auth', 'auth-error', { error: error.message });
        }
    }

    /**
     * Отправить данные пользователя в окно
     */
    sendUserData(userData) {
        this.sendToWindow('auth', 'user-data', userData);
    }

    /**
     * Показать статус инвайт-ключа
     */
    showInviteStatus(status) {
        this.sendToWindow('auth', 'invite-status', status);
    }

    // === Методы из базового класса (не нужны для AuthWindow) ===
    
    createMainWindow() {
        // AuthWindow не создает главное окно
        if (this.eventBus) {
            this.eventBus.emit('window:create:main');
        }
    }

    createSetupWindow() {
        // AuthWindow не создает окно настройки
        if (this.eventBus) {
            this.eventBus.emit('window:create:setup');
        }
    }

    createWidget(playerData) {
        // AuthWindow не создает виджет
        if (this.eventBus) {
            this.eventBus.emit('widget:toggle', { playerData });
        }
    }
}

module.exports = AuthWindow;
