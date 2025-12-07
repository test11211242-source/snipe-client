// ===================================================================
// UpdateManager - Модуль автоматического обновления приложения
// Использует electron-updater для проверки и установки обновлений
// ===================================================================

const { autoUpdater } = require('electron-updater');
const { dialog } = require('electron');
const log = require('electron-log');

class UpdateManager {
    constructor() {
        this.updateCheckInterval = null;
        this.updateCallback = null;

        // Настройка логирования
        log.transports.file.level = 'info';
        autoUpdater.logger = log;

        // Настройки автообновления
        autoUpdater.autoDownload = false; // Не скачиваем автоматически, спрашиваем пользователя
        autoUpdater.autoInstallOnAppQuit = true; // Устанавливаем при выходе

        this.setupEventHandlers();
    }

    setupEventHandlers() {
        // Обновление доступно
        autoUpdater.on('update-available', (info) => {
            log.info('📦 Доступно обновление:', info.version);

            if (this.updateCallback) {
                this.updateCallback('update-available', {
                    version: info.version,
                    releaseDate: info.releaseDate,
                    releaseNotes: info.releaseNotes
                });
            }

            // Показываем диалог пользователю
            this.showUpdateDialog(info);
        });

        // Обновление недоступно
        autoUpdater.on('update-not-available', (info) => {
            log.info('✅ Приложение обновлено до последней версии');

            if (this.updateCallback) {
                this.updateCallback('update-not-available', info);
            }
        });

        // Ошибка при проверке обновления
        autoUpdater.on('error', (error) => {
            log.error('❌ Ошибка обновления:', error);

            if (this.updateCallback) {
                this.updateCallback('error', { error: error.message });
            }
        });

        // Прогресс загрузки
        autoUpdater.on('download-progress', (progressObj) => {
            const message = `Загрузка: ${Math.round(progressObj.percent)}%`;
            log.info(message);

            if (this.updateCallback) {
                this.updateCallback('download-progress', {
                    percent: progressObj.percent,
                    transferred: progressObj.transferred,
                    total: progressObj.total,
                    bytesPerSecond: progressObj.bytesPerSecond
                });
            }
        });

        // Обновление загружено
        autoUpdater.on('update-downloaded', (info) => {
            log.info('✅ Обновление загружено:', info.version);

            if (this.updateCallback) {
                this.updateCallback('update-downloaded', {
                    version: info.version
                });
            }

            // Показываем диалог установки
            this.showInstallDialog(info);
        });
    }

    async showUpdateDialog(info) {
        const response = await dialog.showMessageBox({
            type: 'info',
            title: 'Доступно обновление',
            message: `Доступна новая версия ${info.version}`,
            detail: info.releaseNotes || 'Обновление приложения',
            buttons: ['Скачать и установить', 'Позже'],
            defaultId: 0,
            cancelId: 1
        });

        if (response.response === 0) {
            // Пользователь согласился - начинаем загрузку
            log.info('⬇️ Начинаем загрузку обновления...');
            autoUpdater.downloadUpdate();
        }
    }

    async showInstallDialog(info) {
        const response = await dialog.showMessageBox({
            type: 'info',
            title: 'Обновление готово',
            message: `Версия ${info.version} загружена`,
            detail: 'Перезапустить приложение для установки обновления?',
            buttons: ['Перезапустить', 'Позже'],
            defaultId: 0,
            cancelId: 1
        });

        if (response.response === 0) {
            // Перезапускаем и устанавливаем
            log.info('🔄 Перезапуск для установки обновления...');
            autoUpdater.quitAndInstall(false, true);
        }
    }

    /**
     * Проверка обновлений
     */
    async checkForUpdates() {
        try {
            log.info('🔍 Проверка обновлений...');
            await autoUpdater.checkForUpdates();
        } catch (error) {
            log.error('❌ Ошибка проверки обновлений:', error);
        }
    }

    /**
     * Проверка обновлений без уведомлений (тихая проверка)
     */
    async checkForUpdatesQuietly() {
        try {
            const result = await autoUpdater.checkForUpdates();
            return result;
        } catch (error) {
            log.error('❌ Ошибка тихой проверки обновлений:', error);
            return null;
        }
    }

    /**
     * Запуск автоматической проверки обновлений
     * @param {number} intervalMinutes - Интервал проверки в минутах (по умолчанию 60)
     */
    startAutoCheck(intervalMinutes = 60) {
        // Проверяем сразу при запуске
        this.checkForUpdatesQuietly();

        // Затем проверяем периодически
        this.updateCheckInterval = setInterval(() => {
            this.checkForUpdatesQuietly();
        }, intervalMinutes * 60 * 1000);

        log.info(`⏰ Автопроверка обновлений запущена (каждые ${intervalMinutes} мин)`);
    }

    /**
     * Остановка автоматической проверки
     */
    stopAutoCheck() {
        if (this.updateCheckInterval) {
            clearInterval(this.updateCheckInterval);
            this.updateCheckInterval = null;
            log.info('⏸️ Автопроверка обновлений остановлена');
        }
    }

    /**
     * Установка callback для событий обновления
     * @param {Function} callback - Функция обратного вызова (event, data)
     */
    setUpdateCallback(callback) {
        this.updateCallback = callback;
    }

    /**
     * Получить текущую версию приложения
     */
    getCurrentVersion() {
        return require('../../package.json').version;
    }

    /**
     * Принудительная загрузка обновления
     */
    downloadUpdate() {
        autoUpdater.downloadUpdate();
    }

    /**
     * Установка обновления и перезапуск
     */
    quitAndInstall() {
        autoUpdater.quitAndInstall(false, true);
    }
}

module.exports = UpdateManager;
