const WindowManager = require('./WindowManager');

/**
 * SetupWindow - Управление окном настройки OCR областей
 * Перенесите сюда функцию createSetupWindow() из main_new.js
 */
class SetupWindow extends WindowManager {
    constructor(appManager = null, eventBus = null) {
        super(appManager, eventBus);
        console.log('⚙️ SetupWindow инициализирован');
    }

    /**
     * Создает окно настройки OCR областей
     * РЕАЛЬНАЯ ФУНКЦИЯ ИЗ main.js:836-910 (НЕ из main_new.js!)
     */
    async createSetupWindow(context) {
        console.log('⚙️ Создание окна настройки OCR областей...');

        // Проверяем, что окно уже не существует
        if (this.hasWindow('setup')) {
            console.warn('⚠️ Окно "setup" уже существует');
            this.closeWindow('setup'); // Закрываем старое
        }

        // ОРИГИНАЛЬНАЯ КОНФИГУРАЦИЯ ИЗ main.js:837-848
        const { BrowserWindow, screen, desktopCapturer } = require('electron');
        const path = require('path');
        
        const setupWindow = new BrowserWindow({
            fullscreen: true,
            transparent: true,
            frame: false,
            alwaysOnTop: true,
            skipTaskbar: true,
            webPreferences: {
                preload: path.join(__dirname, '../../preload.js'),
                nodeIntegration: false,
                contextIsolation: true
            }
        });

        let screenshot;
        let setupMode = context?.mode === 'window' && context?.targetWindow ? 'window' : 'screen';
        let windowBounds = null;
        let frameSize = null;

        const ocrManager = this.appManager?.getOcr?.();

        if (ocrManager?.captureSetupFrame) {
            const captureResult = await ocrManager.captureSetupFrame(context || { mode: setupMode });
            if (!captureResult?.success) {
                throw new Error(captureResult?.error || 'Не удалось получить setup frame');
            }

            screenshot = captureResult.screenshot;
            frameSize = captureResult.frameSize || captureResult.size;
            setupMode = captureResult.target?.targetType === 'window' ? 'window' : setupMode;
            windowBounds = frameSize ? {
                x: 0,
                y: 0,
                width: frameSize.width,
                height: frameSize.height
            } : null;
        } else if (context && context.mode === 'window' && context.targetWindow) {
            console.log('📸 Capturing specific window for setup');
            const windowScreenshot = await this.captureWindowScreenshot(context.targetWindow);
            if (!windowScreenshot) {
                throw new Error('Failed to capture window screenshot');
            }

            screenshot = windowScreenshot.dataURL;
            frameSize = windowScreenshot.frameSize || windowScreenshot.bounds;
            windowBounds = {
                x: 0,
                y: 0,
                width: frameSize.width,
                height: frameSize.height
            };
        } else {
            console.log('📸 Capturing full screen for setup');
            const display = screen.getPrimaryDisplay();
            const physicalSize = {
                width: Math.round(display.size.width * display.scaleFactor),
                height: Math.round(display.size.height * display.scaleFactor)
            };

            const sources = await desktopCapturer.getSources({
                types: ['screen'],
                thumbnailSize: physicalSize
            });

            screenshot = sources[0].thumbnail.toDataURL();
            frameSize = physicalSize;
            windowBounds = {
                x: 0,
                y: 0,
                width: frameSize.width,
                height: frameSize.height
            };
        }

        const resolvedContext = {
            ...(context || {}),
            mode: setupMode,
            captureTarget: context?.targetWindow || this.appManager?.getStore?.()?.getSelectedCaptureTarget?.() || null,
            sourceFrameSize: frameSize || null
        };

        setupWindow.loadFile(path.join(__dirname, '../../renderer/setup.html'));
        
        // ОРИГИНАЛЬНАЯ ОТПРАВКА ДАННЫХ ИЗ main.js:901-906 + НОВАЯ ЛОГИКА ГРАНИЦ ОКНА
        setupWindow.webContents.on('did-finish-load', () => {
            setupWindow.webContents.send('screenshot', screenshot);
            
            // 🆕 КРИТИЧНО: Передаем контекст настройки в setup.html
            console.log('📤 Sending setup-context to setup.html:', JSON.stringify(resolvedContext));
            setupWindow.webContents.send('setup-context', resolvedContext);
            
            setupWindow.webContents.send('window-bounds', {
                bounds: windowBounds,
                scaleFactor: 1,
                mode: setupMode
            });
        });
        
        // ОРИГИНАЛЬНАЯ ЛОГИКА ЗАКРЫТИЯ ИЗ main.js:908-910
        setupWindow.on('closed', () => {
            console.log('⚙️ Окно настройки закрыто');
            this.windows.delete('setup');
        });

        // Добавляем в хранилище
        this.windows.set('setup', setupWindow);

        // Подписываемся на события сохранения областей
        this.setupSetupWindowEvents();

        // Эмитируем событие создания окна
        if (this.eventBus) {
            this.eventBus.emit('window:created:setup', { 
                window: setupWindow, 
                screenshot, 
                context: resolvedContext,
                setupMode,
                windowBounds,
                frameSize
            });
        }

        console.log('✅ Окно настройки OCR областей создано:', {
            setupMode: setupMode,
            hasWindowBounds: !!windowBounds,
            context: resolvedContext,
            frameSize
        });
        return setupWindow;
    }

