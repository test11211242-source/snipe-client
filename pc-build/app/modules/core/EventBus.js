/**
 * EventBus - Централизованная система событий для слабой связанности модулей
 */
class EventBus {
    constructor() {
        this.events = new Map();
        this.onceEvents = new Map();
        this.maxListeners = 100; // Предотвращение утечек памяти
        this.debugMode = false;
        
        console.log('📡 EventBus инициализирован');
    }

    // === Регистрация обработчика события ===
    
    on(event, handler, context = null) {
        if (typeof event !== 'string') {
            throw new Error('Название события должно быть строкой');
        }
        
        if (typeof handler !== 'function') {
            throw new Error('Обработчик должен быть функцией');
        }

        // Создаем карту для события если её нет
        if (!this.events.has(event)) {
            this.events.set(event, []);
        }

        const handlers = this.events.get(event);
        
        // Проверяем лимит обработчиков
        if (handlers.length >= this.maxListeners) {
            console.warn(`⚠️ EventBus: Превышен лимит обработчиков для события "${event}" (${this.maxListeners})`);
        }

        // Добавляем обработчик с контекстом
        const handlerInfo = {
            handler,
            context,
            id: this.generateHandlerId()
        };
        
        handlers.push(handlerInfo);

        if (this.debugMode) {
            console.log(`📝 EventBus: Зарегистрирован обработчик для "${event}" (ID: ${handlerInfo.id})`);
        }

        // Возвращаем ID для возможности удаления
        return handlerInfo.id;
    }

    // === Регистрация одноразового обработчика ===
    
    once(event, handler, context = null) {
        const handlerId = this.on(event, (...args) => {
            // Удаляем обработчик после первого вызова
            this.off(event, handlerId);
            
            // Вызываем оригинальный обработчик
            if (context) {
                handler.call(context, ...args);
            } else {
                handler(...args);
            }
        }, context);

        if (this.debugMode) {
            console.log(`🔂 EventBus: Зарегистрирован одноразовый обработчик для "${event}"`);
        }

        return handlerId;
    }

    // === Удаление обработчика ===
    
    off(event, handlerOrId) {
        if (!this.events.has(event)) {
            return false;
        }

        const handlers = this.events.get(event);
        let removedCount = 0;

        if (typeof handlerOrId === 'string') {
            // Удаление по ID
            const index = handlers.findIndex(h => h.id === handlerOrId);
            if (index !== -1) {
                handlers.splice(index, 1);
                removedCount = 1;
            }
        } else if (typeof handlerOrId === 'function') {
            // Удаление по функции
            for (let i = handlers.length - 1; i >= 0; i--) {
                if (handlers[i].handler === handlerOrId) {
                    handlers.splice(i, 1);
                    removedCount++;
                }
            }
        } else if (handlerOrId === undefined) {
            // Удаление всех обработчиков события
            removedCount = handlers.length;
            handlers.length = 0;
        }

        // Удаляем событие если нет обработчиков
        if (handlers.length === 0) {
            this.events.delete(event);
        }

        if (this.debugMode && removedCount > 0) {
            console.log(`🗑️ EventBus: Удалено ${removedCount} обработчик(ов) для "${event}"`);
        }

        return removedCount > 0;
    }

    // === Эмиссия события ===
    
    emit(event, ...args) {
        const startTime = this.debugMode ? Date.now() : null;
        
        if (!this.events.has(event)) {
            if (this.debugMode) {
                console.log(`📢 EventBus: Событие "${event}" эмитировано, но нет обработчиков`);
            }
            return 0;
        }

        const handlers = this.events.get(event);
        let executedCount = 0;
        const errors = [];

        // Создаем копию массива для избежания проблем с изменением во время итерации
        const handlersCopy = [...handlers];

        handlersCopy.forEach((handlerInfo) => {
            try {
                if (handlerInfo.context) {
                    handlerInfo.handler.call(handlerInfo.context, ...args);
                } else {
                    handlerInfo.handler(...args);
                }
                executedCount++;
            } catch (error) {
                console.error(`❌ EventBus: Ошибка в обработчике события "${event}":`, error);
                errors.push({
                    handlerId: handlerInfo.id,
                    error: error
                });
            }
        });

        if (this.debugMode) {
            const duration = Date.now() - startTime;
            console.log(`📢 EventBus: Событие "${event}" обработано ${executedCount} обработчиками за ${duration}мс`);
            
            if (errors.length > 0) {
                console.warn(`⚠️ EventBus: ${errors.length} ошибок при обработке события "${event}"`);
            }
        }

        return executedCount;
    }

    // === Асинхронная эмиссия события ===
    
