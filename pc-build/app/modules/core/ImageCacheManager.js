const fs = require('fs').promises;
const path = require('path');
const { app } = require('electron');
const https = require('https');
const http = require('http');

/**
 * ImageCacheManager - Управление локальным кешем изображений карт
 * Аналог Android CardsCacheManager для PC Electron приложения
 */
class ImageCacheManager {
    constructor(storeManager, apiManager) {
        this.store = storeManager;
        this.api = apiManager;

        // Путь к кешу изображений: {userData}/cache/cards/
        this.cacheDir = path.join(app.getPath('userData'), 'cache', 'cards');

        // Интервал проверки обновлений: 12 часов (как в Android)
        this.checkInterval = 12 * 60 * 60 * 1000;

        this.initialized = false;
    }

    /**
     * Инициализация при старте приложения
     */
    async initialize() {
        try {
            console.log('🎴 Инициализация ImageCacheManager...');
            console.log(`📂 Директория кеша: ${this.cacheDir}`);

            // Создаем директорию для кеша если её нет
            await fs.mkdir(this.cacheDir, { recursive: true });

            // Загружаем метаданные кеша из StoreManager
            const cacheMetadata = this.store.getCardsCache();
            console.log(`📊 Метаданные кеша:`, {
                version: cacheMetadata.version,
                hash: cacheMetadata.contentHash?.substring(0, 8) + '...',
                lastCheck: cacheMetadata.lastCheck ? new Date(cacheMetadata.lastCheck).toISOString() : 'Never'
            });

            this.initialized = true;
            console.log('✅ ImageCacheManager инициализирован');

        } catch (error) {
            console.error('❌ Ошибка инициализации ImageCacheManager:', error);
            throw error;
        }
    }

    /**
     * Проверка и обновление кеша
     * @param {boolean} force - Принудительное обновление
     * @returns {Promise<{success: boolean, updated: boolean, message: string}>}
     */
    async checkAndUpdate(force = false) {
        try {
            console.log('🔍 Проверка необходимости обновления кеша...');

            if (!this.initialized) {
                console.warn('⚠️ ImageCacheManager не инициализирован');
                return { success: false, updated: false, message: 'Not initialized' };
            }

            // Проверяем нужно ли обновлять
            const shouldUpdate = force || await this._shouldUpdate();

            if (!shouldUpdate) {
                console.log('✅ Кеш актуален, обновление не требуется');
                return { success: true, updated: false, message: 'Cache is up to date' };
            }

            console.log('🔄 Начинаем обновление кеша...');

            // Загружаем манифест с сервера
            const manifest = await this.downloadManifest();

            if (!manifest || !Array.isArray(manifest.cards) || manifest.cards.length === 0) {
                console.error('❌ Пустой манифест получен от сервера');
                return { success: false, updated: false, message: 'Empty manifest' };
            }

            console.log(`📋 Получен манифест: ${manifest.cards.length} карт`);

            // Загружаем изображения
            const downloadResult = await this.downloadImages(manifest.cards);

            if (downloadResult.success) {
                // Обновляем метаданные
                this.store.updateCardsCacheVersion(manifest.version, manifest.content_hash);

                console.log(`✅ Кеш успешно обновлен: ${downloadResult.downloaded} файлов`);
                return {
                    success: true,
                    updated: true,
                    message: `Downloaded ${downloadResult.downloaded} images`,
                    stats: downloadResult
                };
            } else {
                console.error('❌ Ошибка загрузки изображений');
                return { success: false, updated: false, message: downloadResult.error };
            }

        } catch (error) {
            console.error('❌ Ошибка проверки и обновления кеша:', error);
            return { success: false, updated: false, message: error.message };
        }
    }

