// electron-client/app/invite-system.js - Клиентская система инвайт-ключей для Renderer процесса

class InviteSystemClient {
    constructor() {
        this.isInitialized = false;
        this.hwid = null;
    }
    
    /**
     * Инициализация системы инвайт-ключей
     */
    async init() {
        try {
            console.log('🎫 Инициализация системы инвайт-ключей (Renderer)...');
            
            // Получаем HWID через IPC
            const hwidResult = await window.electronAPI.invite.getHwid();
            if (!hwidResult.success) {
                throw new Error('Не удалось получить HWID системы');
            }
            
            this.hwid = hwidResult.hwid;
            this.isInitialized = true;
            
            console.log('🔐 Система инвайт-ключей инициализирована');
            console.log('🔐 HWID:', this.hwid.slice(0, 16) + '...');
            
            return true;
            
        } catch (error) {
            console.error('❌ Ошибка инициализации системы инвайт-ключей:', error);
            return false;
        }
    }
    
    /**
     * Проверка доступа по сохраненному ключу/HWID
     */
    async checkAccess() {
        try {
            if (!this.isInitialized) {
                await this.init();
            }
            
            console.log('🔐 Проверка доступа...');
            
            const result = await window.electronAPI.invite.checkAccess();
            
            if (result.success && result.hasAccess) {
                console.log('✅ Доступ подтвержден');
                return {
                    hasAccess: true,
                    keyInfo: result.keyInfo
                };
            } else {
                console.log('🚫 Доступ не подтвержден, требуется инвайт-ключ');
                return {
                    hasAccess: false,
                    message: result.message || 'Требуется инвайт-ключ'
                };
            }
            
        } catch (error) {
            console.error('❌ Ошибка проверки доступа:', error);
            return {
                hasAccess: false,
                error: error.message
            };
        }
    }
    
    /**
     * Проверка и активация инвайт-ключа
     */
    async validateInviteKey(inviteCode) {
        try {
            if (!this.isInitialized) {
                await this.init();
            }
            
            console.log('🔐 Валидация инвайт-ключа...');
            
            const result = await window.electronAPI.invite.validateKey(inviteCode.trim());
            
            if (result.success) {
                // Сохраняем ключ в localStorage
                this.saveKey(inviteCode.trim());
                console.log('✅ Инвайт-ключ активирован:', result.message);
                
                return {
                    success: true,
                    message: result.message,
                    keyInfo: result.keyInfo
                };
            } else {
                console.log('🚫 Инвайт-ключ недействителен:', result.message);
                
                return {
                    success: false,
                    message: result.message,
                    error_code: result.error_code
                };
            }
            
        } catch (error) {
            console.error('❌ Ошибка проверки инвайт-ключа:', error);
            return {
                success: false,
                message: 'Ошибка связи с сервером',
                error: error.message
            };
        }
    }
    
