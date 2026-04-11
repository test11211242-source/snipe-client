const { createApp } = Vue;

const MAX_RESULTS = 20;

const PAGE_META = [
    {
        id: 'overview',
        label: 'Обзор',
        title: 'Обзор',
        description: 'Старт работы, статус мониторинга и быстрая сводка по текущей сессии.'
    },
    {
        id: 'results',
        label: 'Результаты',
        title: 'Результаты',
        description: 'Список найденных игроков и детальная информация по выбранному результату.'
    },
    {
        id: 'capture',
        label: 'Захват',
        title: 'Захват',
        description: 'Источник OCR, состояние областей и запуск настройки окна или экрана.'
    },
    {
        id: 'settings',
        label: 'Настройки',
        title: 'Настройки',
        description: 'Режимы поиска, сервер, trigger-параметры и обновления приложения.'
    },
    {
        id: 'tools',
        label: 'Инструменты',
        title: 'Инструменты',
        description: 'Виджет, стримерская панель и служебные функции приложения.'
    }
];

function normalizeSearchMode(mode) {
    return mode === 'precise' ? 'precise' : 'fast';
}

function normalizeDeckMode(mode) {
    return mode === 'gt' ? 'gt' : 'pol';
}

function hasConfiguredRegions(regions) {
    return !!(regions && regions.trigger_area && regions.normal_data_area);
}

function createResultId() {
    return `result-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatNumber(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric.toLocaleString('ru-RU') : '0';
}

function formatRank(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? `#${numeric.toLocaleString('ru-RU')}` : 'N/A';
}

function formatClock(value) {
    try {
        return new Date(value).toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    } catch {
        return '--:--:--';
    }
}

function formatDateLabel(value) {
    if (!value || value === 'Never') {
        return 'Не было';
    }

    try {
        return new Date(value).toLocaleString('ru-RU', {
            day: '2-digit',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit'
        });
    } catch {
        return String(value);
    }
}

function formatFileSize(fileSize) {
    const numeric = Number(fileSize);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return 'Размер неизвестен';
    }

    return `${(numeric / 1024 / 1024).toFixed(1)} MB`;
}

function calculateAverageElixir(cards) {
    if (!Array.isArray(cards) || cards.length === 0) {
        return 'N/A';
    }

    const values = cards
        .map((card) => Number(card.elixir_cost))
        .filter((cost) => Number.isFinite(cost));

    if (!values.length) {
        return 'N/A';
    }

    const total = values.reduce((sum, cost) => sum + cost, 0);
    return (total / values.length).toFixed(1);
}

function getFallbackCardImage(card) {
    const evolutionLevel = Number(card?.evolution_level || 0);

    if (card?.display_icon_url) {
        return card.display_icon_url;
    }

    if (evolutionLevel >= 2 && card?.hero_icon_url) {
        return card.hero_icon_url;
    }

    if ((evolutionLevel === 1 || card?.is_evolution) && card?.evolution_icon_url) {
        return card.evolution_icon_url;
    }

    return card?.icon_url || '';
}

