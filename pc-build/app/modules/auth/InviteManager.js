const ConfigManager = require('../core/ConfigManager');
const StoreManager = require('../core/StoreManager');

/**
 * InviteManager - Управление системой инвайт-ключей
 */
class InviteManager {
    constructor(apiManager = null) {
        this.config = new ConfigManager();
        this.store = new StoreManager();
        this.api = apiManager;
        this.hwid = null;
        
        this.initialize();
    }

    initialize() {
        console.log('🎫 Инициализация InviteManager...');
        
        // Получаем HWID системы
        this.loadHWID();
        
        console.log('✅ InviteManager инициализирован');
    }

    // === Установка API менеджера ===
    
    setApiManager(apiManager) {
        this.api = apiManager;
        console.log('🔗 API Manager подключен к InviteManager');
    }

    // === Получение HWID системы ===
    
    loadHWID() {
        try {
            // Используем существующий hwid_client.js
            const HWIDClient = require('../utils/hwid_client.js');
            this.hwid = HWIDClient.getSystemHWID();
            
            console.log('💻 HWID получен:', this.hwid.slice(0, 8) + '...');
            
        } catch (error) {
            console.error('❌ Ошибка получения HWID:', error.message);
            this.hwid = null;
        }
    }

    // === Получение HWID ===
    
    getHWID() {
        if (!this.hwid) {
            this.loadHWID();
        }
        
        return {
            success: !!this.hwid,
            hwid: this.hwid,
            shortHwid: this.hwid ? this.hwid.slice(0, 8) + '...' : null,
            error: this.hwid ? null : 'Не удалось получить HWID системы'
        };
    }

    // === Проверка доступа по HWID ===
    
    async checkAccess() {
        try {
            console.log('🔍 Проверка доступа по HWID...');
            
            if (!this.hwid) {
                const hwidResult = this.getHWID();
                if (!hwidResult.success) {
                    return hwidResult;
                }
            }
            
            if (!this.api) {
                throw new Error('API Manager не инициализирован');
            }
            
            const result = await this.api.post('/api/invite-keys/check-hwid', {
                hwid: this.hwid
            });
            
            if (!result.success) {
                console.log('❌ Ошибка проверки доступа:', result.userMessage);
                return {
                    success: false,
                    hasAccess: false,
                    error: result.userMessage || 'Ошибка проверки доступа'
                };
            }
            
            const { has_access, key_info, message } = result.data;
            
            if (has_access) {
                console.log('✅ HWID имеет доступ');
                return {
                    success: true,
                    hasAccess: true,
                    keyInfo: key_info
                };
            } else {
                console.log('🚫 HWID не имеет доступа:', message);
                return {
                    success: true,
                    hasAccess: false,
                    message: message || 'Доступ не предоставлен'
                };
            }
            
        } catch (error) {
            console.error('❌ Ошибка проверки доступа:', error.message);
            return {
                success: false,
                hasAccess: false,
                error: error.message || 'Ошибка связи с сервером'
            };
        }
    }

    // === Валидация инвайт-ключа ===
    
    async validateInviteKey(inviteCode) {
        try {
            console.log('🎫 Валидация инвайт-ключа...');
            
            if (!inviteCode || typeof inviteCode !== 'string') {
                return {
                    success: false,
                    error: 'Введите инвайт-ключ'
                };
            }
            
            const cleanCode = inviteCode.trim();
            if (!cleanCode) {
                return {
                    success: false,
                    error: 'Инвайт-ключ не может быть пустым'
                };
            }
            
            if (!this.hwid) {
                const hwidResult = this.getHWID();
                if (!hwidResult.success) {
                    return hwidResult;
                }
            }
            
            if (!this.api) {
                throw new Error('API Manager не инициализирован');
            }
            
            const result = await this.api.post('/api/invite-keys/validate', {
                invite_code: cleanCode,
                hwid: this.hwid
            });
            
            if (!result.success) {
                console.log('❌ Ошибка валидации ключа:', result.userMessage);
                return {
                    success: false,
                    error: result.userMessage || 'Ошибка валидации ключа'
                };
            }
            
            const { message, key_info, error_code } = result.data;
            
            if (result.data.success) {
                console.log('✅ Инвайт-ключ активирован:', message);
                
                return {
                    success: true,
                    message: message || 'Инвайт-ключ успешно активирован',
                    keyInfo: key_info
                };
            } else {
                console.log('🚫 Инвайт-ключ недействителен:', message);
                
                return {
                    success: false,
                    error: message || 'Инвайт-ключ недействителен',
                    errorCode: error_code
                };
            }
            
        } catch (error) {
            console.error('❌ Ошибка валидации инвайт-ключа:', error.message);
            return {
                success: false,
                error: error.message || 'Ошибка связи с сервером'
            };
        }
    }

