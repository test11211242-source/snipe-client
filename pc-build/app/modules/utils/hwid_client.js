// electron-client/python_scripts/hwid_client.js - Клиентская система HWID
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');

class HWIDClient {
    /**
     * Получает HWID текущей системы (клиентская версия)
     * Должен генерировать тот же HWID что и серверная версия
     */
    static getSystemHWID() {
        try {
            const components = [];
            
            // 1. Процессор
            try {
                if (process.platform === 'win32') {
                    // Windows: получаем ProcessorId через WMI
                    try {
                        const result = execSync('wmic cpu get ProcessorId /value', { 
                            encoding: 'utf8', 
                            timeout: 10000 
                        });
                        
                        const lines = result.split('\n');
                        for (const line of lines) {
                            if (line.includes('ProcessorId=')) {
                                const cpuId = line.split('=')[1].trim();
                                if (cpuId && cpuId !== '') {
                                    components.push(`CPU:${cpuId}`);
                                    break;
                                }
                            }
                        }
                    } catch (e) {
                        // Fallback: используем тип процессора
                        const cpuModel = os.cpus()[0].model;
                        if (cpuModel) {
                            components.push(`CPU:${cpuModel}`);
                        }
                    }
                } else {
                    // Linux/Mac: используем модель процессора
                    const cpuModel = os.cpus()[0].model;
                    if (cpuModel) {
                        components.push(`CPU:${cpuModel}`);
                    }
                }
            } catch (e) {
                console.warn('Не удалось получить CPU ID:', e.message);
            }
            
            // 2. Материнская плата
            try {
                if (process.platform === 'win32') {
                    try {
                        const result = execSync('wmic baseboard get SerialNumber /value', { 
                            encoding: 'utf8', 
                            timeout: 10000 
                        });
                        
                        const lines = result.split('\n');
                        for (const line of lines) {
                            if (line.includes('SerialNumber=')) {
                                const mbSerial = line.split('=')[1].trim();
                                if (mbSerial && mbSerial !== '' && 
                                    !['to be filled by o.e.m.', 'default string'].includes(mbSerial.toLowerCase())) {
                                    components.push(`MB:${mbSerial}`);
                                    break;
                                }
                            }
                        }
                    } catch (e) {
                        console.warn('Не удалось получить MB serial:', e.message);
                    }
                } else {
                    // Linux: пытаемся прочитать DMI
                    try {
                        const fs = require('fs');
                        const mbSerial = fs.readFileSync('/sys/class/dmi/id/board_serial', 'utf8').trim();
                        if (mbSerial && mbSerial !== '') {
                            components.push(`MB:${mbSerial}`);
                        }
                    } catch (e) {
                        // Игнорируем ошибку
                    }
                }
            } catch (e) {
                console.warn('Не удалось получить MB serial:', e.message);
            }
            
            // 3. Жесткий диск
            try {
                if (process.platform === 'win32') {
                    try {
                        const result = execSync('wmic diskdrive get SerialNumber /value', { 
                            encoding: 'utf8', 
                            timeout: 10000 
                        });
                        
                        const lines = result.split('\n');
                        for (const line of lines) {
                            if (line.includes('SerialNumber=')) {
                                const diskSerial = line.split('=')[1].trim();
                                if (diskSerial && diskSerial !== '') {
                                    components.push(`DISK:${diskSerial}`);
                                    break;
                                }
                            }
                        }
                    } catch (e) {
                        console.warn('Не удалось получить disk serial:', e.message);
                    }
                } else {
                    // Linux/Mac: используем информацию о корневом разделе
                    try {
                        const rootDevice = execSync('df / | tail -1 | awk \'{print $1}\'', { 
                            encoding: 'utf8' 
                        }).trim();
                        if (rootDevice) {
                            components.push(`DISK:${rootDevice}`);
                        }
                    } catch (e) {
                        // Игнорируем ошибку
                    }
                }
            } catch (e) {
                console.warn('Не удалось получить disk serial:', e.message);
            }
            
            // 4. MAC адрес
            try {
                const networkInterfaces = os.networkInterfaces();
                let macAddress = null;
                
                // Ищем первый не-виртуальный интерфейс
                for (const [name, interfaces] of Object.entries(networkInterfaces)) {
                    if (name.toLowerCase().includes('ethernet') || 
                        name.toLowerCase().includes('wi-fi') ||
                        name.toLowerCase().includes('wlan') ||
                        name.toLowerCase().includes('en')) {
                        
                        for (const iface of interfaces) {
                            if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
                                macAddress = iface.mac;
                                break;
                            }
                        }
                        if (macAddress) break;
                    }
                }
                
                // Если не нашли, берем любой доступный MAC
                if (!macAddress) {
                    for (const interfaces of Object.values(networkInterfaces)) {
                        for (const iface of interfaces) {
                            if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
                                macAddress = iface.mac;
                                break;
                            }
                        }
                        if (macAddress) break;
                    }
                }
                
                if (macAddress) {
                    components.push(`MAC:${macAddress}`);
                }
            } catch (e) {
                console.warn('Не удалось получить MAC адрес:', e.message);
            }
            
