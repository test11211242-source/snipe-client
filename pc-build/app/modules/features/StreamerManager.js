const EventEmitter = require('events');

/**
 * StreamerManager - Управление функциями стримера
 * Интегрирован с архитектурой Snipe и системой триггеров
 */
class StreamerManager extends EventEmitter {
    constructor(eventBus, storeManager, apiManager, monitorManager) {
        super();
        
        this.eventBus = eventBus;
        this.storeManager = storeManager;
        this.apiManager = apiManager;
        this.monitorManager = monitorManager;
        
        // Состояние стримера
        this.isActive = false;
        this.currentMode = 'predictions'; // predictions, overlay, alerts
        this.resultTriggerActive = false;
        
        // Настройки автопрогнозов
        this.predictionSettings = {
            enabled: false,
            predictionType: 'win_lose', // win_lose, win_streak, mix
            predictionWindow: 60, // секунд
            winStreakCount: 2,
            delayBetweenPredictions: 5,
            autoCreateNext: true,
            smartPredictions: false
        };

        // Статистика
        this.statistics = {
            totalPredictions: 0,
            successfulPredictions: 0,
            currentStreak: 0,
            lastPrediction: null,
            sessionsToday: 0
        };

        // Состояние Twitch подключения
        this.twitchState = {
            connected: false,
            username: null,
            broadcasterId: null,
            lastCheck: null
        };

        // Текущий активный прогноз
        this.activePrediction = null;
        this.pendingResults = new Map();
        
        this.initialize();
        
        console.log('🎮 StreamerManager инициализирован');
    }

    initialize() {
        try {
            // Загружаем настройки из Store
            this.loadSettings();
            
            // Настраиваем обработчики событий
            this.setupEventHandlers();
            
            // Загружаем статистику
            this.loadStatistics();
            
            console.log('✅ StreamerManager настроен');
            
        } catch (error) {
            console.error('❌ Ошибка инициализации StreamerManager:', error);
        }
    }

    setupEventHandlers() {
        // Слушаем события от MonitorManager
        if (this.eventBus) {
            this.eventBus.on('monitor:player-found', (data) => this.handlePlayerFound(data));
            this.eventBus.on('monitor:started', () => this.onMonitorStarted());
            this.eventBus.on('monitor:stopped', () => this.onMonitorStopped());
            this.eventBus.on('monitor:error', (error) => this.onMonitorError(error));
            
            // События от результатов боя (когда будем добавлять триггер результата)
            this.eventBus.on('battle:result-detected', (data) => this.handleBattleResult(data));
        }

        console.log('🎮 Event handlers StreamerManager настроены');
    }

    // === УПРАВЛЕНИЕ НАСТРОЙКАМИ ===

    loadSettings() {
        try {
            // Загружаем настройки стримера из Store
            const savedSettings = this.storeManager.get('streamerSettings', {});
            this.predictionSettings = { ...this.predictionSettings, ...savedSettings };
            
            // Загружаем состояние Twitch
            const twitchData = this.storeManager.get('twitchAuth', {});
            this.twitchState = { ...this.twitchState, ...twitchData };
            
            console.log('📂 Настройки стримера загружены');
            
        } catch (error) {
            console.error('❌ Ошибка загрузки настроек стримера:', error);
        }
    }

    saveSettings() {
        try {
            this.storeManager.set('streamerSettings', this.predictionSettings);
            console.log('💾 Настройки стримера сохранены');
            
        } catch (error) {
            console.error('❌ Ошибка сохранения настроек стримера:', error);
        }
    }

    updateSettings(newSettings) {
        const oldSettings = { ...this.predictionSettings };
        this.predictionSettings = { ...this.predictionSettings, ...newSettings };
        
        this.saveSettings();
        this.emit('settings:updated', { old: oldSettings, new: this.predictionSettings });
        
        console.log('⚙️ Настройки стримера обновлены:', newSettings);
    }

    // === УПРАВЛЕНИЕ TWITCH АВТОРИЗАЦИЕЙ ===

