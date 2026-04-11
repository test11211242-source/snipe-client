const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ConfigManager = require('../core/ConfigManager');
const StoreManager = require('../core/StoreManager');

/**
 * UpdateManager - Управление системой обновлений
 */
class UpdateManager {
    constructor(apiManager = null) {
        this.config = new ConfigManager();
        this.store = new StoreManager();
        this.api = apiManager;
        this.eventBus = null;
        
        this.downloadInProgress = false;
        this.updateInfo = null;
        this.progressCallback = null;
        
        this.initialize();
    }

    initialize() {
        console.log('🔄 Инициализация UpdateManager...');
        
        // Получаем информацию о текущей версии
        this.currentVersion = this.getCurrentVersion();
        
        console.log('✅ UpdateManager инициализирован');
        console.log('📦 Текущая версия:', this.currentVersion);
    }

    // === Установка API менеджера ===
    
    setApiManager(apiManager) {
        this.api = apiManager;
        console.log('🔗 API Manager подключен к UpdateManager');
    }

    setEventBus(eventBus) {
        this.eventBus = eventBus;
        console.log('🔗 EventBus подключен к UpdateManager');
    }

    // === Получение текущей версии ===
    
    getCurrentVersion() {
        try {
            const electronApp = require('electron').app;
            return electronApp ? electronApp.getVersion() : '0.0.0';
        } catch (error) {
            return 'dev-version';
        }
    }

    // === Проверка доступности только в упакованной версии ===
    
    isUpdateAvailable() {
        try {
            const electronApp = require('electron').app;
            return electronApp ? electronApp.isPackaged : false;
        } catch (error) {
            return false;
        }
    }

    // === Проверка обновлений ===
    
    async checkForUpdates() {
        try {
            console.log('🔍 Проверка обновлений...');
            
            if (!this.isUpdateAvailable()) {
                return {
                    success: false,
                    error: 'Проверка обновлений доступна только в установленной версии'
                };
            }
            
            if (!this.api) {
                throw new Error('API Manager не инициализирован');
            }
            
            const result = await this.api.get('/api/app/update-info');
            
            if (!result.success) {
                console.log('❌ Ошибка получения информации об обновлении:', result.userMessage);
                return {
                    success: false,
                    error: result.userMessage || 'Ошибка проверки обновлений'
                };
            }
            
            const updateInfo = result.data;
            const latestVersion = updateInfo.latest_version;
            
            console.log(`📊 Проверка версий:`);
            console.log(`  - Текущая: "${this.currentVersion}"`);
            console.log(`  - Последняя: "${latestVersion}"`);
            
            const hasUpdate = this.compareVersions(this.currentVersion, latestVersion);
            
            this.updateInfo = {
                hasUpdate,
                currentVersion: this.currentVersion,
                latestVersion,
                ...updateInfo
            };
            
            if (hasUpdate) {
                console.log('✨ Найдено обновление!');
            } else {
                console.log('✅ Приложение актуально');
            }
            
            return {
                success: true,
                ...this.updateInfo
            };
            
        } catch (error) {
            console.error('❌ Ошибка проверки обновлений:', error.message);
            
            return {
                success: false,
                error: this.formatError(error)
            };
        }
    }

    // === Сравнение версий ===
    
    compareVersions(current, latest) {
        try {
            const currentParts = current.split('.').map(Number);
            const latestParts = latest.split('.').map(Number);
            
            const maxLength = Math.max(currentParts.length, latestParts.length);
            
            for (let i = 0; i < maxLength; i++) {
                const currentPart = currentParts[i] || 0;
                const latestPart = latestParts[i] || 0;
                
                if (latestPart > currentPart) return true;
                if (latestPart < currentPart) return false;
            }
            
            return false;
        } catch (error) {
            console.error('❌ Ошибка сравнения версий:', error);
            return false;
        }
    }

    // === Скачивание обновления ===
    
