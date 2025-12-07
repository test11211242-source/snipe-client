const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, Notification, dialog } = require('electron');
const FormData = require('form-data');

/**
 * MonitorManager - Управление Python-процессом мониторинга экрана
 */
class MonitorManager {
    constructor(eventBus, storeManager, apiManager) {
        this.eventBus = eventBus;
        this.storeManager = storeManager;
        this.apiManager = apiManager;
        
        this.pythonProcess = null;
        this.isRunning = false;
        this.messageBuffer = '';
        this.currentProfilesFile = null;
        
        console.log('✅ MonitorManager инициализирован');
    }

    // === УПРАВЛЕНИЕ ПРОЦЕССОМ ===

    async start() {
        if (this.pythonProcess) {
            console.log('⚠️ Python процесс уже запущен');
            return { success: true, message: 'Процесс уже запущен' };
        }
        
        try {
            // Проверяем доступность сервера
            const serverCheck = await this.checkServerConnection();
            if (!serverCheck.available) {
                const errorMsg = `Не удалось подключиться к серверу: ${serverCheck.error}`;
                this.eventBus.emit('monitor:error', errorMsg);
                return { success: false, error: errorMsg };
            }
            
            const tokens = this.storeManager.getTokens();
            const serverUrl = this.storeManager.getServerUrl();
            
            if (!tokens?.access_token) {
                const error = 'Нет токена авторизации';
                this.eventBus.emit('monitor:error', error);
                return { success: false, error };
            }
            
            // 🎯 Новая архитектура: создаем профили триггеров вместо простого режима
            const triggerProfiles = this.createTriggerProfiles();
            
            // 📝 Создаем временный файл для профилей (избегаем ENAMETOOLONG ошибку)
            const tempDir = os.tmpdir();
            const profilesFilePath = path.join(tempDir, `snipe_profiles_${Date.now()}.json`);
            const profilesJson = JSON.stringify(triggerProfiles, null, 2);
            
            fs.writeFileSync(profilesFilePath, profilesJson, 'utf8');
            this.currentProfilesFile = profilesFilePath;
            console.log(`📄 Профили сохранены в временный файл: ${profilesFilePath}`);
            
            const pythonScript = this.getPythonScriptPath();
            const pythonExecutable = this.getPythonExecutable();

            console.log('🚀 Запуск Python процесса с профилями:', {
                executable: pythonExecutable,
                script: pythonScript,
                profilesCount: triggerProfiles.length,
                profilesFile: profilesFilePath
            });

            // Получаем параметры захвата (экран или окно)
            const captureParams = this.getCaptureParameters();

            this.pythonProcess = spawn(pythonExecutable, [
                pythonScript,
                '--target_type', captureParams.targetType,
                '--target_id', captureParams.targetId,
                '--profiles_file', profilesFilePath,
                '--fps', '10'
            ], {
                env: {
                    ...process.env,
                    PYTHONIOENCODING: 'utf-8'
                },
                windowsHide: true
            });

            this.setupProcessHandlers();
            this.isRunning = true;
            
            this.eventBus.emit('monitor:started');
            console.log('✅ Python процесс запущен');
            
            return { success: true, message: 'Мониторинг запущен' };
            
        } catch (error) {
            console.error('❌ Ошибка запуска Python процесса:', error);
            this.eventBus.emit('monitor:error', error.message);
            return { success: false, error: error.message };
        }
    }

    stop() {
        if (!this.pythonProcess) {
            console.log('⚠️ Python процесс не запущен');
            return { success: true, message: 'Процесс не был запущен' };
        }
        
        try {
            console.log('🛑 Остановка Python процесса');
            this.pythonProcess.kill();
            this.pythonProcess = null;
            this.isRunning = false;
            
            // 🆕 ЭТАП 1.2: Останавливаем мониторинг окна
            this.stopWindowMonitoring();
            
            // 🗑️ Очищаем временный файл профилей
            this.cleanupProfilesFile();
            
            this.eventBus.emit('monitor:stopped');
            console.log('✅ Python процесс остановлен');
            
            return { success: true, message: 'Мониторинг остановлен' };
            
        } catch (error) {
            console.error('❌ Ошибка остановки Python процесса:', error);
            return { success: false, error: error.message };
        }
    }

