const ConfigManager = require('../core/ConfigManager');
const StoreManager = require('../core/StoreManager');

/**
 * AuthManager - Управление авторизацией и токенами
 */
class AuthManager {
    constructor(apiManager = null) {
        this.config = new ConfigManager();
        this.store = new StoreManager();
        this.api = apiManager; // Будет установлен через AppManager
        this.authState = {
            isAuthenticated: false,
            user: null,
            tokens: null,
            lastLoginTime: null
        };
        
        this.initialize();
    }

    initialize() {
        console.log('🔐 Инициализация AuthManager...');
        
        // Загружаем состояние авторизации из хранилища
        this.loadAuthState();
        
        console.log('✅ AuthManager инициализирован');
        console.log(`👤 Текущий статус: ${this.authState.isAuthenticated ? 'авторизован' : 'не авторизован'}`);
    }

    // === Установка API менеджера ===
    
    setApiManager(apiManager) {
        this.api = apiManager;
        console.log('🔗 API Manager подключен к AuthManager');
    }

    // === Загрузка состояния авторизации ===
    
    loadAuthState() {
        const tokens = this.store.getTokens();
        const user = this.store.getUser();
        
        this.authState = {
            isAuthenticated: !!(tokens?.access_token && user),
            user: user,
            tokens: tokens,
            lastLoginTime: tokens?.issued_at || null
        };
        
        if (this.authState.isAuthenticated) {
            console.log('✅ Найдены сохраненные данные авторизации:', user?.username);
        }
    }

    // === Вход в систему ===
    
    async login(credentials) {
        try {
            console.log('🔐 Попытка входа в систему:', credentials.username);
            
            if (!this.api) {
                throw new Error('API Manager не инициализирован');
            }
            
            // Выполняем запрос на вход
            const result = await this.api.post('/api/auth/login', credentials);
            
            if (!result.success) {
                console.log('❌ Ошибка входа:', result.userMessage);
                return {
                    success: false,
                    error: result.userMessage || 'Ошибка входа в систему'
                };
            }
            
            const { tokens, user } = result.data;
            
            if (!tokens?.access_token || !user) {
                throw new Error('Неверный ответ сервера: отсутствуют токены или данные пользователя');
            }
            
            // Сохраняем данные авторизации
            this.saveAuthData(tokens, user);
            
            console.log('✅ Успешный вход в систему:', user.username);
            
            return {
                success: true,
                user: user,
                tokens: tokens
            };
            
        } catch (error) {
            console.error('❌ Ошибка входа в систему:', error.message);
            
            return {
                success: false,
                error: error.message || 'Неизвестная ошибка при входе'
            };
        }
    }

    // === Регистрация ===
    
    async register(userData) {
        try {
            console.log('📝 Попытка регистрации:', userData.username);
            
            if (!this.api) {
                throw new Error('API Manager не инициализирован');
            }
            
            // Выполняем запрос на регистрацию
            const result = await this.api.post('/api/auth/register', userData);
            
            if (!result.success) {
                console.log('❌ Ошибка регистрации:', result.userMessage);
                return {
                    success: false,
                    error: result.userMessage || 'Ошибка регистрации'
                };
            }
            
            console.log('✅ Успешная регистрация:', userData.username);
            
            return {
                success: true,
                message: 'Регистрация прошла успешно'
            };
            
        } catch (error) {
            console.error('❌ Ошибка регистрации:', error.message);
            
            return {
                success: false,
                error: error.message || 'Неизвестная ошибка при регистрации'
            };
        }
    }

    // === Выход из системы ===
    
    async logout(notifyServer = true) {
        try {
            console.log('🚪 Выход из системы...');
            
            // Уведомляем сервер о выходе (если нужно)
            if (notifyServer && this.api && this.authState.isAuthenticated) {
                try {
                    await this.api.post('/api/auth/logout');
                    console.log('✅ Сервер уведомлен о выходе');
                } catch (error) {
                    console.warn('⚠️ Не удалось уведомить сервер о выходе:', error.message);
                    // Продолжаем выход даже если сервер недоступен
                }
            }
            
            // Очищаем локальные данные
            this.clearAuthData();
            
            console.log('✅ Выход из системы выполнен');
            
            return { success: true };
            
        } catch (error) {
            console.error('❌ Ошибка при выходе:', error.message);
            
            // В любом случае очищаем локальные данные
            this.clearAuthData();
            
            return {
                success: true, // Возвращаем success даже при ошибке
                warning: 'Выход выполнен с предупреждениями'
            };
        }
    }

    // === Проверка валидности токена ===
    
    async validateToken() {
        try {
            if (!this.authState.tokens?.access_token) {
                return { valid: false, reason: 'Токен отсутствует' };
            }
            
            if (!this.api) {
                return { valid: false, reason: 'API Manager недоступен' };
            }
            
            console.log('🔍 Проверка валидности токена...');
            
            // Делаем тестовый запрос для проверки токена (как в оригинальном приложении)
            const result = await this.api.get('/health');
            
            if (result.success) {
                console.log('✅ Токен валиден');
                
                // /health не возвращает данные пользователя, используем сохраненные
                const savedUser = this.store.getUser();
                
                return { valid: true, user: savedUser };
            } else {
                console.log('❌ Токен невалиден:', result.userMessage);
                return { valid: false, reason: result.userMessage };
            }
            
        } catch (error) {
            console.error('❌ Ошибка проверки токена:', error.message);
            return { valid: false, reason: error.message };
        }
    }

