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
            
            // Инициализируем deck sharing
            await this.initializeDeckSharing();
            
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

        // Настройки прогнозов
        this.setupPredictionSettings();

        // Deck sharing переключатель
        const deckSharingToggle = document.getElementById('deckSharingToggle');
        if (deckSharingToggle) {
            deckSharingToggle.addEventListener('change', (e) => this.toggleDeckSharing(e.target.checked));
        }

        console.log('[Streamer] Event listeners настроены');
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
                        currentStreak: response.status.statistics.current_streak || 0,
                        active: response.status.statistics.active_prediction || null
                    };
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
                statusDot.classList.add(this.botState.status === 'detecting' ? 'warning' : 'success');
            }
        }

        // Обновляем текст состояния
        const stateTexts = {
            'idle': 'Бот неактивен',
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
                statusDetails.textContent = 'Автоматические прогнозы активны';
            } else if (!this.twitchState.connected) {
                statusDetails.textContent = 'Для запуска подключите Twitch канал';
            } else {
                statusDetails.textContent = 'Готов к запуску';
            }
        }

        // Обновляем кнопки
        if (startBtn) {
            startBtn.disabled = this.botState.isActive || !this.twitchState.connected;
        }
        
        if (stopBtn) {
            stopBtn.disabled = !this.botState.isActive;
        }
    }

    async startBot() {
        try {
            if (!this.twitchState.connected) {
                this.showMessage('Сначала подключите Twitch канал', 'warning');
                return;
            }

            this.showMessage('Запускаем бота...', 'info');
            this.setButtonLoading('start-bot-btn', true);

            // Передаем текущие настройки прогнозов
            const response = await this.apiCall('/api/streamer/bot/start', 'POST', this.predictionSettings);
            
            if (response.success) {
                this.botState.isActive = true;
                this.botState.status = 'running';
                this.updateBotUI();
                this.showMessage('Бот запущен! Прогнозы будут создаваться автоматически', 'success');
            } else {
                throw new Error(response.error || 'Неизвестная ошибка запуска');
            }
            
        } catch (error) {
            console.error('❌ [Streamer] Ошибка запуска бота:', error);
            this.showMessage('Ошибка запуска бота: ' + error.message, 'error');
        } finally {
            this.setButtonLoading('start-bot-btn', false);
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

    startPeriodicUpdates() {
        // Обновляем статус каждые 5 секунд
        this.updateInterval = setInterval(() => {
            this.updateBotStatus();
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
                // Специальная обработка 403 ошибки
                if (response.status === 403) {
                    throw new Error('Нет доступа: авторизуйтесь в приложении или получите роль STREAMER');
                }
                // Специальная обработка 401 ошибки
                if (response.status === 401) {
                    throw new Error('Токен авторизации истёк. Перезайдите в приложение');
                }
                throw new Error(`Ошибка сервера ${response.status}: ${response.statusText}`);
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