    /**
     * Проверка нужно ли обновлять кеш
     * @returns {Promise<boolean>}
     */
    async _shouldUpdate() {
        try {
            const cacheMetadata = this.store.getCardsCache();

            // 1. Если кеш совсем пустой (версия = 0)
            if (!cacheMetadata.version || cacheMetadata.version === 0) {
                console.log('📥 Кеш пустой, требуется первичная загрузка');
                return true;
            }

            // 2. Если прошло больше 12 часов с последней проверки
            const now = Date.now();
            const timeSinceCheck = now - (cacheMetadata.lastCheck || 0);
            const hoursSinceCheck = timeSinceCheck / (1000 * 60 * 60);

            if (hoursSinceCheck > 12) {
                console.log(`⏰ Прошло ${hoursSinceCheck.toFixed(1)} часов с последней проверки`);

                // Проверяем версию на сервере
                const serverVersion = await this._getServerVersion();

                if (!serverVersion) {
                    console.warn('⚠️ Не удалось получить версию с сервера');
                    return false;
                }

                // Сравниваем версию и хеш
                const versionChanged = serverVersion.version !== cacheMetadata.version;
                const hashChanged = serverVersion.content_hash !== cacheMetadata.contentHash;

                if (versionChanged || hashChanged) {
                    console.log(`🆕 Обнаружено обновление:`, {
                        versionChanged,
                        hashChanged,
                        oldVersion: cacheMetadata.version,
                        newVersion: serverVersion.version
                    });
                    return true;
                }

                console.log('✅ Версия на сервере совпадает с локальной');
                // Обновляем timestamp последней проверки
                cacheMetadata.lastCheck = now;
                this.store.setCardsCache(cacheMetadata);
                return false;
            }

            console.log(`⏱️ С последней проверки прошло ${hoursSinceCheck.toFixed(1)} часов (< 12), пропускаем`);
            return false;

        } catch (error) {
            console.error('❌ Ошибка проверки необходимости обновления:', error);
            return false;
        }
    }

    /**
     * Получить версию кеша с сервера
     * @returns {Promise<{version: number, content_hash: string}|null>}
     */
    async _getServerVersion() {
        try {
            const response = await this.api.get('/api/cards/version');

            if (response.success && response.data) {
                return {
                    version: response.data.version,
                    content_hash: response.data.content_hash
                };
            }

            return null;
        } catch (error) {
            console.error('❌ Ошибка получения версии с сервера:', error);
            return null;
        }
    }

    /**
     * Загрузка манифеста карт с сервера
     * @returns {Promise<{cards: Array, version: number, content_hash: string}>}
     */
    async downloadManifest() {
        try {
            console.log('📡 Загрузка манифеста карт с сервера...');

            const response = await this.api.get('/api/cards/manifest');

            if (!response.success || !response.data) {
                throw new Error('Failed to download manifest');
            }

            const cards = this.normalizeManifestCards(response.data.cards);
            console.log(`✅ Манифест загружен: ${cards.length} карт`);

            return {
                ...response.data,
                cards
            };

        } catch (error) {
            console.error('❌ Ошибка загрузки манифеста:', error);
            throw error;
        }
    }

    normalizeManifestCards(cards) {
        if (Array.isArray(cards)) {
            return cards.filter(card => card && card.name);
        }

        if (!cards || typeof cards !== 'object') {
            return [];
        }

        return Object.entries(cards)
            .map(([cardName, cardData]) => ({
                ...(cardData || {}),
                name: cardData?.name || cardName
            }))
            .filter(card => card.name);
    }

    /**
     * Загрузка изображений карт
     * @param {Array} cards - Массив карт из манифеста
     * @returns {Promise<{success: boolean, downloaded: number, skipped: number, failed: number}>}
     */
    async downloadImages(cards) {
        try {
            const normalizedCards = this.normalizeManifestCards(cards);
            console.log(`🚀 Начинаем загрузку изображений: ${normalizedCards.length} карт...`);

            let downloaded = 0;
            let skipped = 0;
            let failed = 0;

            for (const card of normalizedCards) {
                const cardName = card.name;

                // Загружаем 3 варианта изображения для каждой карты
                const variants = [
                    { url: card.icon_url, suffix: '' },
                    { url: card.evolution_icon_url, suffix: '_evo' },
                    { url: card.hero_icon_url, suffix: '_hero' }
                ];

                for (const variant of variants) {
                    if (!variant.url) continue; // Пропускаем пустые URL

                    const fileName = `${cardName}${variant.suffix}.png`;
                    const filePath = path.join(this.cacheDir, fileName);

                    try {
                        // Проверяем существует ли уже файл
                        const exists = await this._fileExists(filePath);

                        if (exists) {
                            skipped++;
                            continue;
                        }

                        // Загружаем файл
                        await this._downloadFile(variant.url, filePath);
                        downloaded++;

                    } catch (error) {
                        console.error(`❌ Ошибка загрузки ${fileName}:`, error.message);
                        failed++;
                    }
                }
            }

            console.log(`📊 Статистика загрузки:`);
            console.log(`   ✅ Загружено: ${downloaded}`);
            console.log(`   ⏭️ Пропущено (уже есть): ${skipped}`);
            console.log(`   ❌ Ошибок: ${failed}`);

            return {
                success: failed === 0 || downloaded > 0,
                downloaded,
                skipped,
                failed
            };

        } catch (error) {
            console.error('❌ Критическая ошибка загрузки изображений:', error);
            return {
                success: false,
                downloaded: 0,
                skipped: 0,
                failed: 0,
                error: error.message
            };
        }
    }