    async checkTwitchConnection() {
        try {
            console.log('🔍 Проверяем Twitch подключение...');
            
            if (!this.apiManager) {
                throw new Error('ApiManager не подключен');
            }

            const response = await this.apiManager.get('/api/streamer/auth/status');
            
            if (response.success && response.connected) {
                this.twitchState = {
                    connected: true,
                    username: response.username,
                    broadcasterId: response.broadcaster_id,
                    lastCheck: new Date().toISOString()
                };
                
                this.storeManager.set('twitchAuth', this.twitchState);
                this.emit('twitch:connected', this.twitchState);
                
                console.log(`✅ Twitch подключен: @${response.username}`);
                return { success: true, data: this.twitchState };
                
            } else {
                this.twitchState.connected = false;
                this.emit('twitch:disconnected');
                
                console.log('ℹ️ Twitch не подключен');
                return { success: false, message: 'Twitch не подключен' };
            }
            
        } catch (error) {
            console.error('❌ Ошибка проверки Twitch:', error);
            this.twitchState.connected = false;
            this.emit('twitch:error', error.message);
            
            return { success: false, error: error.message };
        }
    }

    async getTwitchAuthUrl() {
        try {
            if (!this.apiManager) {
                throw new Error('ApiManager не подключен');
            }

            const response = await this.apiManager.get('/api/streamer/auth/connect');
            
            if (response.success && response.auth_url) {
                console.log('🔗 Получена ссылка авторизации Twitch');
                return { success: true, authUrl: response.auth_url };
            } else {
                throw new Error(response.error || 'Не удалось получить ссылку авторизации');
            }
            
        } catch (error) {
            console.error('❌ Ошибка получения ссылки авторизации:', error);
            return { success: false, error: error.message };
        }
    }

    async disconnectTwitch() {
        try {
            if (!this.apiManager) {
                throw new Error('ApiManager не подключен');
            }

            const response = await this.apiManager.post('/api/streamer/auth/disconnect');
            
            if (response.success) {
                this.twitchState = {
                    connected: false,
                    username: null,
                    broadcasterId: null,
                    lastCheck: new Date().toISOString()
                };
                
                this.storeManager.delete('twitchAuth');
                this.emit('twitch:disconnected');
                
                console.log('🔌 Twitch отключен');
                return { success: true };
                
            } else {
                throw new Error(response.error || 'Ошибка отключения');
            }
            
        } catch (error) {
            console.error('❌ Ошибка отключения Twitch:', error);
            return { success: false, error: error.message };
        }
    }

    // === УПРАВЛЕНИЕ БОТОМ ПРОГНОЗОВ ===

    async startPredictionBot() {
        try {
            console.log('🤖 Запуск бота прогнозов...');
            
            // Проверяем подключение к Twitch
            const twitchCheck = await this.checkTwitchConnection();
            if (!twitchCheck.success) {
                throw new Error('Twitch канал не подключен');
            }

            // Проверяем настройки областей OCR
            if (!this.storeManager.hasOcrRegions()) {
                throw new Error('OCR области не настроены');
            }

            // Включаем триггер результата боя
            await this.startResultTrigger();

            this.predictionSettings.enabled = true;
            this.isActive = true;
            this.saveSettings();

            this.emit('bot:started');
            console.log('✅ Бот прогнозов запущен');
            
            return { success: true };
            
        } catch (error) {
            console.error('❌ Ошибка запуска бота:', error);
            this.predictionSettings.enabled = false;
            this.isActive = false;
            
            return { success: false, error: error.message };
        }
    }

    async stopPredictionBot() {
        try {
            console.log('🛑 Остановка бота прогнозов...');
            
            // Останавливаем триггер результата боя
            await this.stopResultTrigger();
            
            // Закрываем активный прогноз если есть
            if (this.activePrediction) {
                await this.closePrediction('CANCELED');
            }

            this.predictionSettings.enabled = false;
            this.isActive = false;
            this.saveSettings();

            this.emit('bot:stopped');
            console.log('✅ Бот прогнозов остановлен');
            
            return { success: true };
            
        } catch (error) {
            console.error('❌ Ошибка остановки бота:', error);
            return { success: false, error: error.message };
        }
    }

