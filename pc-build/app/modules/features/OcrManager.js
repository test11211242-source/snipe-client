// Безопасный импорт Electron модулей
let desktopCapturer, screen;
try {
    const electron = require('electron');
    desktopCapturer = electron.desktopCapturer;
    screen = electron.screen;
} catch (error) {
    // Работаем в тестовом режиме без Electron
    console.log('⚠️ Electron не доступен в OcrManager, работаем в тестовом режиме');
    desktopCapturer = null;
    screen = null;
}

// Импорты для анализа персональных профилей
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ConfigManager = require('../core/ConfigManager');
const StoreManager = require('../core/StoreManager');

const TRIGGER_PROFILE_SCHEMA_VERSION = 2;
const DEFAULT_SCREEN_TARGET = {
    targetType: 'screen',
    targetId: '0',
    name: 'Full Screen'
};

/**
 * OcrManager - Управление OCR функциональностью и областями
 */
class OcrManager {
    constructor(apiManager = null, eventBus = null) {
        this.config = new ConfigManager();
        this.store = new StoreManager();
        this.api = apiManager;
        this.eventBus = eventBus;
        this.regions = null;
        this.lastScreenshot = null;
        
        this.initialize();
    }

    initialize() {
        console.log('👁️ Инициализация OcrManager...');
        
        // Загружаем сохраненные области
        this.loadRegions();
        
        console.log('✅ OcrManager инициализирован');
        console.log('📊 Области OCR:', this.hasValidRegions() ? 'настроены' : 'не настроены');
    }

    // === Установка зависимостей ===
    
    setApiManager(apiManager) {
        this.api = apiManager;
        console.log('🔗 API Manager подключен к OcrManager');
    }

    setEventBus(eventBus) {
        this.eventBus = eventBus;
        console.log('🔗 EventBus подключен к OcrManager');
    }

    // === Загрузка областей из хранилища ===
    
    loadRegions() {
        try {
            this.regions = this.store.getOcrRegions();
            
            if (this.regions) {
                console.log('📋 OCR области загружены из хранилища');
                this.validateRegions();
            } else {
                console.log('⚠️ OCR области не найдены в хранилище');
            }
            
        } catch (error) {
            console.error('❌ Ошибка загрузки OCR областей:', error);
            this.regions = null;
        }
    }

    // === Валидация областей ===
    
    validateRegions() {
        if (!this.regions) {
            return { valid: false, reason: 'Области не заданы' };
        }

        const requiredAreas = ['trigger_area', 'normal_data_area', 'precise_data_area'];
        const missingAreas = [];

        for (const area of requiredAreas) {
            if (!this.regions[area]) {
                missingAreas.push(area);
            } else {
                // Проверяем структуру области
                const region = this.regions[area];
                if (typeof region.x !== 'number' || typeof region.y !== 'number' || 
                    typeof region.width !== 'number' || typeof region.height !== 'number' ||
                    region.width <= 0 || region.height <= 0) {
                    missingAreas.push(`${area} (некорректная структура)`);
                }
            }
        }

        if (missingAreas.length > 0) {
            console.warn('⚠️ Отсутствующие или некорректные области:', missingAreas);
            return { 
                valid: false, 
                reason: `Отсутствуют области: ${missingAreas.join(', ')}` 
            };
        }

        if (!this.hasStructuredTriggerProfile(this.regions.trigger_area)) {
            return {
                valid: false,
                reason: 'Триггер-профиль устарел. Перенастройте область триггера заново.'
            };
        }

        console.log('✅ OCR области прошли валидацию');
        return { valid: true };
    }

    // === Проверка наличия валидных областей ===
    
    hasValidRegions() {
        return this.validateRegions().valid;
    }

    // === Получение областей ===
    
    getRegions() {
        return this.regions;
    }

    // === Получение конкретной области ===
    
    getRegion(areaName) {
        return this.regions?.[areaName] || null;
    }

    // === Сохранение областей ===
    