            // 5. Информация о системе
            try {
                const systemInfo = `${os.platform()}:${os.arch()}:${os.release()}`;
                components.push(`SYS:${systemInfo}`);
            } catch (e) {
                console.warn('Не удалось получить system info:', e.message);
            }
            
            // 6. Резервный метод
            if (components.length < 2) {
                try {
                    const hostname = os.hostname();
                    const username = os.userInfo().username;
                    components.push(`HOST:${hostname}:${username}`);
                } catch (e) {
                    // Последний резерв
                    const randomUUID = crypto.randomUUID();
                    components.push(`UUID:${randomUUID}`);
                }
            }
            
            // Создаем финальный HWID
            if (components.length === 0) {
                console.warn('⚠️ Не удалось получить никакие компоненты HWID, создаем случайный');
                components.push(`RANDOM:${crypto.randomUUID()}`);
            }
            
            // Объединяем компоненты и хешируем (аналогично серверной версии)
            const hwidString = components.sort().join('|');
            const hwidHash = crypto.createHash('sha256').update(hwidString, 'utf8').digest('hex');
            
            console.log(`ПОЛНЫЙ HWID: ${hwidHash}`);
            console.log('HWID компоненты:', components);
            
            return hwidHash;
            
        } catch (error) {
            console.error('❌ Критическая ошибка генерации HWID:', error);
            // Fallback HWID
            const fallbackHWID = crypto.createHash('sha256').update(crypto.randomUUID(), 'utf8').digest('hex');
            console.warn(`⚠️ Используется fallback HWID: ${fallbackHWID.slice(0, 16)}...`);
            return fallbackHWID;
        }
    }
    
    /**
     * Получает подробную информацию о системе
     */
    static getHWIDInfo() {
        try {
            const info = {
                hwid: this.getSystemHWID(),
                platform: os.platform(),
                arch: os.arch(),
                release: os.release(),
                hostname: os.hostname(),
                username: os.userInfo().username,
                cpus: os.cpus().length,
                memory: os.totalmem(),
                timestamp: new Date().toISOString()
            };
            
            // Дополнительная информация о системе
            try {
                info.cpu_model = os.cpus()[0].model;
                info.uptime = os.uptime();
                info.load_avg = os.loadavg();
            } catch (e) {
                // Игнорируем ошибки дополнительной информации
            }
            
            return info;
            
        } catch (error) {
            console.error('❌ Ошибка получения HWID info:', error);
            return {
                hwid: this.getSystemHWID(),
                error: error.message,
                timestamp: new Date().toISOString()
            };
        }
    }
    
    /**
     * Проверяет формат HWID
     */
    static validateHWID(hwid) {
        if (!hwid || hwid.length !== 64) {
            return false;
        }
        
        // Проверяем, что это валидный hex
        return /^[a-fA-F0-9]{64}$/.test(hwid);
    }
    
    /**
     * Сравнивает два HWID
     */
    static compareHWID(hwid1, hwid2) {
        if (!hwid1 || !hwid2) {
            return false;
        }
        return hwid1.toLowerCase() === hwid2.toLowerCase();
    }
    
    /**
     * Получает короткую версию HWID для отображения
     */
    static getHWIDShort(hwid) {
        if (!hwid || hwid.length < 8) {
            return 'INVALID';
        }
        return `${hwid.slice(0, 8)}...${hwid.slice(-4)}`;
    }
}

// Экспортируем класс и функции для удобства
module.exports = HWIDClient;

// Для тестирования (если запускается напрямую)
if (require.main === module) {
    console.log('🔐 Тестирование HWID Client...');
    
    const hwid = HWIDClient.getSystemHWID();
    console.log('HWID:', hwid);
    console.log('HWID Short:', HWIDClient.getHWIDShort(hwid));
    console.log('HWID Valid:', HWIDClient.validateHWID(hwid));
    
    const info = HWIDClient.getHWIDInfo();
    console.log('System Info:', JSON.stringify(info, null, 2));
}