    /**
     * Показ диалога ввода инвайт-ключа
     */
    async showInviteDialog() {
        return new Promise((resolve) => {
            // Создаем модальное окно
            const modal = document.createElement('div');
            modal.className = 'invite-modal';
            modal.innerHTML = `
                <div class="invite-modal-content">
                    <div class="invite-header">
                        <h2>🎫 Введите инвайт-ключ</h2>
                        <p>Для доступа к программе требуется инвайт-ключ</p>
                    </div>
                    
                    <div class="invite-form">
                        <input type="text" 
                               id="invite-input" 
                               placeholder="CRTLS-XXXX-XXXX-XXXX"
                               class="invite-input"
                               maxlength="25">
                        
                        <div class="invite-buttons">
                            <button id="invite-submit" class="btn-primary">Активировать</button>
                            <button id="invite-cancel" class="btn-secondary">Отмена</button>
                        </div>
                        
                        <div id="invite-error" class="invite-error" style="display: none;"></div>
                        <div id="invite-loading" class="invite-loading" style="display: none;">
                            Проверка ключа...
                        </div>
                    </div>
                    
                </div>
            `;
            
            // Добавляем стили
            if (!document.getElementById('invite-modal-styles')) {
                const styles = document.createElement('style');
                styles.id = 'invite-modal-styles';
                styles.textContent = `
                    .invite-modal {
                        position: fixed;
                        top: 0;
                        left: 0;
                        width: 100%;
                        height: 100%;
                        background: rgba(0, 0, 0, 0.8);
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        z-index: 10000;
                        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                    }
                    
                    .invite-modal-content {
                        background: linear-gradient(135deg, rgba(20, 20, 35, 0.98), rgba(15, 15, 30, 0.98));
                        border: 1px solid rgba(139, 92, 246, 0.2);
                        padding: 30px;
                        max-width: 500px;
                        width: 90%;
                        box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
                        color: white;
                        text-align: center;
                    }
                    
                    .invite-header h2 {
                        margin: 0 0 10px 0;
                        font-size: 24px;
                        font-weight: 600;
                    }
                    
                    .invite-header p {
                        margin: 0 0 25px 0;
                        opacity: 0.9;
                        font-size: 16px;
                    }
                    
                    .invite-form {
                        margin-bottom: 25px;
                    }
                    
                    .invite-input {
                        width: 100%;
                        padding: 15px;
                        border: none;
                        border-radius: 8px;
                        font-size: 16px;
                        text-align: center;
                        text-transform: uppercase;
                        letter-spacing: 2px;
                        font-family: 'Courier New', monospace;
                        margin-bottom: 20px;
                        box-sizing: border-box;
                    }
                    
                    .invite-input:focus {
                        outline: none;
                        box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.3);
                    }
                    
                    .invite-buttons {
                        display: flex;
                        gap: 10px;
                        justify-content: center;
                    }
                    
                    .btn-primary, .btn-secondary {
                        padding: 12px 24px;
                        border: none;
                        border-radius: 8px;
                        font-size: 16px;
                        font-weight: 600;
                        cursor: pointer;
                        transition: all 0.3s ease;
                    }
                    
                    .btn-primary {
                        background: linear-gradient(135deg, #8B5CF6, #3B82F6);
                        color: white;
                    }
                    
                    .btn-primary:hover {
                        background: #45a049;
                        transform: translateY(-2px);
                    }
                    
                    .btn-secondary {
                        background: transparent;
                        color: white;
                        border: 2px solid rgba(255, 255, 255, 0.3);
                    }
                    
                    .btn-secondary:hover {
                        background: rgba(255, 255, 255, 0.1);
                    }
                    
                    .invite-error {
                        background: rgba(244, 67, 54, 0.9);
                        color: white;
                        padding: 12px;
                        border-radius: 8px;
                        margin-top: 15px;
                        font-weight: 500;
                        animation: shake 0.5s ease-in-out;
                    }
                    
                    .invite-loading {
                        background: rgba(33, 150, 243, 0.9);
                        color: white;
                        padding: 12px;
                        border-radius: 8px;
                        margin-top: 15px;
                        font-weight: 500;
                    }
                    
                    .invite-info {
                        background: rgba(255, 255, 255, 0.1);
                        border-radius: 8px;
                        padding: 15px;
                        font-size: 14px;
                        text-align: left;
                    }
                    
                    .invite-info p {
                        margin: 5px 0;
                    }
                    
                    .invite-info strong {
                        color: #FFE082;
                    }
                    
                    @keyframes shake {
                        0%, 100% { transform: translateX(0); }
                        10%, 30%, 50%, 70%, 90% { transform: translateX(-5px); }
                        20%, 40%, 60%, 80% { transform: translateX(5px); }
                    }
                `;
                document.head.appendChild(styles);
            }
            
            document.body.appendChild(modal);
            
            const input = modal.querySelector('#invite-input');
            const submitBtn = modal.querySelector('#invite-submit');
            const cancelBtn = modal.querySelector('#invite-cancel');
            const errorDiv = modal.querySelector('#invite-error');
            const loadingDiv = modal.querySelector('#invite-loading');
            
            // Фокус на поле ввода
            setTimeout(() => input.focus(), 100);
            
            // Форматирование ввода
            input.addEventListener('input', (e) => {
                let value = e.target.value.replace(/[^A-Z0-9]/g, '').toUpperCase();
                let formatted = '';
                
                for (let i = 0; i < value.length; i++) {
                    if (i === 5 || i === 9 || i === 13) {
                        formatted += '-';
                    }
                    formatted += value[i];
                }
                
                e.target.value = formatted;
            });
            
            // Обработка отправки
            const handleSubmit = async () => {
                const inviteCode = input.value.trim();
                
                if (!inviteCode) {
                    this.showError(errorDiv, 'Введите инвайт-ключ');
                    return;
                }
                
                if (inviteCode.length < 19) {
                    this.showError(errorDiv, 'Неполный инвайт-ключ');
                    return;
                }
                
                // Показываем загрузку
                errorDiv.style.display = 'none';
                loadingDiv.style.display = 'block';
                submitBtn.disabled = true;
                cancelBtn.disabled = true;
                
                try {
                    const result = await this.validateInviteKey(inviteCode);
                    
                    if (result.success) {
                        // Успех
                        document.body.removeChild(modal);
                        resolve({
                            success: true,
                            keyInfo: result.keyInfo
                        });
                    } else {
                        // Ошибка валидации
                        loadingDiv.style.display = 'none';
                        this.showError(errorDiv, result.message);
                        submitBtn.disabled = false;
                        cancelBtn.disabled = false;
                    }
                } catch (error) {
                    loadingDiv.style.display = 'none';
                    this.showError(errorDiv, 'Ошибка связи с сервером');
                    submitBtn.disabled = false;
                    cancelBtn.disabled = false;
                }
            };
            
            // Обработка отмены
            const handleCancel = () => {
                document.body.removeChild(modal);
                resolve({
                    success: false,
                    cancelled: true
                });
            };
            
            // События
            submitBtn.addEventListener('click', handleSubmit);
            cancelBtn.addEventListener('click', handleCancel);
            input.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    handleSubmit();
                }
            });
            