    async saveRegions(regions) {
        try {
            console.log('💾 Сохранение OCR областей...');
            
            // Валидируем перед сохранением
            const tempRegions = this.regions;
            this.regions = regions;
            
            const validation = this.validateRegions();
            if (!validation.valid) {
                this.regions = tempRegions; // Возвращаем старые области
                throw new Error(`Валидация не пройдена: ${validation.reason}`);
            }

            // Сохраняем локально
            this.store.setOcrRegions(regions);
            
            // Отправляем на сервер если API доступен
            if (this.api) {
                const result = await this.api.post('/api/user/me/ocr-regions', this.buildLegacyRegionsPayload(regions));
                
                if (!result.success) {
                    throw new Error(result.userMessage || 'Ошибка сохранения на сервере');
                }
                
                console.log('☁️ OCR области синхронизированы с сервером');
            }

            // Эмитируем событие
            if (this.eventBus) {
                this.eventBus.emit('ocr:regions:updated', { regions });
            }

            console.log('✅ OCR области успешно сохранены');
            
            return { success: true };
            
        } catch (error) {
            console.error('❌ Ошибка сохранения OCR областей:', error);
            return { 
                success: false, 
                error: error.message 
            };
        }
    }

    // === Загрузка областей с сервера ===
    
    async loadRegionsFromServer() {
        try {
            console.log('📡 Загрузка OCR областей с сервера...');
            
            if (!this.api) {
                throw new Error('API Manager не подключен');
            }

            const result = await this.api.get('/api/user/me/ocr-regions');
            
            if (!result.success) {
                throw new Error(result.userMessage || 'Ошибка загрузки с сервера');
            }

            if (result.data) {
                this.regions = result.data;
                this.store.setOcrRegions(result.data);
                
                console.log('✅ OCR области загружены с сервера');
                
                // Эмитируем событие
                if (this.eventBus) {
                    this.eventBus.emit('ocr:regions:loaded', { regions: result.data });
                }
                
                return { 
                    success: true, 
                    regions: result.data 
                };
            } else {
                console.log('📭 На сервере нет сохраненных OCR областей');
                return { 
                    success: true, 
                    regions: null,
                    message: 'Области не настроены'
                };
            }
            
        } catch (error) {
            console.error('❌ Ошибка загрузки OCR областей с сервера:', error);
            return { 
                success: false, 
                error: error.message 
            };
        }
    }

    // === Создание скриншота для настройки ===
    