    async restart(reason = 'настройки изменены') {
        console.log(`🔄 Перезапуск Python процесса: ${reason}`);
        
        try {
            this.eventBus.emit('monitor:status', 'Перезапуск мониторинга...');
            
            this.stop();
            await new Promise(resolve => setTimeout(resolve, 1500));
            const result = await this.start();
            
            if (result.success) {
                console.log('✅ Python процесс успешно перезапущен');
                this.eventBus.emit('monitor:restarted', { reason });
            }
            
            return result;
            
        } catch (error) {
            console.error('❌ Ошибка перезапуска Python процесса:', error);
            const errorMsg = `Ошибка перезапуска: ${error.message}`;
            this.eventBus.emit('monitor:error', errorMsg);
            return { success: false, error: errorMsg };
        }
    }

    // === НАСТРОЙКА ОБРАБОТЧИКОВ ПРОЦЕССА ===

    setupProcessHandlers() {
        if (!this.pythonProcess) return;

        this.pythonProcess.stdout.setEncoding('utf-8');
        this.pythonProcess.stderr.setEncoding('utf-8');
        
        // Обработчик stdout - парсинг сообщений от Python
        this.pythonProcess.stdout.on('data', (data) => {
            const output = data.toString();
            const lines = output.split('\n');
            
            lines.forEach(line => {
                const message = line.trim();
                if (!message) return;
                
                console.log('Python message:', message);
                this.processMessage(message);
            });
        });
        
        // Обработчик stderr - только реальные ошибки и предупреждения
        this.pythonProcess.stderr.on('data', (data) => {
            const message = data.toString().trim();
            console.log('Python stderr:', message);
            
            // Фильтруем только реальные ошибки и предупреждения
            if (message.includes('ERROR:') || message.includes('WARNING:') || 
                message.includes('Exception') || message.includes('Traceback')) {
                console.error('Python error detected:', message);
                this.eventBus.emit('monitor:error', message);
            } else {
                // Информационные сообщения логируем, но не отправляем как ошибки
                console.log('Python info (stderr):', message);
            }
        });
        
        // Обработчик закрытия процесса
        this.pythonProcess.on('close', (code) => {
            console.log(`Python процесс завершен с кодом ${code}`);
            this.pythonProcess = null;
            this.isRunning = false;
            
            // 🆕 ЭТАП 1.2: Останавливаем мониторинг окна
            this.stopWindowMonitoring();
            
            // 🗑️ Очищаем временный файл профилей
            this.cleanupProfilesFile();
            
            this.eventBus.emit('monitor:stopped');
            
            // 🔧 ИСПРАВЛЕНИЕ: null код не является ошибкой при принудительной остановке
            if (code !== null && code !== 0) {
                this.eventBus.emit('monitor:error', `Процесс завершился с кодом ${code}`);
            } else if (code === null) {
                console.log('✅ Python процесс остановлен принудительно (нормальная остановка)');
            }
        });
        
        // Обработчик ошибок процесса
        this.pythonProcess.on('error', (error) => {
            console.error('Python процесс ошибка:', error);
            this.eventBus.emit('monitor:error', `Ошибка процесса: ${error.message}`);
            this.pythonProcess = null;
            this.isRunning = false;
            
            // 🆕 ЭТАП 1.2: Останавливаем мониторинг окна
            this.stopWindowMonitoring();
            
            // 🗑️ Очищаем временный файл профилей
            this.cleanupProfilesFile();
        });
    }

    // === ОБРАБОТКА СООБЩЕНИЙ ОТ PYTHON ===

