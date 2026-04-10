const { contextBridge, ipcRenderer } = require('electron');

// Создаём безопасный API для renderer процесса
contextBridge.exposeInMainWorld('electronAPI', {
  // Общий метод для IPC вызовов
  invoke: (channel, ...args) => {
    // Белый список разрешенных каналов
    const allowedChannels = [
      'window:get-available', 'window:save-selection', 'window:get-last-selected', 'window:clear-cache',
      'auth:login', 'auth:register', 'auth:logout', 'auth:success',
      'tokens:getUser',
      'invite:get-hwid', 'invite:check-access', 'invite:validate-key', 'invite:get-key-info',
      'ocr:setup', 'ocr:save-regions', 'ocr:get-regions', 'ocr:analyze-profile',
      'monitor:start', 'monitor:stop', 'monitor:restart', 'monitor:get-status',
      'monitor:set-window-target', 'monitor:set-screen-target', 'monitor:get-capture-target',
      'streamer:get-result-config', 'streamer:save-result-trigger-area', 'streamer:save-result-data-area',
      'app:get-version', 'update:check-simple', 'server:get-current', 'server:switch',
      'store:get', 'store:set', 'store:has', 'store:delete',
      'cache:get-card-image', 'cache:force-update', 'cache:get-status'
    ];
    
    if (allowedChannels.includes(channel)) {
      return ipcRenderer.invoke(channel, ...args);
    } else {
      throw new Error(`IPC channel '${channel}' not allowed`);
    }
  },
  
  // Аутентификация
  auth: {
    login: (credentials) => ipcRenderer.invoke('auth:login', credentials),
    register: (userData) => ipcRenderer.invoke('auth:register', userData),
    logout: () => ipcRenderer.invoke('auth:logout'),
    success: () => ipcRenderer.invoke('auth:success')
  },

  // Токены
  tokens: {
    getUser: () => ipcRenderer.invoke('tokens:getUser')
  },

  // Система инвайт-ключей
  invite: {
    getHwid: () => ipcRenderer.invoke('invite:get-hwid'),
    checkAccess: () => ipcRenderer.invoke('invite:check-access'),
    validateKey: (key) => ipcRenderer.invoke('invite:validate-key', key),
    getKeyInfo: () => ipcRenderer.invoke('invite:get-key-info'),
    clearKey: () => ipcRenderer.invoke('invite:clear-key')
  },
  
  // OCR настройки
  ocr: {
    setupRegions: (context) => ipcRenderer.invoke('ocr:setup', context),
    saveRegions: (regions) => ipcRenderer.invoke('ocr:save-regions', regions),
    getRegions: () => ipcRenderer.invoke('ocr:get-regions'),
    analyzeProfile: (profileData) => ipcRenderer.invoke('ocr:analyze-profile', profileData)
  },
  
  // Мониторинг
  monitor: {
    start: () => ipcRenderer.invoke('monitor:start'),
    stop: () => ipcRenderer.invoke('monitor:stop'),
    restart: (reason) => ipcRenderer.invoke('monitor:restart', reason),
    getStatus: () => ipcRenderer.invoke('monitor:get-status'),
    // 🆕 Новые методы для управления целями захвата
    setWindowTarget: (windowInfo) => ipcRenderer.invoke('monitor:set-window-target', windowInfo),
    setScreenTarget: () => ipcRenderer.invoke('monitor:set-screen-target'),
    getCaptureTarget: () => ipcRenderer.invoke('monitor:get-capture-target')
  },

  streamerConfig: {
    getResultConfig: () => ipcRenderer.invoke('streamer:get-result-config'),
    saveResultTriggerArea: (area) => ipcRenderer.invoke('streamer:save-result-trigger-area', area),
    saveResultDataArea: (area) => ipcRenderer.invoke('streamer:save-result-data-area', area)
  },
  
  // Приложение
  app: {
      getVersion: () => ipcRenderer.invoke('app:get-version')
  },

  // 🚀 Улучшенная система автообновлений
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    install: (filePath) => ipcRenderer.invoke('update:install', filePath),
    checkSimple: () => ipcRenderer.invoke('update:check-simple'),
    openRelease: (url) => ipcRenderer.invoke('update:open-release', url),
    
    // Новые методы для расширенной системы
    download: (downloadType = 'installer') => ipcRenderer.invoke('update:download', downloadType),
    cancelDownload: () => ipcRenderer.invoke('update:cancel-download'),
    openDownloads: () => ipcRenderer.invoke('update:open-downloads'),
    getStatus: () => ipcRenderer.invoke('update:get-status')
  },

  // Настройки
  settings: {
      saveSearchMode: (mode) => ipcRenderer.invoke('settings:save-search-mode', mode),
      getSearchMode: () => ipcRenderer.invoke('settings:get-search-mode')
  },
  
  // 🌐 Управление серверами
  server: {
    getCurrent: () => ipcRenderer.invoke('server:get-current'),
    switch: (mode) => ipcRenderer.invoke('server:switch', mode),
    check: () => ipcRenderer.invoke('server:check')
  },
  
  // Виджет
  widget: {
    toggle: (playerData) => ipcRenderer.invoke('widget:toggle', playerData),
    close: () => ipcRenderer.invoke('widget:close'),
    setAlwaysOnTop: (flag) => ipcRenderer.invoke('widget:setAlwaysOnTop', flag),
    resize: (width, height) => ipcRenderer.invoke('widget:resize', width, height),
    move: (deltaX, deltaY) => ipcRenderer.invoke('widget:move', deltaX, deltaY)
  },
  
  // 🎯 Прямой доступ к хранилищу (для расширенных настроек)
  store: {
    get: (key, defaultValue) => ipcRenderer.invoke('store:get', key, defaultValue),
    set: (key, value) => ipcRenderer.invoke('store:set', key, value),
    has: (key) => ipcRenderer.invoke('store:has', key),
    delete: (key) => ipcRenderer.invoke('store:delete', key),
    getServerUrl: () => ipcRenderer.invoke('store:get', 'serverUrl')
  },
  
  // 🪟 Работа с окнами
  window: {
    getAvailable: (forceRefresh = false) => ipcRenderer.invoke('window:get-available', forceRefresh),
    saveSelection: (windowData) => ipcRenderer.invoke('window:save-selection', windowData),
    getLastSelected: () => ipcRenderer.invoke('window:get-last-selected'),
    clearCache: () => ipcRenderer.invoke('window:clear-cache')
  },

  // 🎴 Кеш изображений карт
  cache: {
    getCardImage: (cardName, level) => ipcRenderer.invoke('cache:get-card-image', cardName, level),
    forceUpdate: () => ipcRenderer.invoke('cache:force-update'),
    getStatus: () => ipcRenderer.invoke('cache:get-status')
  },

  // Слушатели событий
  on: (channel, callback) => {
    const validChannels = [
      'user-data',
      'screenshot',
      'python-status',
      'player-found',
      'ocr_reprocessed', // << --- ДОБАВЛЕН КАНАЛ ДЛЯ ПЕРЕОБРАБОТКИ --- >>
      'python-error',
      'python-stopped',
      'regions-updated',
      'player-data', // Для виджета
      'server-changed', // Изменение сервера
      'server-switching', // Процесс переключения
      'server-status', // Статус сервера
      
      // 🚀 Новые события обновлений
      'update-status', // Статус автообновлений
      'update-progress', // Прогресс загрузки
      'update-download-progress', // Прогресс скачивания
      'update-info-changed', // Изменение информации об обновлении
      'update-downloaded', // Обновление скачано
      'update-error' // Ошибка обновления
    ];
    
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (event, ...args) => callback(...args));
    }
  },
  
  // Удаление слушателей
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  }
});