    async createSetupScreenshot() {
        try {
            console.log('📸 Создание setup-кадра через capture helper...');
            return await this.captureSetupFrame({ mode: 'screen' });
            
        } catch (error) {
            console.error('❌ Ошибка создания скриншота:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    // === Получение последнего скриншота ===
    
    getLastScreenshot() {
        return this.lastScreenshot;
    }

    // === Конвертация координат областей ===
    
    convertRegionsCoordinates(regions, fromSize, toSize) {
        try {
            const scaleX = toSize.width / fromSize.width;
            const scaleY = toSize.height / fromSize.height;
            
            const convertedRegions = {};
            
            Object.keys(regions).forEach(areaName => {
                if (areaName === 'screen_resolution') {
                    convertedRegions[areaName] = toSize;
                } else {
                    const area = regions[areaName];
                    convertedRegions[areaName] = {
                        x: Math.round(area.x * scaleX),
                        y: Math.round(area.y * scaleY),
                        width: Math.round(area.width * scaleX),
                        height: Math.round(area.height * scaleY)
                    };
                }
            });
            
            console.log('🔄 Координаты областей конвертированы');
            console.log(`  - Масштаб: ${scaleX.toFixed(2)}x, ${scaleY.toFixed(2)}x`);
            
            return {
                success: true,
                regions: convertedRegions
            };
            
        } catch (error) {
            console.error('❌ Ошибка конвертации координат:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    // === Получение рекомендуемых областей ===
    
    getRecommendedRegions() {
        let width = 1920;
        let height = 1080;
        
        // Получаем размеры экрана из Electron если доступен
        if (screen) {
            const display = screen.getPrimaryDisplay();
            const workArea = display.workAreaSize;
            width = workArea.width;
            height = workArea.height;
        } else {
            console.log('⚠️ Используем тестовое разрешение 1920x1080');
        }
        
        // Базовые рекомендуемые области (пропорциональные)
        const recommendedRegions = {
            trigger_area: {
                x: Math.round(width * 0.3),
                y: Math.round(height * 0.1),
                width: Math.round(width * 0.4),
                height: Math.round(height * 0.2),
                description: 'Область обнаружения экрана VS'
            },
            normal_data_area: {
                x: Math.round(width * 0.1),
                y: Math.round(height * 0.3),
                width: Math.round(width * 0.8),
                height: Math.round(height * 0.4),
                description: 'Быстрая область захвата данных'
            },
            precise_data_area: {
                x: Math.round(width * 0.05),
                y: Math.round(height * 0.2),
                width: Math.round(width * 0.9),
                height: Math.round(height * 0.6),
                description: 'Точная область захвата данных'
            },
            screen_resolution: {
                width: width,
                height: height
            }
        };
        
        console.log('💡 Сгенерированы рекомендуемые OCR области');
        
        return recommendedRegions;
    }

    // === Сброс областей ===
    
    resetRegions() {
        console.log('🗑️ Сброс OCR областей...');
        
        this.regions = null;
        this.store.delete('ocrRegions');
        
        // Эмитируем событие
        if (this.eventBus) {
            this.eventBus.emit('ocr:regions:reset');
        }
        
        console.log('✅ OCR области сброшены');
    }

    // === Экспорт областей ===
    
    exportRegions() {
        if (!this.regions) {
            return {
                success: false,
                error: 'Нет областей для экспорта'
            };
        }

        const exportData = {
            regions: this.regions,
            timestamp: new Date().toISOString(),
            version: '2.0',
            screen_resolution: this.regions.screen_resolution
        };

        console.log('📤 OCR области экспортированы');
        
        return {
            success: true,
            data: exportData
        };
    }

    // === Импорт областей ===
    
    async importRegions(importData) {
        try {
            console.log('📥 Импорт OCR областей...');
            
            if (!importData || !importData.regions) {
                throw new Error('Некорректные данные для импорта');
            }

            // Валидируем импортированные области
            const tempRegions = this.regions;
            this.regions = importData.regions;
            
            const validation = this.validateRegions();
            if (!validation.valid) {
                this.regions = tempRegions;
                throw new Error(`Импортированные области некорректны: ${validation.reason}`);
            }

            // Сохраняем области
            const saveResult = await this.saveRegions(importData.regions);
            
            if (!saveResult.success) {
                this.regions = tempRegions;
                throw new Error(saveResult.error);
            }

            console.log('✅ OCR области успешно импортированы');
            
            return { success: true };
            
        } catch (error) {
            console.error('❌ Ошибка импорта OCR областей:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    // === Получение статистики ===
    
    getStats() {
        const stats = {
            hasRegions: !!this.regions,
            isValid: this.hasValidRegions(),
            areasCount: this.regions ? Object.keys(this.regions).length : 0,
            lastScreenshot: !!this.lastScreenshot,
            lastUpdate: this.regions ? new Date().toISOString() : null
        };

        if (this.regions) {
            stats.areas = Object.keys(this.regions).filter(key => key !== 'screen_resolution');
        }

        return stats;
    }

    // === Получение статуса ===
    
    getStatus() {
        return {
            initialized: true,
            hasApi: !!this.api,
            hasEventBus: !!this.eventBus,
            regions: this.getStats(),
            lastScreenshot: this.lastScreenshot?.timestamp || null
        };
    }

    // === Отладочная информация ===
    
    getDebugInfo() {
        return {
            status: this.getStatus(),
            regions: this.regions,
            validation: this.validateRegions(),
            screenshot: {
                available: !!this.lastScreenshot,
                timestamp: this.lastScreenshot?.timestamp,
                size: this.lastScreenshot?.size
            }
        };
    }

    // === Анализ персональных профилей ===
    
    async analyzePersonalProfile(profileData) {
        try {
            console.log('🧬 Анализ персонального профиля триггера...');
            console.log(`📊 Размер изображения: ${profileData.size.width}x${profileData.size.height}`);
            
            // Создаем temporary файл для изображения
            const tempDir = os.tmpdir();
            const tempImagePath = path.join(tempDir, `trigger_${Date.now()}.png`);
            
            // Конвертируем base64 обратно в файл
            const imageBuffer = Buffer.from(profileData.imageData, 'base64');
            fs.writeFileSync(tempImagePath, imageBuffer);
            
            console.log(`💾 Временный файл создан: ${tempImagePath}`);
            
            // Путь к Python анализатору (относительно frontend папки)
            const pythonScript = this.getPythonScriptPath('profile_analyzer.py');
            const pythonExecutable = this.getPythonExecutable();
            const analyzerArgs = [tempImagePath];

            if (profileData.forceFullInner) {
                analyzerArgs.push('--force-full-inner');
            }
            
            // Вызываем Python анализатор
            const analysisResult = await this.executePythonJsonScript(pythonExecutable, pythonScript, analyzerArgs);
            
            // Удаляем временный файл
            try {
                fs.unlinkSync(tempImagePath);
                console.log('🗑️ Временный файл удален');
            } catch (cleanupError) {
                console.warn('⚠️ Не удалось удалить временный файл:', cleanupError.message);
            }
            
            if (!analysisResult.success) {
                throw new Error(analysisResult.error);
            }

            this.validateAnalyzedTriggerProfile(analysisResult);
            const featureMode = analysisResult.feature_mode;
            
            console.log('✅ Персональный профиль успешно создан');
            console.log(`🎨 Найдено цветов: ${(analysisResult.aux_color_palette || []).length}`);
            console.log(`🧩 Feature mode: ${featureMode}`);
            
            return {
                success: true,
                inner_bbox: analysisResult.inner_bbox,
                feature_mode: featureMode,
                keypoints_count: analysisResult.keypoints_count,
                normalized_template_size: analysisResult.normalized_template_size,
                template_gray_base64: analysisResult.template_gray_base64,
                thumbnail_hash: analysisResult.thumbnail_hash,
                aux_color_palette: analysisResult.aux_color_palette || analysisResult.color_palette || [],
                color_palette: analysisResult.aux_color_palette || analysisResult.color_palette || [],
                analysis_info: analysisResult.analysis_info
            };
            
        } catch (error) {
            console.error('❌ Ошибка анализа персонального профиля:', error);
            return {
                success: false,
                error: error.message || 'Неизвестная ошибка анализа'
            };
        }
    }

    hasStructuredTriggerProfile(region) {
        return !!(
            region &&
            region.trigger_profile &&
            region.trigger_profile.schema_version === TRIGGER_PROFILE_SCHEMA_VERSION &&
            region.trigger_profile.outer_ratio &&
            region.trigger_profile.inner_ratio &&
            typeof region.trigger_profile.template_gray_base64 === 'string' &&
            region.trigger_profile.template_gray_base64.length > 0 &&
            typeof region.trigger_profile.thumbnail_hash === 'string' &&
            region.trigger_profile.thumbnail_hash.length > 0 &&
            typeof region.trigger_profile.feature_mode === 'string'
        );
    }

    validateAnalyzedTriggerProfile(profile) {
        const isValidRect = (rect) => !!(
            rect &&
            typeof rect.x === 'number' &&
            typeof rect.y === 'number' &&
            typeof rect.width === 'number' &&
            typeof rect.height === 'number' &&
            rect.width > 0 &&
            rect.height > 0
        );

        const isValidSize = (size) => !!(
            size &&
            typeof size.width === 'number' &&
            typeof size.height === 'number' &&
            size.width > 0 &&
            size.height > 0
        );

        const isValidRatioRect = (rect) => !!(
            rect &&
            typeof rect.x === 'number' &&
            typeof rect.y === 'number' &&
            typeof rect.width === 'number' &&
            typeof rect.height === 'number' &&
            rect.width > 0 &&
            rect.height > 0
        );

        if (!profile || typeof profile !== 'object') {
            throw new Error('Python анализатор вернул пустой trigger profile');
        }

        if (!isValidRect(profile.inner_bbox)) {
            throw new Error('Python анализатор не вернул корректный inner_bbox');
        }

        if (!isValidSize(profile.normalized_template_size)) {
            throw new Error('Python анализатор не вернул normalized_template_size');
        }

        if (!profile.template_gray_base64 || typeof profile.template_gray_base64 !== 'string') {
            throw new Error('Python анализатор не вернул template_gray_base64');
        }

        if (!profile.thumbnail_hash || typeof profile.thumbnail_hash !== 'string') {
            throw new Error('Python анализатор не вернул thumbnail_hash');
        }

        if (!['orb', 'ncc'].includes(profile.feature_mode)) {
            throw new Error(`Python анализатор вернул неизвестный feature_mode: ${profile.feature_mode}`);
        }

        if (typeof profile.keypoints_count !== 'number') {
            throw new Error('Python анализатор не вернул keypoints_count');
        }

        if (!profile.analysis_info || typeof profile.analysis_info !== 'object') {
            throw new Error('Python анализатор не вернул analysis_info');
        }

        if (!isValidSize(profile.analysis_info.outer_size)) {
            throw new Error('Python анализатор не вернул analysis_info.outer_size');
        }

        if (!isValidSize(profile.analysis_info.inner_size)) {
            throw new Error('Python анализатор не вернул analysis_info.inner_size');
        }

        if (!isValidRatioRect(profile.analysis_info.inner_ratio)) {
            throw new Error('Python анализатор не вернул analysis_info.inner_ratio');
        }
    }

    buildLegacyRegionsPayload(regions) {
        if (!regions) {
            return null;
        }

        const pickRect = (area) => {
            if (!area) {
                return null;
            }

            return {
                x: area.x,
                y: area.y,
                width: area.width,
                height: area.height,
                created_at: area.created_at
            };
        };

        return {
            trigger_area: pickRect(regions.trigger_area),
            normal_data_area: pickRect(regions.normal_data_area),
            precise_data_area: pickRect(regions.precise_data_area),
            screen_resolution: regions.screen_resolution
        };
    }

    getPythonExecutable() {
        const { app } = require('electron');
        return app.isPackaged
            ? path.join(process.resourcesPath, 'python-portable', 'python-3.11.9.amd64', 'python.exe')
            : (process.platform === 'win32' ? 'python' : 'python3');
    }

    getPythonScriptPath(scriptName) {
        const { app } = require('electron');
        return app.isPackaged
            ? path.join(process.resourcesPath, 'python_scripts', scriptName)
            : path.join(__dirname, '..', '..', '..', 'python_scripts', scriptName);
    }

    resolveSetupCaptureTarget(context = null) {
        if (context?.mode === 'window' && context?.targetWindow) {
            return {
                targetType: 'window',
                targetId: context.targetWindow.name || context.targetWindow.targetId || context.targetWindow.id,
                targetWindow: context.targetWindow
            };
        }

        const selectedTarget = this.store.getSelectedCaptureTarget?.() || DEFAULT_SCREEN_TARGET;
        if (selectedTarget?.targetType === 'screen') {
            return {
                targetType: 'screen',
                targetId: selectedTarget.targetId || '0',
                targetWindow: null
            };
        }

        return {
            targetType: 'screen',
            targetId: '0',
            targetWindow: null
        };
    }

    async captureSetupFrame(context = null) {
        const target = this.resolveSetupCaptureTarget(context);

        try {
            const pythonExecutable = this.getPythonExecutable();
            const pythonScript = this.getPythonScriptPath('capture_frame.py');
            const args = [
                '--target_type', target.targetType,
                '--target_id', String(target.targetId)
            ];

            if (this.store.get('hideCaptureborder', false)) {
                args.push('--hide_capture_border');
            }

            const captureResult = await this.executePythonJsonScript(pythonExecutable, pythonScript, args);

            if (!captureResult.success) {
                throw new Error(captureResult.error || 'Capture helper вернул ошибку');
            }

            const screenshot = `data:image/png;base64,${captureResult.image_base64}`;
            this.lastScreenshot = {
                dataUrl: screenshot,
                timestamp: new Date().toISOString(),
                size: captureResult.frame_size,
                target
            };

            return {
                success: true,
                screenshot,
                size: captureResult.frame_size,
                frameSize: captureResult.frame_size,
                target
            };
        } catch (error) {
            console.warn('⚠️ Capture helper недоступен, используем fallback:', error.message);
            return this.captureSetupFrameFallback(target);
        }
    }

    async captureSetupFrameFallback(target) {
        if (!screen || !desktopCapturer) {
            return {
                success: true,
                screenshot: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
                size: { width: 1920, height: 1080 },
                frameSize: { width: 1920, height: 1080 },
                target
            };
        }

        if (target.targetType === 'window') {
            const sources = await desktopCapturer.getSources({
                types: ['window'],
                thumbnailSize: { width: 1920, height: 1080 }
            });

            const targetSource = sources.find(source =>
                source.name === target.targetId ||
                source.id === target.targetId
            );

            if (!targetSource) {
                throw new Error(`Окно "${target.targetId}" не найдено`);
            }

            const size = targetSource.thumbnail.getSize();
            const screenshot = targetSource.thumbnail.toDataURL();
            this.lastScreenshot = {
                dataUrl: screenshot,
                timestamp: new Date().toISOString(),
                size,
                target
            };

            return {
                success: true,
                screenshot,
                size,
                frameSize: size,
                target
            };
        }

        const display = screen.getPrimaryDisplay();
        const physicalSize = {
            width: Math.round(display.size.width * display.scaleFactor),
            height: Math.round(display.size.height * display.scaleFactor)
        };

        const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: physicalSize
        });

        if (!sources || sources.length === 0) {
            throw new Error('Не удалось получить источники экрана');
        }

        const screenshot = sources[0].thumbnail.toDataURL();
        this.lastScreenshot = {
            dataUrl: screenshot,
            timestamp: new Date().toISOString(),
            size: physicalSize,
            target
        };

        return {
            success: true,
            screenshot,
            size: physicalSize,
            frameSize: physicalSize,
            target
        };
    }

    async captureWindowScreenshot(targetWindow) {
        const result = await this.captureSetupFrame({ mode: 'window', targetWindow });
        if (!result.success) {
            return null;
        }

        return {
            dataURL: result.screenshot,
            bounds: {
                x: 0,
                y: 0,
                width: result.frameSize.width,
                height: result.frameSize.height
            },
            windowName: targetWindow?.name || result.target?.targetId || 'Window',
            frameSize: result.frameSize
        };
    }

    // === Вспомогательный метод для выполнения Python JSON-скриптов ===
    
    executePythonJsonScript(pythonExecutable, scriptPath, args) {
        return new Promise((resolve, reject) => {
            console.log(`🐍 Запуск Python скрипта: ${pythonExecutable} ${scriptPath} ${args.join(' ')}`);
            
            const pythonProcess = spawn(pythonExecutable, [scriptPath, ...args], {
                stdio: ['pipe', 'pipe', 'pipe']
            });
            
            let stdout = '';
            let stderr = '';
            
            pythonProcess.stdout.on('data', (data) => {
                stdout += data.toString();
            });
            
            pythonProcess.stderr.on('data', (data) => {
                stderr += data.toString();
                console.log('Python stderr:', data.toString().trim());
            });
            
            pythonProcess.on('close', (code) => {
                console.log(`🐍 Python анализатор завершен с кодом: ${code}`);

                try {
                    const result = JSON.parse(stdout);
                    if (code !== 0 && result?.success === false) {
                        resolve(result);
                        return;
                    }

                    if (code !== 0) {
                        reject(new Error(`Python анализатор завершился с ошибкой (код ${code}): ${stderr}`));
                        return;
                    }

                    resolve(result);
                } catch (parseError) {
                    reject(new Error(`Ошибка парсинга результата Python анализатора: ${parseError.message}`));
                }
            });
            
            pythonProcess.on('error', (error) => {
                reject(new Error(`Ошибка запуска Python анализатора: ${error.message}`));
            });
        });
    }
}

module.exports = OcrManager;
