const Store = require('electron-store');
const ConfigManager = require('./ConfigManager');

/**
 * StoreManager - Централизованное управление локальным хранилищем
 */
class StoreManager {
    constructor() {
        this.config = new ConfigManager();
        this.initialize();
    }

    initialize() {
        // Инициализируем зашифрованное хранилище
        this.store = new Store(this.config.store);
        
        // Логируем информацию о хранилище
        this.logStoreInfo();
    }

    logStoreInfo() {
        console.log('💾 Store path:', this.store.path);
        console.log('🔑 Current tokens:', this.hasTokens() ? 'EXIST' : 'NONE');
        console.log('👤 Current user:', this.getUser()?.username || 'NONE');
    }

    // === Методы для работы с токенами ===
    
    getTokens() {
        return this.store.get('tokens');
    }

    setTokens(tokens) {
        this.store.set('tokens', tokens);
        console.log('🔑 Токены сохранены');
    }

    hasTokens() {
        const tokens = this.getTokens();
        return tokens && tokens.access_token;
    }

    hasRefreshToken() {
        const tokens = this.getTokens();
        return tokens && tokens.refresh_token;
    }

    clearTokens() {
        this.store.delete('tokens');
        console.log('🗑️ Токены удалены');
    }

    // === Методы для работы с пользователем ===
    
    getUser() {
        return this.store.get('user');
    }

    setUser(user) {
        this.store.set('user', user);
        console.log('👤 Данные пользователя сохранены:', user?.username);
    }

    clearUser() {
        this.store.delete('user');
        console.log('🗑️ Данные пользователя удалены');
    }

    // === Методы для работы с сервером ===
    
    getServerUrl() {
        return this.store.get('serverUrl');
    }

    setServerUrl(url) {
        this.store.set('serverUrl', url);
        console.log('🌐 URL сервера обновлен:', url);
    }

    getServerMode() {
        return this.store.get('serverMode', 'global');
    }

    setServerMode(mode) {
        this.store.set('serverMode', mode);
        console.log('🔄 Режим сервера изменен:', mode);
    }

    // === Методы для работы с OCR областями ===
    
    getOcrRegions() {
        return this.store.get('ocrRegions');
    }

    setOcrRegions(regions) {
        this.store.set('ocrRegions', regions);
        console.log('📊 OCR области сохранены');
    }

    hasOcrRegions() {
        const regions = this.getOcrRegions();
        return regions && regions.trigger_area && regions.normal_data_area;
    }

    // === Настройки стримерских автопрогнозов ===

    getStreamerPredictionAreas() {
        return this.store.get('streamerPredictionAreas', {});
    }

    getStreamerPredictionConfig(userId = null) {
        const resolvedUserId = userId || this.getUser()?.id;
        if (!resolvedUserId) {
            return {};
        }

        const areas = this.getStreamerPredictionAreas();
        return areas[resolvedUserId] || {};
    }

    setStreamerPredictionConfig(config, userId = null) {
        const resolvedUserId = userId || this.getUser()?.id;
        if (!resolvedUserId) {
            throw new Error('Невозможно сохранить streamer prediction config без пользователя');
        }

        const areas = this.getStreamerPredictionAreas();
        areas[resolvedUserId] = config;
        this.store.set('streamerPredictionAreas', areas);
        console.log(`🎥 Streamer prediction config сохранен для пользователя ${resolvedUserId}`);
    }

    clearStreamerPredictionConfig(userId = null) {
        const resolvedUserId = userId || this.getUser()?.id;
        if (!resolvedUserId) {
            return;
        }

        const areas = this.getStreamerPredictionAreas();
        delete areas[resolvedUserId];
        this.store.set('streamerPredictionAreas', areas);
        console.log(`🗑️ Streamer prediction config удален для пользователя ${resolvedUserId}`);
    }

    getStreamerResultTriggerArea(userId = null) {
        return this.getStreamerPredictionConfig(userId).result_trigger_area || null;
    }