    /**
     * 🆕 ЭТАП 1.1: Захват скриншота конкретного окна с получением bounds
     * Эта функция должна быть доступна из оригинального main.js
     */
    async captureWindowScreenshot(targetWindow) {
        try {
            console.log('📸 Захват скриншота окна:', targetWindow);
            
            // Пытаемся вызвать через appManager, если есть OcrManager
            if (this.appManager && this.appManager.getOcr) {
                const ocrManager = this.appManager.getOcr();
                if (ocrManager && typeof ocrManager.captureWindowScreenshot === 'function') {
                    return await ocrManager.captureWindowScreenshot(targetWindow);
                }
            }
            
            // 🆕 Fallback: Захват через desktopCapturer с получением bounds
            console.warn('⚠️ captureWindowScreenshot не найдена в OcrManager, используем fallback');
            return await this.captureWindowScreenshotFallback(targetWindow);
            
        } catch (error) {
            console.error('❌ Ошибка захвата окна:', error);
            return null;
        }
    }
    
    /**
     * 🆕 ЭТАП 1.1: Fallback метод для захвата окна с bounds
     */
    async captureWindowScreenshotFallback(targetWindow) {
        try {
            const { desktopCapturer, screen } = require('electron');
            
            // Получаем все окна
            const sources = await desktopCapturer.getSources({
                types: ['window'],
                thumbnailSize: { width: 1920, height: 1080 }
            });
            
            // Ищем целевое окно
            const targetSource = sources.find(source => 
                source.name === targetWindow.name || 
                source.id === targetWindow.id
            );
            
            if (!targetSource) {
                throw new Error(`Окно "${targetWindow.name || targetWindow.id}" не найдено`);
            }
            
            console.log('✅ Найдено целевое окно:', targetSource.name);
            
            // Получаем скриншот
            const dataURL = targetSource.thumbnail.toDataURL();
            
            // Получаем размеры окна (приблизительные)
            const display = screen.getPrimaryDisplay();
            const bounds = {
                x: 0, // Точные координаты получить сложно из desktopCapturer
                y: 0,
                width: targetSource.thumbnail.getSize().width,
                height: targetSource.thumbnail.getSize().height
            };
            
            return {
                dataURL: dataURL,
                bounds: bounds,
                windowName: targetSource.name
            };
            
        } catch (error) {
            console.error('❌ Ошибка fallback захвата окна:', error);
            throw error;
        }
    }

    /**
     * Создает скриншот напрямую (fallback)
     */
    async createScreenshotDirect() {
        try {
            const { screen, desktopCapturer } = require('electron');
            
            const display = screen.getPrimaryDisplay();
            const physicalSize = {
                width: Math.round(display.size.width * display.scaleFactor),
                height: Math.round(display.size.height * display.scaleFactor)
            };
            
            console.log(`📊 Параметры скриншота:`);
            console.log(`  - Scale Factor: ${display.scaleFactor}x`);
            console.log(`  - Logical Size: ${display.size.width}x${display.size.height}`);
            console.log(`  - Physical Size: ${physicalSize.width}x${physicalSize.height}`);
            
            const sources = await desktopCapturer.getSources({
                types: ['screen'],
                thumbnailSize: physicalSize
            });
            
            if (!sources || sources.length === 0) {
                throw new Error('Не удалось получить источники экрана');
            }
            
            const screenshot = sources[0].thumbnail.toDataURL();
            
            return {
                screenshot,
                size: physicalSize
            };
            
        } catch (error) {
            console.error('❌ Ошибка создания скриншота напрямую:', error);
            return {
                screenshot: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
                size: { width: 1920, height: 1080 }
            };
        }
    }