    // === УПРАВЛЕНИЕ ТРИГГЕРАМИ РЕЗУЛЬТАТА ===

    async startResultTrigger() {
        try {
            console.log('🎯 Запуск триггера результата боя...');
            
            if (!this.monitorManager) {
                throw new Error('MonitorManager не подключен');
            }

            // Создаем дополнительный профиль триггера для результата боя
            const resultTriggerProfile = this.createResultTriggerProfile();
            
            // TODO: Интегрировать с системой триггеров MonitorManager
            // Пока что просто отмечаем как активный
            this.resultTriggerActive = true;
            
            console.log('✅ Триггер результата боя активирован');
            return { success: true };
            
        } catch (error) {
            console.error('❌ Ошибка запуска триггера результата:', error);
            return { success: false, error: error.message };
        }
    }

    async stopResultTrigger() {
        try {
            console.log('🎯 Остановка триггера результата боя...');
            
            // TODO: Отключить от системы триггеров MonitorManager
            this.resultTriggerActive = false;
            
            console.log('✅ Триггер результата боя деактивирован');
            return { success: true };
            
        } catch (error) {
            console.error('❌ Ошибка остановки триггера результата:', error);
            return { success: false, error: error.message };
        }
    }

    createResultTriggerProfile() {
        // Создаем профиль триггера для детекции результата боя
        const regions = this.storeManager.getOcrRegions();
        
        if (!regions || !regions.battle_result_area) {
            // Если нет специальной области для результата, используем область данных
            console.warn('⚠️ Область battle_result_area не найдена, используем normal_data_area');
        }

        const profile = {
            id: 'battle_result_detector',
            monitor_region: regions.battle_result_area || regions.normal_data_area,
            data_capture_region: regions.battle_result_area || regions.normal_data_area,
            
            // Параметры для детекции результата
            action_type: "detect_battle_result",
            capture_delay: 0, // Мгновенная детекция результата
            cooldown: 5, // 5 секунд между проверками результата
            confirmations_needed: 1, // Достаточно одного подтверждения
            
            // Цвета для детекции победы/поражения
            victory_colors: [[255, 215, 0], [255, 255, 0]], // Золотые оттенки
            defeat_colors: [[255, 0, 0], [200, 0, 0]], // Красные оттенки
            
            // Настройки детекции
            color_tolerance: 40,
            min_color_percentage: 5 // Минимум 5% пикселей нужного цвета
        };

        return profile;
    }

    // === ОБРАБОТКА СОБЫТИЙ МОНИТОРИНГА ===

    handlePlayerFound(data) {
        console.log('👤 Игрок найден, проверяем нужность создания прогноза');
        
        if (!this.isActive || !this.predictionSettings.enabled) {
            return;
        }

        // Создаем прогноз если нет активного
        if (!this.activePrediction) {
            this.createPrediction();
        }
    }

    handleBattleResult(data) {
        console.log('⚔️ Получен результат боя:', data.result);
        
        if (!this.isActive || !this.activePrediction) {
            return;
        }

        // Закрываем активный прогноз с результатом
        this.closePrediction(data.result === 'victory' ? 'WIN' : 'LOSE');
    }

    onMonitorStarted() {
        console.log('📊 Мониторинг запущен');
        this.emit('monitor:status', 'Мониторинг активен');
    }

    onMonitorStopped() {
        console.log('📊 Мониторинг остановлен');
        this.emit('monitor:status', 'Мониторинг неактивен');
        
        // Если был активен бот прогнозов, останавливаем его
        if (this.isActive) {
            this.stopPredictionBot();
        }
    }

    onMonitorError(error) {
        console.error('📊 Ошибка мониторинга:', error);
        this.emit('monitor:error', error);
    }

    // === УПРАВЛЕНИЕ ПРОГНОЗАМИ ===

