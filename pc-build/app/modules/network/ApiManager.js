const axios = require('axios');
const ConfigManager = require('../core/ConfigManager');
const StoreManager = require('../core/StoreManager');

/**
 * ApiManager - Управление HTTP API с автоматическим обновлением токенов
 */
class ApiManager {
    constructor() {
        this.config = new ConfigManager();
        this.store = new StoreManager();
        this.api = null;
        this.initialize();
    }

    initialize() {
        console.log('🌐 Инициализация ApiManager...');
        
        // Создаем экземпляр axios с базовой конфигурацией
        this.api = axios.create({
            timeout: this.config.api.timeout,
            headers: {
                'Content-Type': 'application/json'
            }
        });

        // Настраиваем interceptors
        this.setupRequestInterceptor();
        this.setupResponseInterceptor();
        
        console.log('✅ ApiManager инициализирован');
    }

    // === Настройка request interceptor ===
    
    setupRequestInterceptor() {
        this.api.interceptors.request.use(
            config => {
                // Обновляем baseURL из настроек
                const serverUrl = this.store.getServerUrl();
                if (serverUrl) {
                    config.baseURL = serverUrl;
                }
                
                // Добавляем токен авторизации
                const tokens = this.store.getTokens();
                if (tokens?.access_token) {
                    config.headers.Authorization = `Bearer ${tokens.access_token}`;
                }
                
                // Логируем запрос
                console.log(`📡 API Request: ${config.method?.toUpperCase()} ${config.url}`);
                
                return config;
            },
            error => {
                console.error('❌ Request interceptor error:', error);
                return Promise.reject(error);
            }
        );
    }

    // === Настройка response interceptor для автообновления токенов ===
    
    setupResponseInterceptor() {
        this.api.interceptors.response.use(
            response => {
                // Логируем успешный ответ
                console.log(`✅ API Response: ${response.status} ${response.config.url}`);
                return response;
            },
            async error => {
                const originalRequest = error.config;
                
                // Логируем ошибку
                console.log(`❌ API Error: ${error.response?.status} ${originalRequest?.url}`);
                
                // Проверяем, нужно ли обновить токен
                if (this.shouldRefreshToken(error, originalRequest)) {
                    // Помечаем запрос как повторный чтобы избежать бесконечного цикла
                    originalRequest._retry = true;
                    
                    console.log('🔄 Попытка обновления токена...');
                    
                    try {
                        const refreshResult = await this.refreshToken();
                        
                        if (refreshResult.success) {
                            console.log('✅ Токен успешно обновлен, повторяем запрос');
                            
                            // Обновляем заголовок для повторного запроса
                            originalRequest.headers['Authorization'] = `Bearer ${refreshResult.tokens.access_token}`;
                            
                            // Повторяем исходный запрос
                            return this.api(originalRequest);
                        } else {
                            console.log('❌ Не удалось обновить токен, требуется повторный вход');
                            this.handleAuthFailure();
                            return Promise.reject(error);
                        }
                        
                    } catch (refreshError) {
                        console.error('❌ Ошибка обновления токена:', refreshError.message);
                        this.handleAuthFailure();
                        return Promise.reject(refreshError);
                    }
                }
                
                // Логируем ошибки доступа
                if (error.response?.status === 403) {
                    console.error('🚫 Ошибка 403 - недостаточно прав:', {
                        url: originalRequest?.url,
                        method: originalRequest?.method,
                        userRole: this.store.getUser()?.role
                    });
                }
                
                return Promise.reject(error);
            }
        );
    }

    // === Проверка необходимости обновления токена ===
    
    shouldRefreshToken(error, originalRequest) {
        return (
            error.response?.status === 401 &&
            !originalRequest._retry &&
            this.store.hasRefreshToken() &&
            !originalRequest.url?.includes('/auth/refresh') // Избегаем бесконечного цикла
        );
    }

    // === Обновление токена ===
    
    async refreshToken() {
        try {
            const tokens = this.store.getTokens();
            
            if (!tokens?.refresh_token) {
                throw new Error('Нет refresh токена');
            }
            
            console.log('🔑 Обновление токена через refresh token...');
            
            // Используем обычный axios для избежания recursion
            const serverUrl = this.store.getServerUrl();
            const response = await axios.post(`${serverUrl}/api/auth/refresh`, {
                refresh_token: tokens.refresh_token
            }, {
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: this.config.api.timeout
            });
            
            if (response.data?.success && response.data?.tokens) {
                const newTokens = response.data.tokens;
                
                // Сохраняем новые токены
                this.store.setTokens(newTokens);
                
                console.log('✅ Токены успешно обновлены');
                
                return {
                    success: true,
                    tokens: newTokens
                };
            } else {
                throw new Error('Неверный ответ сервера при обновлении токена');
            }
            
        } catch (error) {
            console.error('❌ Ошибка обновления токена:', error.message);
            
            return {
                success: false,
                error: error.message
            };
        }
    }

