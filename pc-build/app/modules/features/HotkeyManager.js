let globalShortcut;
let nativeImage;
try {
    const electron = require('electron');
    globalShortcut = electron.globalShortcut;
    nativeImage = electron.nativeImage;
} catch (error) {
    globalShortcut = null;
    nativeImage = null;
}

class HotkeyManager {
    constructor(appManager, eventBus, storeManager) {
        this.appManager = appManager;
        this.eventBus = eventBus;
        this.storeManager = storeManager;
        this.registrationStates = new Map();
        this.executionLocks = new Set();

        console.log('⌨️ HotkeyManager инициализирован');
    }

    async initialize() {
        console.log('⌨️ Инициализация global hotkeys...');
        return await this.refreshRegistrations();
    }

    createDefaultRegistrationState(state = 'disabled', message = '') {
        return {
            state,
            registered: state === 'registered',
            message
        };
    }

    normalizeString(value) {
        return typeof value === 'string' ? value.trim() : '';
    }

    normalizeAccelerator(accelerator) {
        const rawValue = this.normalizeString(accelerator);
        if (!rawValue) {
            return '';
        }

        const parts = rawValue
            .split('+')
            .map((part) => part.trim())
            .filter(Boolean);

        return parts.join('+');
    }

    normalizeTarget(target) {
        if (!target || typeof target !== 'object') {
            return null;
        }

        const targetType = target.targetType === 'screen' ? 'screen' : 'window';

        return {
            targetType,
            id: this.normalizeString(target.id),
            name: this.normalizeString(target.name),
            executableName: this.normalizeString(target.executableName),
            processId: Number.isFinite(Number(target.processId)) ? Number(target.processId) : null
        };
    }

    normalizeProfile(profile = {}, index = 0) {
        return {
            id: this.normalizeString(profile.id) || `manual_hotkey_${index + 1}`,
            label: this.normalizeString(profile.label) || '',
            enabled: Boolean(profile.enabled),
            accelerator: this.normalizeAccelerator(profile.accelerator),
            searchMode: profile.searchMode === 'precise' ? 'precise' : 'fast',
            deckMode: profile.deckMode === 'gt' ? 'gt' : 'pol',
            target: this.normalizeTarget(profile.target),
            registration: profile.registration || null
        };
    }

    sanitizeProfiles(profiles) {
        if (!Array.isArray(profiles)) {
            return [];
        }

        return profiles.map((profile, index) => this.normalizeProfile(profile, index));
    }

    getStoredProfiles() {
        return this.sanitizeProfiles(this.storeManager.getManualHotkeys());
    }

    getRegistrationState(profileId) {
        return this.registrationStates.get(profileId) || this.createDefaultRegistrationState();
    }

    decorateProfiles(profiles) {
        return profiles.map((profile) => ({
            ...profile,
            registration: this.getRegistrationState(profile.id),
            ocrProfileConfigured: this.hasConfiguredRegionsForTarget(profile.target),
            ocrProfileMessage: this.getOcrProfileMessage(profile.target)
        }));
    }

    getProfilesWithStates() {
        const profiles = this.getStoredProfiles();
        return {
            success: true,
            profiles: this.decorateProfiles(profiles)
        };
    }

    hasRequiredTarget(target) {
        if (!target) {
            return false;
        }

        if (target.targetType === 'screen') {
            return true;
        }

        return Boolean(target.name || target.id || target.executableName);
    }

