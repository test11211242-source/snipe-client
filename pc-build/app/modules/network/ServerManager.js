const axios = require('axios');
const ConfigManager = require('../core/ConfigManager');
const StoreManager = require('../core/StoreManager');

/**
 * ServerManager - Управление серверами и переключение между ними
 */
class ServerManager {
    constructor() {
        this.config = new ConfigManager();
        this.store = new StoreManager();
        this.currentServerStatus = { 
            mode: 'global', 
            url: '', 
            available: false 
        };
        this.initialize();
    }

    initialize() {
        this.updateServerUrl();
    }

    // === Получение текущего сервера ===
    
    getCurrentServer() {
        const mode = this.store.getServerMode();
        const config = this.config.getServerConfig(mode);
        
        if (mode === 'global') {
            return {
                mode,
                url: config.primary,
                backup: config.backup
            };
        } else {
            return {
                mode,
                url: config.primary
            };
        }
    }

    // === Обновление URL сервера ===
    
    updateServerUrl() {
        const server = this.getCurrentServer();
        this.store.setServerUrl(server.url);
        this.currentServerStatus = { ...server, available: false };
        console.log(`🌐 Переключен на ${server.mode} сервер:`, server.url);
        return server;
    }

    // === Проверка доступности сервера ===
    
    async checkServerConnection(url = null) {
        try {
            const serverUrl = url || this.store.getServerUrl();
            console.log('🔍 Проверяем сервер:', serverUrl);
            
            const response = await axios.get(`${serverUrl}/health`, {
                timeout: 5000
            });
            
            console.log('✅ Сервер доступен');
            return { available: true };
            
        } catch (error) {
            console.error('❌ Сервер недоступен:', error.message);
            return { 
                available: false, 
                error: error.code === 'ECONNREFUSED' 
                    ? 'Сервер не запущен или недоступен'
                    : error.message
            };
        }
    }

    // === Переключение режима сервера ===
    
    async switchServerMode(mode) {
        try {
            console.log(`🔄 Переключение на ${mode} сервер...`);
            
            if (!['global', 'test'].includes(mode)) {
                throw new Error('Неверный режим сервера');
            }
            
            // Обновляем настройки
            this.store.setServerMode(mode);
            const server = this.updateServerUrl();
            
            // Проверяем доступность нового сервера
            const serverCheck = await this.checkServerConnection();
            
            if (serverCheck.available) {
                this.currentServerStatus.available = true;
                console.log(`✅ Успешно переключен на ${mode} сервер`);
                
                return { 
                    success: true, 
                    server,
                    status: this.currentServerStatus
                };
                
            } else {
                // Если global сервер недоступен, пробуем резервный
                if (mode === 'global' && server.backup) {
                    console.log('⚠️ Основной сервер недоступен, пробуем резервный...');
                    this.store.setServerUrl(server.backup);
                    
                    const backupCheck = await this.checkServerConnection();
                    if (backupCheck.available) {
                        this.currentServerStatus.url = server.backup;
                        this.currentServerStatus.available = true;
                        
                        console.log('✅ Переключен на резервный сервер');
                        return { 
                            success: true, 
                            server: { ...server, url: server.backup, isBackup: true },
                            status: this.currentServerStatus
                        };
                    }
                }
                
                // Серверы недоступны
                this.currentServerStatus.available = false;
                return { 
                    success: false, 
                    error: `Сервер ${mode} недоступен: ${serverCheck.error}`,
                    server,
                    status: this.currentServerStatus
                };
            }
            
        } catch (error) {
            console.error('❌ Ошибка переключения сервера:', error);
            return { 
                success: false, 
                error: error.message,
                server: this.getCurrentServer(),
                status: this.currentServerStatus
            };
        }
    }

    // === Инициализация при запуске приложения ===
    
    async initializeOnStartup() {
        try {
            // Проверяем доступность текущего сервера
            const serverCheck = await this.checkServerConnection();
            if (serverCheck.available) {
                this.currentServerStatus.available = true;
                console.log('✅ Сервер доступен при запуске');
                return { success: true, status: this.currentServerStatus };
            } else {
                const server = this.getCurrentServer();
                
                // Если global режим и есть backup, пробуем его
                if (server.mode === 'global' && server.backup) {
                    console.log('⚠️ Основной сервер недоступен, переключаемся на резервный...');
                    this.store.setServerUrl(server.backup);
                    
                    const backupCheck = await this.checkServerConnection();
                    if (backupCheck.available) {
                        this.currentServerStatus.url = server.backup;
                        this.currentServerStatus.available = true;
                        console.log('✅ Успешно переключен на резервный сервер');
                        
                        return { 
                            success: true, 
                            status: this.currentServerStatus,
                            isBackup: true 
                        };
                    }
                }
                
                console.log('❌ Все серверы недоступны');
                return { 
                    success: false, 
                    error: serverCheck.error,
                    status: this.currentServerStatus
                };
            }
        } catch (error) {
            console.error('❌ Ошибка инициализации сервера:', error);
            return { 
                success: false, 
                error: error.message,
                status: this.currentServerStatus
            };
        }
    }

    // === Получение статуса сервера ===
    
    getServerStatus() {
        return {
            ...this.currentServerStatus,
            server: this.getCurrentServer()
        };
    }

    // === Обновление статуса доступности ===
    
    setServerAvailable(available, error = null) {
        this.currentServerStatus.available = available;
        if (error) {
            this.currentServerStatus.error = error;
        }
    }

    // === Получение всех доступных серверов ===
    
    getAllServers() {
        return {
            global: this.config.servers.global,
            test: this.config.servers.test
        };
    }

    // === Отладочная информация ===
    
    getDebugInfo() {
        return {
            current: this.getCurrentServer(),
            status: this.currentServerStatus,
            stored: {
                url: this.store.getServerUrl(),
                mode: this.store.getServerMode()
            },
            available: this.getAllServers()
        };
    }
}

module.exports = ServerManager;