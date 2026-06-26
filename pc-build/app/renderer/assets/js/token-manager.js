// token-manager.js - Современная система управления JWT токенами (2025)
// Автоматический refresh с защитой от race conditions

class TokenManager {
    constructor() {
        this.refreshPromise = null; // Защита от race conditions
        this.isRefreshing = false;
        this.failedQueue = []; // Очередь запросов во время refresh
        
        // Настройки
        this.REFRESH_BEFORE_EXPIRE_MS = 5 * 60 * 1000; // 5 минут до истечения
        this.MAX_RETRY_ATTEMPTS = 3;
        
        console.log('🔑 [TokenManager] Инициализирован');
    }

    /**
     * Основной метод получения актуального access token
     * Автоматически обновляет токен если нужно
     */
    async getValidAccessToken() {
        try {
            // Получаем токены из хранилища
            const tokens = await this.getStoredTokens();
            
            if (!tokens || !tokens.access_token) {
                console.warn('⚠️ [TokenManager] Нет токенов в хранилище');
                return null;
            }

            // Проверяем, нужно ли обновить токен
            if (this.shouldRefreshToken(tokens.access_token)) {
                console.log('🔄 [TokenManager] Токен скоро истечёт, обновляем...');
                
                // Обновляем токен
                const newTokens = await this.refreshTokens(tokens.refresh_token);
                if (newTokens) {
                    await this.storeTokens(newTokens);
                    return newTokens.access_token;
                } else {
                    console.error('❌ [TokenManager] Не удалось обновить токены');
                    return null;
                }
            }

            return tokens.access_token;

        } catch (error) {
            console.error('❌ [TokenManager] Ошибка получения токена:', error);
            return null;
        }
    }

    /**
     * Проверяет, нужно ли обновить токен (превентивная проверка)
     */
    shouldRefreshToken(accessToken) {
        try {
            // Декодируем JWT токен (без проверки подписи, только для чтения exp)
            const payload = this.decodeJwtPayload(accessToken);
            if (!payload || !payload.exp) {
                console.warn('⚠️ [TokenManager] Некорректный JWT токен');
                return true;
            }

            // Проверяем время истечения
            const expireTime = payload.exp * 1000; // Переводим в миллисекунды
            const currentTime = Date.now();
            const timeUntilExpire = expireTime - currentTime;

            console.log(`⏰ [TokenManager] До истечения токена: ${Math.round(timeUntilExpire / 60000)} минут`);

            // Обновляем за 5 минут до истечения
            return timeUntilExpire <= this.REFRESH_BEFORE_EXPIRE_MS;

        } catch (error) {
            console.error('❌ [TokenManager] Ошибка проверки токена:', error);
            return true; // В случае ошибки обновляем токен
        }
    }

    /**
     * Декодирует payload JWT токена (без проверки подписи)
     */
    decodeJwtPayload(token) {
        try {
            const parts = token.split('.');
            if (parts.length !== 3) {
                throw new Error('Некорректный формат JWT');
            }

            const payload = parts[1];
            const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
            return JSON.parse(decoded);

        } catch (error) {
            console.error('❌ [TokenManager] Ошибка декодирования JWT:', error);
            return null;
        }
    }

    /**
     * Обновляет токены через API с защитой от race conditions
     */
    async refreshTokens(refreshToken) {
        // Защита от множественных одновременных refresh запросов
        if (this.refreshPromise) {
            console.log('🔄 [TokenManager] Refresh уже выполняется, ждём...');
            return this.refreshPromise;
        }

        if (!refreshToken) {
            console.error('❌ [TokenManager] Нет refresh_token');
            return null;
        }

        this.refreshPromise = this._performRefresh(refreshToken);

        try {
            const result = await this.refreshPromise;
            return result;
        } finally {
            this.refreshPromise = null;
        }
    }