            // Закрытие по ESC
            const handleKeydown = (e) => {
                if (e.key === 'Escape') {
                    document.removeEventListener('keydown', handleKeydown);
                    handleCancel();
                }
            };
            document.addEventListener('keydown', handleKeydown);
        });
    }
    
    /**
     * Показ ошибки в диалоге
     */
    showError(errorDiv, message) {
        errorDiv.textContent = message;
        errorDiv.style.display = 'block';
    }
    
    /**
     * Загрузка сохраненного ключа
     */
    loadStoredKey() {
        try {
            const stored = localStorage.getItem('snipe_invite_key');
            return stored || null;
        } catch (error) {
            console.error('Ошибка загрузки сохраненного ключа:', error);
            return null;
        }
    }
    
    /**
     * Сохранение ключа
     */
    saveKey(key) {
        try {
            localStorage.setItem('snipe_invite_key', key);
            console.log('🔑 Инвайт-ключ сохранен в localStorage');
        } catch (error) {
            console.error('Ошибка сохранения ключа:', error);
        }
    }
    
    /**
     * Очистка сохраненного ключа
     */
    clearKey() {
        try {
            localStorage.removeItem('snipe_invite_key');
            console.log('🗑️ Инвайт-ключ очищен из localStorage');
        } catch (error) {
            console.error('Ошибка очистки ключа:', error);
        }
    }
    
    /**
     * Получение информации о текущем ключе
     */
    getKeyInfo() {
        const storedKey = this.loadStoredKey();
        return {
            hasKey: !!storedKey,
            key: storedKey ? storedKey.slice(0, 5) + '...' : null,
            hwid: this.hwid ? this.hwid.slice(0, 8) + '...' : null
        };
    }
    
    /**
     * Полная проверка доступа с автоматическим запросом ключа
     */
    async ensureAccess() {
        try {
            console.log('🎫 Проверка доступа...');
            
            // Инициализируем систему если нужно
            if (!this.isInitialized) {
                await this.init();
            }
            
            // Проверяем текущий доступ
            const accessCheck = await this.checkAccess();
            
            if (accessCheck.hasAccess) {
                console.log('✅ Доступ подтвержден');
                return {
                    success: true,
                    hasAccess: true,
                    keyInfo: accessCheck.keyInfo
                };
            }
            
            // Если доступа нет, показываем диалог ввода ключа
            console.log('🎫 Требуется инвайт-ключ');
            const dialogResult = await this.showInviteDialog();
            
            if (dialogResult.success) {
                console.log('✅ Инвайт-ключ успешно активирован');
                return {
                    success: true,
                    hasAccess: true,
                    keyInfo: dialogResult.keyInfo,
                    newKey: true
                };
            } else {
                console.log('🚫 Пользователь отменил ввод ключа');
                return {
                    success: false,
                    hasAccess: false,
                    cancelled: dialogResult.cancelled
                };
            }
            
        } catch (error) {
            console.error('❌ Ошибка проверки доступа:', error);
            return {
                success: false,
                hasAccess: false,
                error: error.message
            };
        }
    }
}

// Создаем глобальный экземпляр для использования в браузере
if (typeof window !== 'undefined') {
    window.inviteSystem = new InviteSystemClient();
    console.log('🎫 Система инвайт-ключей загружена (Renderer)');
}

// Экспортируем для использования в модулях (если поддерживается)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = InviteSystemClient;
}
