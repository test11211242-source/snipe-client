/**
 * Streamer Panel - JavaScript для современной панели стримера
 * Интегрированный с архитектурой Snipe
 */

console.log('[Streamer] Загружается панель стримера...');

class StreamerPanel {
    constructor() {
        this.currentTab = 'predictions';
        this.isInitialized = false;
        this.updateInterval = null;
        
        // Состояние бота
        this.botState = {
            isActive: false,
            status: 'idle',
            predictions: {
                total: 0,
                successRate: 0,
                currentStreak: 0,
                active: null
            }
        };

        // Настройки прогнозов
        this.predictionSettings = {
            predictionType: 'win_lose',
            predictionWindow: 60,
            winStreakCount: 2,
            delayBetweenPredictions: 5,
            autoCreateNext: true,
            smartPredictions: false
        };

        // Состояние Twitch
        this.twitchState = {
            connected: false,
            username: null,
            checking: false
        };

        // Состояние deck sharing
        this.deckSharingState = {
            enabled: false,
            loading: true,
            error: null
        };

        this.monitorState = {
            isRunning: false,
            loading: true
        };

        this.predictionAreasState = {
            triggerConfigured: false,
            triggerArea: null,
            dataConfigured: false,
            dataArea: null,
            loading: true
        };

        this.streamTitleState = {
            loading: true,
            settings: null,
            accounts: [],
            session: null,
            twitch: null,
            recentResults: [],
            previewTitle: '#134·972🏅|8W-7L|Δ-32|Название стрима',
            error: null
        };

        console.log('[Streamer] StreamerPanel создан');
        this.init();
    }

