const WindowManager = require('./WindowManager');

/**
 * WidgetWindow - Управление виджетом колоды
 * Перенесите сюда функцию createDeckWidget() из main_new.js
 */
class WidgetWindow extends WindowManager {
    constructor(appManager = null, eventBus = null) {
        super(appManager, eventBus);
        console.log('🪟 WidgetWindow инициализирован');
    }

    /**
     * Создает виджет колоды
     * РЕАЛЬНАЯ ФУНКЦИЯ ИЗ main.js:998-1077 (НЕ из main_new.js!)
     */
    createWidget(playerData) {
        console.log('🪟 Создание виджета колоды...');

        // ОРИГИНАЛЬНАЯ ЛОГИКА ИЗ main.js:999-1005
        if (this.hasWindow('widget')) {
            // Если виджет уже открыт, обновляем данные
            const widgetWindow = this.getWindow('widget');
            widgetWindow.webContents.send('player-data', playerData);
            widgetWindow.show();
            widgetWindow.focus();
            console.log('🔄 Виджет обновлен и показан (оригинальная версия)');
            return widgetWindow;
        }

        // ОРИГИНАЛЬНАЯ КОНФИГУРАЦИЯ ИЗ main.js:1007-1029
        const { BrowserWindow, screen } = require('electron');
        const path = require('path');
        
        const display = screen.getPrimaryDisplay();
        const { width: screenWidth, height: screenHeight } = display.workAreaSize;

        const widgetWindow = new BrowserWindow({
            width: 450,
            height: 350,
            x: screenWidth - 470,
            y: 20,
            frame: false,
            transparent: true,
            alwaysOnTop: false,
            skipTaskbar: false,  // ВАЖНО: false вместо true (было потеряно!)
            resizable: false,
            movable: true,
            hasShadow: true,
            focusable: true,     // ВАЖНО: разрешаем фокус (было потеряно!)
            show: true,          // ВАЖНО: показываем окно (было потеряно!)
            webPreferences: {
                preload: path.join(__dirname, '../../preload.js'),
                nodeIntegration: false,
                contextIsolation: true
            }
        });

        widgetWindow.loadFile(path.join(__dirname, '../../renderer/widget.html'));

        // ОРИГИНАЛЬНАЯ ОТПРАВКА ДАННЫХ ИЗ main.js:1033-1035
        widgetWindow.webContents.on('did-finish-load', () => {
            widgetWindow.webContents.send('player-data', playerData);
        });

        // ОРИГИНАЛЬНАЯ ЛОГИКА ЗАКРЫТИЯ ИЗ main.js:1037-1039
        widgetWindow.on('closed', () => {
            console.log('🪟 Виджет колоды закрыт');
            this.windows.delete('widget');
        });
        
        // 🔧 Предотвращаем автоматическое сворачивание при потере фокуса
        widgetWindow.on('blur', () => {
            // Если виджет закреплен поверх всех окон, не позволяем ему сворачиваться
            if (widgetWindow.isAlwaysOnTop()) {
                console.log('🔒 Виджет закреплен - предотвращаем сворачивание при потере фокуса');
                // Не сворачиваем окно при потере фокуса если оно закреплено
                return;
            }
        });
        
        // 🔧 Обработчик для восстановления фокуса закрепленного виджета
        widgetWindow.on('show', () => {
            if (widgetWindow.isAlwaysOnTop()) {
                console.log('👀 Закрепленный виджет показан - устанавливаем фокус');
                setTimeout(() => {
                    if (widgetWindow && !widgetWindow.isDestroyed()) {
                        widgetWindow.focus();
                    }
                }, 100);
            }
        });

        // ВАЖНО: МАГНИТНОЕ ПРИЛИПАНИЕ К КРАЯМ ЭКРАНА ИЗ main.js:1043-1076 (было потеряно!)
        widgetWindow.on('moved', () => {
            if (!widgetWindow) return;
            
            const bounds = widgetWindow.getBounds();
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
                widgetWindow.setPosition(newX, newY);
            }
        });

        // Добавляем в хранилище
        this.windows.set('widget', widgetWindow);

        // Подписываемся на события для обновления виджета
        this.setupWidgetEvents();