function createHotkeyProfile(index = 0) {
    const generatedId = typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `hotkey_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    return {
        id: generatedId,
        label: `Бинд ${index + 1}`,
        enabled: true,
        accelerator: '',
        searchMode: 'fast',
        deckMode: 'pol',
        target: null,
        ocrProfileConfigured: false,
        ocrProfileMessage: 'Сначала выберите окно и сохраните bind.',
        registration: {
            state: 'disabled',
            registered: false,
            message: 'Сохраните бинды, чтобы активировать shortcut'
        }
    };
}

createApp({
    data() {
        return {
            isReady: false,
            pages: PAGE_META,
            activePage: 'overview',
            currentUser: null,
            version: '-',
            isMonitoring: false,
            searchMode: 'fast',
            deckMode: 'pol',
            currentServerMode: 'global',
            serverStatus: 'checking',
            serverBackup: false,
            serverMessage: '',
            regions: null,
            captureTarget: {
                targetType: 'screen',
                targetId: '0',
                name: 'Full Screen'
            },
            results: [],
            selectedResultId: null,
            lastPlayerData: null,
            toasts: [],
            toastCounter: 0,
            windowDialogVisible: false,
            selectedCaptureMode: 'window',
            selectedWindow: null,
            availableWindows: [],
            windowsLoading: false,
            windowsError: '',
            triggerSettings: {
                preciseDelay: 2.2,
                cooldown: 15,
                confirmations: 2,
                hideCaptureBorder: false
            },
            updateState: {
                status: 'ready',
                text: 'Готов к проверке',
                checking: false,
                downloading: false,
                hasUpdate: false,
                latestVersion: '',
                releaseDate: '',
                fileSizeLabel: '',
                downloadUrl: '',
                releaseUrl: '',
                downloadedFilePath: '',
                progress: 0
            },
            cacheStatus: {
                initialized: false,
                filesCount: 0,
                version: '-',
                lastCheck: 'Never',
                lastUpdated: 'Never',
                error: ''
            },
            cacheBusy: false,
            streamerBusy: false,
            serverPollHandle: null,
            autoOpenWidget: true,
            hotkeyProfiles: [],
            hotkeysSaving: false,
            hotkeyWindowDialogVisible: false,
            editingHotkeyId: null,
            selectedHotkeyWindow: null
        };
    },

    computed: {
        activePageMeta() {
            return this.pages.find((page) => page.id === this.activePage) || this.pages[0];
        },

        userDisplayName() {
            return this.currentUser?.username || this.currentUser?.email || 'Пользователь';
        },

        userSecondaryLabel() {
            return this.currentUser?.email || 'Desktop client';
        },

        userInitials() {
            const source = this.userDisplayName;
            const parts = source.split(/\s+/).filter(Boolean);
            if (!parts.length) {
                return 'SN';
            }

            if (parts.length === 1) {
                return parts[0].slice(0, 2).toUpperCase();
            }

            return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
        },

        monitoringChipText() {
            return this.isMonitoring ? 'Мониторинг активен' : 'Мониторинг остановлен';
        },

        monitoringChipTone() {
            return this.isMonitoring ? 'success' : 'neutral';
        },

        searchModeMeta() {
            return this.getSearchModeMeta(this.searchMode);
        },

        deckModeMeta() {
            return this.getDeckModeMeta(this.deckMode);
        },

        serverLabel() {
            return this.currentServerMode === 'test' ? 'Test' : 'Global';
        },

        serverStatusLabel() {
            if (this.serverStatus === 'switching') {
                return 'Переключение...';
            }

            if (this.serverStatus === 'connected') {
                return this.serverBackup ? `${this.serverLabel} (резерв)` : `${this.serverLabel} online`;
            }

            if (this.serverStatus === 'error') {
                return `${this.serverLabel} offline`;
            }

            return `${this.serverLabel} проверяется`;
        },

        serverChipTone() {
            if (this.serverStatus === 'connected') {
                return this.serverBackup ? 'warning' : 'success';
            }

            if (this.serverStatus === 'error') {
                return 'danger';
            }

            return 'neutral';
        },

        hasConfiguredRegions() {
            return hasConfiguredRegions(this.regions);
        },

        captureTargetLabel() {
            if (this.captureTarget?.targetType === 'window') {
                return this.captureTarget?.name || 'Выбранное окно';
            }

            return this.captureTarget?.name || 'Full Screen';
        },

        captureTargetDescription() {
            if (this.captureTarget?.targetType === 'window') {
                if (this.captureTarget?.executableName) {
                    return this.captureTarget.executableName;
                }
                return 'Захват конкретного окна';
            }

            return 'Захват всего экрана';
        },

        overviewHeadline() {
            if (this.isMonitoring) {
                return 'Мониторинг работает';
            }

            if (!this.hasConfiguredRegions) {
                return 'Сначала настройте захват';
            }

            return 'Приложение готово к работе';
        },

        overviewSubline() {
            if (this.isMonitoring) {
                return 'Приложение ждёт новые матчи и будет добавлять найденных соперников в историю автоматически.';
            }

            if (!this.hasConfiguredRegions) {
                return 'Настройте OCR-области и источник захвата, чтобы начать поиск противников из клиента.';
            }

            return 'Все основные настройки на месте. Можно запускать мониторинг и переходить к результатам.';
        },

        sessionFound() {
            return this.results.filter((result) => result.isFound).length;
        },

        sessionSuccessRate() {
            if (!this.results.length) {
                return 0;
            }

            return Math.round((this.sessionFound / this.results.length) * 100);
        },

        latestResult() {
            return this.results[0] || null;
        },

        selectedResult() {
            return this.results.find((result) => result.id === this.selectedResultId) || this.latestResult || null;
        },

        recentActivity() {
            return this.results.slice(0, 5);
        },

        updateStatusTone() {
            if (this.updateState.status === 'available' || this.updateState.status === 'downloaded') {
                return 'success';
            }

            if (this.updateState.status === 'error') {
                return 'danger';
            }

            if (this.updateState.status === 'downloading') {
                return 'warning';
            }

            return 'neutral';
        }
    },

    methods: {
        formatNumber(value) {
            return formatNumber(value);
        },

        formatRank(value) {
            return formatRank(value);
        },

        formatDateLabel(value) {
            return formatDateLabel(value);
        },

        cloneTarget(target) {
            if (!target) {
                return null;
            }

            return {
                targetType: target.targetType === 'screen' ? 'screen' : 'window',
                id: target.id || '',
                name: target.name || '',
                executableName: target.executableName || '',
                processId: Number.isFinite(Number(target.processId)) ? Number(target.processId) : null
            };
        },

        createWindowPayload(windowInfo) {
            if (!windowInfo) {
                return null;
            }

            return {
                id: windowInfo.id || '',
                name: windowInfo.name || '',
                executableName: windowInfo.executableName || '',
                processId: Number.isFinite(Number(windowInfo.processId)) ? Number(windowInfo.processId) : null
            };
        },

        serializeHotkeyProfiles() {
            return this.hotkeyProfiles.map((profile) => ({
                id: profile.id,
                label: profile.label || '',
                enabled: Boolean(profile.enabled),
                accelerator: profile.accelerator || '',
                searchMode: profile.searchMode === 'precise' ? 'precise' : 'fast',
                deckMode: profile.deckMode === 'gt' ? 'gt' : 'pol',
                target: this.cloneTarget(profile.target)
            }));
        },

        applyHotkeyProfiles(profiles) {
            this.hotkeyProfiles = Array.isArray(profiles)
                ? profiles.map((profile, index) => ({
                    ...createHotkeyProfile(index),
                    ...profile,
                    target: this.cloneTarget(profile.target),
                    registration: profile.registration || {
                        state: profile.enabled ? 'invalid' : 'disabled',
                        registered: false,
                        message: profile.enabled
                            ? 'Сохраните бинды, чтобы применить регистрацию'
                            : 'Бинд выключен'
                    }
                }))
                : [];
        },

        async loadHotkeyProfiles() {
            try {
                const result = await window.electronAPI.hotkeys.getAll();
                if (!result?.success) {
                    throw new Error(result?.error || 'Не удалось загрузить бинды');
                }

                this.applyHotkeyProfiles(result.profiles || []);
            } catch (error) {
                console.error('Ошибка загрузки hotkeys:', error);
                this.hotkeyProfiles = [];
            }
        },

        async loadWidgetSettings() {
            try {
                this.autoOpenWidget = await window.electronAPI.store.get('autoOpenWidget', true);
            } catch (error) {
                console.error('Ошибка загрузки настроек виджета:', error);
                this.autoOpenWidget = true;
            }
        },

        async saveAutoOpenWidget() {
            try {
                await window.electronAPI.store.set('autoOpenWidget', this.autoOpenWidget);
                this.notify(
                    this.autoOpenWidget
                        ? 'Виджет будет открываться автоматически'
                        : 'Автооткрытие виджета отключено',
                    'success'
                );
            } catch (error) {
                this.autoOpenWidget = !this.autoOpenWidget;
                this.notify(`Ошибка сохранения настройки виджета: ${error.message}`, 'error');
            }
        },

        async saveHotkeyProfiles() {
            this.hotkeysSaving = true;

            try {
                const result = await window.electronAPI.hotkeys.saveAll(this.serializeHotkeyProfiles());
                if (!result?.success) {
                    throw new Error(result?.error || 'Не удалось сохранить бинды');
                }

                this.applyHotkeyProfiles(result.profiles || []);
                const unresolvedProfiles = (result.profiles || []).filter((profile) =>
                    profile.enabled && profile.registration?.state !== 'registered'
                );

                if (unresolvedProfiles.length > 0) {
                    this.notify('Бинды сохранены, но часть shortcut-ов не активировалась. Проверьте статусы ниже.', 'warning');
                } else {
                    this.notify('Бинды сохранены и перерегистрированы', 'success');
                }
            } catch (error) {
                this.notify(`Ошибка сохранения биндов: ${error.message}`, 'error');
            } finally {
                this.hotkeysSaving = false;
            }
        },

        addHotkeyProfile() {
            this.hotkeyProfiles.push(createHotkeyProfile(this.hotkeyProfiles.length));
            this.notify('Новый bind добавлен. Не забудьте сохранить изменения.', 'info');
        },

        removeHotkeyProfile(profileId) {
            this.hotkeyProfiles = this.hotkeyProfiles.filter((profile) => profile.id !== profileId);
            this.notify('Бинд удалён из списка. Сохраните изменения, чтобы применить их.', 'warning');
        },

        getHotkeyRegistrationChipLabel(profile) {
            const state = profile?.registration?.state || 'disabled';

            if (state === 'registered') {
                return 'Активен';
            }

            if (state === 'conflict') {
                return 'Конфликт';
            }

            if (state === 'failed') {
                return 'Ошибка';
            }

            if (state === 'invalid') {
                return 'Незаполнен';
            }

            return 'Выключен';
        },

        getHotkeyRegistrationChipTone(profile) {
            const state = profile?.registration?.state || 'disabled';

            if (state === 'registered') {
                return 'success';
            }

            if (state === 'conflict') {
                return 'warning';
            }

            if (state === 'failed' || state === 'invalid') {
                return 'danger';
            }

            return 'neutral';
        },

        getHotkeyRegistrationDescription(profile) {
            return profile?.registration?.message || 'Сохраните бинды, чтобы применить global shortcuts';
        },

        getHotkeyOcrChipTone(profile) {
            return profile?.ocrProfileConfigured ? 'success' : 'warning';
        },

        getHotkeyOcrChipLabel(profile) {
            return profile?.ocrProfileConfigured ? 'OCR готов' : 'Нет OCR профиля';
        },

        getHotkeyTargetLabel(profile) {
            if (!profile?.target) {
                return 'Окно не выбрано';
            }

            return profile.target.name || profile.target.executableName || 'Неизвестное окно';
        },

        getHotkeyTargetMeta(profile) {
            if (!profile?.target) {
                return 'Выберите окно, для которого будет запускаться ручной OCR.';
            }

            return profile.target.executableName || 'Окно из текущего списка desktopCapturer';
        },

        getHotkeyProfileKey(profile) {
            if (!profile?.target) {
                return '';
            }

            return profile.target.executableName || `window:${profile.target.name || ''}`;
        },

        handleWindowProfileUpdated(payload = {}) {
            const executableKey = payload.executableName || '';
            let updated = false;

            this.hotkeyProfiles = this.hotkeyProfiles.map((profile) => {
                if (this.getHotkeyProfileKey(profile) !== executableKey) {
                    return profile;
                }

                updated = true;
                return {
                    ...profile,
                    ocrProfileConfigured: true,
                    ocrProfileMessage: `OCR профиль для окна ${profile.target?.name || profile.target?.executableName || 'окно'} настроен.`
                };
            });

            if (!updated) {
                this.loadHotkeyProfiles();
            }
        },

        mapKeyToAccelerator(event) {
            const specialKeys = {
                Space: 'Space',
                Tab: 'Tab',
                Enter: 'Enter',
                Escape: 'Esc',
                ArrowUp: 'Up',
                ArrowDown: 'Down',
                ArrowLeft: 'Left',
                ArrowRight: 'Right',
                Insert: 'Insert',
                Delete: 'Delete',
                Home: 'Home',
                End: 'End',
                PageUp: 'PageUp',
                PageDown: 'PageDown'
            };

            if (specialKeys[event.code]) {
                return specialKeys[event.code];
            }

            if (/^Key[A-Z]$/.test(event.code)) {
                return event.code.slice(3);
            }

            if (/^Digit[0-9]$/.test(event.code)) {
                return event.code.slice(5);
            }

            if (/^F\d{1,2}$/.test(event.key)) {
                return event.key.toUpperCase();
            }

            return null;
        },

        buildAcceleratorFromKeyboardEvent(event) {
            const modifierKeys = ['Shift', 'Control', 'Alt', 'Meta'];
            if (event.key === 'Backspace' || event.key === 'Delete') {
                return '';
            }

            if (event.key === 'Escape') {
                event.target.blur();
                return null;
            }

            if (modifierKeys.includes(event.key)) {
                return null;
            }

            const mainKey = this.mapKeyToAccelerator(event);
            if (!mainKey) {
                return null;
            }

            const modifiers = [];
            if (event.ctrlKey || event.metaKey) {
                modifiers.push('CommandOrControl');
            }
            if (event.altKey) {
                modifiers.push('Alt');
            }
            if (event.shiftKey) {
                modifiers.push('Shift');
            }

            if (!modifiers.length && !/^F\d{1,2}$/.test(mainKey)) {
                this.notify('Для горячей клавиши используйте модификатор или функциональную клавишу', 'error');
                return null;
            }

            return [...modifiers, mainKey].join('+');
        },

        captureHotkeyInput(event, profile) {
            const accelerator = this.buildAcceleratorFromKeyboardEvent(event);
            if (accelerator === null) {
                return;
            }

            profile.accelerator = accelerator;
        },

        async openHotkeyTargetDialog(profileId) {
            this.editingHotkeyId = profileId;
            this.hotkeyWindowDialogVisible = true;
            this.selectedHotkeyWindow = null;

            await this.loadAvailableWindows();

            const profile = this.hotkeyProfiles.find((item) => item.id === profileId);
            if (!profile?.target) {
                return;
            }

            this.selectedHotkeyWindow = this.availableWindows.find((entry) =>
                entry.id === profile.target.id ||
                (profile.target.name && entry.name === profile.target.name) ||
                (profile.target.executableName && entry.executableName === profile.target.executableName)
            ) || null;
        },

        closeHotkeyTargetDialog() {
            this.hotkeyWindowDialogVisible = false;
            this.editingHotkeyId = null;
            this.selectedHotkeyWindow = null;
        },

        selectHotkeyWindow(windowInfo) {
            this.selectedHotkeyWindow = windowInfo;
        },

        applyHotkeyTargetSelection() {
            if (!this.selectedHotkeyWindow || !this.editingHotkeyId) {
                return;
            }

            const profile = this.hotkeyProfiles.find((item) => item.id === this.editingHotkeyId);
            if (!profile) {
                this.closeHotkeyTargetDialog();
                return;
            }

            profile.target = this.cloneTarget({
                targetType: 'window',
                ...this.selectedHotkeyWindow
            });
            profile.ocrProfileConfigured = false;
            profile.ocrProfileMessage = `Для окна ${profile.target.name || profile.target.executableName || 'окно'} ещё не настроены trigger/fast/precise области.`;

            this.closeHotkeyTargetDialog();
        },

        clearHotkeyTarget(profile) {
            profile.target = null;
            profile.ocrProfileConfigured = false;
            profile.ocrProfileMessage = 'Сначала выберите окно и сохраните bind.';
        },

        async configureHotkeyOcrProfile(profile) {
            if (!profile?.target) {
                this.notify('Сначала выберите окно для bind-профиля', 'error');
                return;
            }

            try {
                const targetWindow = this.createWindowPayload(profile.target);
                await window.electronAPI.ocr.setupRegions({
                    mode: 'window',
                    targetWindow,
                    setupType: 'window_capture_profile',
                    profileExecutableName: targetWindow.executableName || `window:${targetWindow.name}`,
                    profileWindowName: targetWindow.name,
                    bindProfileId: profile.id
                });
            } catch (error) {
                this.notify(`Ошибка запуска настройки bind OCR: ${error.message}`, 'error');
            }
        },

        async testHotkeyProfile(profile) {
            try {
                const payload = {
                    id: profile.id,
                    label: profile.label || '',
                    enabled: Boolean(profile.enabled),
                    accelerator: profile.accelerator || '',
                    searchMode: profile.searchMode === 'precise' ? 'precise' : 'fast',
                    deckMode: profile.deckMode === 'gt' ? 'gt' : 'pol',
                    target: this.cloneTarget(profile.target)
                };

                const result = await window.electronAPI.hotkeys.testRun(payload);
                if (!result?.success) {
                    throw new Error(result?.error || 'Не удалось выполнить bind');
                }

                this.notify(
                    result.found
                        ? `Проверка bind выполнена: ${profile.label || profile.accelerator || 'bind'}`
                        : 'Проверка bind завершена, но игрок не найден',
                    result.found ? 'success' : 'warning'
                );
            } catch (error) {
                this.notify(`Ошибка проверки bind: ${error.message}`, 'error');
            }
        },

        setActivePage(pageId) {
            this.activePage = pageId;
        },

        selectResult(resultId) {
            this.selectedResultId = resultId;
            const result = this.results.find((entry) => entry.id === resultId);
            if (result) {
                this.lastPlayerData = result.rawData;
            }
        },

        openResult(resultId) {
            this.selectResult(resultId);
            this.activePage = 'results';
        },

        notify(message, tone = 'info') {
            const id = ++this.toastCounter;
            this.toasts.push({ id, message, tone });

            window.setTimeout(() => {
                this.dismissToast(id);
            }, 3200);
        },

        dismissToast(id) {
            this.toasts = this.toasts.filter((toast) => toast.id !== id);
        },

        applyIncomingUserData(data) {
            if (data?.user) {
                this.currentUser = data.user;
            }

            if (data?.searchMode !== undefined) {
                this.searchMode = normalizeSearchMode(data.searchMode);
            }

            if (data?.deckMode !== undefined) {
                this.deckMode = normalizeDeckMode(data.deckMode);
            }

            if (data?.regions) {
                this.regions = data.regions;
            }

            if (data?.server) {
                this.currentServerMode = data.server.mode || this.currentServerMode;
                this.serverStatus = data.server.available ? 'connected' : 'error';
                this.serverBackup = !!data.server.isBackup;
            }
        },

        getSearchModeMeta(mode) {
            if (mode === 'precise') {
                return {
                    label: 'Точный',
                    summary: 'Ник, рейтинг и клан',
                    description: 'Более строгий поиск, когда нужна дополнительная проверка по клану.'
                };
            }

            return {
                label: 'Быстрый',
                summary: 'Ник и рейтинг',
                description: 'Основной режим для быстрого поиска по OCR без дополнительной валидации.'
            };
        },

        getDeckModeMeta(mode) {
            if (mode === 'gt') {
                return {
                    label: 'GT режим',
                    summary: 'Турнирные бои из battlelog',
                    description: 'Поиск колод по GT-сигнатуре, подтверждённой battlelog API.'
                };
            }

            return {
                label: 'Path of Legends',
                summary: 'Ranked колоды',
                description: 'Поиск колод только по ranked-боям из Path of Legends.'
            };
        },

        getBattleTypeLabel(battleType, fallbackMode = 'pol') {
            if (battleType === 'grandTournament') {
                return 'GT';
            }

            if (battleType === 'pathOfLegends') {
                return 'PoL';
            }

            if (battleType === 'tournament') {
                return 'Турнир';
            }

            if (battleType === 'challenge') {
                return 'Challenge';
            }

            if (battleType === 'friendly') {
                return 'Friendly';
            }

            return fallbackMode === 'gt' ? 'GT' : 'PoL';
        },

        getCaptureSourceLabel(mode) {
            return mode === 'screen' ? 'Экран' : 'Окно';
        },

        async resolveCardImage(card) {
            const fallbackUrl = getFallbackCardImage(card);
            const evolutionLevel = Number(card?.evolution_level || 0);

            try {
                const cachedPath = await window.electronAPI.cache.getCardImage(card?.name || 'Card', evolutionLevel);
                return cachedPath || fallbackUrl;
            } catch {
                return fallbackUrl;
            }
        },

        async prepareDeck(rawDeck, requestedDeckMode) {
            if (!rawDeck || !Array.isArray(rawDeck.cards) || !rawDeck.cards.length) {
                return null;
            }

            const cards = await Promise.all(rawDeck.cards.map(async (card) => {
                const evolutionLevel = Number(card?.evolution_level || 0);
                const fallbackUrl = getFallbackCardImage(card);

                return {
                    name: card?.name || 'Карта',
                    elixirCost: card?.elixir_cost ?? null,
                    evolutionLevel,
                    isEvolution: evolutionLevel === 1 || card?.is_evolution === true,
                    isHero: evolutionLevel >= 2,
                    imageSource: await this.resolveCardImage(card),
                    fallbackUrl
                };
            }));

            return {
                battleType: rawDeck.battle_type || null,
                battleLabel: this.getBattleTypeLabel(rawDeck.battle_type, requestedDeckMode),
                averageElixir: Number.isFinite(Number(rawDeck.average_elixir))
                    ? Number(rawDeck.average_elixir).toFixed(1)
                    : calculateAverageElixir(rawDeck.cards),
                cards
            };
        },

        async prepareResultEntry(playerData) {
            const player = playerData?.player || {};
            const ocrResult = playerData?.ocr_result || {};
            const searchResult = playerData?.search_result || {};
            const decks = Array.isArray(playerData?.decks) ? playerData.decks : [];
            const requestedDeckMode = normalizeDeckMode(playerData?.deck_mode || this.deckMode);
            const isFound = !(playerData?.player_not_found || playerData?.success === false);
            const searchedNickname = playerData?.searched_nickname || ocrResult?.nickname || 'Неизвестный игрок';
            const playerName = player?.name || searchedNickname;

            return {
                id: createResultId(),
                rawData: playerData,
                isFound,
                playerName,
                searchedNickname,
                rating: Number(player?.rating || ocrResult?.rating || 0),
                clanName: player?.clan_name || 'Без клана',
                rank: player?.rank || null,
                searchMethod: searchResult?.search_method || 'OCR',
                deckMode: requestedDeckMode,
                deckModeLabel: this.getDeckModeMeta(requestedDeckMode).label,
                statusLabel: isFound ? 'Найден' : 'Не найден',
                createdAt: new Date().toISOString(),
                displayTime: formatClock(new Date().toISOString()),
                primaryDeck: decks.length ? await this.prepareDeck(decks[0], requestedDeckMode) : null
            };
        },

        async pushResult(playerData) {
            const entry = await this.prepareResultEntry(playerData);
            this.results.unshift(entry);

            if (this.results.length > MAX_RESULTS) {
                this.results.splice(MAX_RESULTS);
            }

            this.selectedResultId = entry.id;
            this.lastPlayerData = playerData;
        },

        async handlePlayerEvent(playerData) {
            await this.pushResult(playerData);
        },

        async handleReprocessedEvent(reprocessData) {
            const updatedData = reprocessData?.data || reprocessData;
            if (!updatedData) {
                return;
            }

            this.notify('Данные результата обновлены', 'success');
            await this.pushResult(updatedData);
        },

        async loadUserSnapshot() {
            try {
                const result = await window.electronAPI.tokens.getUser();
                if (result?.success && result.user) {
                    this.currentUser = result.user;
                }
            } catch {
                // user-data event remains the main source of truth
            }
        },

        async loadSearchPreferences() {
            try {
                const result = await window.electronAPI.settings.getSearchMode();
                if (result?.success) {
                    this.searchMode = normalizeSearchMode(result.mode);
                }

                const deckMode = await window.electronAPI.store.get('deckMode', 'pol');
                this.deckMode = normalizeDeckMode(deckMode);
            } catch (error) {
                console.error('Ошибка загрузки search preferences:', error);
            }
        },

        async loadTriggerSettings() {
            try {
                const delays = await window.electronAPI.store.get('triggerDelays', { fast: 0, precise: 2.2 });
                const settings = await window.electronAPI.store.get('triggerSettings', { cooldown: 15, confirmations: 2 });
                const hideCaptureBorder = await window.electronAPI.store.get('hideCaptureborder', false);

                this.triggerSettings.preciseDelay = Number(delays?.precise || 2.2);
                this.triggerSettings.cooldown = Number(settings?.cooldown || 15);
                this.triggerSettings.confirmations = Number(settings?.confirmations || 2);
                this.triggerSettings.hideCaptureBorder = !!hideCaptureBorder;
            } catch (error) {
                console.error('Ошибка загрузки trigger settings:', error);
            }
        },

        async loadRegions() {
            try {
                const result = await window.electronAPI.ocr.getRegions();
                if (result?.success) {
                    this.regions = result.regions;
                }
            } catch (error) {
                console.error('Ошибка загрузки OCR областей:', error);
            }
        },

        async loadCaptureTarget() {
            try {
                const result = await window.electronAPI.monitor.getCaptureTarget();
                if (result?.success && result.target) {
                    this.captureTarget = result.target;
                }
            } catch (error) {
                console.error('Ошибка загрузки capture target:', error);
            }
        },

        async loadMonitoringStatus() {
            try {
                const result = await window.electronAPI.monitor.getStatus();
                if (result?.success) {
                    this.isMonitoring = !!result.status?.isRunning;
                }
            } catch (error) {
                console.error('Ошибка загрузки статуса мониторинга:', error);
            }
        },

        async loadVersion() {
            try {
                this.version = await window.electronAPI.app.getVersion();
            } catch (error) {
                console.error('Ошибка загрузки версии:', error);
                this.version = '-';
            }
        },

        async loadServerState() {
            try {
                const result = await window.electronAPI.server.getCurrent();
                if (result?.success && result.server) {
                    this.currentServerMode = result.server.mode || this.currentServerMode;
                    this.serverStatus = result.server.available ? 'connected' : 'error';
                }

                await this.pollServerConnection(true);
            } catch (error) {
                console.error('Ошибка загрузки сервера:', error);
                this.serverStatus = 'error';
            }
        },

        async loadCacheStatus() {
            try {
                const status = await window.electronAPI.cache.getStatus();
                this.cacheStatus = {
                    ...this.cacheStatus,
                    ...status
                };
            } catch (error) {
                console.error('Ошибка загрузки статуса кеша:', error);
                this.cacheStatus.error = error.message;
            }
        },

        async refreshCache() {
            if (this.cacheBusy) {
                return;
            }

            this.cacheBusy = true;

            try {
                const result = await window.electronAPI.cache.forceUpdate();
                if (result?.success === false) {
                    throw new Error(result.error || 'Не удалось обновить кеш карт');
                }

                await this.loadCacheStatus();
                this.notify('Кеш изображений обновлен', 'success');
            } catch (error) {
                this.notify(`Ошибка обновления кеша: ${error.message}`, 'error');
            } finally {
                this.cacheBusy = false;
            }
        },

        async pollServerConnection(silent = true) {
            try {
                const result = await window.electronAPI.server.check();
                this.serverStatus = result?.available ? 'connected' : 'error';
                this.serverMessage = result?.error || '';

                if (!result?.available && !silent) {
                    this.notify(this.serverMessage || 'Сервер недоступен', 'error');
                }
            } catch (error) {
                this.serverStatus = 'error';
                this.serverMessage = error.message;
                if (!silent) {
                    this.notify(`Ошибка проверки сервера: ${error.message}`, 'error');
                }
            }
        },

        async startMonitoring() {
            try {
                const result = await window.electronAPI.monitor.start();
                if (!result?.success) {
                    throw new Error(result?.error || 'Не удалось запустить мониторинг');
                }

                this.isMonitoring = true;
                this.notify(result.message || 'Мониторинг запущен', 'success');
            } catch (error) {
                this.notify(error.message, 'error');
            }
        },

        async stopMonitoring() {
            try {
                const result = await window.electronAPI.monitor.stop();
                if (!result?.success) {
                    throw new Error(result?.error || 'Не удалось остановить мониторинг');
                }

                this.isMonitoring = false;
                this.notify('Мониторинг остановлен', 'warning');
            } catch (error) {
                this.notify(error.message, 'error');
            }
        },

        async saveSearchMode(mode) {
            const normalizedMode = normalizeSearchMode(mode);
            if (this.searchMode === normalizedMode) {
                return;
            }

            const previousMode = this.searchMode;
            this.searchMode = normalizedMode;

            try {
                const result = await window.electronAPI.settings.saveSearchMode(normalizedMode);
                if (!result?.success) {
                    throw new Error(result?.error || 'Не удалось сохранить режим OCR');
                }

                this.notify(`Режим OCR: ${this.getSearchModeMeta(normalizedMode).label}`, 'success');
            } catch (error) {
                this.searchMode = previousMode;
                this.notify(`Ошибка сохранения режима OCR: ${error.message}`, 'error');
            }
        },

        async saveDeckMode(mode) {
            const normalizedMode = normalizeDeckMode(mode);
            if (this.deckMode === normalizedMode) {
                return;
            }

            const previousMode = this.deckMode;
            this.deckMode = normalizedMode;

            try {
                await window.electronAPI.store.set('deckMode', normalizedMode);
                this.notify(`Тип колоды: ${this.getDeckModeMeta(normalizedMode).label}`, 'success');
            } catch (error) {
                this.deckMode = previousMode;
                this.notify(`Ошибка сохранения режима колоды: ${error.message}`, 'error');
            }
        },

        async switchServer(mode) {
            if (this.currentServerMode === mode && this.serverStatus !== 'error') {
                return;
            }

            const previousMode = this.currentServerMode;
            this.currentServerMode = mode;
            this.serverStatus = 'switching';

            try {
                const result = await window.electronAPI.server.switch(mode);
                if (!result?.success) {
                    throw new Error(result?.error || 'Не удалось переключить сервер');
                }

                this.currentServerMode = mode;
                this.serverStatus = result.server?.available ? 'connected' : 'error';
                this.serverBackup = !!result.server?.isBackup;
                this.notify(`Сервер: ${mode === 'test' ? 'Test' : 'Global'}`, 'success');
            } catch (error) {
                this.currentServerMode = previousMode;
                await this.loadServerState();
                this.notify(`Ошибка переключения сервера: ${error.message}`, 'error');
            }
        },

        async savePreciseDelay() {
            try {
                const delays = await window.electronAPI.store.get('triggerDelays', { fast: 0, precise: 2.2 });
                delays.precise = Number(this.triggerSettings.preciseDelay);
                await window.electronAPI.store.set('triggerDelays', delays);
                await this.restartMonitoringIfActive('обновление задержки точного режима');
                this.notify(`Задержка точного режима: ${this.triggerSettings.preciseDelay.toFixed(1)} с`, 'success');
            } catch (error) {
                this.notify(`Ошибка сохранения задержки: ${error.message}`, 'error');
            }
        },

        async saveCooldown() {
            try {
                const settings = await window.electronAPI.store.get('triggerSettings', { cooldown: 15, confirmations: 2 });
                settings.cooldown = Number(this.triggerSettings.cooldown);
                await window.electronAPI.store.set('triggerSettings', settings);
                await this.restartMonitoringIfActive('обновление cooldown');
                this.notify(`Cooldown: ${this.triggerSettings.cooldown} с`, 'success');
            } catch (error) {
                this.notify(`Ошибка сохранения cooldown: ${error.message}`, 'error');
            }
        },

        async saveConfirmations() {
            try {
                const settings = await window.electronAPI.store.get('triggerSettings', { cooldown: 15, confirmations: 2 });
                settings.confirmations = Number(this.triggerSettings.confirmations);
                await window.electronAPI.store.set('triggerSettings', settings);
                await this.restartMonitoringIfActive('обновление числа подтверждений');
                this.notify(`Подтверждения: ${this.triggerSettings.confirmations}`, 'success');
            } catch (error) {
                this.notify(`Ошибка сохранения подтверждений: ${error.message}`, 'error');
            }
        },

        async saveHideCaptureBorder() {
            try {
                await window.electronAPI.store.set('hideCaptureborder', this.triggerSettings.hideCaptureBorder);
                await this.restartMonitoringIfActive('обновление режима скрытия рамки');
                this.notify(
                    this.triggerSettings.hideCaptureBorder
                        ? 'Рамка захвата скрыта'
                        : 'Рамка захвата отображается',
                    'success'
                );
            } catch (error) {
                this.notify(`Ошибка сохранения настройки рамки: ${error.message}`, 'error');
            }
        },

        async resetTriggerSettings() {
            const confirmed = confirm('Сбросить trigger-настройки к значениям по умолчанию?');
            if (!confirmed) {
                return;
            }

            try {
                await window.electronAPI.store.set('triggerDelays', { fast: 0, precise: 2.2 });
                await window.electronAPI.store.set('triggerSettings', { cooldown: 15, confirmations: 2 });
                await window.electronAPI.store.set('hideCaptureborder', false);
                await this.loadTriggerSettings();
                await this.restartMonitoringIfActive('сброс trigger-настроек');
                this.notify('Trigger-настройки сброшены', 'success');
            } catch (error) {
                this.notify(`Ошибка сброса настроек: ${error.message}`, 'error');
            }
        },

        async restartMonitoringIfActive(reason) {
            try {
                const result = await window.electronAPI.monitor.getStatus();
                if (result?.success && result.status?.isRunning) {
                    await window.electronAPI.monitor.restart(reason);
                    this.isMonitoring = true;
                }
            } catch (error) {
                console.warn('Не удалось перезапустить мониторинг:', error);
            }
        },

        async openCaptureDialog() {
            this.windowDialogVisible = true;
            this.windowsError = '';
            this.selectedWindow = null;
            this.selectedCaptureMode = this.captureTarget?.targetType === 'screen' ? 'screen' : 'window';

            if (this.selectedCaptureMode === 'window') {
                await this.loadAvailableWindows();
                if (this.captureTarget?.targetType === 'window' && this.captureTarget?.targetId) {
                    this.selectedWindow = this.availableWindows.find((entry) => entry.id === this.captureTarget.targetId) || null;
                }
            }
        },

        closeCaptureDialog() {
            this.windowDialogVisible = false;
            this.selectedWindow = null;
            this.windowsError = '';
        },

        async selectCaptureMode(mode) {
            this.selectedCaptureMode = mode;
            this.selectedWindow = null;

            if (mode === 'window') {
                await this.loadAvailableWindows();
            }
        },

        async loadAvailableWindows() {
            this.windowsLoading = true;
            this.windowsError = '';

            try {
                const response = await window.electronAPI.window.getAvailable(true);
                if (!response?.success || !Array.isArray(response.windows)) {
                    throw new Error(response?.error || 'Не удалось загрузить список окон');
                }

                this.availableWindows = response.windows;
            } catch (error) {
                this.availableWindows = [];
                this.windowsError = error.message;
            } finally {
                this.windowsLoading = false;
            }
        },

        selectWindow(windowInfo) {
            this.selectedWindow = windowInfo;
        },

        async startOCRSetup() {
            try {
                if (this.selectedCaptureMode === 'screen') {
                    await window.electronAPI.ocr.setupRegions();
                } else if (this.selectedWindow) {
                    const targetWindow = this.createWindowPayload(this.selectedWindow);
                    const context = {
                        mode: 'window',
                        targetWindow
                    };

                    const setTargetResult = await window.electronAPI.monitor.setWindowTarget(targetWindow);
                    if (!setTargetResult?.success) {
                        throw new Error(setTargetResult?.error || 'Не удалось выбрать окно для захвата');
                    }

                    await window.electronAPI.ocr.setupRegions(context);
                    await window.electronAPI.window.saveSelection(targetWindow);
                } else {
                    throw new Error('Выберите окно для настройки OCR');
                }

                this.closeCaptureDialog();
                await this.loadCaptureTarget();
                this.notify('Окно настройки OCR открыто', 'success');
            } catch (error) {
                this.notify(`Ошибка запуска настройки: ${error.message}`, 'error');
            }
        },

        async openWidget(resultEntry = null) {
            const payload = resultEntry?.rawData || this.selectedResult?.rawData || this.latestResult?.rawData || this.lastPlayerData;
            if (!payload) {
                this.notify('Нет данных для открытия виджета', 'error');
                return;
            }

            try {
                await window.electronAPI.widget.toggle(payload);
            } catch (error) {
                this.notify(`Ошибка открытия виджета: ${error.message}`, 'error');
            }
        },

        async openStreamerPanel() {
            if (this.streamerBusy) {
                return;
            }

            this.streamerBusy = true;

            try {
                const result = await window.electronAPI.tokens.getUser();
                if (!result?.success || !result.tokens) {
                    throw new Error(result?.error || 'Токены не найдены');
                }

                const tokensJson = JSON.stringify(result.tokens);
                localStorage.setItem('auth_tokens', tokensJson);
                localStorage.setItem('tokens', tokensJson);
                localStorage.setItem('streamer_tokens', tokensJson);
                sessionStorage.setItem('auth_tokens', tokensJson);
                sessionStorage.setItem('streamer_tokens', tokensJson);
                window.name = JSON.stringify({
                    tokens: result.tokens,
                    user: result.user || null
                });

                if (result.user) {
                    const userJson = JSON.stringify(result.user);
                    localStorage.setItem('user', userJson);
                    localStorage.setItem('streamer_user', userJson);
                    sessionStorage.setItem('user', userJson);
                    sessionStorage.setItem('streamer_user', userJson);
                }

                try {
                    await window.electronAPI.store.set('streamer_tokens', result.tokens);
                    await window.electronAPI.store.set('streamer_user', result.user || null);
                } catch (storeError) {
                    console.warn('Ошибка сохранения streamer auth в store:', storeError);
                }

                window.location.href = 'streamer.html';
            } catch (error) {
                this.notify(`Ошибка открытия стримерской панели: ${error.message}`, 'error');
            } finally {
                this.streamerBusy = false;
            }
        },

        async resolveExternalUrl(url) {
            if (!url) {
                return '';
            }

            if (url.startsWith('http://') || url.startsWith('https://')) {
                return url;
            }

            if (url.startsWith('/')) {
                const serverUrl = await window.electronAPI.store.getServerUrl();
                return `${serverUrl}${url}`;
            }

            return url;
        },

        async checkForUpdates(options = {}) {
            const silent = Boolean(options.silent);
            if (this.updateState.checking) {
                return;
            }

            this.updateState = {
                ...this.updateState,
                checking: true,
                status: 'checking',
                text: 'Проверяем обновления...'
            };

            try {
                const result = await window.electronAPI.update.checkSimple();
                if (!result?.success) {
                    throw new Error(result?.error || 'Не удалось проверить обновления');
                }

                if (result.hasUpdate) {
                    this.updateState = {
                        ...this.updateState,
                        checking: false,
                        status: 'available',
                        text: `Доступна версия ${result.latestVersion}`,
                        hasUpdate: true,
                        latestVersion: result.latestVersion || '',
                        releaseDate: formatDateLabel(result.releaseDate),
                        fileSizeLabel: formatFileSize(result.fileSize),
                        downloadUrl: result.downloadUrl || '',
                        releaseUrl: result.releaseUrl || '',
                        downloadedFilePath: '',
                        progress: 0,
                        downloading: false
                    };

                    if (!silent) {
                        this.notify(`Доступно обновление ${result.latestVersion}`, 'success');
                    }
                } else {
                    this.updateState = {
                        ...this.updateState,
                        checking: false,
                        status: 'ready',
                        text: 'Приложение актуально',
                        hasUpdate: false,
                        latestVersion: '',
                        releaseDate: '',
                        fileSizeLabel: '',
                        downloadUrl: '',
                        releaseUrl: '',
                        downloadedFilePath: '',
                        progress: 0,
                        downloading: false
                    };

                    if (!silent) {
                        this.notify('У вас последняя версия', 'success');
                    }
                }
            } catch (error) {
                this.updateState = {
                    ...this.updateState,
                    checking: false,
                    status: 'error',
                    text: error.message,
                    downloading: false
                };

                if (!silent) {
                    this.notify(`Ошибка проверки обновлений: ${error.message}`, 'error');
                }
            }
        },

        async downloadUpdate(downloadType = 'installer') {
            if (this.updateState.downloading) {
                return;
            }

            try {
                this.updateState = {
                    ...this.updateState,
                    status: 'downloading',
                    text: 'Скачивание обновления...',
                    downloading: true,
                    progress: 0
                };

                const result = await window.electronAPI.update.download(downloadType);
                if (result?.success === false) {
                    throw new Error(result.error || 'Не удалось начать скачивание');
                }

                if (result?.downloadPath) {
                    this.handleUpdateDownloaded({
                        filePath: result.downloadPath,
                        version: result.version,
                        type: result.type,
                        fileSize: result.fileSize
                    });
                } else {
                    this.notify('Скачивание обновления запущено', 'success');
                }
            } catch (error) {
                this.updateState = {
                    ...this.updateState,
                    status: 'error',
                    text: error.message,
                    downloading: false
                };
                this.notify(`Ошибка скачивания: ${error.message}`, 'error');
            }
        },

        async installUpdate() {
            if (!this.updateState.downloadedFilePath) {
                this.notify('Сначала скачайте обновление', 'error');
                return;
            }

            try {
                const result = await window.electronAPI.update.install(this.updateState.downloadedFilePath);
                if (result?.success === false) {
                    throw new Error(result.error || 'Не удалось запустить установку');
                }

                this.notify('Установка обновления запущена', 'success');
            } catch (error) {
                this.notify(`Ошибка установки: ${error.message}`, 'error');
            }
        },

        async openUpdatePage(url = '') {
            try {
                const resolvedUrl = await this.resolveExternalUrl(url || this.updateState.releaseUrl || this.updateState.downloadUrl);
                if (!resolvedUrl) {
                    throw new Error('Нет ссылки для открытия');
                }

                const result = await window.electronAPI.update.openRelease(resolvedUrl);
                if (result?.success === false) {
                    throw new Error(result.error || 'Не удалось открыть ссылку');
                }
            } catch (error) {
                this.notify(`Ошибка открытия ссылки: ${error.message}`, 'error');
            }
        },

        handleUpdateProgress(progress) {
            const percent = Number(progress?.percent || 0);
            this.updateState = {
                ...this.updateState,
                status: 'downloading',
                text: `Скачивание обновления... ${percent.toFixed(0)}%`,
                progress: percent,
                downloading: percent < 100
            };
        },

        handleUpdateDownloaded(result) {
            const nextFilePath = result?.filePath || '';
            const alreadyHandled = this.updateState.status === 'downloaded' &&
                this.updateState.downloadedFilePath &&
                this.updateState.downloadedFilePath === nextFilePath;

            this.updateState = {
                ...this.updateState,
                status: 'downloaded',
                text: 'Обновление готово к установке',
                downloadedFilePath: nextFilePath,
                downloading: false,
                progress: 100
            };

            if (!alreadyHandled) {
                this.notify('Обновление готово к установке', 'success');
            }
        },

        handleUpdateError(errorMessage) {
            const message = typeof errorMessage === 'string'
                ? errorMessage
                : errorMessage?.message || 'Неизвестная ошибка';

            this.updateState = {
                ...this.updateState,
                status: 'error',
                text: message,
                downloading: false
            };

            this.notify(`Ошибка обновления: ${message}`, 'error');
        },

        async logout() {
            const confirmed = confirm('Выйти из приложения?');
            if (!confirmed) {
                return;
            }

            await window.electronAPI.auth.logout();
        },

        handlePythonStatus(status) {
            this.notify(status, 'info');
        },

        handlePythonError(error) {
            this.notify(`Ошибка: ${error}`, 'error');
        },

        handlePythonStopped() {
            this.isMonitoring = false;
            this.notify('Мониторинг остановлен', 'warning');
        },

        async handleRegionsUpdated(regions) {
            if (regions) {
                this.regions = regions;
            } else {
                await this.loadRegions();
            }

            this.notify('OCR области обновлены', 'success');
        },

        handleServerChanged(serverInfo) {
            this.currentServerMode = serverInfo?.mode || this.currentServerMode;
            this.serverStatus = serverInfo?.available ? 'connected' : 'error';
            this.serverBackup = !!serverInfo?.isBackup;
        },

        handleServerSwitching(data) {
            this.currentServerMode = data?.mode || this.currentServerMode;
            this.serverStatus = 'switching';
        },

        handleServerStatus(serverInfo) {
            this.serverStatus = serverInfo?.available ? 'connected' : 'error';
            this.serverBackup = !!serverInfo?.isBackup;
        },

        registerElectronListeners() {
            window.electronAPI.on('user-data', (data) => {
                this.applyIncomingUserData(data);
            });

            window.electronAPI.on('python-status', (status) => {
                this.handlePythonStatus(status);
            });

            window.electronAPI.on('player-found', async (playerData) => {
                await this.handlePlayerEvent(playerData);
            });

            window.electronAPI.on('ocr_reprocessed', async (payload) => {
                await this.handleReprocessedEvent(payload);
            });

            window.electronAPI.on('python-error', (error) => {
                this.handlePythonError(error);
            });

            window.electronAPI.on('python-stopped', () => {
                this.handlePythonStopped();
            });

            window.electronAPI.on('regions-updated', async (regions) => {
                await this.handleRegionsUpdated(regions);
            });

            window.electronAPI.on('server-changed', (serverInfo) => {
                this.handleServerChanged(serverInfo);
            });

            window.electronAPI.on('server-switching', (data) => {
                this.handleServerSwitching(data);
            });

            window.electronAPI.on('server-status', (serverInfo) => {
                this.handleServerStatus(serverInfo);
            });

            window.electronAPI.on('window-profile-updated', (payload) => {
                this.handleWindowProfileUpdated(payload);
                this.notify('OCR профиль окна обновлён', 'success');
            });

            window.electronAPI.on('update-download-progress', (progress) => {
                this.handleUpdateProgress(progress);
            });

            window.electronAPI.on('update-downloaded', (result) => {
                this.handleUpdateDownloaded(result);
            });

            window.electronAPI.on('update-error', (error) => {
                this.handleUpdateError(error);
            });
        },

        async loadBootstrapState() {
            await Promise.allSettled([
                this.loadUserSnapshot(),
                this.loadSearchPreferences(),
                this.loadTriggerSettings(),
                this.loadRegions(),
                this.loadCaptureTarget(),
                this.loadWidgetSettings(),
                this.loadHotkeyProfiles(),
                this.loadMonitoringStatus(),
                this.loadVersion(),
                this.loadServerState(),
                this.loadCacheStatus()
            ]);

            this.isReady = true;

            window.setTimeout(() => {
                this.checkForUpdates({ silent: true });
            }, 1500);

            this.serverPollHandle = window.setInterval(() => {
                this.pollServerConnection(true);
            }, 30000);
        }
    },

    async mounted() {
        this.registerElectronListeners();
        await this.loadBootstrapState();
    },

    beforeUnmount() {
        if (this.serverPollHandle) {
            window.clearInterval(this.serverPollHandle);
        }
    }
}).mount('#app');