    getStreamerResultDataArea(userId = null) {
        return this.getStreamerPredictionConfig(userId).result_data_area || null;
    }

    setStreamerResultTriggerArea(area, userId = null) {
        const config = this.getStreamerPredictionConfig(userId);
        this.setStreamerPredictionConfig({
            ...config,
            result_trigger_area: area
        }, userId);
    }

    setStreamerResultDataArea(area, userId = null) {
        const config = this.getStreamerPredictionConfig(userId);
        this.setStreamerPredictionConfig({
            ...config,
            result_data_area: area
        }, userId);
    }

    hasStreamerResultTriggerArea(userId = null) {
        return !!this.getStreamerResultTriggerArea(userId);
    }

    hasStreamerResultDataArea(userId = null) {
        return !!this.getStreamerResultDataArea(userId);
    }

    // === Методы для работы с режимом поиска ===
    
    getSearchMode() {
        return this.store.get('searchMode', 'fast');
    }

    setSearchMode(mode) {
        this.store.set('searchMode', mode);
        console.log('🔍 Режим поиска изменен:', mode);
    }

    getDeckMode() {
        return this.store.get('deckMode', 'pol');
    }

    setDeckMode(mode) {
        this.store.set('deckMode', mode);
        console.log('🃏 Режим колоды изменен:', mode);
    }

    getManualHotkeys() {
        const profiles = this.store.get('manualHotkeys', []);
        return Array.isArray(profiles) ? profiles : [];
    }

    setManualHotkeys(profiles) {
        const safeProfiles = Array.isArray(profiles) ? profiles : [];
        this.store.set('manualHotkeys', safeProfiles);
        console.log(`⌨️ Сохранено manual hotkeys: ${safeProfiles.length}`);
    }

    // === Методы для работы с задержками триггеров ===
    
    getTriggerDelays() {
        return this.store.get('triggerDelays', {
            fast: 0,      // Быстрый режим - без задержки
            precise: 2.2  // Точный режим - ждем загрузки клана
        });
    }

    setTriggerDelays(delays) {
        this.store.set('triggerDelays', delays);
        console.log('⏱️ Задержки триггеров обновлены:', delays);
    }

    // Получить задержку для текущего режима поиска
    getCurrentDelay() {
        const mode = this.getSearchMode(); // 'fast' или 'precise'
        const delays = this.getTriggerDelays();
        return delays[mode] || 0;
    }

    // Обновить задержку для конкретного режима
    setDelayForMode(mode, delay) {
        const delays = this.getTriggerDelays();
        delays[mode] = delay;
        this.setTriggerDelays(delays);
    }

    // === Методы для работы с профилями триггеров ===
    
    getTriggerProfiles() {
        return this.store.get('triggerProfiles', this.getDefaultTriggerProfiles());
    }

    setTriggerProfiles(profiles) {
        this.store.set('triggerProfiles', profiles);
        console.log('🎯 Профили триггеров сохранены');
    }

    // Получить профиль для текущего режима поиска
    getCurrentTriggerProfile() {
        const mode = this.getSearchMode(); // 'fast' или 'precise'
        const profiles = this.getTriggerProfiles();
        return profiles[`start_battle_${mode}`];
    }

    // Дефолтные профили триггеров
    getDefaultTriggerProfiles() {
        return {
            start_battle_fast: {
                id: "start_battle_fast",
                action_type: "capture_and_send",
                capture_delay: 0,
                cooldown: 15,
                confirmations_needed: 2
            },
            start_battle_precise: {
                id: "start_battle_precise", 
                action_type: "capture_and_send",
                capture_delay: 2.2,
                cooldown: 15,
                confirmations_needed: 2
            }
        };
    }

    // === Методы для настроек триггеров ===
    
    getTriggerSettings() {
        return this.store.get('triggerSettings', {
            cooldown: 15,           // Cooldown между поисками
            confirmations: 2,       // Количество подтверждений
            colorTolerance: 30      // Допустимое отклонение цветов
        });
    }