    createProfileLabel(profile) {
        return profile.label || profile.accelerator || 'manual hotkey';
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

    hasConfiguredRegionsForTarget(target) {
        return !!this.getOcrRegionsForTarget(target);
    }

    getTargetProfileKey(target) {
        if (!target) {
            return '';
        }

        const executableName = this.normalizeString(target.executableName);
        if (executableName) {
            return executableName;
        }

        const targetName = this.normalizeString(target.name);
        return targetName ? `window:${targetName}` : '';
    }

    getOcrRegionsForTarget(target) {
        if (!target) {
            return null;
        }

        if (target.targetType === 'screen') {
            const globalRegions = this.storeManager.getOcrRegions();
            return this.hasManualLookupRegions(globalRegions) ? globalRegions : null;
        }

        const profileKey = this.getTargetProfileKey(target);
        if (!profileKey) {
            return null;
        }

        const profile = this.storeManager.getWindowProfile(profileKey);
        return this.hasManualLookupRegions(profile) ? profile : null;
    }

    hasManualLookupRegions(profile) {
        return !!(
            profile &&
            this.isValidRegion(profile.normal_data_area) &&
            this.isValidRegion(profile.precise_data_area)
        );
    }

    getOcrProfileMessage(target) {
        if (!target) {
            return 'Сначала выберите окно и сохраните bind.';
        }

        if (target.targetType === 'screen') {
            return this.hasConfiguredRegionsForTarget(target)
                ? 'Используются общие OCR области приложения.'
                : 'Для экранного бинда нужно настроить общие OCR области на странице Захват.';
        }

        const windowName = target.name || target.executableName || 'окно';
        return this.hasConfiguredRegionsForTarget(target)
            ? `OCR профиль для окна ${windowName} настроен.`
            : `Для окна ${windowName} ещё не настроены trigger/fast/precise области.`;
    }

    getProfileRegionForSearchMode(ocrProfile, searchMode) {
        if (!ocrProfile) {
            return null;
        }

        return searchMode === 'precise'
            ? ocrProfile.precise_data_area
            : ocrProfile.normal_data_area;
    }

    setRegistrationState(profileId, state, message = '') {
        this.registrationStates.set(profileId, this.createDefaultRegistrationState(state, message));
    }

    async refreshRegistrations() {
        const profiles = this.getStoredProfiles();
        this.unregisterAllShortcuts();

        if (!globalShortcut) {
            profiles.forEach((profile) => {
                this.setRegistrationState(profile.id, 'failed', 'globalShortcut недоступен');
            });

            return {
                success: false,
                error: 'globalShortcut недоступен',
                profiles: this.decorateProfiles(profiles)
            };
        }

        const usedAccelerators = new Map();

        for (const profile of profiles) {
            if (!profile.enabled) {
                this.setRegistrationState(profile.id, 'disabled', 'Бинд выключен');
                continue;
            }

            if (!profile.accelerator) {
                this.setRegistrationState(profile.id, 'invalid', 'Не задано сочетание клавиш');
                continue;
            }

            if (!this.hasRequiredTarget(profile.target)) {
                this.setRegistrationState(profile.id, 'invalid', 'Не выбрано окно для бинда');
                continue;
            }

            const acceleratorKey = profile.accelerator.toLowerCase();
            if (usedAccelerators.has(acceleratorKey)) {
                const duplicateOf = usedAccelerators.get(acceleratorKey);
                this.setRegistrationState(profile.id, 'conflict', `Конфликт с биндом ${duplicateOf}`);
                continue;
            }

            let registered = false;

            try {
                registered = globalShortcut.register(profile.accelerator, () => {
                    this.handleShortcutTriggered(profile.id).catch((error) => {
                        const bindLabel = this.createProfileLabel(profile);
                        this.eventBus.emit('monitor:error', `Бинд ${bindLabel}: ${error.message}`);
                    });
                });
            } catch (error) {
                this.setRegistrationState(profile.id, 'failed', error.message || 'Некорректное сочетание клавиш');
                continue;
            }

            if (!registered) {
                this.setRegistrationState(profile.id, 'failed', 'Сочетание не удалось зарегистрировать');
                continue;
            }

            usedAccelerators.set(acceleratorKey, this.createProfileLabel(profile));
            this.setRegistrationState(profile.id, 'registered', 'Бинд активен');
        }

        console.log(`⌨️ Зарегистрировано биндов: ${Array.from(this.registrationStates.values()).filter((state) => state.registered).length}`);

        return {
            success: true,
            profiles: this.decorateProfiles(profiles)
        };
    }

    unregisterAllShortcuts() {
        if (globalShortcut) {
            globalShortcut.unregisterAll();
        }

        this.registrationStates.clear();
    }

    async saveProfiles(profiles) {
        const sanitizedProfiles = this.sanitizeProfiles(profiles).map(({ registration, ...profile }) => profile);
        this.storeManager.setManualHotkeys(sanitizedProfiles);
        return await this.refreshRegistrations();
    }

    async handleShortcutTriggered(profileId) {
        if (this.executionLocks.has(profileId)) {
            const profile = this.getStoredProfiles().find((item) => item.id === profileId);
            this.eventBus.emit('monitor:status', `Бинд ${this.createProfileLabel(profile || {})} уже выполняется`);
            return;
        }

        const profile = this.getStoredProfiles().find((item) => item.id === profileId);
        if (!profile || !profile.enabled) {
            return;
        }

        this.executionLocks.add(profileId);

        try {
            await this.executeProfile(profile);
        } finally {
            this.executionLocks.delete(profileId);
        }
    }

    async executeProfile(profile) {
        const bindLabel = this.createProfileLabel(profile);
        this.eventBus.emit('monitor:status', `Запуск ручного бинда: ${bindLabel}`);

        const { imageBuffer, resolvedTarget } = await this.captureForProfile(profile);
        const monitor = this.appManager.getMonitor();

        const lookupResult = await monitor.runManualLookup({
            imageBuffer,
            timestamp: new Date().toISOString(),
            searchMode: profile.searchMode,
            deckMode: profile.deckMode,
            sourceLabel: bindLabel,
            targetLabel: resolvedTarget?.name || resolvedTarget?.targetType || 'manual'
        });

        const statusMessage = lookupResult.found
            ? `Бинд ${bindLabel}: результат получен`
            : `Бинд ${bindLabel}: игрок не найден`;

        this.eventBus.emit('monitor:status', statusMessage);

        return lookupResult;
    }

    async testProfile(profile) {
        const normalizedProfile = this.normalizeProfile(profile);
        return await this.executeProfile(normalizedProfile);
    }

    async captureForProfile(profile) {
        if (!this.hasRequiredTarget(profile.target)) {
            throw new Error('Для бинда не выбрано окно');
        }

        if (profile.target.targetType === 'screen') {
            const screenshot = await this.captureScreen();
            const ocrProfile = this.getOcrRegionsForTarget(profile.target);
            if (!ocrProfile) {
                throw new Error('Для экранного бинда не настроены общие OCR области');
            }

            return {
                imageBuffer: this.cropScreenshotToSearchRegion(screenshot.dataURL, ocrProfile, profile.searchMode),
                resolvedTarget: screenshot.resolvedTarget
            };
        }

        const resolvedTarget = await this.resolveWindowTarget(profile.target);
        const screenshot = await this.captureWindow(resolvedTarget);
        const ocrProfile = this.getOcrRegionsForTarget({
            targetType: 'window',
            executableName: resolvedTarget.executableName,
            name: resolvedTarget.name
        });

        if (!ocrProfile) {
            throw new Error(`Для окна ${resolvedTarget.name} не настроены OCR области bind-профиля`);
        }

        return {
            imageBuffer: this.cropScreenshotToSearchRegion(screenshot.dataURL, ocrProfile, profile.searchMode),
            resolvedTarget
        };
    }

    async resolveWindowTarget(target) {
        const windows = await this.appManager.getAvailableWindows(true);
        if (!Array.isArray(windows) || windows.length === 0) {
            throw new Error('Список окон пуст');
        }

        const exactId = target.id
            ? windows.find((windowInfo) => windowInfo.id === target.id)
            : null;
        if (exactId) {
            return exactId;
        }

        const exactNameAndExe = windows.find((windowInfo) =>
            target.name &&
            target.executableName &&
            windowInfo.name === target.name &&
            windowInfo.executableName === target.executableName
        );
        if (exactNameAndExe) {
            return exactNameAndExe;
        }

        const exactName = target.name
            ? windows.find((windowInfo) => windowInfo.name === target.name)
            : null;
        if (exactName) {
            return exactName;
        }

        const sameExecutable = target.executableName
            ? windows.find((windowInfo) => windowInfo.executableName === target.executableName)
            : null;
        if (sameExecutable) {
            return sameExecutable;
        }

        throw new Error(`Окно для бинда не найдено: ${target.name || target.executableName || 'Unknown window'}`);
    }

    async captureWindow(windowInfo) {
        const setupWindow = this.appManager.getSetupWindow();
        if (!setupWindow || typeof setupWindow.captureWindowScreenshot !== 'function') {
            throw new Error('Модуль захвата окна недоступен');
        }

        const screenshot = await setupWindow.captureWindowScreenshot(windowInfo);
        if (!screenshot?.dataURL) {
            throw new Error('Не удалось захватить окно для бинда');
        }

        return screenshot;
    }

    async captureScreen() {
        const ocrManager = this.appManager.getOcr();
        if (!ocrManager || typeof ocrManager.createSetupScreenshot !== 'function') {
            throw new Error('Модуль захвата экрана недоступен');
        }

        const screenshotResult = await ocrManager.createSetupScreenshot();
        if (!screenshotResult?.success || !screenshotResult.screenshot) {
            throw new Error(screenshotResult?.error || 'Не удалось захватить экран для бинда');
        }

        return {
            dataURL: screenshotResult.screenshot,
            resolvedTarget: {
                targetType: 'screen',
                name: 'Full Screen'
            }
        };
    }

    cropScreenshotToSearchRegion(dataUrl, ocrProfile, searchMode) {
        if (!nativeImage) {
            throw new Error('nativeImage недоступен');
        }

        const selectedRegion = this.getProfileRegionForSearchMode(ocrProfile, searchMode);
        if (!this.isValidRegion(selectedRegion)) {
            throw new Error(`Для режима ${searchMode} не настроена область захвата`);
        }

        const image = nativeImage.createFromDataURL(dataUrl);
        const imageSize = image.getSize();
        const sourceResolution = ocrProfile.screen_resolution || imageSize;

        const scaleX = imageSize.width / sourceResolution.width;
        const scaleY = imageSize.height / sourceResolution.height;

        const cropRegion = {
            x: Math.max(0, Math.round(selectedRegion.x * scaleX)),
            y: Math.max(0, Math.round(selectedRegion.y * scaleY)),
            width: Math.max(1, Math.round(selectedRegion.width * scaleX)),
            height: Math.max(1, Math.round(selectedRegion.height * scaleY))
        };

        const boundedRegion = {
            x: Math.min(cropRegion.x, Math.max(0, imageSize.width - 1)),
            y: Math.min(cropRegion.y, Math.max(0, imageSize.height - 1)),
            width: Math.min(cropRegion.width, imageSize.width - cropRegion.x),
            height: Math.min(cropRegion.height, imageSize.height - cropRegion.y)
        };

        if (boundedRegion.width <= 0 || boundedRegion.height <= 0) {
            throw new Error('Область OCR выходит за границы текущего скриншота');
        }

        return image.crop(boundedRegion).toPNG();
    }

    dataUrlToBuffer(dataUrl) {
        if (typeof dataUrl !== 'string' || !dataUrl.includes(',')) {
            throw new Error('Некорректный data URL скриншота');
        }

        const base64 = dataUrl.split(',')[1];
        return Buffer.from(base64, 'base64');
    }

    cleanup() {
        this.unregisterAllShortcuts();
        console.log('🧹 HotkeyManager очищен');
    }
}

module.exports = HotkeyManager;