    // === Получение информации о ключе ===
    
    async getKeyInfo() {
        try {
            console.log('📋 Получение информации о ключе...');
            
            const hwidResult = this.getHWID();
            if (!hwidResult.success) {
                return hwidResult;
            }
            
            // Проверяем доступ и получаем информацию о ключе
            const accessResult = await this.checkAccess();
            
            if (accessResult.success && accessResult.hasAccess) {
                return {
                    success: true,
                    hwid: hwidResult.shortHwid,
                    hasKey: true,
                    keyInfo: accessResult.keyInfo
                };
            } else {
                return {
                    success: true,
                    hwid: hwidResult.shortHwid,
                    hasKey: false,
                    message: accessResult.message
                };
            }
            
        } catch (error) {
            console.error('❌ Ошибка получения информации о ключе:', error.message);
            return {
                success: false,
                error: error.message
            };
        }
    }

    // === Очистка ключа (локально) ===
    
    async clearKey() {
        try {
            console.log('🗑️ Очистка ключа...');
            
            // В текущей реализации очистка ключа происходит на сервере
            // Здесь можем просто подтвердить действие
            
            return {
                success: true,
                message: 'Ключ очищен (требуется новый ключ для доступа)'
            };
            
        } catch (error) {
            console.error('❌ Ошибка очистки ключа:', error.message);
            return {
                success: false,
                error: error.message
            };
        }
    }


    // === Валидация формата инвайт-ключа ===
    
    validateKeyFormat(inviteCode) {
        if (!inviteCode || typeof inviteCode !== 'string') {
            return {
                valid: false,
                error: 'Ключ должен быть строкой'
            };
        }
        
        const cleanCode = inviteCode.trim();
        
        if (!cleanCode) {
            return {
                valid: false,
                error: 'Ключ не может быть пустым'
            };
        }
        
        // Простая валидация формата (можно расширить)
        if (cleanCode.length < 8) {
            return {
                valid: false,
                error: 'Ключ слишком короткий'
            };
        }
        
        if (cleanCode.length > 50) {
            return {
                valid: false,
                error: 'Ключ слишком длинный'
            };
        }
        
        // Проверяем допустимые символы
        if (!/^[A-Za-z0-9\-_]+$/.test(cleanCode)) {
            return {
                valid: false,
                error: 'Ключ содержит недопустимые символы'
            };
        }
        
        return {
            valid: true,
            cleanCode: cleanCode
        };
    }

    // === Получение статуса системы ===
    
    getStatus() {
        return {
            hwid: this.hwid ? this.hwid.slice(0, 8) + '...' : null,
            hasHwid: !!this.hwid,
            apiConnected: !!this.api
        };
    }

    // === Полная проверка при запуске приложения ===
    
    async checkStartupAccess() {
        try {
            console.log('🚀 Проверка инвайт-доступа при запуске...');
            
            // Проверяем доступ по HWID (как в оригинальном приложении)
            const accessResult = await this.checkAccess();
            
            if (!accessResult.success) {
                return {
                    success: false,
                    error: accessResult.error
                };
            }
            
            if (accessResult.hasAccess) {
                console.log('✅ Доступ разрешен по инвайт-ключу');
                return {
                    success: true,
                    accessGranted: true,
                    keyInfo: accessResult.keyInfo
                };
            } else {
                console.log('🚫 Требуется активация инвайт-ключа');
                return {
                    success: true,
                    accessGranted: false,
                    requiresInvite: true,
                    message: accessResult.message
                };
            }
            
        } catch (error) {
            console.error('❌ Ошибка проверки доступа при запуске:', error.message);
            return {
                success: false,
                error: error.message
            };
        }
    }

    // === Отладочная информация ===
    
    getDebugInfo() {
        return {
            status: this.getStatus(),
            api: {
                connected: !!this.api,
                baseURL: this.api?.getStatus?.()?.baseURL
            },
            hwid: {
                available: !!this.hwid,
                short: this.hwid ? this.hwid.slice(0, 12) : null
            }
        };
    }
}

module.exports = InviteManager;