    async processMessage(message) {
        try {
            if (message.startsWith('STATUS:')) {
                const status = message.substring(7);
                // Фильтруем - показываем только важные сообщения о действиях, не частые кадры
                if (status.includes('Выполнение действия') || 
                    status.includes('захвачены и отправлены') ||
                    status.includes('Ожидание') ||
                    status.includes('Screen capture')) {
                    console.log('>>> STATUS:', status);
                    this.eventBus.emit('monitor:status', status);
                }
                
            } else if (message.startsWith('ACTION_DATA:')) {
                // 🆕 Обработка нового формата данных от профильной системы
                const jsonData = message.substring(12);
                console.log('>>> ACTION_DATA:', jsonData);
                
                const actionData = JSON.parse(jsonData);
                await this.handleActionData(actionData);
                
            } else if (message.startsWith('PLAYER_FOUND:')) {
                const jsonData = message.substring(13);
                console.log('>>> PLAYER_FOUND:', jsonData);
                
                const playerData = JSON.parse(jsonData);
                this.eventBus.emit('monitor:player-found', { playerData });
                
                // Уведомление
                this.showPlayerFoundNotification(playerData);
                
            } else if (message.startsWith('OCR_REPROCESSED:')) {
                const jsonData = message.substring(16);
                const reprocessData = JSON.parse(jsonData);
                
                console.log('>>> OCR_REPROCESSED:', reprocessData);
                this.eventBus.emit('monitor:ocr-reprocessed', { data: reprocessData });
                
                // Уведомление об обновлении
                this.showReprocessedNotification();
                
            } else if (message.startsWith('ERROR:')) {
                const error = message.substring(6);
                console.log('>>> ERROR:', error);
                this.eventBus.emit('monitor:error', error);
                
            } else {
                console.log('Неизвестное сообщение от Python:', message);
            }
            
        } catch (parseError) {
            console.error('❌ Ошибка парсинга сообщения от Python:', parseError);
            console.error('❌ Проблемное сообщение:', message);
            this.eventBus.emit('monitor:error', `Ошибка парсинга: ${parseError.message}`);
        }
    }

    // === УВЕДОМЛЕНИЯ ===

    showPlayerFoundNotification(playerData) {
        try {
            const nickname = playerData.ocr_result?.nickname || 
                            playerData.player?.name || 
                            'Игрок';
            const rating = playerData.ocr_result?.rating || 
                          playerData.player?.rating || 
                          'N/A';
            
            new Notification({
                title: 'Противник найден!',
                body: `${nickname} [${rating}]`,
                icon: path.join(__dirname, '../../../build/icon.png')
            }).show();
        } catch (error) {
            console.error('Ошибка показа уведомления:', error);
        }
    }

    showReprocessedNotification() {
        try {
            new Notification({
                title: 'Данные обновлены!',
                body: 'Получены обновленные данные от администратора',
                icon: path.join(__dirname, '../../../build/icon.png')
            }).show();
        } catch (error) {
            console.error('Ошибка показа уведомления:', error);
        }
    }

    // === ПОЛУЧЕНИЕ ПУТЕЙ ===

    getPythonExecutable() {
        if (app.isPackaged) {
            const portablePython = path.join(process.resourcesPath, 'python-portable', 'python-3.11.9.amd64', 'python.exe');
            
            try {
                require('fs').accessSync(portablePython);
                console.log('✅ Найден портативный Python:', portablePython);
                return portablePython;
            } catch (error) {
                console.warn('⚠️ Портативный Python не найден, используем системный');
                return process.platform === 'win32' ? 'python' : 'python3';
            }
        } else {
            return process.platform === 'win32' ? 'python' : 'python3';
        }
    }

    getPythonScriptPath() {
        // 🎯 Используем обновленный скрипт с поддержкой профилей
        if (app.isPackaged) {
            return path.join(process.resourcesPath, 'python_scripts', 'screen_monitor.py');
        } else {
            return path.join(__dirname, '../../../python_scripts/screen_monitor.py');
        }
    }

    // === ПРОВЕРКА СЕРВЕРА ===

    async checkServerConnection() {
        try {
            const serverUrl = this.storeManager.getServerUrl();
            console.log('🔍 Проверка сервера:', serverUrl);
            
            // ПРЕВЕНТИВНАЯ ПРОВЕРКА И ОБНОВЛЕНИЕ ТОКЕНА
            await this.checkAndRefreshTokens();
            
            // Используем API Manager для проверки
            const response = await this.apiManager.get('/health', { timeout: 5000 });
            
            console.log('✅ Сервер доступен');
            return { available: true };
            
        } catch (error) {
            console.error('❌ Сервер недоступен:', error.message);
            return { 
                available: false, 
                error: error.code === 'ECONNREFUSED' 
                    ? 'Сервер не запущен или недоступен'
                    : error.message
            };
        }
    }

    // === ИЗМЕНЕНИЕ НАСТРОЕК ===

    async updateSearchMode(mode) {
        console.log(`🔄 Изменение режима поиска на '${mode}'`);
        
        this.storeManager.setSearchMode(mode);
        
        if (this.isRunning) {
            return await this.restart(`переключение на ${mode === 'fast' ? 'быстрый' : 'точный'} режим`);
        }
        
        return { success: true, message: `Режим '${mode}' сохранен` };
    }

