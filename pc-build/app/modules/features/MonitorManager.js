const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, Notification, dialog } = require('electron');
const FormData = require('form-data');

const TRIGGER_PROFILE_SCHEMA_VERSION = 2;

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
        this.isRestarting = false;
        this.messageBuffer = '';
        this.currentProfilesFile = null;
        this.engineReadyWaiter = null;
        this.lastDebugByTrigger = {};
        this.lastEngineReadyPayload = null;
        
        console.log('✅ MonitorManager инициализирован');
    }

    // === УПРАВЛЕНИЕ ПРОЦЕССОМ ===

    async start() {
        if (this.pythonProcess) {
            console.log('⚠️ Python процесс уже запущен');
            return { success: true, message: 'Процесс уже запущен' };
        }
        
        try {
            this.messageBuffer = '';
            this.lastDebugByTrigger = {};
            this.lastEngineReadyPayload = null;

            // Проверяем доступность сервера
            const serverCheck = await this.checkServerConnection();
            if (!serverCheck.available) {
                const errorMsg = `Не удалось подключиться к серверу: ${serverCheck.error}`;
                this.eventBus.emit('monitor:error', errorMsg);
                return { success: false, error: errorMsg };
            }
            
            const tokens = this.storeManager.getTokens();
            
            if (!tokens?.access_token) {
                const error = 'Нет токена авторизации';
                this.eventBus.emit('monitor:error', error);
                return { success: false, error };
            }
            
            const captureParams = this.getCaptureParameters();
            const triggerProfiles = this.createTriggerProfiles();

            if (!Array.isArray(triggerProfiles) || triggerProfiles.length === 0) {
                throw new Error('Не удалось создать ни одного trigger profile для мониторинга');
            }
            
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
            const readyPayload = await this.waitForEngineReady();

            this.isRunning = true;
            this.lastEngineReadyPayload = readyPayload;
            this.eventBus.emit('monitor:started');
            console.log('✅ Python процесс запущен и подтвердил готовность');
            
            return { success: true, message: 'Мониторинг запущен' };
            
        } catch (error) {
            console.error('❌ Ошибка запуска Python процесса:', error);
            if (this.pythonProcess) {
                try {
                    this.pythonProcess.kill();
                } catch (killError) {
                    console.warn('⚠️ Не удалось остановить процесс после ошибки запуска:', killError.message);
                }
            }
            this.pythonProcess = null;
            this.isRunning = false;
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
            this.engineReadyWaiter = null;
            this.lastEngineReadyPayload = null;
            
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
            this.isRestarting = true;
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
        } finally {
            this.isRestarting = false;
        }
    }

    // === НАСТРОЙКА ОБРАБОТЧИКОВ ПРОЦЕССА ===

    setupProcessHandlers() {
        if (!this.pythonProcess) return;

        this.engineReadyWaiter = {};
        this.engineReadyWaiter.promise = new Promise((resolve, reject) => {
            this.engineReadyWaiter.resolve = resolve;
            this.engineReadyWaiter.reject = reject;
            this.engineReadyWaiter.timeout = setTimeout(() => {
                reject(new Error('Python engine не подтвердил готовность вовремя'));
            }, 8000);
        });

        this.pythonProcess.stdout.setEncoding('utf-8');
        this.pythonProcess.stderr.setEncoding('utf-8');
        
        // Обработчик stdout - парсинг сообщений от Python
        this.pythonProcess.stdout.on('data', (data) => {
            this.messageBuffer += data.toString();
            const lines = this.messageBuffer.split('\n');
            this.messageBuffer = lines.pop() || '';
            
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
            if (this.messageBuffer.trim()) {
                try {
                    this.processMessage(this.messageBuffer.trim());
                } catch (bufferError) {
                    console.warn('⚠️ Не удалось обработать хвост stdout буфера:', bufferError.message);
                }
            }
            this.messageBuffer = '';
            if (this.engineReadyWaiter?.reject) {
                this.engineReadyWaiter.reject(new Error(code === null ? 'Python процесс был остановлен' : `Python процесс завершился с кодом ${code}`));
            }
            this.clearEngineReadyWaiter();
            this.pythonProcess = null;
            this.isRunning = false;
            this.lastEngineReadyPayload = null;
            
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
            if (this.engineReadyWaiter?.reject) {
                this.engineReadyWaiter.reject(error);
            }
            this.clearEngineReadyWaiter();
            this.eventBus.emit('monitor:error', `Ошибка процесса: ${error.message}`);
            this.pythonProcess = null;
            this.isRunning = false;
            this.lastEngineReadyPayload = null;
            
            // 🆕 ЭТАП 1.2: Останавливаем мониторинг окна
            this.stopWindowMonitoring();
            
            // 🗑️ Очищаем временный файл профилей
            this.cleanupProfilesFile();
        });
    }

    clearEngineReadyWaiter() {
        if (this.engineReadyWaiter?.timeout) {
            clearTimeout(this.engineReadyWaiter.timeout);
        }

        this.engineReadyWaiter = null;
    }

    async waitForEngineReady() {
        if (!this.engineReadyWaiter?.promise) {
            throw new Error('Ожидание готовности monitor engine не инициализировано');
        }

        try {
            return await this.engineReadyWaiter.promise;
        } finally {
            this.clearEngineReadyWaiter();
        }
    }

    // === ОБРАБОТКА СООБЩЕНИЙ ОТ PYTHON ===

    async processMessage(message) {
        try {
            if (message.startsWith('ENGINE_READY:')) {
                const jsonData = message.substring(13);
                const readyPayload = JSON.parse(jsonData);
                this.lastEngineReadyPayload = readyPayload;
                if (this.engineReadyWaiter?.resolve) {
                    this.engineReadyWaiter.resolve(readyPayload);
                }
            } else if (message.startsWith('DEBUG_JSON:')) {
                const jsonData = message.substring(11);
                const debugPayload = JSON.parse(jsonData);
                if (debugPayload?.id) {
                    this.lastDebugByTrigger[debugPayload.id] = debugPayload;
                }
                console.log('>>> DEBUG_JSON:', debugPayload);
            } else if (message.startsWith('STATUS:')) {
                const status = message.substring(7);
                // Фильтруем - показываем только важные сообщения о действиях, не частые кадры
                if (status.includes('Выполнение действия') || 
                    status.includes('захвачены и отправлены') ||
                    status.includes('Ожидание') ||
                    status.includes('Screen capture') ||
                    status.includes('engine ready')) {
                    console.log('>>> STATUS:', status);
                    this.eventBus.emit('monitor:status', status);
                }
                
            } else if (message.startsWith('ACTION_DATA:')) {
                // 🆕 Обработка нового формата данных от профильной системы
                const jsonData = message.substring(12);
                console.log('>>> ACTION_DATA:', jsonData);
                
                const actionData = JSON.parse(jsonData);
                await this.handleActionData(actionData);

            } else if (message.startsWith('TRIGGER_FIRED:')) {
                const jsonData = message.substring(15);
                console.log('>>> TRIGGER_FIRED:', jsonData);

                const triggerData = JSON.parse(jsonData);
                await this.handleTriggerFired(triggerData);
                
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
            
            // apiManager.get() не бросает исключений — проверяем response.success
            if (!response.success) {
                console.error('❌ Сервер недоступен:', response.userMessage || response.error);
                return { 
                    available: false, 
                    error: response.userMessage || 'Сервер не запущен или недоступен'
                };
            }
            
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
            const targetId = selectedWindow.name || selectedWindow.targetId || selectedWindow.id;
            
            return {
                targetType: 'window',
                targetId: targetId,
                windowInfo: selectedWindow
            };
        }
        
        // По умолчанию - захват экрана
        return {
            targetType: 'screen',
            targetId: selectedWindow?.targetType === 'screen' ? (selectedWindow.targetId || '0') : '0',
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
            const streamerResultTriggerArea = this.storeManager.getStreamerResultTriggerArea?.() || null;
            const streamerResultDataArea = this.storeManager.getStreamerResultDataArea?.() || null;
            const predictionMonitorEnabled = this.storeManager.get('streamerPredictionMonitorEnabled', false);
            const mode = this.storeManager.getSearchMode(); // 'fast' или 'precise'
            const delays = this.storeManager.getTriggerDelays();
            const triggerSettings = this.storeManager.getTriggerSettings();
            const captureParams = this.getCaptureParameters();
            
            if (!regions || !regions.trigger_area) {
                throw new Error('OCR области не настроены');
            }
            const captureReference = regions.capture_reference || {
                target_type: captureParams.targetType,
                target_id: captureParams.targetId,
                target_name: captureParams.windowInfo?.name || 'Full Screen',
                selected_target: captureParams.windowInfo || null,
                source_frame_size: regions.screen_resolution || null
            };

            this.assertCaptureReferenceMatches(captureReference, captureParams, 'основного trigger');

            const startProfile = this.buildEngineProfile({
                id: `start_battle_${mode}`,
                profileType: 'start_battle',
                actionType: 'capture_and_send',
                triggerArea: regions.trigger_area,
                dataArea: mode === 'fast' ? regions.normal_data_area : regions.precise_data_area,
                captureReference,
                cooldown: triggerSettings.cooldown || 15,
                confirmationsNeeded: triggerSettings.confirmations || 2,
                captureDelay: delays[mode] || 0
            });
            
            const profiles = [startProfile];

            if (predictionMonitorEnabled) {
                if (this.hasTriggerProfile(streamerResultTriggerArea) && this.isValidRegion(streamerResultDataArea)) {
                    const resultCaptureReference = streamerResultTriggerArea.capture_reference || captureReference;
                    this.assertCaptureReferenceMatches(resultCaptureReference, captureParams, 'battle_result trigger');
                    const resultProfile = this.buildEngineProfile({
                        id: 'battle_result',
                        profileType: 'battle_result',
                        actionType: 'capture_prediction_result',
                        triggerArea: streamerResultTriggerArea,
                        dataArea: streamerResultDataArea,
                        captureReference: resultCaptureReference,
                        cooldown: 60,
                        confirmationsNeeded: 1,
                        captureDelay: 0
                    });

                    profiles.push(resultProfile);
                } else {
                    console.warn('⚠️ Автопрогнозы включены, но result trigger/data areas настроены не полностью - второй триггер не добавлен');
                }
            }

            console.log(`🎯 Созданы профили триггеров для ${mode} режима:`, {
                count: profiles.length,
                ids: profiles.map(profile => profile.id)
            });
            
            return profiles;
            
        } catch (error) {
            console.error('❌ Ошибка создания профилей триггеров:', error);
            throw error;
        }
    }

    buildEngineProfile({ id, profileType, actionType, triggerArea, dataArea, captureReference, cooldown, confirmationsNeeded, captureDelay }) {
        if (!this.hasTriggerProfile(triggerArea)) {
            throw new Error(`Триггер-профиль ${id} устарел. Выполните re-setup.`);
        }

        if (!this.isValidRegion(dataArea)) {
            throw new Error(`Область данных для ${id} не настроена`);
        }

        const triggerProfile = triggerArea.trigger_profile;
        const sourceFrameSize = captureReference?.source_frame_size || triggerArea.screen_resolution || this.storeManager.getOcrRegions()?.screen_resolution;
        const dataCaptureRatio = this.extractAreaRatio(dataArea, sourceFrameSize, `${id}:data_capture_ratio`);

        return {
            id,
            schema_version: TRIGGER_PROFILE_SCHEMA_VERSION,
            profile_type: profileType,
            action_type: actionType,
            outer_ratio: triggerProfile.outer_ratio,
            inner_ratio: triggerProfile.inner_ratio,
            data_capture_ratio: dataCaptureRatio,
            template_gray_base64: triggerProfile.template_gray_base64,
            thumbnail_hash: triggerProfile.thumbnail_hash,
            feature_mode: triggerProfile.feature_mode,
            keypoints_count: triggerProfile.keypoints_count || 0,
            normalized_template_size: triggerProfile.normalized_template_size || { width: 128, height: 128 },
            hash_max_distance: triggerProfile.hash_threshold || triggerProfile.analysis_info?.hash_threshold || 18,
            orb_distance_threshold: triggerProfile.orb_distance_threshold || triggerProfile.analysis_info?.orb_distance_threshold || 55,
            orb_min_good_matches: triggerProfile.orb_min_good_matches || triggerProfile.analysis_info?.orb_min_good_matches || 10,
            ncc_min_score: triggerProfile.ncc_threshold || triggerProfile.analysis_info?.ncc_threshold || 0.72,
            cooldown,
            confirmations_needed: confirmationsNeeded,
            confirmation_decay: 0.5,
            capture_delay: captureDelay,
            hideCaptureBorder: this.storeManager.get('hideCaptureborder', false),
            source_frame_size: sourceFrameSize,
            capture_reference: captureReference,
            debug_outer_rect: {
                x: triggerArea.x,
                y: triggerArea.y,
                width: triggerArea.width,
                height: triggerArea.height
            }
        };
    }

    assertCaptureReferenceMatches(captureReference, captureParams, label) {
        if (!captureReference) {
            throw new Error(`Не найден capture reference для ${label}`);
        }

        if (captureReference.target_type !== captureParams.targetType) {
            throw new Error(`Текущий режим захвата не совпадает с setup для ${label}. Нужен re-setup.`);
        }

        if (captureParams.targetType !== 'window') {
            return;
        }

        const expectedName = captureReference.target_name || captureReference.selected_target?.name;
        const currentName = captureParams.windowInfo?.name || captureParams.targetId;
        const expectedExecutable = captureReference.selected_target?.executableName;
        const currentExecutable = captureParams.windowInfo?.executableName;

        if (expectedExecutable && currentExecutable && expectedExecutable === currentExecutable) {
            return;
        }

        if (expectedName && currentName && expectedName === currentName) {
            return;
        }

        throw new Error(`Выбрано другое окно захвата для ${label}. Выполните re-setup.`);
    }

    extractAreaRatio(area, sourceFrameSize, areaLabel = 'area') {
        if (this.isValidRatioRect(area?.ratio)) {
            return area.ratio;
        }

        if (!this.isValidRegion(area) || !sourceFrameSize?.width || !sourceFrameSize?.height) {
            throw new Error(`Не удалось вычислить ratio для ${areaLabel}`);
        }

        return {
            x: Number((area.x / sourceFrameSize.width).toFixed(6)),
            y: Number((area.y / sourceFrameSize.height).toFixed(6)),
            width: Number((area.width / sourceFrameSize.width).toFixed(6)),
            height: Number((area.height / sourceFrameSize.height).toFixed(6))
        };
    }

    isValidRatioRect(rect) {
        return !!(
            rect &&
            typeof rect.x === 'number' &&
            typeof rect.y === 'number' &&
            typeof rect.width === 'number' &&
            typeof rect.height === 'number' &&
            rect.width > 0 &&
            rect.height > 0
        );
    }

    isValidRegion(region) {
        return !!(
            region &&
            typeof region.x === 'number' &&
            typeof region.y === 'number' &&
            typeof region.width === 'number' &&
            typeof region.height === 'number' &&
            region.width > 0 &&
            region.height > 0
        );
    }

    hasTriggerProfile(region) {
        return this.isValidRegion(region) &&
            !!region.trigger_profile &&
            region.trigger_profile.schema_version === TRIGGER_PROFILE_SCHEMA_VERSION &&
            this.isValidRatioRect(region.trigger_profile.outer_ratio) &&
            this.isValidRatioRect(region.trigger_profile.inner_ratio) &&
            typeof region.trigger_profile.template_gray_base64 === 'string' &&
            region.trigger_profile.template_gray_base64.length > 0 &&
            typeof region.trigger_profile.thumbnail_hash === 'string' &&
            region.trigger_profile.thumbnail_hash.length > 0;
    }

    isPredictionsBotActive() {
        return !!this.storeManager.get('streamerPredictionsActive', false);
    }

    async handleTriggerFired(triggerData) {
        if (!triggerData?.id) {
            return;
        }

        if (triggerData.id.startsWith('start_battle_') && this.isPredictionsBotActive()) {
            await this.notifyPredictionBattleStart(triggerData.id);
        }
    }

    async notifyPredictionBattleStart(triggerId) {
        try {
            console.log(`🎯 [Predictions] Отправляем battle-start для ${triggerId}`);

            const response = await this.apiManager.post('/api/streamer/bot/battle-start', {
                trigger_id: triggerId,
                timestamp: new Date().toISOString()
            });

            if (response.success && response.data?.success) {
                const message = response.data.message || (
                    response.data.ignored
                        ? 'Автопрогнозы уже ждут результат боя'
                        : 'Автопрогнозы переключены в режим ожидания результата'
                );
                this.eventBus.emit('monitor:status', message);
                return;
            }

            console.warn('⚠️ [Predictions] battle-start не принят сервером:', response.error || response.userMessage);
        } catch (error) {
            console.error('❌ [Predictions] Ошибка отправки battle-start:', error);
        }
    }
    
    // === ОБРАБОТКА ДАННЫХ ДЕЙСТВИЙ ===
    
    async handleActionData(actionData) {
        const actionType = actionData.action_type || 'capture_and_send';

        if (actionType === 'capture_prediction_result') {
            return await this.handlePredictionResultAction(actionData);
        }

        return await this.handlePlayerLookupAction(actionData);
    }

    async handlePlayerLookupAction(actionData) {
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
            formData.append('deck_mode', this.storeManager.getDeckMode() || 'pol');
            
            // Отправляем на сервер через ApiManager (токен добавляется автоматически)
            console.log('📡 [OCR] Отправка запроса на сервер...');
            const response = await this.apiManager.post('/api/ocr/process', formData, {
                headers: formData.getHeaders()
            });
            
            if (response.success) {
                const playerData = response.data;
                console.log('✅ OCR данные получены:', playerData.ocr_result?.nickname || 'Unknown');
                
                // Отправляем событие как обычно
                this.eventBus.emit('monitor:player-found', { playerData });
                this.showPlayerFoundNotification(playerData);
            } else {
                // Игрок не найден - всё равно отправляем данные для обновления UI
                const playerData = response.data || {};
                playerData.player_not_found = true;
                playerData.searched_nickname = playerData.ocr_result?.nickname || 
                                               playerData.searched_nickname || 'Неизвестный';
                console.log('❌ Игрок не найден:', playerData.searched_nickname);
                
                // Отправляем событие для обновления UI с сообщением об ошибке
                this.eventBus.emit('monitor:player-found', { playerData });
            }
            
        } catch (error) {
            console.error('❌ Ошибка обработки ACTION_DATA:', error);
            this.eventBus.emit('monitor:error', `Ошибка обработки: ${error.message}`);
        }
    }

    async handlePredictionResultAction(actionData) {
        try {
            if (!this.isPredictionsBotActive()) {
                console.log('ℹ️ [Predictions] battle-result проигнорирован: бот не активен');
                return;
            }

            console.log('🎯 [Predictions] Обработка результата боя:', actionData.id);
            await this.checkAndRefreshTokens();

            const imageBuffer = Buffer.from(actionData.image_b64, 'base64');
            const formData = new FormData();
            formData.append('screenshot', imageBuffer, {
                filename: 'battle_result.png',
                contentType: 'image/png'
            });

            const response = await this.apiManager.post('/api/streamer/bot/battle-result', formData, {
                headers: formData.getHeaders()
            });

            if (!response.success || !response.data?.success) {
                throw new Error(response.error || response.userMessage || 'Сервер не смог обработать результат боя');
            }

            if (response.data.ignored) {
                console.log('ℹ️ [Predictions] Результат боя проигнорирован:', response.data.message || 'ignored');
                if (response.data.analysis?.result === 'unknown') {
                    this.eventBus.emit('monitor:status', 'Автопрогнозы: результат боя не распознан, прогноз оставлен открытым');
                }
                return;
            }

            const detectedResult = response.data.result === 'win' ? 'победа' : 'поражение';
            this.eventBus.emit('monitor:status', `Автопрогнозы: определен результат боя (${detectedResult})`);

        } catch (error) {
            console.error('❌ [Predictions] Ошибка обработки результата боя:', error);
            this.eventBus.emit('monitor:error', `Автопрогнозы: ${error.message}`);
        }
    }

    // === СОСТОЯНИЕ МОНИТОРА ===

    getStatus() {
        let profilesCount = 0;

        try {
            profilesCount = this.createTriggerProfiles().length;
        } catch (error) {
            profilesCount = 0;
        }

        return {
            isRunning: this.isRunning,
            isRestarting: this.isRestarting,
            hasProcess: !!this.pythonProcess,
            searchMode: this.storeManager.getSearchMode() || 'fast',
            profilesCount
        };
    }

    isMonitorRunning() {
        return this.isRunning;
    }

    // === ОТЛАДОЧНАЯ ИНФОРМАЦИЯ ===

    getDebugInfo() {
        return {
            isRunning: this.isRunning,
            isRestarting: this.isRestarting,
            hasProcess: !!this.pythonProcess,
            processId: this.pythonProcess?.pid,
            searchMode: this.storeManager.getSearchMode(),
            pythonPath: this.getPythonExecutable(),
            scriptPath: this.getPythonScriptPath(),
            engineReady: this.lastEngineReadyPayload,
            lastDebugByTrigger: this.lastDebugByTrigger
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