    /**
     * Настраивает события для окна настройки
     */
    setupSetupWindowEvents() {
        if (!this.eventBus) return;

        // Событие сохранения OCR областей
        this.eventBus.on('ocr:regions:saved', (data) => {
            if (data.result.success) {
                console.log('✅ OCR области сохранены, закрываем окно настройки');
                this.closeWindow('setup');
            }
        });

        // Событие закрытия окна настройки
        this.eventBus.on('window:close:setup', () => {
            this.closeWindow('setup');
        });
        
        // 🆕 ЭТАП 1.1: Обработка ошибок валидации границ
        this.eventBus.on('setup:bounds:validation:error', (data) => {
            console.warn('⚠️ Ошибка валидации границ окна:', data.error);
            this.sendToWindow('setup', 'validation-error', {
                error: data.error,
                bounds: data.bounds
            });
        });

        console.log('📡 SetupWindow подписан на события');
    }

    /**
     * Отправляет скриншот в окно настройки
     */
    sendScreenshotToSetupWindow(screenshot, screenSize) {
        this.sendToWindow('setup', 'screenshot', {
            screenshot,
            size: screenSize
        });
        
        console.log('📸 Скриншот отправлен в окно настройки');
    }

    /**
     * Отправляет текущие OCR области в окно настройки
     */
    sendCurrentRegions() {
        if (!this.appManager) return;

        const regions = this.appManager.getStore().getOcrRegions();
        if (regions) {
            this.sendToWindow('setup', 'current-regions', regions);
            console.log('📋 Текущие области отправлены в окно настройки');
        }
    }

    /**
     * Показать статус валидации областей
     */
    showValidationStatus(validation) {
        this.sendToWindow('setup', 'validation-status', validation);
    }

    /**
     * Показать прогресс сохранения
     */
    showSaveProgress(progress) {
        this.sendToWindow('setup', 'save-progress', progress);
    }

    /**
     * Показать ошибку настройки
     */
    showSetupError(error) {
        this.sendToWindow('setup', 'setup-error', { error: error.message });
    }
    
    /**
     * 🆕 ЭТАП 1.1: Валидация области в пределах границ окна
     */
    validateRegionWithinBounds(region, windowBounds) {
        if (!windowBounds) {
            return { valid: true }; // Для полноэкранного режима ограничений нет
        }
        
        const withinBounds = region.x >= windowBounds.x && 
                            region.y >= windowBounds.y &&
                            region.x + region.width <= windowBounds.x + windowBounds.width &&
                            region.y + region.height <= windowBounds.y + windowBounds.height;
        
        if (!withinBounds) {
            return {
                valid: false,
                error: 'Область должна быть внутри выбранного окна',
                bounds: windowBounds
            };
        }
        
        return { valid: true };
    }

    /**
     * 🆕 ЭТАП 1.1: Получение информации о доступных окнах для выбора
     */
    async getAvailableWindows() {
        try {
            const { desktopCapturer } = require('electron');
            
            const sources = await desktopCapturer.getSources({
                types: ['window'],
                thumbnailSize: { width: 200, height: 150 }
            });
            
            // Фильтруем системные окна
            const filteredWindows = sources.filter(source => 
                source.name && 
                source.name.trim() !== '' &&
                !source.name.includes('Program Manager') &&
                !source.name.includes('Desktop Window Manager') &&
                !source.name.includes('Task Manager') &&
                !source.name.includes('Windows Input Experience')
            );
            
            return filteredWindows.map(source => ({
                id: source.id,
                name: source.name,
                thumbnail: source.thumbnail.toDataURL()
            }));
            
        } catch (error) {
            console.error('❌ Ошибка получения списка окон:', error);
            return [];
        }
    }

    // === Методы из базового класса (не нужны для SetupWindow) ===
    
    createAuthWindow() {
        // SetupWindow не создает окно авторизации
        if (this.eventBus) {
            this.eventBus.emit('window:create:auth');
        }
    }

    createMainWindow() {
        // SetupWindow не создает главное окно
        if (this.eventBus) {
            this.eventBus.emit('window:create:main');
        }
    }

    createWidget(playerData) {
        // SetupWindow не создает виджет
        if (this.eventBus) {
            this.eventBus.emit('widget:toggle', { playerData });
        }
    }
}

module.exports = SetupWindow;