    // === 🆕 УПРАВЛЕНИЕ ЗАХВАТОМ ОКОН ===

    /**
     * Получить параметры захвата (экран или окно)
     */
    getCaptureParameters() {
        const selectedWindow = this.storeManager.getSelectedCaptureTarget();
        
        if (selectedWindow && selectedWindow.targetType === 'window') {
            // 🔧 Используем имя окна вместо ID для Python скрипта
            const targetId = selectedWindow.name || selectedWindow.targetId;
            
            return {
                targetType: 'window',
                targetId: targetId,
                windowInfo: selectedWindow
            };
        }
        
        // По умолчанию - захват экрана
        return {
            targetType: 'screen',
            targetId: '0',
            windowInfo: null
        };
    }

    /**
     * Установить окно для захвата
     */
    async setWindowTarget(windowInfo) {
        console.log('🪟 Установка целевого окна для захвата:', windowInfo.name);
        
        try {
            // Валидируем, что окно еще существует
            const exists = await this.validateWindowExists(windowInfo);
            if (!exists) {
                throw new Error(`Окно "${windowInfo.name}" не найдено`);
            }
            
            // Сохраняем выбранное окно
            this.storeManager.setSelectedCaptureTarget({
                targetType: 'window',
                targetId: windowInfo.id,
                name: windowInfo.name,
                executableName: windowInfo.executableName,
                processId: windowInfo.processId,
                timestamp: new Date().toISOString()
            });
            
            // Перезапускаем мониторинг если он активен
            if (this.isRunning) {
                return await this.restart(`переключение на окно "${windowInfo.name}"`);
            }
            
            return { 
                success: true, 
                message: `Целевое окно установлено: ${windowInfo.name}` 
            };
            
        } catch (error) {
            console.error('❌ Ошибка установки целевого окна:', error);
            return { 
                success: false, 
                error: error.message 
            };
        }
    }

    /**
     * Переключиться на захват экрана
     */
    async setScreenTarget() {
        console.log('🖥️ Переключение на захват экрана');
        
        this.storeManager.setSelectedCaptureTarget({
            targetType: 'screen',
            targetId: '0',
            name: 'Full Screen',
            timestamp: new Date().toISOString()
        });
        
        // Перезапускаем мониторинг если он активен
        if (this.isRunning) {
            return await this.restart('переключение на захват экрана');
        }
        
        return { 
            success: true, 
            message: 'Переключено на захват экрана' 
        };
    }

    /**
     * Получить текущую цель захвата
     */
    getCurrentCaptureTarget() {
        return this.storeManager.getSelectedCaptureTarget();
    }

    /**
     * Валидация существования окна
     */
    async validateWindowExists(windowInfo) {
        try {
            // Эмитируем событие для проверки существования окна через IpcManager
            return new Promise((resolve) => {
                this.eventBus.emit('window:validate:request', {
                    windowInfo,
                    callback: (exists) => resolve(exists)
                });
                
                // Timeout на случай если callback не вызовется
                setTimeout(() => resolve(false), 3000);
            });
        } catch (error) {
            console.warn('⚠️ Ошибка валидации окна:', error);
            return false;
        }
    }

    // === СОЗДАНИЕ ПРОФИЛЕЙ ТРИГГЕРОВ ===
    
