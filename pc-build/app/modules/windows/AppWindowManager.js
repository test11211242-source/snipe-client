const WindowManager = require('./WindowManager');
const { screen, desktopCapturer } = require('electron');
const path = require('path');

/**
 * AppWindowManager - Конкретная реализация WindowManager для нашего приложения
 * Реализует все методы создания окон
 */
class AppWindowManager extends WindowManager {
    constructor(appManager = null, eventBus = null) {
        super(appManager, eventBus);
        console.log('🏠 AppWindowManager инициализирован');
    }

    // === РЕАЛИЗАЦИЯ КОНКРЕТНЫХ МЕТОДОВ СОЗДАНИЯ ОКОН ===

    /**
     * Создает окно авторизации
     */
    createAuthWindow() {
        console.log('🔐 Создание окна авторизации...');

        const config = {
            width: 500,
            height: 700,
            resizable: false,
            autoHideMenuBar: true
        };

        const window = this.createBaseWindow('auth', config, 'auth.html');
        
        // Специальная логика для окна авторизации
        window.on('closed', () => {
            if (!this.isAuthenticated()) {
                // Если закрыто окно авторизации без входа - выходим
                const { app } = require('electron');
                app.quit();
            }
        });

        return window;
    }

    /**
     * Создает главное окно приложения
     */
    createMainWindow() {
        console.log('🏠 Создание главного окна...');

        const screenSize = this.getScreenSize();
        
        const config = {
            width: Math.min(1200, screenSize.width * 0.8),
            height: Math.min(800, screenSize.height * 0.8),
            minWidth: 1000,
            minHeight: 600,
            autoHideMenuBar: true
        };

        const window = this.createBaseWindow('main', config, 'app.html');
        
        // Отправляем данные пользователя в renderer после загрузки
        window.webContents.on('did-finish-load', () => {
            if (this.appManager) {
                const appState = this.appManager.getAppState();
                
                // Извлекаем данные пользователя из auth состояния для правильной структуры
                const userData = {
                    user: appState.auth?.user || null,
                    initialized: appState.initialized,
                    searchMode: appState.store?.settings?.searchMode || 'fast'  // 🔧 ИСПРАВЛЕНИЕ: правильный путь к searchMode
                };
                window.webContents.send('user-data', userData);
            }
        });
        
        // Специальная логика для главного окна
        window.on('closed', () => {
            // Если закрыто главное окно - выходим из приложения
            this.closeWindow('widget');
            this.closeWindow('setup');
            
            const { app } = require('electron');
            app.quit();
        });

        return window;
    }

    /**
     * Создает окно настройки OCR областей через SetupWindow класс
     */
    async createSetupWindow(context = null) {
        console.log('⚙️ Создание окна настройки OCR через SetupWindow...', context);

        // Используем SetupWindow класс вместо прямого создания окна
        const setupWindow = this.getSetupWindow();
        if (setupWindow) {
            return await setupWindow.createSetupWindow(context);
        } else {
            console.error('❌ SetupWindow не найден в WindowManager');
            return null;
        }
    }

    /**
     * Создает виджет колоды
     */
    createWidget(playerData = null) {
        console.log('🪟 Создание виджета колоды...');

        if (this.hasWindow('widget')) {
            // Если виджет уже открыт, обновляем данные
            if (playerData) {
                this.sendToWindow('widget', 'player-data', playerData);
            }
            this.focusWindow('widget');
            return this.getWindow('widget');
        }

        const screenSize = this.getScreenSize();

        const config = {
            width: 450,
            height: 350,
            x: screenSize.width - 470,
            y: 20,
            frame: false,
            transparent: true,
            alwaysOnTop: false,
            skipTaskbar: false,
            resizable: false,
            movable: true,
            hasShadow: true,
            focusable: true,
            show: true
        };

        const window = this.createBaseWindow('widget', config, 'widget.html');

        // Отправляем данные игрока после загрузки
        if (playerData) {
            window.webContents.on('did-finish-load', () => {
                window.webContents.send('player-data', playerData);
            });
        }

        // Магнитное прилипание к краям экрана
        window.on('moved', () => {
            if (!window || window.isDestroyed()) return;
            
            const bounds = window.getBounds();
            const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
            const { width: screenWidth, height: screenHeight } = display.workAreaSize;
            
            const magnetDistance = 20;
            let newX = bounds.x;
            let newY = bounds.y;
            
            // Прилипание к левому краю
            if (bounds.x < magnetDistance) {
                newX = 0;
            }
            // Прилипание к правому краю
            else if (bounds.x + bounds.width > screenWidth - magnetDistance) {
                newX = screenWidth - bounds.width;
            }
            
            // Прилипание к верхнему краю
            if (bounds.y < magnetDistance) {
                newY = 0;
            }
            // Прилипание к нижнему краю
            else if (bounds.y + bounds.height > screenHeight - magnetDistance) {
                newY = screenHeight - bounds.height;
            }
            
            if (newX !== bounds.x || newY !== bounds.y) {
                window.setPosition(newX, newY);
            }
        });

        return window;
    }

    // === ДОПОЛНИТЕЛЬНЫЕ МЕТОДЫ ===

    /**
     * Переключает видимость виджета (переопределяем для правильной работы с данными)
     */
    toggleWidget(playerData = null) {
        if (this.hasWindow('widget')) {
            this.closeWindow('widget');
        } else {
            this.createWidget(playerData);
        }
    }

    /**
     * Обновляет данные виджета
     */
    updateWidget(playerData) {
        if (this.hasWindow('widget')) {
            this.sendToWindow('widget', 'player-data', playerData);
        } else {
            // Если виджет закрыт, но пришли новые данные - открываем его
            this.createWidget(playerData);
        }
    }

    // === ОТЛАДОЧНАЯ ИНФОРМАЦИЯ ===

    getDebugInfo() {
        const baseInfo = super.getDebugInfo();
        
        return {
            ...baseInfo,
            className: 'AppWindowManager',
            implementations: {
                createAuthWindow: '✅ Implemented',
                createMainWindow: '✅ Implemented', 
                createSetupWindow: '✅ Implemented',
                createWidget: '✅ Implemented'
            }
        };
    }

    // === 🆕 ЭТАП 3.2: Доступ к SetupWindow ===
    
    getSetupWindow() {
        if (this.appManager && this.appManager.getSetupWindow) {
            return this.appManager.getSetupWindow();
        }
        return null;
    }
}

module.exports = AppWindowManager;