        // Эмитируем событие создания виджета
        if (this.eventBus) {
            this.eventBus.emit('widget:created', { 
                window: widgetWindow, 
                playerData 
            });
        }

        console.log('✅ Виджет колоды создан (оригинальная версия с магнитным прилипанием)');
        return widgetWindow;
    }

    /**
     * Настраивает события для виджета
     */
    setupWidgetEvents() {
        if (!this.eventBus) return;

        // Событие обновления данных виджета
        this.eventBus.on('widget:update', (data) => {
            this.updateWidget(data.playerData);
        });

        // Событие закрытия виджета
        this.eventBus.on('widget:close', () => {
            this.closeWindow('widget');
        });

        // Событие переключения виджета
        this.eventBus.on('widget:toggle', (data) => {
            if (this.hasWindow('widget')) {
                this.closeWindow('widget');
            } else {
                this.createWidget(data.playerData);
            }
        });

        console.log('📡 WidgetWindow подписан на события');
    }

    /**
     * Отправляет данные игрока в виджет
     */
    sendPlayerDataToWidget(playerData) {
        this.sendToWindow('widget', 'player-data', playerData);
        console.log('📤 Данные игрока отправлены в виджет');
    }

    /**
     * Обновляет данные в виджете
     */
    updateWidget(playerData) {
        if (this.hasWindow('widget')) {
            this.sendPlayerDataToWidget(playerData);
            
            // Показываем и фокусируем виджет
            const widgetWindow = this.getWindow('widget');
            widgetWindow.show();
            widgetWindow.focus();
            
            console.log('🔄 Виджет обновлен');
        } else {
            // Если виджет не существует, создаем его
            this.createWidget(playerData);
        }
    }

    /**
     * Переключает видимость виджета
     */
    toggleWidget(playerData = null) {
        if (this.hasWindow('widget')) {
            this.closeWindow('widget');
            console.log('🔄 Виджет скрыт');
        } else if (playerData) {
            this.createWidget(playerData);
            console.log('🔄 Виджет показан');
        } else {
            console.warn('⚠️ Нет данных для создания виджета');
        }
    }

    /**
     * Изменяет позицию виджета
     */
    setWidgetPosition(x, y) {
        const widgetWindow = this.getWindow('widget');
        if (widgetWindow) {
            widgetWindow.setPosition(x, y);
            console.log(`📍 Позиция виджета изменена: ${x}, ${y}`);
        }
    }

    /**
     * Изменяет размер виджета
     */
    setWidgetSize(width, height) {
        const widgetWindow = this.getWindow('widget');
        if (widgetWindow) {
            widgetWindow.setSize(width, height);
            console.log(`📏 Размер виджета изменен: ${width}x${height}`);
        }
    }

    /**
     * Устанавливает, должен ли виджет быть поверх других окон
     */
    setWidgetAlwaysOnTop(alwaysOnTop) {
        const widgetWindow = this.getWindow('widget');
        if (widgetWindow) {
            widgetWindow.setAlwaysOnTop(alwaysOnTop);
            console.log(`🔝 Поверх других окон: ${alwaysOnTop ? 'включено' : 'отключено'}`);
        }
    }

    /**
     * Показывает/скрывает виджет
     */
    setWidgetVisible(visible) {
        const widgetWindow = this.getWindow('widget');
        if (widgetWindow) {
            if (visible) {
                widgetWindow.show();
                console.log('👀 Виджет показан');
            } else {
                widgetWindow.hide();
                console.log('🙈 Виджет скрыт');
            }
        }
    }

    // === Методы из базового класса (не нужны для WidgetWindow) ===
    
    createAuthWindow() {
        // WidgetWindow не создает окно авторизации
        if (this.eventBus) {
            this.eventBus.emit('window:create:auth');
        }
    }

    createMainWindow() {
        // WidgetWindow не создает главное окно
        if (this.eventBus) {
            this.eventBus.emit('window:create:main');
        }
    }

    createSetupWindow() {
        // WidgetWindow не создает окно настройки
        if (this.eventBus) {
            this.eventBus.emit('window:create:setup');
        }
    }
}

module.exports = WidgetWindow;