    createTriggerProfiles() {
        try {
            const regions = this.storeManager.getOcrRegions();
            const mode = this.storeManager.getSearchMode(); // 'fast' или 'precise'
            const delays = this.storeManager.getTriggerDelays();
            const triggerSettings = this.storeManager.getTriggerSettings();
            
            if (!regions || !regions.trigger_area) {
                throw new Error('OCR области не настроены');
            }
            
            // 🔍 Валидация персональных данных профиля
            const hasPersonalProfile = regions.trigger_area.color_palette && regions.trigger_area.template_base64;
            
            if (!hasPersonalProfile) {
                console.warn('⚠️ Персональный профиль не создан, используем fallback данные');
                console.warn('💡 Для создания персонального профиля перенастройте области триггера через setup');
            } else {
                console.log('✅ Персональный профиль найден:', {
                    colors: regions.trigger_area.color_palette.length,
                    template_size: Math.round(regions.trigger_area.template_base64.length / 1024) + 'KB',
                    created_at: regions.trigger_area.created_at || 'неизвестно'
                });
            }
            
            // Создаем профиль для текущего режима
            const profile = {
                id: `start_battle_${mode}`,
                
                // Область триггера (общая для всех режимов)
                monitor_region: regions.trigger_area,
                
                // Область захвата данных (зависит от режима)
                data_capture_region: mode === 'fast' 
                    ? regions.normal_data_area 
                    : regions.precise_data_area,
                
                // Параметры действия
                action_type: "capture_and_send",
                capture_delay: delays[mode] || 0,
                
                // Системные параметры
                cooldown: triggerSettings.cooldown || 15,
                confirmations_needed: triggerSettings.confirmations || 2,
                
                // 🎨 Персональная цветовая палитра из настроенного профиля
                color_palette: regions.trigger_area.color_palette || [[128, 128, 128], [64, 64, 64], [192, 192, 192]],
                
                // 📸 Персональный эталонный скриншот 
                template_base64: regions.trigger_area.template_base64 || "",
                
                // 🖼️ Настройка скрытия рамки захвата
                hideCaptureBorder: this.storeManager.get('hideCaptureborder', false)
            };
            
            console.log(`🎯 Создан профиль триггера для ${mode} режима:`, {
                id: profile.id,
                delay: profile.capture_delay,
                cooldown: profile.cooldown,
                personal_colors: hasPersonalProfile ? profile.color_palette.length : 0,
                has_template: !!profile.template_base64
            });
            
            return [profile];
            
        } catch (error) {
            console.error('❌ Ошибка создания профилей триггеров:', error);
            return [];
        }
    }
    
    // === ОБРАБОТКА ДАННЫХ ДЕЙСТВИЙ ===
    
    async handleActionData(actionData) {
        try {
            console.log('🎯 Обработка данных действия:', actionData.id);
            
            // 🔑 ПРЕВЕНТИВНАЯ ПРОВЕРКА ТОКЕНОВ ПЕРЕД КАЖДЫМ OCR ЗАПРОСОМ
            console.log('🔍 [OCR] Превентивная проверка токенов...');
            await this.checkAndRefreshTokens();
            
            // Конвертируем base64 обратно в изображение для отправки на сервер
            const imageBuffer = Buffer.from(actionData.image_b64, 'base64');
            
            // Подготавливаем данные для отправки на OCR сервер
            const formData = new FormData();
            formData.append('image', imageBuffer, {
                filename: 'screenshot.png',
                contentType: 'image/png'
            });
            formData.append('timestamp', actionData.timestamp);
            formData.append('search_mode', actionData.id.includes('fast') ? 'fast' : 'precise');
            
            // Отправляем на сервер через ApiManager (токен добавляется автоматически)
            console.log('📡 [OCR] Отправка запроса на сервер...');
            const response = await this.apiManager.post('/api/ocr/process', formData, {
                headers: {
                    'Content-Type': 'multipart/form-data'
                }
            });
            
            if (response.success) {
                const playerData = response.data;
                console.log('✅ OCR данные получены:', playerData.ocr_result?.nickname || 'Unknown');
                
                // Отправляем событие как обычно
                this.eventBus.emit('monitor:player-found', { playerData });
                this.showPlayerFoundNotification(playerData);
            } else {
                console.error('❌ Ошибка OCR сервера:', response.status);
                this.eventBus.emit('monitor:error', `Ошибка OCR: ${response.status}`);
            }
            
        } catch (error) {
            console.error('❌ Ошибка обработки ACTION_DATA:', error);
            this.eventBus.emit('monitor:error', `Ошибка обработки: ${error.message}`);
        }
    }

    // === СОСТОЯНИЕ МОНИТОРА ===

    getStatus() {
        return {
            isRunning: this.isRunning,
            hasProcess: !!this.pythonProcess,
            searchMode: this.storeManager.getSearchMode() || 'fast',
            profilesCount: this.createTriggerProfiles().length
        };
    }

    isMonitorRunning() {
        return this.isRunning;
    }

    // === ОТЛАДОЧНАЯ ИНФОРМАЦИЯ ===

    getDebugInfo() {
        return {
            isRunning: this.isRunning,
            hasProcess: !!this.pythonProcess,
            processId: this.pythonProcess?.pid,
            searchMode: this.storeManager.getSearchMode(),
            pythonPath: this.getPythonExecutable(),
            scriptPath: this.getPythonScriptPath()
        };
    }