    async downloadUpdate(downloadType = 'installer') {
        try {
            console.log(`📥 Начало скачивания ${downloadType}...`);
            
            if (this.downloadInProgress) {
                return {
                    success: false,
                    error: 'Скачивание уже выполняется'
                };
            }
            
            // Получаем актуальную информацию об обновлении
            const updateCheck = await this.checkForUpdates();
            if (!updateCheck.success || !updateCheck.hasUpdate) {
                return {
                    success: false,
                    error: 'Нет доступных обновлений'
                };
            }
            
            this.downloadInProgress = true;
            
            const version = updateCheck.latestVersion;
            const downloadUrl = this.getDownloadUrl(updateCheck, downloadType);
            const downloadPath = this.getDownloadPath(version, downloadType);
            
            console.log('🌐 URL скачивания:', downloadUrl);
            console.log('📁 Путь сохранения:', downloadPath);
            
            // Удаляем старый файл если существует
            await this.removeOldFile(downloadPath);
            
            // Скачиваем файл
            const downloadResult = await this.performDownload(downloadUrl, downloadPath);
            
            if (downloadResult.success) {
                // Проверяем скачанный файл
                const validation = await this.validateDownloadedFile(downloadPath);
                
                if (validation.success) {
                    console.log('✅ Обновление скачано успешно');
                    
                    this.downloadInProgress = false;

                    if (this.eventBus) {
                        this.eventBus.emit('update:downloaded', {
                            filePath: downloadPath,
                            version,
                            type: downloadType,
                            fileSize: validation.fileSize
                        });
                    }
                    
                    return {
                        success: true,
                        downloadPath,
                        version,
                        type: downloadType,
                        fileSize: validation.fileSize
                    };
                } else {
                    this.downloadInProgress = false;
                    return validation;
                }
            } else {
                this.downloadInProgress = false;
                return downloadResult;
            }
            
        } catch (error) {
            this.downloadInProgress = false;
            console.error('❌ Ошибка скачивания:', error.message);

            if (this.eventBus) {
                this.eventBus.emit('update:error', {
                    message: this.formatError(error)
                });
            }
             
            return {
                success: false,
                error: this.formatError(error)
            };
        }
    }

    // === Получение URL для скачивания ===
    
    getDownloadUrl(updateInfo, downloadType) {
        const serverUrl = this.store.getServerUrl();
        
        let downloadUrl;
        if (downloadType === 'installer') {
            downloadUrl = updateInfo.download_url || `${serverUrl}/api/app/download/${updateInfo.latestVersion}/installer`;
        } else {
            downloadUrl = updateInfo.portable_url || `${serverUrl}/api/app/download/${updateInfo.latestVersion}/portable`;
        }
        
        // Корректируем относительные пути
        if (downloadUrl.startsWith('/')) {
            downloadUrl = serverUrl + downloadUrl;
        }
        
        return downloadUrl;
    }

    // === Получение пути для сохранения ===
    
    getDownloadPath(version, downloadType) {
        const { app } = require('electron');
        const downloadsPath = app.getPath('downloads');
        
        const fileName = downloadType === 'installer' 
            ? `Snipe_Client_Setup_${version}.exe`
            : `Snipe_Client_Portable_${version}.exe`;
            
        return path.join(downloadsPath, fileName);
    }

    // === Удаление старого файла ===
    
