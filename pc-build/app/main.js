// ===================================================================
// НОВЫЙ МОДУЛЬНЫЙ MAIN.JS
// Использует созданную модульную архитектуру вместо монолитного кода
// ===================================================================

const { app, BrowserWindow, ipcMain, screen, desktopCapturer, Notification, dialog } = require('electron');
const path = require('path');

// 🎯 ИМПОРТИРУЕМ НАШИ МОДУЛИ
const AppManager = require('./modules/AppManager');
const UpdateManager = require('./modules/UpdateManager');

// ===================================================================
// ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ (минимум!)
// ===================================================================
let appManager = null;
let updateManager = null;

// ===================================================================
// ИНИЦИАЛИЗАЦИЯ ПРИЛОЖЕНИЯ
// ===================================================================

app.whenReady().then(async () => {
    console.log('🚀 === ЗАПУСК НОВОГО МОДУЛЬНОГО ПРИЛОЖЕНИЯ ===');
    
    try {
        // 1. Инициализация AppManager
        console.log('⚡ Инициализация модулей...');
        appManager = new AppManager();
        await appManager.initialize();
        
        // 2. Настройка событий AppManager
        appManager.setAppEventCallback((event, data) => {
            console.log(`🔔 App событие: ${event}`);
            
            if (event === 'auth_failure') {
                // Переходим на экран авторизации
                appManager.closeWindow('main');
                appManager.createWindow('auth');
            } else if (event === 'player_found') {
                // Передаем событие о найденном игроке в UI
                appManager.sendToWindow('main', 'player-found', data);
                
                // Автоматически открываем виджет
                // TODO: Проверить настройки автооткрытия
                appManager.createWindow('widget', data);
                
            } else if (event === 'ocr_reprocessed') {
                // Передаем событие о переобработке OCR в UI
                appManager.sendToWindow('main', 'ocr_reprocessed', data);
                
                // Обновляем виджет если открыт
                appManager.sendToWindow('widget', 'player-data', data.data);
                
            } else if (event === 'monitor_status') {
                // Передаем отфильтрованные статусы мониторинга в UI (без спама кадров)
                appManager.sendToWindow('main', 'python-status', data);
                
            } else if (event === 'monitor_error') {
                // Передаем ошибки мониторинга в UI
                appManager.sendToWindow('main', 'python-error', data);
                
            } else if (event === 'monitor_started') {
                appManager.sendToWindow('main', 'python-started');
                
            } else if (event === 'monitor_stopped') {
                appManager.sendToWindow('main', 'python-stopped');
            }
        });
        
        // 3. Полная инициализация при запуске
        console.log('🔍 Проверка состояния приложения...');
        const initResult = await appManager.initializeOnStartup();
        
        if (!initResult.success) {
            console.error('❌ Ошибка инициализации:', initResult.error);
            dialog.showErrorBox('Ошибка запуска', initResult.error);
            app.quit();
            return;
        }
        
        // 4. Определяем какое окно открыть
        if (initResult.requiresInvite) {
            console.log('🎫 Требуется инвайт-ключ');
            appManager.createWindow('auth'); // В auth.html есть логика инвайт-ключей
        } else if (initResult.authenticated) {
            console.log('✅ Пользователь авторизован, открываем главное окно');
            appManager.createWindow('main');
        } else {
            console.log('🔐 Требуется авторизация');
            appManager.createWindow('auth');
        }
        
        console.log('🎉 === ПРИЛОЖЕНИЕ УСПЕШНО ЗАПУЩЕНО ===');

        // 5. Инициализация системы автообновлений
        console.log('🔄 Инициализация системы обновлений...');
        updateManager = new UpdateManager();

        // Устанавливаем callback для событий обновления
        updateManager.setUpdateCallback((event, data) => {
            console.log(`🔔 Update событие: ${event}`, data);

            // Отправляем события в UI если нужно
            if (appManager) {
                appManager.sendToWindow('main', 'update-event', { event, data });
            }
        });

        // Запускаем автопроверку обновлений (каждые 4 часа)
        updateManager.startAutoCheck(240);
        console.log('✅ Система обновлений инициализирована');

    } catch (error) {
        console.error('💥 Критическая ошибка запуска:', error);
        dialog.showErrorBox('Критическая ошибка', error.message);
        app.quit();
    }
});

// ===================================================================
// СОБЫТИЯ ПРИЛОЖЕНИЯ
// ===================================================================

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        if (appManager && appManager.isAuthenticated()) {
            appManager.createWindow('main');
        } else {
            appManager.createWindow('auth');
        }
    }
});

app.on('before-quit', async () => {
    console.log('👋 Завершение работы приложения...');

    if (updateManager) {
        updateManager.stopAutoCheck();
    }

    if (appManager) {
        await appManager.cleanup();
    }
});

// ===================================================================
// ОБРАБОТКА ОШИБОК
// ===================================================================

process.on('uncaughtException', (error) => {
    console.error('💥 Необработанная ошибка:', error);
    dialog.showErrorBox('Неожиданная ошибка', error.message);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Необработанный отказ промиса:', reason);
});// Test change Fri Jan  9 21:42:42 UTC 2026