    // === ВИЗУАЛЬНЫЙ МОНИТОРИНГ ОКОН ===

    startWindowMonitoring() {
        // Метод для запуска визуального мониторинга окон (например, отображение желтых рамок)
        console.log('🔍 Запуск визуального мониторинга окон');
        
        // Здесь может быть код для:
        // - Создания визуальных индикаторов (желтые рамки вокруг областей OCR)
        // - Отслеживания положения и размера окна
        // - Добавления визуальных эффектов мониторинга
        
        console.log('✅ Визуальный мониторинг окон запущен');
    }

    stopWindowMonitoring() {
        // Метод для остановки визуального мониторинга окон (например, удаление желтых рамок)
        // В текущей реализации функциональность не требуется, но метод добавлен для избежания ошибок
        console.log('🔍 Остановка визуального мониторинга окон');
        
        // Здесь может быть код для:
        // - Удаления визуальных индикаторов (желтые рамки)
        // - Остановки отслеживания положения окна
        // - Очистки визуальных эффектов мониторинга
        
        // Пока просто логируем, что метод вызван
        console.log('✅ Визуальный мониторинг окон остановлен');
    }

    // === ОЧИСТКА РЕСУРСОВ ===

    cleanupProfilesFile() {
        if (this.currentProfilesFile) {
            try {
                if (fs.existsSync(this.currentProfilesFile)) {
                    fs.unlinkSync(this.currentProfilesFile);
                    console.log(`🗑️ Временный файл профилей удален: ${this.currentProfilesFile}`);
                }
            } catch (error) {
                console.warn(`⚠️ Не удалось удалить временный файл: ${error.message}`);
            } finally {
                this.currentProfilesFile = null;
            }
        }
    }

    // === ПРЕВЕНТИВНОЕ ОБНОВЛЕНИЕ ТОКЕНОВ ===

    async checkAndRefreshTokens() {
        try {
            const tokens = this.storeManager.getTokens();
            
            if (!tokens?.access_token || !tokens?.refresh_token) {
                console.log('⚠️ [MonitorManager] Нет токенов для проверки');
                return;
            }
            
            // Проверяем время истечения токена (как в TokenManager)
            const payload = this.decodeJwtPayload(tokens.access_token);
            if (!payload?.exp) {
                console.warn('⚠️ [MonitorManager] Некорректный JWT токен');
                return;
            }
            
            const expireTime = payload.exp * 1000;
            const currentTime = Date.now();
            const timeUntilExpire = expireTime - currentTime;
            const REFRESH_BEFORE_EXPIRE_MS = 5 * 60 * 1000; // 5 минут
            
            console.log(`⏰ [MonitorManager] До истечения токена: ${Math.round(timeUntilExpire / 60000)} минут`);
            
            // Если токен скоро истечет - обновляем превентивно
            if (timeUntilExpire <= REFRESH_BEFORE_EXPIRE_MS) {
                console.log('🔄 [MonitorManager] Токен скоро истечет, превентивно обновляем...');
                
                const refreshResult = await this.apiManager.refreshToken();
                if (refreshResult?.success) {
                    console.log('✅ [MonitorManager] Токены превентивно обновлены');
                } else {
                    console.error('❌ [MonitorManager] Не удалось превентивно обновить токены');
                }
            }
            
        } catch (error) {
            console.error('❌ [MonitorManager] Ошибка при проверке токенов:', error);
        }
    }

    // Декодирование JWT payload (копия из TokenManager)
    decodeJwtPayload(token) {
        try {
            const parts = token.split('.');
            if (parts.length !== 3) {
                throw new Error('Некорректный формат JWT');
            }

            const payload = parts[1];
            const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
            return JSON.parse(decoded);

        } catch (error) {
            console.error('❌ [MonitorManager] Ошибка декодирования JWT:', error);
            return null;
        }
    }

    cleanup() {
        console.log('🧹 Очистка MonitorManager...');
        
        if (this.pythonProcess) {
            this.stop();
        }
        
        // Дополнительная очистка временного файла на случай, если он остался
        this.cleanupProfilesFile();
        
        console.log('✅ MonitorManager очищен');
    }
}

module.exports = MonitorManager;