    async init() {
        try {
            console.log('[Streamer] Инициализация панели...');
            
            // Ждем готовности DOM
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => this.setup());
            } else {
                await this.setup();
            }
            
        } catch (error) {
            console.error('❌ [Streamer] Ошибка инициализации:', error);
        }
    }

    async setup() {
        try {
            console.log('[Streamer] Настройка интерфейса...');
            
            // Настраиваем обработчики событий
            this.setupEventListeners();
            
            // Настраиваем систему вкладок
            this.setupTabs();
            
            // Проверяем авторизацию перед загрузкой данных
            const hasAuth = await this.checkAppAuthorization();
            if (!hasAuth) {
                this.showMessage('❌ Войдите в приложение для доступа к панели стримера', 'warning');
                return;
            }
            
            // Проверяем Twitch подключение
            await this.checkTwitchConnection();

            // Проверяем готовность локального мониторинга и result trigger
            await this.refreshPredictionEnvironment();
             
            // Инициализируем deck sharing
            await this.initializeDeckSharing();

            // Инициализируем серверное автоназвание
            await this.initializeStreamTitle();
            
            // Обновляем статус бота
            await this.updateBotStatus();
            
            // Запускаем периодические обновления
            this.startPeriodicUpdates();
            
            this.isInitialized = true;
            console.log('✅ [Streamer] Панель стримера инициализирована');
            
        } catch (error) {
            console.error('❌ [Streamer] Ошибка настройки:', error);
        }
    }

    setupEventListeners() {
        // Кнопка "Назад"
        const backBtn = document.querySelector('.back-btn');
        if (backBtn) {
            backBtn.addEventListener('click', () => this.goBack());
        }

        // Кнопки Twitch авторизации
        const connectTwitchBtn = document.getElementById('connect-twitch-btn');
        const disconnectTwitchBtn = document.getElementById('disconnect-twitch-btn');
        
        if (connectTwitchBtn) {
            connectTwitchBtn.addEventListener('click', () => this.connectTwitch());
        }
        
        if (disconnectTwitchBtn) {
            disconnectTwitchBtn.addEventListener('click', () => this.disconnectTwitch());
        }

        // Кнопки управления ботом
        const startBotBtn = document.getElementById('start-bot-btn');
        const stopBotBtn = document.getElementById('stop-bot-btn');
        
        if (startBotBtn) {
            startBotBtn.addEventListener('click', () => this.startBot());
        }
        
        if (stopBotBtn) {
            stopBotBtn.addEventListener('click', () => this.stopBot());
        }

        const configureResultTriggerAreaBtn = document.getElementById('configure-result-trigger-area-btn');
        if (configureResultTriggerAreaBtn) {
            configureResultTriggerAreaBtn.addEventListener('click', () => this.configureResultTriggerArea());
        }

        const configureResultDataAreaBtn = document.getElementById('configure-result-data-area-btn');
        if (configureResultDataAreaBtn) {
            configureResultDataAreaBtn.addEventListener('click', () => this.configureResultDataArea());
        }

        // Настройки прогнозов
        this.setupPredictionSettings();

        // Deck sharing переключатель
        const deckSharingToggle = document.getElementById('deckSharingToggle');
        if (deckSharingToggle) {
            deckSharingToggle.addEventListener('change', (e) => this.toggleDeckSharing(e.target.checked));
        }

        this.setupStreamTitleControls();

        console.log('[Streamer] Event listeners настроены');
    }

    setupStreamTitleControls() {
        const enabledToggle = document.getElementById('streamTitleEnabled');
        const addAccountBtn = document.getElementById('stream-title-add-account-btn');
        const saveSettingsBtn = document.getElementById('stream-title-save-settings-btn');
        const resetBtn = document.getElementById('stream-title-reset-btn');
        const pauseBtn = document.getElementById('stream-title-pause-btn');
        const undoBtn = document.getElementById('stream-title-undo-btn');
        const restoreBtn = document.getElementById('stream-title-restore-btn');

        if (enabledToggle) {
            enabledToggle.addEventListener('change', (event) => this.toggleStreamTitle(event.target.checked));
        }
        if (addAccountBtn) {
            addAccountBtn.addEventListener('click', () => this.addStreamTitleAccount());
        }
        if (saveSettingsBtn) {
            saveSettingsBtn.addEventListener('click', () => this.saveStreamTitleSettings());
        }
        if (resetBtn) {
            resetBtn.addEventListener('click', () => this.resetStreamTitleSession());
        }
        if (pauseBtn) {
            pauseBtn.addEventListener('click', () => this.toggleStreamTitlePause());
        }
        if (undoBtn) {
            undoBtn.addEventListener('click', () => this.undoStreamTitleResult());
        }
        if (restoreBtn) {
            restoreBtn.addEventListener('click', () => this.restoreOriginalStreamTitle());
        }
    }

    setupTabs() {
        const tabItems = document.querySelectorAll('.tab-item');
        
        tabItems.forEach(item => {
            item.addEventListener('click', () => {
                const tabName = item.dataset.tab;
                if (tabName) {
                    this.switchTab(tabName);
                }
            });
        });

        console.log('[Streamer] Система вкладок настроена');
    }

    setupPredictionSettings() {
        // Загружаем сохраненные настройки
        this.loadPredictionSettings();

        // Обработчики для настроек
        const predictionType = document.getElementById('prediction-type');
        const predictionWindow = document.getElementById('prediction-window');
        const winStreakCount = document.getElementById('win-streak-count');
        const delayBetween = document.getElementById('delay-between-predictions');
        const autoCreateNext = document.getElementById('auto-create-next');
        const smartPredictions = document.getElementById('smart-predictions');

        if (predictionType) {
            predictionType.addEventListener('change', (e) => {
                this.predictionSettings.predictionType = e.target.value;
                this.updateStreakSettings();
                this.savePredictionSettings();
                console.log('[Streamer] Тип прогноза изменен:', e.target.value);
            });
        }

        if (predictionWindow) {
            predictionWindow.addEventListener('change', (e) => {
                this.predictionSettings.predictionWindow = parseInt(e.target.value);
                this.savePredictionSettings();
                console.log('[Streamer] Время участия изменено:', e.target.value);
            });
        }

        if (winStreakCount) {
            winStreakCount.addEventListener('change', (e) => {
                this.predictionSettings.winStreakCount = parseInt(e.target.value);
                this.savePredictionSettings();
                console.log('[Streamer] Количество побед подряд изменено:', e.target.value);
            });
        }

        if (delayBetween) {
            delayBetween.addEventListener('change', (e) => {
                this.predictionSettings.delayBetweenPredictions = parseInt(e.target.value);
                this.savePredictionSettings();
                console.log('[Streamer] Задержка между прогнозами изменена:', e.target.value);
            });
        }

        if (autoCreateNext) {
            autoCreateNext.addEventListener('change', (e) => {
                this.predictionSettings.autoCreateNext = e.target.checked;
                this.savePredictionSettings();
                console.log('[Streamer] Автосоздание изменено:', e.target.checked);
            });
        }

        if (smartPredictions) {
            smartPredictions.addEventListener('change', (e) => {
                this.predictionSettings.smartPredictions = e.target.checked;
                this.savePredictionSettings();
                console.log('[Streamer] Умные прогнозы изменены:', e.target.checked);
            });
        }

        // Обновляем UI на основе текущих настроек
        this.updateStreakSettings();
        
        console.log('[Streamer] Настройки прогнозов инициализированы');
    }

    loadPredictionSettings() {
        try {
            const saved = localStorage.getItem('streamer_prediction_settings');
            if (saved) {
                const settings = JSON.parse(saved);
                this.predictionSettings = { ...this.predictionSettings, ...settings };
                this.applySettingsToUI();
                console.log('[Streamer] Настройки прогнозов загружены из localStorage');
            }
        } catch (error) {
            console.error('[Streamer] Ошибка загрузки настроек:', error);
        }
    }

    savePredictionSettings() {
        try {
            localStorage.setItem('streamer_prediction_settings', JSON.stringify(this.predictionSettings));
            console.log('[Streamer] Настройки прогнозов сохранены');
        } catch (error) {
            console.error('[Streamer] Ошибка сохранения настроек:', error);
        }
    }

    applySettingsToUI() {
        const predictionType = document.getElementById('prediction-type');
        const predictionWindow = document.getElementById('prediction-window');
        const winStreakCount = document.getElementById('win-streak-count');
        const delayBetween = document.getElementById('delay-between-predictions');
        const autoCreateNext = document.getElementById('auto-create-next');
        const smartPredictions = document.getElementById('smart-predictions');

        if (predictionType) predictionType.value = this.predictionSettings.predictionType;
        if (predictionWindow) predictionWindow.value = this.predictionSettings.predictionWindow;
        if (winStreakCount) winStreakCount.value = this.predictionSettings.winStreakCount;
        if (delayBetween) delayBetween.value = this.predictionSettings.delayBetweenPredictions;
        if (autoCreateNext) autoCreateNext.checked = this.predictionSettings.autoCreateNext;
        if (smartPredictions) smartPredictions.checked = this.predictionSettings.smartPredictions;
    }

    updateStreakSettings() {
        const winStreakGroup = document.getElementById('win-streak-count').parentElement;
        const isStreakType = this.predictionSettings.predictionType === 'win_streak';
        
        if (winStreakGroup) {
            winStreakGroup.style.opacity = isStreakType ? '1' : '0.5';
            winStreakGroup.style.pointerEvents = isStreakType ? 'auto' : 'none';
        }
    }

    async refreshPredictionEnvironment() {
        await Promise.all([
            this.updateMonitorStatus(),
            this.loadPredictionAreas()
        ]);

        this.updatePredictionRequirementsUI();
    }

    async updateMonitorStatus() {
        try {
            this.monitorState.loading = true;

            if (!window.electronAPI?.monitor?.getStatus) {
                this.monitorState.isRunning = false;
                return;
            }

            const result = await window.electronAPI.monitor.getStatus();
            this.monitorState.isRunning = !!(result?.success && result.status?.isRunning);
        } catch (error) {
            console.error('❌ [Streamer] Ошибка получения статуса мониторинга:', error);
            this.monitorState.isRunning = false;
        } finally {
            this.monitorState.loading = false;
        }
    }

    async loadPredictionAreas() {
        try {
            this.predictionAreasState.loading = true;

            if (!window.electronAPI?.streamerConfig?.getResultConfig) {
                this.predictionAreasState.triggerConfigured = false;
                this.predictionAreasState.triggerArea = null;
                this.predictionAreasState.dataConfigured = false;
                this.predictionAreasState.dataArea = null;
                return;
            }

            const result = await window.electronAPI.streamerConfig.getResultConfig();
            const config = result?.config || {};

            this.predictionAreasState.triggerArea = config.result_trigger_area || null;
            this.predictionAreasState.triggerConfigured = !!config.result_trigger_area;
            this.predictionAreasState.dataArea = config.result_data_area || null;
            this.predictionAreasState.dataConfigured = !!config.result_data_area;
        } catch (error) {
            console.error('❌ [Streamer] Ошибка получения зон результата:', error);
            this.predictionAreasState.triggerConfigured = false;
            this.predictionAreasState.triggerArea = null;
            this.predictionAreasState.dataConfigured = false;
            this.predictionAreasState.dataArea = null;
        } finally {
            this.predictionAreasState.loading = false;
        }
    }

    updatePredictionRequirementsUI() {
        const monitorStatus = document.getElementById('monitor-prereq-status');
        const resultTriggerAreaStatus = document.getElementById('result-trigger-area-status');
        const resultDataAreaStatus = document.getElementById('result-data-area-status');

        if (monitorStatus) {
            if (this.monitorState.loading) {
                monitorStatus.textContent = 'Проверяем...';
                monitorStatus.style.color = 'var(--warning)';
            } else if (this.monitorState.isRunning) {
                monitorStatus.textContent = 'Снайп-мониторинг активен';
                monitorStatus.style.color = 'var(--success)';
            } else {
                monitorStatus.textContent = 'Сначала запустите систему снайпа';
                monitorStatus.style.color = 'var(--error)';
            }
        }

        if (resultTriggerAreaStatus) {
            if (this.predictionAreasState.loading) {
                resultTriggerAreaStatus.textContent = 'Проверяем...';
                resultTriggerAreaStatus.style.color = 'var(--warning)';
            } else if (this.predictionAreasState.triggerConfigured) {
                const area = this.predictionAreasState.triggerArea;
                resultTriggerAreaStatus.textContent = `Настроена: ${area.width}x${area.height}`;
                resultTriggerAreaStatus.style.color = 'var(--success)';
            } else {
                resultTriggerAreaStatus.textContent = 'Не настроена';
                resultTriggerAreaStatus.style.color = 'var(--warning)';
            }
        }

        if (resultDataAreaStatus) {
            if (this.predictionAreasState.loading) {
                resultDataAreaStatus.textContent = 'Проверяем...';
                resultDataAreaStatus.style.color = 'var(--warning)';
            } else if (this.predictionAreasState.dataConfigured) {
                const area = this.predictionAreasState.dataArea;
                resultDataAreaStatus.textContent = `Настроена: ${area.width}x${area.height}`;
                resultDataAreaStatus.style.color = 'var(--success)';
            } else {
                resultDataAreaStatus.textContent = 'Не настроена';
                resultDataAreaStatus.style.color = 'var(--warning)';
            }
        }

        this.updateBotUI();
    }

    canStartPredictions() {
        return this.twitchState.connected &&
            this.monitorState.isRunning &&
            this.predictionAreasState.triggerConfigured &&
            this.predictionAreasState.dataConfigured;
    }

    getPredictionStartBlocker() {
        if (!this.twitchState.connected) {
            return 'Для запуска подключите Twitch канал';
        }

        if (!this.monitorState.isRunning) {
            return 'Сначала запустите систему снайпа';
        }

        if (!this.predictionAreasState.triggerConfigured) {
            return 'Настройте trigger area результата';
        }

        if (!this.predictionAreasState.dataConfigured) {
            return 'Настройте data area результата';
        }

        return 'Готов к запуску';
    }

    buildPredictionPayload() {
        return {
            prediction_type: this.predictionSettings.predictionType,
            prediction_window: this.predictionSettings.predictionWindow,
            win_streak_count: this.predictionSettings.winStreakCount,
            delay_between_predictions: this.predictionSettings.delayBetweenPredictions,
            auto_create_next: this.predictionSettings.autoCreateNext,
            smart_predictions: this.predictionSettings.smartPredictions
        };
    }

    async applyPredictionMonitorMode(enabled, reason) {
        if (!window.electronAPI?.store || !window.electronAPI?.monitor) {
            throw new Error('Electron API для управления мониторингом недоступен');
        }

        const previousValue = await window.electronAPI.store.get('streamerPredictionMonitorEnabled', false);
        await window.electronAPI.store.set('streamerPredictionMonitorEnabled', enabled);

        if (!this.monitorState.isRunning) {
            return;
        }

        const restartResult = await window.electronAPI.monitor.restart(reason);
        if (!restartResult?.success) {
            await window.electronAPI.store.set('streamerPredictionMonitorEnabled', previousValue);
            throw new Error(restartResult?.error || 'Не удалось перезапустить мониторинг');
        }

        await this.updateMonitorStatus();
    }

    async openPredictionAreaSetup(setupType, successMessage) {
        try {
            if (!window.electronAPI?.ocr?.setupRegions || !window.electronAPI?.monitor?.getCaptureTarget) {
                throw new Error('Настройка области результата недоступна в этой сборке');
            }

            const captureTargetResult = await window.electronAPI.monitor.getCaptureTarget();
            const target = captureTargetResult?.target || null;
            const setupContext = {
                setupType,
                mode: target?.targetType === 'window' ? 'window' : 'screen',
                targetWindow: target?.targetType === 'window' ? target : null
            };

            await window.electronAPI.ocr.setupRegions(setupContext);
            this.showMessage(successMessage, 'info');
        } catch (error) {
            console.error('❌ [Streamer] Ошибка открытия настройки streamer area:', error);
            this.showMessage('Не удалось открыть настройку области: ' + error.message, 'error');
        }
    }

    async configureResultTriggerArea() {
        return this.openPredictionAreaSetup(
            'streamer_result_trigger_area',
            'Окно настройки trigger area открыто'
        );
    }

    async configureResultDataArea() {
        return this.openPredictionAreaSetup(
            'streamer_result_data_area',
            'Окно настройки data area открыто'
        );
    }

    switchTab(tabName) {
        console.log(`[Streamer] Переключение на вкладку: ${tabName}`);

        // Убираем активный класс со всех вкладок
        document.querySelectorAll('.tab-item').forEach(item => {
            item.classList.remove('active');
        });

        // Добавляем активный класс к выбранной вкладке
        const selectedTab = document.querySelector(`[data-tab="${tabName}"]`);
        if (selectedTab) {
            selectedTab.classList.add('active');
        }

        // Скрываем все панели контента
        document.querySelectorAll('.content-panel').forEach(panel => {
            panel.classList.remove('active');
        });

        // Показываем выбранную панель
        const selectedPanel = document.querySelector(`[data-panel="${tabName}"]`);
        if (selectedPanel) {
            selectedPanel.classList.add('active');
        }

        this.currentTab = tabName;

        // Обновляем данные для активной вкладки
        this.onTabChanged(tabName);
    }

    onTabChanged(tabName) {
        switch (tabName) {
            case 'predictions':
                this.updatePredictionsTab();
                break;
            case 'twitch':
                this.updateTwitchTab();
                break;
            case 'stream-title':
                this.updateStreamTitleUI();
                break;
            // Добавим обработчики для других вкладок позже
        }
    }

    async checkTwitchConnection() {
        try {
            console.log('[Streamer] Проверяем Twitch подключение...');
            
            this.twitchState.checking = true;
            this.updateTwitchUI();

            // Проверяем через API
            const response = await this.apiCall('/api/streamer/auth/status');
            
            if (response.success && response.connected) {
                this.twitchState.connected = true;
                this.twitchState.username = response.username;
                console.log(`✅ [Streamer] Twitch подключен: @${response.username}`);
            } else {
                this.twitchState.connected = false;
                this.twitchState.username = null;
                console.log('ℹ️ [Streamer] Twitch не подключен');
            }

        } catch (error) {
            console.error('❌ [Streamer] Ошибка проверки Twitch:', error);
            this.twitchState.connected = false;
            this.twitchState.username = null;
            this.showMessage('Ошибка подключения к серверу', 'error');
        } finally {
            this.twitchState.checking = false;
            this.updateTwitchUI();
        }
    }

    updateTwitchUI() {
        const statusContainer = document.getElementById('twitch-auth-status');
        const connectBtn = document.getElementById('connect-twitch-btn');
        const disconnectBtn = document.getElementById('disconnect-twitch-btn');
        const twitchStatusDot = document.getElementById('twitch-status');

        if (!statusContainer) return;

        if (this.twitchState.checking) {
            statusContainer.innerHTML = `
                <div class="auth-status loading">
                    <div class="status-dot info"></div>
                    <div>
                        <div>Проверяем подключение...</div>
                        <small>Загрузка данных авторизации</small>
                    </div>
                </div>
            `;
            if (connectBtn) connectBtn.style.display = 'none';
            if (disconnectBtn) disconnectBtn.style.display = 'none';
            
        } else if (this.twitchState.connected) {
            statusContainer.innerHTML = `
                <div class="auth-status connected">
                    <div class="status-dot success"></div>
                    <div>
                        <div>Twitch подключен</div>
                        <small>@${this.twitchState.username || 'Неизвестно'}</small>
                    </div>
                </div>
            `;
            if (connectBtn) connectBtn.style.display = 'none';
            if (disconnectBtn) disconnectBtn.style.display = 'inline-flex';
            if (twitchStatusDot) twitchStatusDot.className = 'status-dot success';
            
        } else {
            statusContainer.innerHTML = `
                <div class="auth-status disconnected">
                    <div class="status-dot error"></div>
                    <div>
                        <div>Twitch не подключен</div>
                        <small>Подключите канал для создания прогнозов</small>
                    </div>
                </div>
            `;
            if (connectBtn) connectBtn.style.display = 'inline-flex';
            if (disconnectBtn) disconnectBtn.style.display = 'none';
            if (twitchStatusDot) twitchStatusDot.className = 'status-dot error';
        }

        // Обновляем состояние кнопок бота
        this.updateBotUI();
    }

    async connectTwitch() {
        try {
            this.showMessage('Получаем ссылку авторизации...', 'info');
            
            const response = await this.apiCall('/api/streamer/auth/connect');
            
            if (response.success && response.auth_url) {
                // Открываем окно авторизации
                const authWindow = window.open(
                    response.auth_url,
                    'twitch_auth',
                    'width=600,height=700,scrollbars=yes,resizable=yes'
                );

                // Мониторим закрытие окна
                const checkInterval = setInterval(async () => {
                    if (authWindow.closed) {
                        clearInterval(checkInterval);
                        this.showMessage('Проверяем результат авторизации...', 'info');
                        
                        // Даем время серверу обработать callback
                        setTimeout(async () => {
                            await this.checkTwitchConnection();
                        }, 2000);
                    }
                }, 1000);
                
            } else {
                throw new Error(response.error || 'Не удалось получить ссылку авторизации');
            }
            
        } catch (error) {
            console.error('❌ [Streamer] Ошибка подключения Twitch:', error);
            this.showMessage('Ошибка подключения к Twitch: ' + error.message, 'error');
        }
    }

    async disconnectTwitch() {
        try {
            this.showMessage('Отключаем Twitch канал...', 'info');
            
            const response = await this.apiCall('/api/streamer/auth/disconnect', 'POST');
            
            if (response.success) {
                this.twitchState.connected = false;
                this.twitchState.username = null;
                this.updateTwitchUI();
                this.showMessage('Twitch канал отключен', 'success');
            } else {
                throw new Error(response.error || 'Ошибка отключения');
            }
            
        } catch (error) {
            console.error('❌ [Streamer] Ошибка отключения Twitch:', error);
            this.showMessage('Ошибка отключения: ' + error.message, 'error');
        }
    }

    async updateBotStatus() {
        try {
            console.log('[Streamer] Обновляем статус бота...');
            
            const response = await this.apiCall('/api/streamer/bot/status');
            
            if (response.success) {
                this.botState.isActive = response.status.is_active || false;
                this.botState.status = response.status.state || 'idle';
                
                if (response.status.statistics) {
                    this.botState.predictions = {
                        total: response.status.statistics.total_predictions || 0,
                        successRate: response.status.statistics.success_rate || 0,
                        currentStreak: response.status.statistics.current_win_streak || 0,
                        active: response.status.current_prediction?.prediction?.title || null
                    };
                }

                if (!this.botState.isActive && window.electronAPI?.store) {
                    await window.electronAPI.store.set('streamerPredictionsActive', false);

                    const predictionMonitorEnabled = await window.electronAPI.store.get('streamerPredictionMonitorEnabled', false);
                    if (predictionMonitorEnabled) {
                        try {
                            await this.applyPredictionMonitorMode(false, 'синхронизация локального состояния автопрогнозов');
                        } catch (syncError) {
                            console.error('❌ [Streamer] Ошибка синхронизации monitor mode:', syncError);
                        }
                    }
                }
            }
            
        } catch (error) {
            console.log('ℹ️ [Streamer] Бот неактивен или нет данных статуса');
        } finally {
            this.updateBotUI();
            this.updateStatistics();
        }
    }

    updateBotUI() {
        const statusDot = document.getElementById('bot-status-dot');
        const statusText = document.getElementById('bot-status-text');
        const statusDetails = document.getElementById('bot-status-details');
        const startBtn = document.getElementById('start-bot-btn');
        const stopBtn = document.getElementById('stop-bot-btn');

        // Обновляем индикатор состояния
        if (statusDot) {
            statusDot.className = 'status-dot';
            if (this.botState.isActive) {
                const waitingForResultStates = ['waiting_result', 'detecting'];
                statusDot.classList.add(waitingForResultStates.includes(this.botState.status) ? 'warning' : 'success');
            }
        }

        // Обновляем текст состояния
        const stateTexts = {
            'idle': 'Бот неактивен',
            'waiting_battle_start': 'Ожидание нового боя',
            'waiting_result': 'Ожидание результата боя',
            'processing_result': 'Обработка результата',
            'closing': 'Закрытие и создание нового прогноза',
            'running': 'Бот активен',
            'detecting': 'Ожидание результата боя',
            'processing': 'Обработка результата',
            'error': 'Ошибка бота'
        };

        if (statusText) {
            statusText.textContent = stateTexts[this.botState.status] || 'Неизвестное состояние';
        }

        if (statusDetails) {
            if (this.botState.isActive) {
                if (!this.monitorState.isRunning) {
                    statusDetails.textContent = 'Снайп остановлен: prediction-цикл не сможет получить новый бой';
                } else {
                    statusDetails.textContent = 'Автоматические прогнозы активны';
                }
            } else {
                statusDetails.textContent = this.getPredictionStartBlocker();
            }
        }

        // Обновляем кнопки
        if (startBtn) {
            startBtn.disabled = this.botState.isActive || !this.canStartPredictions();
        }
        
        if (stopBtn) {
            stopBtn.disabled = !this.botState.isActive;
        }
    }

    async startBot() {
        let predictionMonitorModeApplied = false;

        try {
            await this.refreshPredictionEnvironment();

            if (!this.canStartPredictions()) {
                this.showMessage(this.getPredictionStartBlocker(), 'warning');
                return;
            }

            this.showMessage('Применяем триггеры для автопрогнозов...', 'info');
            this.setButtonLoading('start-bot-btn', true);

            await this.applyPredictionMonitorMode(true, 'включение автопрогнозов');
            predictionMonitorModeApplied = true;

            this.showMessage('Запускаем бота...', 'info');

            // Передаем текущие настройки прогнозов
            const response = await this.apiCall('/api/streamer/bot/start', 'POST', this.buildPredictionPayload());
            
            if (response.success) {
                this.botState.isActive = true;
                this.botState.status = response.bot_status?.state || 'waiting_battle_start';

                if (window.electronAPI?.store) {
                    await window.electronAPI.store.set('streamerPredictionsActive', true);
                }

                this.updateBotUI();
                this.showMessage('Бот запущен. Новый прогноз будет создаваться автоматически после каждого результата', 'success');
            } else {
                throw new Error(response.error || 'Неизвестная ошибка запуска');
            }
            
        } catch (error) {
            console.error('❌ [Streamer] Ошибка запуска бота:', error);

            if (window.electronAPI?.store) {
                await window.electronAPI.store.set('streamerPredictionsActive', false);
            }

            if (predictionMonitorModeApplied) {
                try {
                    await this.applyPredictionMonitorMode(false, 'откат после ошибки запуска автопрогнозов');
                } catch (rollbackError) {
                    console.error('❌ [Streamer] Ошибка отката мониторинга:', rollbackError);
                }
            }

            this.showMessage('Ошибка запуска бота: ' + error.message, 'error');
        } finally {
            this.setButtonLoading('start-bot-btn', false);
            await this.refreshPredictionEnvironment();
        }
    }

    async stopBot() {
        try {
            this.showMessage('Останавливаем бота...', 'info');
            this.setButtonLoading('stop-bot-btn', true);

            const response = await this.apiCall('/api/streamer/bot/stop', 'POST');
            
            if (response.success) {
                this.botState.isActive = false;
                this.botState.status = 'idle';

                if (window.electronAPI?.store) {
                    await window.electronAPI.store.set('streamerPredictionsActive', false);
                }

                await this.applyPredictionMonitorMode(false, 'выключение автопрогнозов');

                this.updateBotUI();
                this.showMessage('Бот остановлен', 'warning');
            } else {
                throw new Error(response.error || 'Неизвестная ошибка остановки');
            }
            
        } catch (error) {
            console.error('❌ [Streamer] Ошибка остановки бота:', error);
            this.showMessage('Ошибка остановки бота: ' + error.message, 'error');
        } finally {
            this.setButtonLoading('stop-bot-btn', false);
            await this.refreshPredictionEnvironment();
        }
    }

    updateStatistics() {
        // Обновляем статистику
        const elements = {
            'total-predictions': this.botState.predictions.total,
            'success-rate': this.botState.predictions.successRate + '%',
            'current-streak': this.botState.predictions.currentStreak,
            'active-prediction': this.botState.predictions.active || '—'
        };

        Object.entries(elements).forEach(([id, value]) => {
            const element = document.getElementById(id);
            if (element) {
                element.textContent = value;
            }
        });

        // Обновляем badge с количеством прогнозов
        const badge = document.getElementById('predictions-badge');
        if (badge) {
            badge.textContent = this.botState.predictions.total.toString();
        }
    }

    updatePredictionsTab() {
        // Обновление данных во вкладке прогнозов
        this.updateStatistics();
        console.log('[Streamer] Обновлена вкладка прогнозов');
    }

    updateTwitchTab() {
        // Обновление данных во вкладке Twitch
        console.log('[Streamer] Обновлена вкладка Twitch');
    }

    // === STREAM TITLE METHODS ===

    async initializeStreamTitle() {
        try {
            await this.loadStreamTitleStatus();
        } catch (error) {
            console.error('[Streamer] Ошибка инициализации stream title:', error);
        }
    }

    async loadStreamTitleStatus() {
        try {
            const response = await this.apiCall('/api/streamer/title/status');
            if (!response.success) {
                throw new Error(response.error || 'Не удалось получить статус автоназвания');
            }

            this.streamTitleState.loading = false;
            this.streamTitleState.settings = response.settings || {};
            this.streamTitleState.accounts = response.accounts || [];
            this.streamTitleState.session = response.session || null;
            this.streamTitleState.twitch = response.twitch || {};
            this.streamTitleState.recentResults = response.recent_results || [];
            this.streamTitleState.previewTitle = response.preview_title || response.default_template || '';
            this.streamTitleState.error = null;
            this.updateStreamTitleUI();
        } catch (error) {
            this.streamTitleState.loading = false;
            this.streamTitleState.error = error.message;
            this.updateStreamTitleUI();
        }
    }

    updateStreamTitleUI() {
        const state = this.streamTitleState;
        const settings = state.settings || {};
        const session = state.session;
        const twitch = state.twitch || {};

        const enabledToggle = document.getElementById('streamTitleEnabled');
        if (enabledToggle) {
            enabledToggle.checked = !!settings.enabled;
            enabledToggle.disabled = state.loading;
        }

        const badge = document.getElementById('stream-title-badge');
        if (badge) {
            badge.textContent = settings.enabled ? 'ON' : 'OFF';
            badge.style.background = settings.enabled ? 'var(--success)' : 'var(--accent-purple)';
        }

        this.setText('stream-title-twitch-status', twitch.connected ? `@${twitch.username || 'connected'}` : 'Не подключен');
        this.setText('stream-title-live-status', twitch.online ? 'Online' : 'Offline');
        this.setText('stream-title-session-status', session ? 'Активна' : 'Ожидание стрима');
        this.setText('stream-title-preview', state.previewTitle || '#134·972🏅|8W-7L|Δ-32|Название стрима');

        const templateInput = document.getElementById('stream-title-template');
        if (templateInput && document.activeElement !== templateInput) {
            templateInput.value = settings.prefix_template || '#{rank}·{elo}🏅|{wins}W-{losses}L|Δ{delta}|';
        }

        this.setValue('stream-title-wl-mode', settings.wl_mode || 'total');
        this.setValue('stream-title-account-mode', settings.account_display_mode || 'last_active');
        this.setChecked('stream-title-include-rank', settings.include_rank !== false);
        this.setChecked('stream-title-include-elo', settings.include_elo !== false);
        this.setChecked('stream-title-include-wl', settings.include_wl !== false);
        this.setChecked('stream-title-include-delta', settings.include_delta !== false);

        const pauseBtn = document.getElementById('stream-title-pause-btn');
        if (pauseBtn) {
            pauseBtn.textContent = settings.paused ? 'Продолжить' : 'Пауза';
        }

        const totalWins = session?.total_wins || 0;
        const totalLosses = session?.total_losses || 0;
        this.setText('stream-title-session-wl', `${totalWins}W-${totalLosses}L`);
        this.setText('stream-title-active-account', this.getActiveAccountLabel(session));
        this.setText('stream-title-last-result', this.getLastStreamTitleResult());
        this.renderStreamTitleAccounts();
    }

    renderStreamTitleAccounts() {
        const container = document.getElementById('stream-title-accounts-list');
        if (!container) return;

        const accounts = this.streamTitleState.accounts || [];
        if (!accounts.length) {
            container.innerHTML = '<div style="color: var(--text-secondary); font-size: 14px;">Аккаунты еще не добавлены</div>';
            return;
        }

        container.innerHTML = accounts.map((account) => {
            const name = this.escapeHtml(account.alias || account.name || account.tag);
            const tag = this.escapeHtml(account.tag || '');
            const rank = account.current_rank ? `#${account.current_rank}` : '#?';
            const elo = account.current_elo ? `${account.current_elo}🏅` : '?🏅';
            return `
                <div class="account-row">
                    <div class="account-main">
                        <div class="account-name">${name}</div>
                        <div class="account-meta">${rank}·${elo} · ${tag}</div>
                    </div>
                    <div class="status-dot ${account.enabled ? 'success' : ''}"></div>
                    <button class="btn btn-secondary" data-remove-stream-title-account="${tag}">Удалить</button>
                </div>
            `;
        }).join('');

        container.querySelectorAll('[data-remove-stream-title-account]').forEach((button) => {
            button.addEventListener('click', () => this.removeStreamTitleAccount(button.dataset.removeStreamTitleAccount));
        });
    }

    async toggleStreamTitle(enabled) {
        if (enabled && !this.streamTitleState.twitch?.connected) {
            this.showStreamTitleMessage('Сначала подключите Twitch', 'warning');
            const toggle = document.getElementById('streamTitleEnabled');
            if (toggle) toggle.checked = false;
            return;
        }

        try {
            await this.apiCall('/api/streamer/title/enabled', 'POST', { enabled });
            await this.loadStreamTitleStatus();
            this.showStreamTitleMessage(enabled ? 'Автоназвание включено' : 'Автоназвание выключено', 'success');
        } catch (error) {
            this.showStreamTitleMessage(error.message, 'error');
            await this.loadStreamTitleStatus();
        }
    }

    async saveStreamTitleSettings() {
        const payload = {
            prefix_template: document.getElementById('stream-title-template')?.value || '#{rank}·{elo}🏅|{wins}W-{losses}L|Δ{delta}|',
            wl_mode: document.getElementById('stream-title-wl-mode')?.value || 'total',
            account_display_mode: document.getElementById('stream-title-account-mode')?.value || 'last_active',
            include_rank: document.getElementById('stream-title-include-rank')?.checked !== false,
            include_elo: document.getElementById('stream-title-include-elo')?.checked !== false,
            include_wl: document.getElementById('stream-title-include-wl')?.checked !== false,
            include_delta: document.getElementById('stream-title-include-delta')?.checked !== false
        };

        try {
            this.setButtonLoading('stream-title-save-settings-btn', true);
            await this.apiCall('/api/streamer/title/settings', 'POST', payload);
            await this.loadStreamTitleStatus();
            this.showStreamTitleMessage('Настройки сохранены', 'success');
        } catch (error) {
            this.showStreamTitleMessage(error.message, 'error');
        } finally {
            this.setButtonLoading('stream-title-save-settings-btn', false);
        }
    }

    async addStreamTitleAccount() {
        const tagInput = document.getElementById('stream-title-account-tag');
        const aliasInput = document.getElementById('stream-title-account-alias');
        const tag = tagInput?.value?.trim();
        const alias = aliasInput?.value?.trim() || '';

        if (!tag) {
            this.showStreamTitleMessage('Введите тег аккаунта', 'warning');
            return;
        }

        try {
            this.setButtonLoading('stream-title-add-account-btn', true);
            await this.apiCall('/api/streamer/title/accounts', 'POST', { tag, alias });
            if (tagInput) tagInput.value = '';
            if (aliasInput) aliasInput.value = '';
            await this.loadStreamTitleStatus();
            this.showStreamTitleMessage('Аккаунт добавлен', 'success');
        } catch (error) {
            this.showStreamTitleMessage(error.message, 'error');
        } finally {
            this.setButtonLoading('stream-title-add-account-btn', false);
        }
    }

    async removeStreamTitleAccount(tag) {
        try {
            await this.apiCall(`/api/streamer/title/accounts/${encodeURIComponent(tag)}`, 'DELETE');
            await this.loadStreamTitleStatus();
            this.showStreamTitleMessage('Аккаунт удален', 'success');
        } catch (error) {
            this.showStreamTitleMessage(error.message, 'error');
        }
    }

    async resetStreamTitleSession() {
        try {
            await this.apiCall('/api/streamer/title/reset', 'POST');
            await this.loadStreamTitleStatus();
            this.showStreamTitleMessage('W/L сброшен', 'success');
        } catch (error) {
            this.showStreamTitleMessage(error.message, 'error');
        }
    }

    async toggleStreamTitlePause() {
        const paused = !(this.streamTitleState.settings?.paused);
        try {
            await this.apiCall('/api/streamer/title/pause', 'POST', { paused });
            await this.loadStreamTitleStatus();
            this.showStreamTitleMessage(paused ? 'Пауза включена' : 'Пауза снята', 'success');
        } catch (error) {
            this.showStreamTitleMessage(error.message, 'error');
        }
    }

    async undoStreamTitleResult() {
        try {
            const response = await this.apiCall('/api/streamer/title/undo', 'POST');
            await this.loadStreamTitleStatus();
            this.showStreamTitleMessage(response.message || 'Последний результат отменен', response.success ? 'success' : 'warning');
        } catch (error) {
            this.showStreamTitleMessage(error.message, 'error');
        }
    }

    async restoreOriginalStreamTitle() {
        try {
            const response = await this.apiCall('/api/streamer/title/restore-title', 'POST');
            await this.loadStreamTitleStatus();
            this.showStreamTitleMessage(response.success ? 'Оригинальное название возвращено' : (response.message || 'Название не изменено'), response.success ? 'success' : 'warning');
        } catch (error) {
            this.showStreamTitleMessage(error.message, 'error');
        }
    }

    getActiveAccountLabel(session) {
        const tag = session?.active_account_tag;
        if (!tag) return '—';
        const account = (this.streamTitleState.accounts || []).find((item) => item.tag === tag);
        return account?.alias || account?.name || tag;
    }

    getLastStreamTitleResult() {
        const result = this.streamTitleState.recentResults?.[0];
        if (!result) return '—';
        const label = result.result === 'win' ? 'Win' : result.result === 'loss' ? 'Loss' : 'Draw';
        return `${label} · ${result.account_tag}`;
    }

    showStreamTitleMessage(text, type = 'info') {
        const container = document.getElementById('stream-title-messages');
        if (!container) {
            this.showMessage(text, type);
            return;
        }
        container.innerHTML = '';
        const message = document.createElement('div');
        message.className = `message ${type} show`;
        message.innerHTML = `<span>${this.getMessageIcon(type)}</span><span>${this.escapeHtml(text)}</span>`;
        container.appendChild(message);
        setTimeout(() => {
            if (message.parentNode) {
                message.remove();
            }
        }, 4000);
    }

    setText(id, value) {
        const element = document.getElementById(id);
        if (element) element.textContent = value;
    }

    setValue(id, value) {
        const element = document.getElementById(id);
        if (element && document.activeElement !== element) element.value = value;
    }

    setChecked(id, value) {
        const element = document.getElementById(id);
        if (element) element.checked = !!value;
    }

    escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    startPeriodicUpdates() {
        // Обновляем статус каждые 5 секунд
        this.updateInterval = setInterval(() => {
            Promise.allSettled([
                this.refreshPredictionEnvironment(),
                this.updateBotStatus(),
                this.loadStreamTitleStatus()
            ]);
        }, 5000);
        
        console.log('[Streamer] Периодические обновления запущены');
    }

    stopPeriodicUpdates() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
            console.log('[Streamer] Периодические обновления остановлены');
        }
    }

    // Проверка авторизации в приложении
    async checkAppAuthorization() {
        console.log('🔐 [Streamer] Проверяем авторизацию в приложении...');
        try {
            const tokens = await this.getAuthTokens();
            const hasAuth = !!(tokens && tokens.access_token);
            console.log('🔐 [Streamer] Результат проверки авторизации:', hasAuth ? 'АВТОРИЗОВАН' : 'НЕ АВТОРИЗОВАН');
            return hasAuth;
        } catch (error) {
            console.error('❌ [Streamer] Ошибка проверки авторизации:', error);
            return false;
        }
    }

    // Utility methods
    async apiCall(endpoint, method = 'GET', data = null) {
        try {
            // Получаем токены от главного процесса
            const tokens = await this.getAuthTokens();
            if (!tokens || !tokens.access_token) {
                // Специальное сообщение для Twitch подключения
                if (endpoint.includes('/auth/connect')) {
                    throw new Error('Для подключения Twitch сначала войдите в приложение и получите роль STREAMER');
                }
                throw new Error('Нет токена авторизации приложения. Сначала войдите в приложение.');
            }

            const serverUrl = await this.getServerUrl();
            const fullUrl = endpoint.startsWith('http') ? endpoint : serverUrl + endpoint;

            const options = {
                method,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${tokens.access_token}`
                }
            };

            if (data && method !== 'GET') {
                options.body = JSON.stringify(data);
            }

            const response = await fetch(fullUrl, options);
            
            if (!response.ok) {
                let errorPayload = null;
                try {
                    errorPayload = await response.json();
                } catch (_) {
                    errorPayload = null;
                }

                const serverMessage = errorPayload?.detail || errorPayload?.message;

                // Специальная обработка 403 ошибки
                if (response.status === 403) {
                    throw new Error(serverMessage || 'Нет доступа: авторизуйтесь в приложении или получите роль STREAMER');
                }
                // Специальная обработка 401 ошибки
                if (response.status === 401) {
                    throw new Error(serverMessage || 'Токен авторизации истёк. Перезайдите в приложение');
                }
                throw new Error(serverMessage || `Ошибка сервера ${response.status}: ${response.statusText}`);
            }

            return await response.json();

        } catch (error) {
            console.error(`❌ [Streamer] API Error (${endpoint}):`, error);
            throw error;
        }
    }

    async getAuthTokens() {
        console.log('🔍 [Streamer] Получаем токены авторизации...');
        try {
            // Используем новый TokenManager для автоматического refresh
            if (window.tokenManager) {
                console.log('✅ [Streamer] TokenManager доступен');
                const accessToken = await window.tokenManager.getValidAccessToken();
                console.log('🔑 [Streamer] AccessToken из TokenManager:', accessToken ? 'ЕСТЬ' : 'НЕТ');
                return accessToken ? { access_token: accessToken } : null;
            } else {
                console.warn('⚠️ [Streamer] TokenManager недоступен');
            }
            
            // Fallback к старому методу
            if (window.electronAPI && window.electronAPI.tokens) {
                console.log('🔄 [Streamer] Используем fallback через electronAPI');
                const result = await window.electronAPI.tokens.getUser();
                console.log('🔑 [Streamer] ElectronAPI результат:', result.success ? 'УСПЕХ' : 'ОШИБКА');
                return result.success ? result.tokens : null;
            } else {
                console.warn('⚠️ [Streamer] ElectronAPI недоступен');
            }
        } catch (error) {
            console.error('❌ [Streamer] Ошибка получения токенов:', error);
        }
        
        console.error('❌ [Streamer] Не удалось получить токены ни одним способом');
        return null;
    }

    async getServerUrl() {
        try {
            if (window.electronAPI && window.electronAPI.store) {
                const result = await window.electronAPI.store.getServerUrl();
                return result || 'http://localhost:8080';
            }
        } catch (error) {
            console.error('❌ [Streamer] Ошибка получения URL сервера:', error);
        }
        return 'http://localhost:8080';
    }

    setButtonLoading(buttonId, loading) {
        const button = document.getElementById(buttonId);
        if (!button) return;

        if (loading) {
            button.disabled = true;
            const originalText = button.innerHTML;
            button.setAttribute('data-original-text', originalText);
            button.innerHTML = '<div style="display: flex; align-items: center; gap: 8px;"><div style="width: 16px; height: 16px; border: 2px solid transparent; border-top: 2px solid currentColor; border-radius: 50%; animation: spin 1s linear infinite;"></div>Загрузка...</div>';
        } else {
            button.disabled = false;
            const originalText = button.getAttribute('data-original-text');
            if (originalText) {
                button.innerHTML = originalText;
                button.removeAttribute('data-original-text');
            }
        }
    }

    showMessage(text, type = 'info', duration = 4000) {
        // Удаляем предыдущие сообщения
        const existingMessages = document.querySelectorAll('.temp-message');
        existingMessages.forEach(msg => msg.remove());

        // Создаем новое сообщение
        const message = document.createElement('div');
        message.className = `message ${type} show temp-message`;
        message.innerHTML = `
            <span>${this.getMessageIcon(type)}</span>
            <span>${text}</span>
        `;

        // Добавляем в контейнер для сообщений
        const container = document.getElementById('predictions-messages') || document.body;
        container.appendChild(message);

        // Автоудаление
        setTimeout(() => {
            if (message.parentNode) {
                message.classList.remove('show');
                setTimeout(() => message.remove(), 300);
            }
        }, duration);

        console.log(`[Streamer] Сообщение (${type}): ${text}`);
    }

    getMessageIcon(type) {
        const icons = {
            'success': '[OK]',
            'error': '[ERROR]',
            'warning': '[WARN]',
            'info': '[INFO]'
        };
        return icons[type] || '[INFO]';
    }

    goBack() {
        console.log('[Streamer] Возврат к главному приложению');
        
        // Останавливаем обновления
        this.stopPeriodicUpdates();
        
        // Используем Electron IPC для перехода
        if (window.electronAPI && window.electronAPI.navigation) {
            window.electronAPI.navigation.goToMain();
        } else {
            // Fallback - пробуем перейти к app.html
            window.location.href = 'app.html';
        }
    }

    // === DECK SHARING МЕТОДЫ ===

    async initializeDeckSharing() {
        console.log('[Streamer] Инициализация deck sharing...');
        
        try {
            // Получаем текущие настройки deck sharing
            const response = await this.apiCall('/api/streamer/settings/deck-sharing');
            
            if (response.success) {
                this.deckSharingState.enabled = response.settings.enabled;
                this.deckSharingState.loading = false;
                this.updateDeckSharingUI();
            } else {
                throw new Error(response.error || 'Не удалось получить настройки');
            }
            
        } catch (error) {
            console.error('[Streamer] Ошибка инициализации deck sharing:', error);
            this.deckSharingState.loading = false;
            this.deckSharingState.error = error.message;
            this.updateDeckSharingUI();
        }
    }

    async toggleDeckSharing(enabled) {
        console.log(`[Streamer] Переключение deck sharing: ${enabled}`);
        
        // Проверяем подключение к Twitch
        if (enabled && !this.twitchState.connected) {
            this.showMessage('❌ Сначала подключите Twitch аккаунт', 'error');
            // Возвращаем переключатель в предыдущее состояние
            const toggle = document.getElementById('deckSharingToggle');
            if (toggle) toggle.checked = false;
            return;
        }

        this.deckSharingState.loading = true;
        this.updateDeckSharingUI();

        try {
            const response = await this.apiCall('/api/streamer/settings/deck-sharing', 'POST', {
                enabled: enabled
            });

            if (response.success) {
                this.deckSharingState.enabled = enabled;
                this.deckSharingState.loading = false;
                this.deckSharingState.error = null;
                
                const statusMessage = enabled 
                    ? '✅ Автоматическая отправка колод включена' 
                    : '⚪ Автоматическая отправка колод отключена';
                this.showMessage(statusMessage, 'success');
                
            } else {
                throw new Error(response.error || 'Не удалось обновить настройки');
            }

        } catch (error) {
            console.error('[Streamer] Ошибка переключения deck sharing:', error);
            this.deckSharingState.loading = false;
            this.deckSharingState.error = error.message;
            
            // Возвращаем переключатель в предыдущее состояние
            const toggle = document.getElementById('deckSharingToggle');
            if (toggle) toggle.checked = !enabled;
            
            this.showMessage(`❌ Ошибка: ${error.message}`, 'error');
        }

        this.updateDeckSharingUI();
    }

    updateDeckSharingUI() {
        const toggle = document.getElementById('deckSharingToggle');
        const statusElement = document.getElementById('deckSharingStatus');
        
        if (!toggle || !statusElement) return;

        // Обновляем переключатель
        toggle.checked = this.deckSharingState.enabled;
        toggle.disabled = this.deckSharingState.loading;

        // Обновляем статус
        const indicator = statusElement.querySelector('.status-indicator');
        const text = statusElement.querySelector('span:last-child');
        
        if (indicator && text) {
            // Очищаем предыдущие классы
            indicator.className = 'status-indicator';
            
            if (this.deckSharingState.loading) {
                indicator.classList.add('loading');
                text.textContent = 'Обновление настроек...';
            } else if (this.deckSharingState.error) {
                indicator.classList.add('error');
                text.textContent = `Ошибка: ${this.deckSharingState.error}`;
            } else if (this.deckSharingState.enabled) {
                indicator.classList.add('enabled');
                text.textContent = 'Функция активна';
            } else {
                indicator.classList.add('disabled');
                text.textContent = 'Функция отключена';
            }
        }
    }

    // Cleanup при закрытии
    destroy() {
        console.log('[Streamer] Очистка ресурсов...');
        this.stopPeriodicUpdates();
    }
}

// Глобальная функция для кнопки "Назад"
function goBack() {
    if (window.streamerPanel) {
        window.streamerPanel.goBack();
    } else {
        window.location.href = 'app.html';
    }
}

// Инициализация при загрузке страницы
function initializeStreamerPanel() {
    console.log('[Streamer] Инициализация панели стримера...');
    
    try {
        window.streamerPanel = new StreamerPanel();
        console.log('✅ [Streamer] Панель стримера создана');
    } catch (error) {
        console.error('❌ [Streamer] Ошибка создания панели:', error);
    }
}

// Cleanup при выгрузке страницы
window.addEventListener('beforeunload', () => {
    if (window.streamerPanel) {
        window.streamerPanel.destroy();
    }
});

// Запуск инициализации
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeStreamerPanel);
} else {
    initializeStreamerPanel();
}

// Добавляем стили для анимации загрузки кнопок
const style = document.createElement('style');
style.textContent = `
    @keyframes spin {
        to { transform: rotate(360deg); }
    }
`;
document.head.appendChild(style);

console.log('[Streamer] streamer.js полностью загружен');