    async emitAsync(event, ...args) {
        if (!this.events.has(event)) {
            return 0;
        }

        const handlers = this.events.get(event);
        let executedCount = 0;
        const promises = [];

        handlers.forEach((handlerInfo) => {
            try {
                let result;
                if (handlerInfo.context) {
                    result = handlerInfo.handler.call(handlerInfo.context, ...args);
                } else {
                    result = handlerInfo.handler(...args);
                }

                // Если результат - промис, добавляем в массив
                if (result && typeof result.then === 'function') {
                    promises.push(result.catch(error => {
                        console.error(`❌ EventBus: Ошибка в асинхронном обработчике события "${event}":`, error);
                        return { error, handlerId: handlerInfo.id };
                    }));
                }

                executedCount++;
            } catch (error) {
                console.error(`❌ EventBus: Ошибка в обработчике события "${event}":`, error);
            }
        });

        // Ждем завершения всех асинхронных обработчиков
        if (promises.length > 0) {
            await Promise.all(promises);
        }

        if (this.debugMode) {
            console.log(`📢 EventBus: Асинхронное событие "${event}" обработано ${executedCount} обработчиками`);
        }

        return executedCount;
    }

    // === Проверка наличия обработчиков ===
    
    hasListeners(event) {
        return this.events.has(event) && this.events.get(event).length > 0;
    }

    // === Получение количества обработчиков ===
    
    listenerCount(event) {
        return this.events.has(event) ? this.events.get(event).length : 0;
    }

    // === Получение списка всех событий ===
    
    eventNames() {
        return Array.from(this.events.keys());
    }

    // === Очистка всех обработчиков ===
    
    removeAllListeners(event = null) {
        if (event) {
            // Очистка конкретного события
            if (this.events.has(event)) {
                this.events.delete(event);
                console.log(`🧹 EventBus: Все обработчики события "${event}" удалены`);
            }
        } else {
            // Очистка всех событий
            const eventCount = this.events.size;
            this.events.clear();
            console.log(`🧹 EventBus: Все обработчики удалены (было ${eventCount} событий)`);
        }
    }

    // === Управление режимом отладки ===
    
    setDebugMode(enabled) {
        this.debugMode = enabled;
        console.log(`🐛 EventBus: Режим отладки ${enabled ? 'включен' : 'отключен'}`);
    }

    // === Установка лимита обработчиков ===
    
    setMaxListeners(max) {
        if (typeof max !== 'number' || max < 0) {
            throw new Error('Максимальное количество обработчиков должно быть неотрицательным числом');
        }
        
        this.maxListeners = max;
        console.log(`⚙️ EventBus: Установлен лимит обработчиков: ${max}`);
    }

    // === Генерация уникального ID ===
    
    generateHandlerId() {
        return `handler_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    // === Получение отладочной информации ===
    
    getDebugInfo() {
        const info = {
            totalEvents: this.events.size,
            totalHandlers: 0,
            events: {},
            maxListeners: this.maxListeners,
            debugMode: this.debugMode
        };

        this.events.forEach((handlers, event) => {
            info.events[event] = handlers.length;
            info.totalHandlers += handlers.length;
        });

        return info;
    }

    // === Создание неймспейса событий ===
    
    namespace(prefix) {
        return {
            emit: (event, ...args) => this.emit(`${prefix}:${event}`, ...args),
            emitAsync: (event, ...args) => this.emitAsync(`${prefix}:${event}`, ...args),
            on: (event, handler, context) => this.on(`${prefix}:${event}`, handler, context),
            once: (event, handler, context) => this.once(`${prefix}:${event}`, handler, context),
            off: (event, handlerOrId) => this.off(`${prefix}:${event}`, handlerOrId),
            hasListeners: (event) => this.hasListeners(`${prefix}:${event}`),
            listenerCount: (event) => this.listenerCount(`${prefix}:${event}`)
        };
    }

    // === Middleware для обработки событий ===
    
    addMiddleware(middleware) {
        if (typeof middleware !== 'function') {
            throw new Error('Middleware должен быть функцией');
        }
        
        // TODO: Реализация middleware при необходимости
        console.log('🔧 EventBus: Middleware функциональность будет добавлена в будущем');
    }

    // === Статистика использования ===
    
    getStats() {
        const stats = {
            eventsCount: this.events.size,
            totalHandlers: 0,
            topEvents: []
        };

        const eventStats = [];
        
        this.events.forEach((handlers, event) => {
            const count = handlers.length;
            stats.totalHandlers += count;
            eventStats.push({ event, count });
        });

        // Сортируем события по количеству обработчиков
        stats.topEvents = eventStats
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);

        return stats;
    }
}

// Экспортируем класс и создаем глобальный экземпляр
const globalEventBus = new EventBus();

module.exports = EventBus;
module.exports.global = globalEventBus;