    setTriggerSettings(settings) {
        this.store.set('triggerSettings', settings);
        console.log('⚙️ Настройки триггеров обновлены:', settings);
    }

    // === Методы для настроек виджета ===
    
    getAutoOpenWidget() {
        return this.store.get('autoOpenWidget', true);
    }

    setAutoOpenWidget(autoOpen) {
        this.store.set('autoOpenWidget', autoOpen);
        console.log('🪟 Автооткрытие виджета:', autoOpen);
    }

    getWidgetState() {
        return this.store.get('widgetState', {
            alwaysOnTop: false,
            mode: 'expanded',
            bounds: null
        });
    }

    setWidgetState(widgetState) {
        const currentState = this.getWidgetState();
        const nextState = {
            ...currentState,
            ...(widgetState || {})
        };

        this.store.set('widgetState', nextState);
        console.log('🪟 Состояние виджета обновлено');
    }

    // === 🆕 ЭТАП 2.2 + 2.3: Методы для работы с профилями окон ===
    
    /**
     * Получить сохраненные профили окон
     */
    getWindowProfiles() {
        return this.store.get('windowProfiles', {});
    }

    /**
     * Сохранить профиль окна по executable name
     */
    setWindowProfile(executableName, profile) {
        const profiles = this.getWindowProfiles();
        profiles[executableName] = {
            ...profile,
            lastUsed: new Date().toISOString()
        };
        this.store.set('windowProfiles', profiles);
        console.log(`🪟 Профиль окна сохранен для ${executableName}:`, profile);
    }

    /**
     * Получить профиль окна по executable name
     */
    getWindowProfile(executableName) {
        const profiles = this.getWindowProfiles();
        return profiles[executableName] || null;
    }

    /**
     * Удалить профиль окна
     */
    deleteWindowProfile(executableName) {
        const profiles = this.getWindowProfiles();
        delete profiles[executableName];
        this.store.set('windowProfiles', profiles);
        console.log(`🗑️ Профиль окна удален для ${executableName}`);
    }

    /**
     * Получить список всех сохраненных executable names
     */
    getWindowProfileExecutables() {
        const profiles = this.getWindowProfiles();
        return Object.keys(profiles);
    }

    /**
     * Очистить старые профили окон (старше 30 дней)
     */
    cleanupOldWindowProfiles() {
        const profiles = this.getWindowProfiles();
        const now = Date.now();
        const monthAgo = now - (30 * 24 * 60 * 60 * 1000); // 30 дней

        let cleaned = 0;
        Object.keys(profiles).forEach(executableName => {
            const profile = profiles[executableName];
            if (profile.lastUsed) {
                const lastUsed = new Date(profile.lastUsed).getTime();
                if (lastUsed < monthAgo) {
                    delete profiles[executableName];
                    cleaned++;
                }
            }
        });

        if (cleaned > 0) {
            this.store.set('windowProfiles', profiles);
            console.log(`🧹 Очищено ${cleaned} старых профилей окон`);
        }
    }

    /**
     * Получить последнее выбранное окно (уже реализовано в IpcManager)
     */
    getLastSelectedWindow() {
        return this.store.get('lastSelectedWindow', null);
    }

    /**
     * Сохранить последнее выбранное окно (уже реализовано в IpcManager)
     */
    setLastSelectedWindow(windowInfo) {
        this.store.set('lastSelectedWindow', {
            ...windowInfo,
            timestamp: new Date().toISOString()
        });
        console.log('🪟 Последнее выбранное окно сохранено:', windowInfo.name);
    }

    // === 🆕 МЕТОДЫ ДЛЯ КЕША КАРТ (ImageCacheManager) ===

    /**
     * Получить метаданные кеша карт
     */
    getCardsCache() {
        return this.store.get('cardsCache', {
            version: 0,
            contentHash: '',
            lastCheck: 0
        });
    }

    /**
     * Сохранить метаданные кеша карт
     */
    setCardsCache(cacheData) {
        this.store.set('cardsCache', {
            ...cacheData,
            lastUpdated: new Date().toISOString()
        });
        console.log('🎴 Метаданные кеша карт сохранены');
    }

