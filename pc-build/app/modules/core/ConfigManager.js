/**
 * ConfigManager - Централизованное управление конфигурацией приложения
 */
class ConfigManager {
    constructor() {
        this.initialize();
    }

    initialize() {
        // 🌐 Конфигурация серверов
        this.SERVER_CONFIG = {
            global: {
                primary: 'http://130.61.118.215:8080',
                backup: 'http://144.24.182.207:8000'
            },
            test: {
                primary: 'http://46.173.132.37:8000'
            }
        };

        // 🔐 Конфигурация хранилища
        this.STORE_CONFIG = {
            encryptionKey: 'n8KfV1qz5YwRuMEgT2pJxD0BsAvLcQ9N',
            schema: {
                tokens: {
                    type: 'object',
                    properties: {
                        access_token: { type: 'string' },
                        refresh_token: { type: 'string' }
                    }
                },
                user: { type: 'object' },
                serverUrl: { type: 'string', default: 'http://130.61.118.215:8080' },
                serverMode: { type: 'string', default: 'global' },
                ocrRegions: { type: 'object' },
                searchMode: { type: 'string', default: 'fast' }
            }
        };

        // 🪟 Конфигурация окон
        this.WINDOW_CONFIG = {
            auth: {
                width: 500,
                height: 700,
                resizable: false,
                autoHideMenuBar: true
            },
            main: {
                minWidth: 1000,
                minHeight: 600,
                autoHideMenuBar: true
            },
            widget: {
                width: 450,
                height: 350,
                frame: false,
                transparent: true,
                alwaysOnTop: false,
                skipTaskbar: false,
                resizable: false,
                movable: true,
                hasShadow: true,
                focusable: true
            },
            setup: {
                fullscreen: true,
                transparent: true,
                frame: false,
                alwaysOnTop: true,
                skipTaskbar: true
            }
        };

        // 🔄 Конфигурация обновлений
        this.UPDATE_CONFIG = {
            timeout: 300000, // 5 минут
            maxRedirects: 5,
            minFileSize: 1000000 // 1MB
        };

        // 🐍 Конфигурация Python
        this.PYTHON_CONFIG = {
            windowsHide: true,
            encoding: 'utf-8',
            env: {
                PYTHONIOENCODING: 'utf-8'
            }
        };

        // 🔌 Конфигурация WebSocket
        this.WEBSOCKET_CONFIG = {
            reconnectTimeout: 5000,
            maxRetries: -1 // бесконечные попытки
        };

        // 📊 Конфигурация axios
        this.API_CONFIG = {
            timeout: 10000,
            maxRetries: 3
        };

        // 🎯 Конфигурация профилей триггеров
        this.TRIGGER_PROFILES_CONFIG = {
            // Дефолтные задержки для разных режимов
            delays: {
                fast_mode: 0,        // Быстрый режим - без задержки
                precise_mode: 2.2,   // Точный режим - ждем загрузки клана
                ultra_precise: 3.0   // Сверхточный - для особо сложных случаев
            },
            // Количество подтверждений для срабатывания
            confirmations: {
                default: 2,          // Стандартное количество подтверждений
                sensitive: 3,        // Для чувствительных триггеров
                relaxed: 1           // Для быстрого срабатывания
            },
            // Время перезарядки между срабатываниями (секунды)
            cooldowns: {
                battle_search: 15,   // Поиск битвы - стандартный cooldown
                streamer_check: 5,   // Проверки для стримеров - чаще
                debug_mode: 3        // Отладочный режим - минимальный cooldown
            },
            // Параметры цветовой кластеризации
            color_matching: {
                tolerance: 30,       // Допустимое отклонение цветов
                clusters: 3,         // Количество доминирующих цветов для анализа
                iterations: 10       // Итерации k-means алгоритма
            },
            // Параметры feature matching
            feature_matching: {
                min_matches: 15,     // Минимум совпадений для срабатывания
                good_matches: 12,    // Минимум качественных совпадений
                distance_threshold: 50, // Порог качества совпадений
                orb_features: 500    // Количество ORB features для анализа
            }
        };
    }

    // Геттеры для удобного доступа к конфигурации
    get servers() {
        return this.SERVER_CONFIG;
    }

    get store() {
        return this.STORE_CONFIG;
    }

    get windows() {
        return this.WINDOW_CONFIG;
    }

    get update() {
        return this.UPDATE_CONFIG;
    }

    get python() {
        return this.PYTHON_CONFIG;
    }

    get websocket() {
        return this.WEBSOCKET_CONFIG;
    }

    get api() {
        return this.API_CONFIG;
    }

    // Методы для получения конфигурации конкретного сервера
    getServerConfig(mode = 'global') {
        return this.SERVER_CONFIG[mode] || this.SERVER_CONFIG.global;
    }

    // Методы для получения конфигурации конкретного окна
    getWindowConfig(windowType) {
        return this.WINDOW_CONFIG[windowType] || {};
    }

    // Метод для получения всей конфигурации (для отладки)
    getAllConfig() {
        return {
            servers: this.SERVER_CONFIG,
            store: this.STORE_CONFIG,
            windows: this.WINDOW_CONFIG,
            update: this.UPDATE_CONFIG,
            python: this.PYTHON_CONFIG,
            websocket: this.WEBSOCKET_CONFIG,
            api: this.API_CONFIG
        };
    }
}

module.exports = ConfigManager;