    /**
     * Загрузить файл по URL
     * @param {string} url - URL файла
     * @param {string} filePath - Путь для сохранения
     */
    async _downloadFile(url, filePath) {
        return new Promise((resolve, reject) => {
            const protocol = url.startsWith('https') ? https : http;

            const request = protocol.get(url, (response) => {
                if (response.statusCode === 301 || response.statusCode === 302) {
                    // Обработка редиректов
                    this._downloadFile(response.headers.location, filePath)
                        .then(resolve)
                        .catch(reject);
                    return;
                }

                if (response.statusCode !== 200) {
                    reject(new Error(`HTTP ${response.statusCode}`));
                    return;
                }

                const fileStream = require('fs').createWriteStream(filePath);

                response.pipe(fileStream);

                fileStream.on('finish', () => {
                    fileStream.close();
                    resolve();
                });

                fileStream.on('error', (error) => {
                    fs.unlink(filePath).catch(() => {});
                    reject(error);
                });
            });

            request.on('error', (error) => {
                reject(error);
            });

            request.setTimeout(30000, () => {
                request.destroy();
                reject(new Error('Timeout'));
            });
        });
    }

    /**
     * Проверить существование файла
     * @param {string} filePath - Путь к файлу
     * @returns {Promise<boolean>}
     */
    async _fileExists(filePath) {
        try {
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Получить путь к изображению карты
     * @param {string} cardName - Имя карты
     * @param {number} level - Уровень эволюции (0=normal, 1=evolution, 2+=hero)
     * @returns {string|null} - file:// путь или null
     */
    getCardImagePath(cardName, level = 0) {
        try {
            let suffix = '';

            if (level === 1) {
                suffix = '_evo';
            } else if (level >= 2) {
                suffix = '_hero';
            }

            const fileName = `${cardName}${suffix}.png`;
            const filePath = path.join(this.cacheDir, fileName);

            // Синхронная проверка существования файла
            try {
                require('fs').accessSync(filePath);
                // Возвращаем file:// URL для Electron
                return `file://${filePath}`;
            } catch {
                // Файл не существует
                return null;
            }

        } catch (error) {
            console.error(`❌ Ошибка получения пути к изображению ${cardName}:`, error);
            return null;
        }
    }

    /**
     * Получить статус кеша (для отладки)
     * @returns {object}
     */
    getCacheStatus() {
        try {
            const cacheMetadata = this.store.getCardsCache();
            const cacheDir = this.cacheDir;

            // Синхронное чтение количества файлов
            let filesCount = 0;
            try {
                const files = require('fs').readdirSync(cacheDir);
                filesCount = files.filter(f => f.endsWith('.png')).length;
            } catch {
                filesCount = 0;
            }

            return {
                initialized: this.initialized,
                cacheDir: cacheDir,
                filesCount: filesCount,
                version: cacheMetadata.version,
                contentHash: cacheMetadata.contentHash,
                lastCheck: cacheMetadata.lastCheck ? new Date(cacheMetadata.lastCheck).toISOString() : 'Never',
                lastUpdated: cacheMetadata.lastUpdated || 'Never'
            };

        } catch (error) {
            console.error('❌ Ошибка получения статуса кеша:', error);
            return {
                initialized: this.initialized,
                error: error.message
            };
        }
    }

    /**
     * Очистка кеша
     */
    async clearCache() {
        try {
            console.log('🗑️ Очистка кеша изображений...');

            const files = await fs.readdir(this.cacheDir);

            for (const file of files) {
                if (file.endsWith('.png')) {
                    await fs.unlink(path.join(this.cacheDir, file));
                }
            }

            // Очищаем метаданные
            this.store.setCardsCache({
                version: 0,
                contentHash: '',
                lastCheck: 0
            });

            console.log('✅ Кеш очищен');

        } catch (error) {
            console.error('❌ Ошибка очистки кеша:', error);
            throw error;
        }
    }
}

module.exports = ImageCacheManager;