    /**
     * Выполняет фактический refresh запрос
     */
    async _performRefresh(refreshToken) {
        try {
            const serverUrl = await this.getServerUrl();
            
            const response = await fetch(`${serverUrl}/api/auth/refresh`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    refresh_token: refreshToken
                })
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();
            
            if (data.success && data.tokens) {
                console.log('✅ [TokenManager] Токены успешно обновлены');
                return data.tokens;
            } else {
                throw new Error(data.error || 'Неизвестная ошибка refresh');
            }

        } catch (error) {
            console.error('❌ [TokenManager] Ошибка refresh запроса:', error);
            return null;
        }
    }

    /**
     * Получает токены из хранилища (Electron или localStorage)
     */
    async getStoredTokens() {
        console.log('🔍 [TokenManager] Поиск токенов в хранилище...');
        try {
            // Для Electron версии
            if (window.electronAPI && window.electronAPI.tokens) {
                console.log('✅ [TokenManager] ElectronAPI доступен, запрашиваем токены...');
                const result = await window.electronAPI.tokens.getUser();
                console.log('🔑 [TokenManager] ElectronAPI ответ:', result.success ? 'УСПЕХ' : 'ОШИБКА', result.error || '');
                if (result.success && result.tokens) {
                    console.log('✅ [TokenManager] Токены получены через ElectronAPI');
                    return result.tokens;
                }
            } else {
                console.log('⚠️ [TokenManager] ElectronAPI недоступен');
            }

            // Для веб-версии - проверяем все хранилища
            console.log('🔄 [TokenManager] Проверяем все хранилища...');
            
            // localStorage
            const authTokensStr = localStorage.getItem('auth_tokens');
            const tokensStr = localStorage.getItem('tokens');
            const streamerTokensStr = localStorage.getItem('streamer_tokens');
            console.log('🔍 [TokenManager] localStorage auth_tokens:', !!authTokensStr);
            console.log('🔍 [TokenManager] localStorage tokens:', !!tokensStr);
            console.log('🔍 [TokenManager] localStorage streamer_tokens:', !!streamerTokensStr);
            
            // sessionStorage
            const sessionAuthTokensStr = sessionStorage.getItem('auth_tokens');
            const sessionStreamerTokensStr = sessionStorage.getItem('streamer_tokens');
            console.log('🔍 [TokenManager] sessionStorage auth_tokens:', !!sessionAuthTokensStr);
            console.log('🔍 [TokenManager] sessionStorage streamer_tokens:', !!sessionStreamerTokensStr);
            
            // window.name
            let windowNameData = null;
            try {
                if (window.name) {
                    windowNameData = JSON.parse(window.name);
                    console.log('🔍 [TokenManager] window.name токены:', !!windowNameData.tokens);
                }
            } catch (e) {
                console.log('🔍 [TokenManager] window.name: нет данных');
            }
            
            // Приоритет: window.name -> sessionStorage -> localStorage
            if (windowNameData && windowNameData.tokens) {
                console.log('✅ [TokenManager] Найдены токены в window.name');
                console.log('🔑 [TokenManager] Токены содержат access_token:', !!windowNameData.tokens.access_token);
                return windowNameData.tokens;
            }
            
            const sessionTokensStr = sessionStreamerTokensStr || sessionAuthTokensStr;
            if (sessionTokensStr) {
                console.log('✅ [TokenManager] Найдены токены в sessionStorage');
                try {
                    const parsed = JSON.parse(sessionTokensStr);
                    console.log('🔑 [TokenManager] Токены содержат access_token:', !!parsed.access_token);
                    return parsed;
                } catch (error) {
                    console.error('❌ [TokenManager] Ошибка парсинга sessionStorage токенов:', error);
                }
            }
            
            const localTokensStr = streamerTokensStr || authTokensStr || tokensStr;
            if (localTokensStr) {
                console.log('✅ [TokenManager] Найдены токены в localStorage');
                try {
                    const parsed = JSON.parse(localTokensStr);
                    console.log('🔑 [TokenManager] Токены содержат access_token:', !!parsed.access_token);
                    return parsed;
                } catch (error) {
                    console.error('❌ [TokenManager] Ошибка парсинга localStorage токенов:', error);
                }
            }

            // Проверяем альтернативные ключи
            const userStr = localStorage.getItem('user');
            const streamerUserStr = localStorage.getItem('streamer_user');
            console.log('🔍 [TokenManager] user данные:', !!userStr);
            console.log('🔍 [TokenManager] streamer_user данные:', !!streamerUserStr);
            
            const finalUserStr = streamerUserStr || userStr;
            if (finalUserStr) {
                console.log('🔄 [TokenManager] Найден user в localStorage');
                try {
                    const userData = JSON.parse(finalUserStr);
                    console.log('👤 [TokenManager] User содержит access_token:', !!userData.access_token);
                    if (userData.access_token) {
                        console.log('✅ [TokenManager] Токены извлечены из user данных');
                        return {
                            access_token: userData.access_token,
                            refresh_token: userData.refresh_token || null
                        };
                    }
                } catch (error) {
                    console.error('❌ [TokenManager] Ошибка парсинга user данных:', error);
                }
            }

            console.log('❌ [TokenManager] Токены не найдены ни в одном хранилище');
            return null;

        } catch (error) {
            console.error('❌ [TokenManager] Ошибка получения токенов из хранилища:', error);
            return null;
        }
    }

    /**
     * Сохраняет токены в хранилище
     */
    async storeTokens(tokens) {
        try {
            // Для Electron версии
            if (window.electronAPI && window.electronAPI.store) {
                await window.electronAPI.store.setTokens(tokens);
                return;
            }

            // Для веб-версии - localStorage
            localStorage.setItem('auth_tokens', JSON.stringify(tokens));
            localStorage.setItem('tokens', JSON.stringify(tokens));
            
            console.log('💾 [TokenManager] Токены сохранены в localStorage');

        } catch (error) {
            console.error('❌ [TokenManager] Ошибка сохранения токенов:', error);
        }
    }

    /**
     * Получает URL сервера
     */
    async getServerUrl() {
        try {
            if (window.electronAPI && window.electronAPI.store) {
                const result = await window.electronAPI.store.getServerUrl();
                return result || 'https://api.artcsworld.xyz';
            }
        } catch (error) {
            console.error('❌ [TokenManager] Ошибка получения URL сервера:', error);
        }
        return 'https://api.artcsworld.xyz';
    }

    /**
     * Очищает все токены (при logout)
     */
    async clearTokens() {
        try {
            if (window.electronAPI && window.electronAPI.store) {
                await window.electronAPI.store.clearTokens();
            }

            localStorage.removeItem('auth_tokens');
            localStorage.removeItem('tokens');
            localStorage.removeItem('user');

            console.log('🗑️ [TokenManager] Все токены очищены');

        } catch (error) {
            console.error('❌ [TokenManager] Ошибка очистки токенов:', error);
        }
    }

    /**
     * API interceptor для автоматической обработки 401 ошибок
     */
    async handleApiRequest(url, options = {}) {
        try {
            // Получаем актуальный токен
            const accessToken = await this.getValidAccessToken();
            
            if (!accessToken) {
                throw new Error('Нет токена авторизации');
            }

            // Добавляем токен в заголовки
            const headers = {
                ...options.headers,
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            };

            const response = await fetch(url, { ...options, headers });

            // Если 401 - пробуем refresh и повторяем запрос
            if (response.status === 401) {
                console.log('🔄 [TokenManager] Получен 401, пробуем refresh...');
                
                const tokens = await this.getStoredTokens();
                if (tokens && tokens.refresh_token) {
                    const newTokens = await this.refreshTokens(tokens.refresh_token);
                    if (newTokens) {
                        await this.storeTokens(newTokens);
                        
                        // Повторяем запрос с новым токеном
                        headers['Authorization'] = `Bearer ${newTokens.access_token}`;
                        return fetch(url, { ...options, headers });
                    }
                }
                
                throw new Error('Не удалось обновить токен, требуется перелогин');
            }

            return response;

        } catch (error) {
            console.error('❌ [TokenManager] Ошибка API запроса:', error);
            throw error;
        }
    }
}

// Глобальный экземпляр
window.tokenManager = new TokenManager();

console.log('🚀 [TokenManager] Модуль загружен');