    async removeOldFile(filePath) {
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                console.log('🗑️ Удален старый файл');
            }
        } catch (error) {
            console.warn('⚠️ Не удалось удалить старый файл:', error.message);
        }
    }

    // === Выполнение скачивания ===
    
    async performDownload(url, filePath) {
        try {
            const response = await axios({
                method: 'GET',
                url: url,
                responseType: 'stream',
                timeout: this.config.update.timeout,
                maxRedirects: this.config.update.maxRedirects,
                onDownloadProgress: (progressEvent) => {
                    if (progressEvent.total) {
                        const percent = Math.round((progressEvent.loaded * 100) / progressEvent.total);
                        
                        // Вызываем callback прогресса
                        if (this.progressCallback) {
                            this.progressCallback({
                                percent,
                                loaded: progressEvent.loaded,
                                total: progressEvent.total
                            });
                        }

                        if (this.eventBus) {
                            this.eventBus.emit('update:download:progress', {
                                progress: {
                                    percent,
                                    loaded: progressEvent.loaded,
                                    total: progressEvent.total
                                }
                            });
                        }
                         
                        console.log(`📥 Прогресс: ${percent}%`);
                    }
                }
            });
            
            // Проверяем headers
            const contentLength = response.headers['content-length'];
            if (!contentLength || parseInt(contentLength) < this.config.update.minFileSize) {
                throw new Error('Файл слишком маленький или поврежден');
            }
            
            // Сохраняем файл
            const writer = fs.createWriteStream(filePath);
            response.data.pipe(writer);
            
            return new Promise((resolve, reject) => {
                writer.on('finish', () => {
                    resolve({ success: true });
                });
                
                writer.on('error', (error) => {
                    reject(new Error(`Ошибка записи файла: ${error.message}`));
                });
                
                response.data.on('error', (error) => {
                    reject(new Error(`Ошибка скачивания: ${error.message}`));
                });
            });
            
        } catch (error) {
            return {
                success: false,
                error: this.formatError(error)
            };
        }
    }

    // === Валидация скачанного файла ===
    
    async validateDownloadedFile(filePath) {
        try {
            const stats = fs.statSync(filePath);
            const fileSize = stats.size;
            
            console.log(`📊 Размер скачанного файла: ${fileSize} байт`);
            
            if (fileSize < this.config.update.minFileSize) {
                throw new Error('Скачанный файл поврежден или неполный');
            }
            
            return {
                success: true,
                fileSize
            };
            
        } catch (error) {
            return {
                success: false,
                error: `Ошибка валидации файла: ${error.message}`
            };
        }
    }

    // === Установка обновления ===
    
    async installUpdate(filePath) {
        try {
            console.log(`🚀 Установка обновления: ${filePath}`);
            
            if (!fs.existsSync(filePath)) {
                return {
                    success: false,
                    error: 'Файл обновления не найден'
                };
            }
            
            // Показываем диалог подтверждения (если доступен)
            const confirmed = await this.confirmInstallation(filePath);
            if (!confirmed) {
                return {
                    success: false,
                    error: 'Отменено пользователем'
                };
            }
            
            // Запускаем установщик
            console.log('🎯 Запуск установщика...');
            
            spawn('explorer', [filePath], {
                detached: true,
                stdio: 'ignore'
            });
            
            // Планируем закрытие приложения
            this.scheduleAppExit();
            
            return {
                success: true,
                message: 'Установщик запущен. Приложение будет закрыто.'
            };
            
        } catch (error) {
            console.error('❌ Ошибка установки:', error);
            return {
                success: false,
                error: `Ошибка запуска установщика: ${error.message}`
            };
        }
    }

    // === Подтверждение установки ===
    
    async confirmInstallation(filePath) {
        try {
            const { dialog } = require('electron');
            const mainWindow = require('electron').BrowserWindow.getAllWindows()[0];
            
            if (!mainWindow) return true; // Если нет окна, продолжаем
            
            const choice = await dialog.showMessageBox(mainWindow, {
                type: 'question',
                title: 'Установка обновления',
                message: 'Обновление готово к установке',
                detail: `Сейчас будет запущен установщик. Приложение будет закрыто.\n\nФайл: ${path.basename(filePath)}`,
                buttons: ['Установить', 'Отмена'],
                defaultId: 0,
                cancelId: 1
            });
            
            return choice.response === 0;
            
        } catch (error) {
            console.warn('⚠️ Не удалось показать диалог подтверждения:', error.message);
            return true; // Продолжаем установку
        }
    }

    // === Планирование закрытия приложения ===
    
    scheduleAppExit() {
        setTimeout(() => {
            console.log('👋 Закрытие приложения для обновления...');
            try {
                const { app } = require('electron');
                app.quit();
            } catch (error) {
                console.error('❌ Ошибка закрытия приложения:', error);
                process.exit(0);
            }
        }, 2000);
    }

    // === Отмена скачивания ===
    
    cancelDownload() {
        this.downloadInProgress = false;
        console.log('🚫 Скачивание отменено');
        return { success: true };
    }

    // === Открытие папки загрузок ===
    
    async openDownloadsFolder() {
        try {
            const { shell, app } = require('electron');
            const downloadsPath = app.getPath('downloads');
            await shell.openPath(downloadsPath);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // === Открытие страницы релиза ===
    
    async openReleasePage(url) {
        try {
            if (!url || typeof url !== 'string') {
                throw new Error('Некорректный URL');
            }
            
            if (!url.startsWith('http://') && !url.startsWith('https://')) {
                throw new Error('URL должен начинаться с http:// или https://');
            }
            
            const { shell } = require('electron');
            await shell.openExternal(url);
            
            console.log('✅ Страница релиза открыта в браузере');
            return { success: true };
            
        } catch (error) {
            console.error('❌ Ошибка открытия страницы:', error);
            return { success: false, error: error.message };
        }
    }

    // === Установка callback прогресса ===
    
    setProgressCallback(callback) {
        this.progressCallback = callback;
    }

    // === Получение статуса ===
    
    getStatus() {
        return {
            currentVersion: this.currentVersion,
            downloadInProgress: this.downloadInProgress,
            updateInfo: this.updateInfo,
            isPackaged: this.isUpdateAvailable()
        };
    }

    // === Форматирование ошибок ===
    
    formatError(error) {
        if (error.code === 'ENOTFOUND') {
            return 'Нет подключения к серверу обновлений';
        } else if (error.code === 'ECONNRESET') {
            return 'Обрыв соединения во время скачивания';
        } else if (error.code === 'ETIMEDOUT') {
            return 'Тайм-аут скачивания. Попробуйте позже';
        } else if (error.response?.status === 404) {
            return 'Файл обновления не найден на сервере';
        } else if (error.response?.status >= 500) {
            return 'Ошибка сервера. Попробуйте позже';
        } else if (error.message.includes('поврежден')) {
            return 'Файл поврежден. Попробуйте еще раз';
        } else {
            return error.message || 'Неизвестная ошибка';
        }
    }

    // === Отладочная информация ===
    
    getDebugInfo() {
        return {
            status: this.getStatus(),
            config: {
                timeout: this.config.update.timeout,
                maxRedirects: this.config.update.maxRedirects,
                minFileSize: this.config.update.minFileSize
            },
            api: {
                connected: !!this.api,
                baseURL: this.api?.getStatus?.()?.baseURL
            }
        };
    }
}

module.exports = UpdateManager;