    async createPrediction() {
        try {
            if (!this.twitchState.connected) {
                throw new Error('Twitch не подключен');
            }

            console.log('🎯 Создаем новый прогноз...');

            const predictionData = this.generatePredictionData();
            
            const response = await this.apiManager.post('/api/streamer/predictions/create', predictionData);
            
            if (response.success) {
                this.activePrediction = {
                    id: response.prediction_id,
                    title: predictionData.title,
                    outcomes: predictionData.outcomes,
                    created_at: new Date().toISOString(),
                    prediction_window: this.predictionSettings.predictionWindow,
                    status: 'ACTIVE'
                };
                
                this.statistics.totalPredictions++;
                this.saveStatistics();
                
                this.emit('prediction:created', this.activePrediction);
                console.log(`✅ Прогноз создан: ${predictionData.title}`);
                
            } else {
                throw new Error(response.error || 'Ошибка создания прогноза');
            }
            
        } catch (error) {
            console.error('❌ Ошибка создания прогноза:', error);
            this.emit('prediction:error', error.message);
        }
    }

    generatePredictionData() {
        // Базовые типы прогнозов
        const types = {
            'win_lose': () => {
                let title = 'Выиграю этот бой?';
                
                // Умные прогнозы: учитываем статистику
                if (this.predictionSettings.smartPredictions && this.statistics.currentStreak >= 3) {
                    title = `Продолжу серию из ${this.statistics.currentStreak} побед?`;
                }
                
                return {
                    title,
                    outcomes: [
                        { title: 'Да, выиграет!', color: 'BLUE' },
                        { title: 'Нет, проиграет!', color: 'PINK' }
                    ]
                };
            },
            'win_streak': () => {
                let count = this.predictionSettings.winStreakCount;
                
                // Умные прогнозы: адаптируем количество на основе статистики
                if (this.predictionSettings.smartPredictions) {
                    const successRate = this.statistics.totalPredictions > 0 
                        ? (this.statistics.successfulPredictions / this.statistics.totalPredictions) * 100
                        : 50;
                    
                    // Если высокая точность, увеличиваем сложность
                    if (successRate > 75 && count < 5) {
                        count = Math.min(count + 1, 5);
                    }
                    // Если низкая точность, уменьшаем сложность
                    else if (successRate < 40 && count > 2) {
                        count = Math.max(count - 1, 2);
                    }
                }
                
                return {
                    title: `Выиграю ${count} боя подряд?`,
                    outcomes: [
                        { title: `Да, ${count} подряд!`, color: 'BLUE' },
                        { title: 'Нет, не получится!', color: 'PINK' }
                    ]
                };
            },
            'mix': () => {
                const randomTypes = ['win_lose', 'win_streak'];
                let randomType = randomTypes[Math.floor(Math.random() * randomTypes.length)];
                
                // Умные прогнозы: выбираем тип на основе статистики
                if (this.predictionSettings.smartPredictions) {
                    const winRate = this.statistics.totalPredictions > 0 
                        ? (this.statistics.successfulPredictions / this.statistics.totalPredictions) * 100
                        : 50;
                    
                    // Если высокая точность, чаще выбираем сложные прогнозы
                    if (winRate > 70) {
                        randomType = Math.random() < 0.7 ? 'win_streak' : 'win_lose';
                    } else {
                        randomType = Math.random() < 0.3 ? 'win_streak' : 'win_lose';
                    }
                }
                
                return types[randomType]();
            }
        };

        const generator = types[this.predictionSettings.predictionType] || types['win_lose'];
        const data = generator();
        
        // Логируем создание умного прогноза
        if (this.predictionSettings.smartPredictions) {
            console.log(`🧠 Умный прогноз: ${data.title} (Точность: ${Math.round((this.statistics.successfulPredictions / Math.max(this.statistics.totalPredictions, 1)) * 100)}%)`);
        }
        
        return {
            ...data,
            prediction_window: this.predictionSettings.predictionWindow,
            smart_mode: this.predictionSettings.smartPredictions
        };
    }