    // === Обработка неудачной авторизации ===
    
    handleAuthFailure() {
        console.log('🚪 Обработка неудачной авторизации - очистка данных');
        
        // Очищаем данные авторизации
        this.store.clearAuthData();
        
        // Эмитируем событие для AppManager
        this.emitAuthFailure();
    }

    // === Эмиссия события о неудачной авторизации ===
    
    emitAuthFailure() {
        // TODO: Здесь будет использоваться EventBus когда создадим
        console.log('🔔 Событие: требуется повторная авторизация');
        
        // Пока что можем использовать прямой callback
        if (this.onAuthFailure) {
            this.onAuthFailure();
        }
    }

    // === Установка callback для неудачной авторизации ===
    
    setAuthFailureCallback(callback) {
        this.onAuthFailure = callback;
    }

    // === Публичные методы для выполнения запросов ===
    
    async get(url, config = {}) {
        try {
            const response = await this.api.get(url, config);
            return { success: true, data: response.data };
        } catch (error) {
            // Retry при 401 уже обрабатывается в response interceptor (setupResponseInterceptor)
            // Здесь просто обрабатываем финальную ошибку
            return this.handleRequestError(error, 'GET', url);
        }
    }

    async post(url, data = {}, config = {}) {
        try {
            const response = await this.api.post(url, data, config);
            return { success: true, data: response.data };
        } catch (error) {
            // Retry при 401 уже обрабатывается в response interceptor (setupResponseInterceptor)
            // Здесь просто обрабатываем финальную ошибку
            return this.handleRequestError(error, 'POST', url);
        }
    }

    async put(url, data = {}, config = {}) {
        try {
            const response = await this.api.put(url, data, config);
            return { success: true, data: response.data };
        } catch (error) {
            return this.handleRequestError(error, 'PUT', url);
        }
    }

    async delete(url, config = {}) {
        try {
            const response = await this.api.delete(url, config);
            return { success: true, data: response.data };
        } catch (error) {
            return this.handleRequestError(error, 'DELETE', url);
        }
    }

    // === Обработка ошибок запросов ===
    
    handleRequestError(error, method, url) {
        const errorInfo = {
            success: false,
            method,
            url,
            status: error.response?.status,
            message: error.message,
            data: error.response?.data
        };
        
        // Определяем тип ошибки
        if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
            errorInfo.type = 'CONNECTION_ERROR';
            errorInfo.userMessage = 'Нет подключения к серверу';
        } else if (error.code === 'ETIMEDOUT') {
            errorInfo.type = 'TIMEOUT_ERROR'; 
            errorInfo.userMessage = 'Тайм-аут запроса';
        } else if (error.response?.status === 401) {
            errorInfo.type = 'AUTH_ERROR';
            errorInfo.userMessage = 'Ошибка авторизации';
        } else if (error.response?.status === 403) {
            errorInfo.type = 'PERMISSION_ERROR';
            errorInfo.userMessage = 'Недостаточно прав';
        } else if (error.response?.status >= 500) {
            errorInfo.type = 'SERVER_ERROR';
            errorInfo.userMessage = 'Ошибка сервера';
        } else {
            errorInfo.type = 'UNKNOWN_ERROR';
            errorInfo.userMessage = error.response?.data?.detail || error.response?.data?.message || 'Неизвестная ошибка';
        }
        
        console.error(`❌ ${method} ${url}:`, errorInfo);
        
        return errorInfo;
    }

    // === Получение прямого доступа к axios (для особых случаев) ===
    
    getAxiosInstance() {
        return this.api;
    }

    // === Обновление базового URL ===
    
    updateBaseURL(url) {
        if (this.api) {
            this.api.defaults.baseURL = url;
            console.log('🌐 API BaseURL обновлен:', url);
        }
    }

    // === Получение статуса ===
    
    getStatus() {
        return {
            baseURL: this.api?.defaults?.baseURL,
            hasTokens: this.store.hasTokens(),
            timeout: this.config.api.timeout
        };
    }

    // === Отладочная информация ===
    
    getDebugInfo() {
        return {
            status: this.getStatus(),
            store: {
                hasTokens: this.store.hasTokens(),
                hasRefreshToken: this.store.hasRefreshToken(),
                serverUrl: this.store.getServerUrl()
            },
            config: {
                timeout: this.config.api.timeout,
                maxRetries: this.config.api.maxRetries
            }
        };
    }
}

module.exports = ApiManager;