    // === Обновление токена ===
    
    async refreshToken() {
        try {
            if (!this.authState.tokens?.refresh_token) {
                throw new Error('Refresh token отсутствует');
            }
            
            if (!this.api) {
                throw new Error('API Manager не инициализирован');
            }
            
            console.log('🔄 Обновление токена...');
            
            // Используем специальный метод API менеджера
            const result = await this.api.refreshToken();
            
            if (result.success) {
                // Обновляем сохраненные токены
                this.store.setTokens(result.tokens);
                this.authState.tokens = result.tokens;
                
                console.log('✅ Токен успешно обновлен');
                
                return { success: true, tokens: result.tokens };
            } else {
                console.log('❌ Не удалось обновить токен:', result.error);
                
                // Если не удалось обновить токен, очищаем данные авторизации
                this.clearAuthData();
                
                return { success: false, error: result.error };
            }
            
        } catch (error) {
            console.error('❌ Ошибка обновления токена:', error.message);
            
            // Очищаем данные авторизации при ошибке
            this.clearAuthData();
            
            return { success: false, error: error.message };
        }
    }

    // === Сохранение данных авторизации ===
    
    saveAuthData(tokens, user) {
        // Добавляем время выдачи токена
        const tokensWithTimestamp = {
            ...tokens,
            issued_at: new Date().toISOString()
        };
        
        // Сохраняем в хранилище
        this.store.setTokens(tokensWithTimestamp);
        this.store.setUser(user);
        
        // Обновляем состояние
        this.authState = {
            isAuthenticated: true,
            user: user,
            tokens: tokensWithTimestamp,
            lastLoginTime: tokensWithTimestamp.issued_at
        };
        
        console.log('💾 Данные авторизации сохранены');
        
        // Эмитируем событие успешной авторизации
        this.emitAuthEvent('login_success', { user });
    }

    // === Очистка данных авторизации ===
    
    clearAuthData() {
        // Очищаем хранилище
        this.store.clearAuthData();
        
        // Сбрасываем состояние
        this.authState = {
            isAuthenticated: false,
            user: null,
            tokens: null,
            lastLoginTime: null
        };
        
        console.log('🗑️ Данные авторизации очищены');
        
        // Эмитируем событие выхода
        this.emitAuthEvent('logout', {});
    }

    // === Проверка авторизации ===
    
    isAuthenticated() {
        return this.authState.isAuthenticated && 
               this.authState.tokens?.access_token && 
               this.authState.user;
    }

    // === Получение пользователя ===
    
    getCurrentUser() {
        return this.authState.user;
    }

    // === Получение токенов ===
    
    getTokens() {
        return this.authState.tokens;
    }

    // === Получение состояния авторизации ===
    
    getAuthState() {
        return {
            isAuthenticated: this.authState.isAuthenticated,
            user: this.authState.user ? {
                username: this.authState.user.username,
                role: this.authState.user.role,
                email: this.authState.user.email
            } : null,
            hasTokens: !!this.authState.tokens?.access_token,
            hasRefreshToken: !!this.authState.tokens?.refresh_token,
            lastLoginTime: this.authState.lastLoginTime
        };
    }

    // === Проверка роли пользователя ===
    
    hasRole(role) {
        return this.authState.user?.role === role;
    }

    // === Проверка прав доступа ===
    
    hasPermission(permission) {
        // Простая реализация, можно расширить
        const userRole = this.authState.user?.role;
        
        const permissions = {
            'admin': ['all'],
            'moderator': ['moderate', 'view'],
            'user': ['view']
        };
        
        const userPermissions = permissions[userRole] || [];
        return userPermissions.includes(permission) || userPermissions.includes('all');
    }

    // === Эмиссия событий авторизации ===
    
    emitAuthEvent(event, data) {
        console.log(`🔔 Auth событие: ${event}`);
        
        // TODO: Использовать EventBus когда создадим
        if (this.authEventCallback) {
            this.authEventCallback(event, data);
        }
    }

    // === Установка callback для событий авторизации ===
    
    setAuthEventCallback(callback) {
        this.authEventCallback = callback;
    }

    // === Инициализация при запуске приложения ===
    
    async initializeOnStartup() {
        console.log('🚀 Инициализация авторизации при запуске...');
        
        if (!this.authState.isAuthenticated) {
            console.log('👤 Пользователь не авторизован');
            return { authenticated: false };
        }
        
        // Проверяем валидность сохраненных токенов
        const tokenValidation = await this.validateToken();
        
        if (tokenValidation.valid) {
            console.log('✅ Пользователь успешно авторизован при запуске');
            return { 
                authenticated: true, 
                user: this.authState.user 
            };
        } else {
            console.log('❌ Сохраненные токены невалидны, требуется повторный вход');
            this.clearAuthData();
            return { 
                authenticated: false, 
                reason: tokenValidation.reason 
            };
        }
    }

    // === Отладочная информация ===
    
    getDebugInfo() {
        return {
            state: this.getAuthState(),
            store: {
                hasTokens: this.store.hasTokens(),
                hasRefreshToken: this.store.hasRefreshToken(),
                user: this.store.getUser()?.username
            },
            api: {
                connected: !!this.api,
                baseURL: this.api?.getStatus?.()?.baseURL
            }
        };
    }
}

module.exports = AuthManager;