    async closePrediction(result) {
        try {
            if (!this.activePrediction) {
                return;
            }

            console.log(`🏁 Закрываем прогноз с результатом: ${result}`);

            const response = await this.apiManager.post(`/api/streamer/predictions/${this.activePrediction.id}/close`, {
                status: result,
                winning_outcome_id: this.getWinningOutcomeId(result)
            });
            
            if (response.success) {
                // Обновляем статистику
                if (result === 'WIN') {
                    this.statistics.successfulPredictions++;
                    this.statistics.currentStreak++;
                } else {
                    this.statistics.currentStreak = 0;
                }
                
                this.statistics.lastPrediction = {
                    ...this.activePrediction,
                    result: result,
                    closed_at: new Date().toISOString()
                };
                
                this.saveStatistics();
                
                this.emit('prediction:closed', {
                    prediction: this.activePrediction,
                    result: result
                });
                
                console.log('✅ Прогноз закрыт');
                
                // Планируем следующий прогноз
                if (this.predictionSettings.autoCreateNext) {
                    setTimeout(() => {
                        if (this.isActive && this.predictionSettings.enabled) {
                            // Следующий прогноз будет создан при обнаружении следующего игрока
                        }
                    }, this.predictionSettings.delayBetweenPredictions * 1000);
                }
                
            } else {
                throw new Error(response.error || 'Ошибка закрытия прогноза');
            }
            
        } catch (error) {
            console.error('❌ Ошибка закрытия прогноза:', error);
            this.emit('prediction:error', error.message);
        } finally {
            this.activePrediction = null;
        }
    }

    getWinningOutcomeId(result) {
        if (!this.activePrediction) return null;
        
        // Определяем победивший вариант на основе результата
        const outcomes = this.activePrediction.outcomes;
        
        if (result === 'WIN') {
            // Ищем положительный исход (обычно первый)
            return outcomes[0]?.id;
        } else {
            // Ищем отрицательный исход (обычно второй)
            return outcomes[1]?.id;
        }
    }

    // === СТАТИСТИКА ===

    loadStatistics() {
        try {
            const savedStats = this.storeManager.get('streamerStatistics', {});
            this.statistics = { ...this.statistics, ...savedStats };
            
            // Обнуляем сессионную статистику при новом запуске
            this.statistics.sessionsToday = (this.statistics.sessionsToday || 0) + 1;
            
            console.log('📊 Статистика стримера загружена');
            
        } catch (error) {
            console.error('❌ Ошибка загрузки статистики:', error);
        }
    }

    saveStatistics() {
        try {
            this.storeManager.set('streamerStatistics', this.statistics);
            console.log('💾 Статистика стримера сохранена');
            
        } catch (error) {
            console.error('❌ Ошибка сохранения статистики:', error);
        }
    }

    getStatistics() {
        const successRate = this.statistics.totalPredictions > 0 
            ? Math.round((this.statistics.successfulPredictions / this.statistics.totalPredictions) * 100)
            : 0;

        return {
            total_predictions: this.statistics.totalPredictions,
            successful_predictions: this.statistics.successfulPredictions,
            success_rate: successRate,
            current_streak: this.statistics.currentStreak,
            sessions_today: this.statistics.sessionsToday,
            last_prediction: this.statistics.lastPrediction,
            active_prediction: this.activePrediction
        };
    }

    // === СТАТУС И ОТЛАДКА ===

    getStatus() {
        return {
            is_active: this.isActive,
            prediction_bot_enabled: this.predictionSettings.enabled,
            twitch_connected: this.twitchState.connected,
            twitch_username: this.twitchState.username,
            result_trigger_active: this.resultTriggerActive,
            current_mode: this.currentMode,
            active_prediction: this.activePrediction,
            statistics: this.getStatistics(),
            settings: this.predictionSettings
        };
    }

    getDebugInfo() {
        return {
            status: this.getStatus(),
            twitch_state: this.twitchState,
            pending_results: Array.from(this.pendingResults.keys()),
            event_listeners: this.listenerCount('*')
        };
    }

    // === ОЧИСТКА ===

    cleanup() {
        console.log('🧹 Очистка StreamerManager...');
        
        // Останавливаем бота если активен
        if (this.isActive) {
            this.stopPredictionBot();
        }
        
        // Очищаем интервалы и таймеры
        this.removeAllListeners();
        
        console.log('✅ StreamerManager очищен');
    }
}

module.exports = StreamerManager;