    /**
     * Обновить версию и хеш кеша карт
     */
    updateCardsCacheVersion(version, contentHash) {
        const cache = this.getCardsCache();
        cache.version = version;
        cache.contentHash = contentHash;
        cache.lastCheck = Date.now();
        this.setCardsCache(cache);
        console.log(`🎴 Версия кеша обновлена: v${version}, hash: ${contentHash.substring(0, 8)}...`);
    }

    // === 🆕 МЕТОДЫ ДЛЯ ЦЕЛИ ЗАХВАТА (ЭКРАН ИЛИ ОКНО) ===

    /**
     * Получить выбранную цель захвата для мониторинга
     */
    getSelectedCaptureTarget() {
        return this.store.get('selectedCaptureTarget', {
            targetType: 'screen',
            targetId: '0',
            name: 'Full Screen'
        });
    }

    /**
     * Установить цель захвата для мониторинга
     */
    setSelectedCaptureTarget(targetInfo) {
        this.store.set('selectedCaptureTarget', {
            ...targetInfo,
            lastUpdated: new Date().toISOString()
        });
        console.log('🎯 Цель захвата установлена:', `${targetInfo.targetType}:${targetInfo.name}`);
    }

    /**
     * Проверить, установлено ли оконное захват
     */
    isWindowCaptureMode() {
        const target = this.getSelectedCaptureTarget();
        return target && target.targetType === 'window';
    }

    /**
     * Получить информацию о выбранном окне для захвата
     */
    getSelectedWindowForCapture() {
        const target = this.getSelectedCaptureTarget();
        return target && target.targetType === 'window' ? target : null;
    }

    /**
     * Сбросить цель захвата на экран по умолчанию
     */
    resetCaptureTargetToScreen() {
        this.setSelectedCaptureTarget({
            targetType: 'screen',
            targetId: '0',
            name: 'Full Screen'
        });
        console.log('🔄 Цель захвата сброшена на полный экран');
    }

    // === Универсальные методы ===
    
    get(key, defaultValue) {
        return this.store.get(key, defaultValue);
    }

    set(key, value) {
        this.store.set(key, value);
        console.log(`💾 Сохранено: ${key}`);
    }

    delete(key) {
        this.store.delete(key);
        console.log(`🗑️ Удалено: ${key}`);
    }

    has(key) {
        return this.store.has(key);
    }

    clear() {
        this.store.clear();
        console.log('🗑️ Хранилище очищено');
    }

    // === Методы для полной очистки при выходе ===
    
    clearAuthData() {
        this.clearTokens();
        this.clearUser();
        console.log('🚪 Данные авторизации очищены');
    }

    // === Методы для получения полного состояния ===
    
    getAuthState() {
        return {
            hasTokens: this.hasTokens(),
            hasRefreshToken: this.hasRefreshToken(),
            user: this.getUser(),
            isAuthenticated: this.hasTokens() && this.getUser()
        };
    }

    getAppState() {
        return {
            auth: this.getAuthState(),
            server: {
                url: this.getServerUrl(),
                mode: this.getServerMode()
            },
            ocr: {
                regions: this.getOcrRegions(),
                hasRegions: this.hasOcrRegions()
            },
            settings: {
                searchMode: this.getSearchMode(),
                deckMode: this.getDeckMode(),
                manualHotkeys: this.getManualHotkeys(),
                autoOpenWidget: this.getAutoOpenWidget()
            },
            windows: {
                profiles: this.getWindowProfiles(),
                profileExecutables: this.getWindowProfileExecutables(),
                lastSelected: this.getLastSelectedWindow()
            },
            capture: {
                target: this.getSelectedCaptureTarget(),
                isWindowMode: this.isWindowCaptureMode()
            }
        };
    }

    // === Отладочный метод ===
    
    debugInfo() {
        const state = this.getAppState();
        console.log('🔍 Store Debug Info:', JSON.stringify(state, null, 2));
        return state;
    }
}

module.exports = StoreManager;
