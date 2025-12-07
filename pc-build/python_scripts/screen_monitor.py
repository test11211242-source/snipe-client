#!/usr/bin/env python3
"""
Universal Screen Monitor with Personal Trigger Profiles
Универсальный монитор экрана с персональными профилями триггеров

Новая архитектура для отслеживания множественных визуальных событий
с использованием двухуровневой проверки (цвет + структура).
"""

import sys
import json
import time
import base64
import argparse
from io import BytesIO
from datetime import datetime

import numpy as np
import cv2
import windows_capture
from PIL import Image


class TriggerProfile:
    """
    Профиль триггера - содержит всю информацию для обнаружения визуального события
    """
    
    def __init__(self, config):
        """
        Инициализация профиля из конфигурационного словаря
        
        Args:
            config (dict): Конфигурация профиля с полями:
                - id: уникальный идентификатор
                - monitor_region: область мониторинга {x, y, width, height}
                - color_palette: доминирующие цвета [[B, G, R], ...]
                - template_base64: эталонный скриншот в base64
                - cooldown: время перезарядки в секундах
                - confirmations_needed: количество подтверждений
        """
        # Основные параметры профиля
        self.id = config['id']
        self.monitor_region = config['monitor_region']
        self.color_palette = config['color_palette']
        self.cooldown = config['cooldown']
        self.confirmations_needed = config['confirmations_needed']
        
        # Внутренние счетчики состояния
        self.current_confirmations = 0
        self.last_triggered_time = 0
        
        # Дескрипторы эталонного изображения
        self.template_keypoints = None
        self.template_descriptors = None
        
        # 🆕 Параметры действий (с обратной совместимостью)
        self.action_type = config.get('action_type', 'capture_and_send')
        self.data_capture_region = config.get('data_capture_region')
        self.capture_delay = config.get('capture_delay', 0)
        
        # 🖼️ Настройка скрытия рамки захвата
        self.hide_capture_border = config.get('hideCaptureBorder', False)
        
        # Инициализируем эталонное изображение (только если не пустое)
        if 'template_base64' in config and config['template_base64'].strip():
            self._initialize_template(config['template_base64'])
        else:
            print(f"Template for {self.id} is empty - features matching will be skipped")
    
    def _initialize_template(self, b64_string):
        """
        Декодирование base64 изображения и вычисление ORB дескрипторов
        
        Args:
            b64_string (str): Эталонное изображение в формате base64
        """
        try:
            # Декодируем base64 в байты
            image_bytes = base64.b64decode(b64_string)
            
            # Преобразуем байты в numpy массив
            image_array = np.frombuffer(image_bytes, dtype=np.uint8)
            
            # Декодируем в изображение OpenCV
            template_image = cv2.imdecode(image_array, cv2.IMREAD_COLOR)
            
            if template_image is None:
                print(f"ERROR: Failed to decode template for trigger {self.id}", file=sys.stderr)
                return
            
            # Конвертируем в серый для ORB
            template_gray = cv2.cvtColor(template_image, cv2.COLOR_BGR2GRAY)
            
            # Создаем ORB детектор и вычисляем дескрипторы
            orb = cv2.ORB_create(nfeatures=500)
            self.template_keypoints, self.template_descriptors = orb.detectAndCompute(template_gray, None)
            
            if self.template_descriptors is not None:
                print(f"Template initialized for {self.id}: {len(self.template_keypoints)} keypoints")
            else:
                print(f"WARNING: No keypoints found in template for {self.id}", file=sys.stderr)
                
        except Exception as e:
            print(f"ERROR: Failed to initialize template for {self.id}: {str(e)}", file=sys.stderr)


class ScreenMonitor:
    """
    Основной класс монитора экрана с поддержкой множественных триггеров
    """
    
    def __init__(self, target_type, target_id, profiles_config, target_fps=10):
        """
        Инициализация монитора экрана
        
        Args:
            target_type (str): Тип цели - 'window' или 'screen'
            target_id (str): ID цели - имя окна или индекс монитора
            profiles_config (list): Список конфигураций профилей триггеров
            target_fps (int): Целевая частота кадров (по умолчанию 10 FPS)
        """
        # Инициализируем компоненты OpenCV
        self.orb = cv2.ORB_create(nfeatures=500)
        self.matcher = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
        
        # Создаем профили триггеров
        self.triggers = [TriggerProfile(profile) for profile in profiles_config]
        print(f"Loaded {len(self.triggers)} trigger profiles")
        
        # 🖼️ Читаем настройку скрытия рамки из первого профиля (глобальная настройка)
        self.hide_capture_border = profiles_config[0].get('hideCaptureBorder', False) if profiles_config else False
        
        # Настройка ограничения частоты кадров
        self.target_fps = target_fps
        self.frame_interval = 1.0 / target_fps if target_fps > 0 else 0
        self.last_processed_time = 0
        print(f"Frame rate limited to {target_fps} FPS (interval: {self.frame_interval:.3f}s)")
        
        # Инициализируем захватчик экрана/окна напрямую в конструкторе
        # last_frame больше не нужен - вся обработка в _on_frame_arrived
        self.capturer = self._create_capturer(target_type, target_id)
        
        # ИСПРАВЛЕНИЕ: Не устанавливаем handlers в конструкторе
        # Они будут установлены непосредственно перед start() в run()
        
        # 🆕 Список для отложенных действий (pending actions)
        self.pending_actions = []
        
        # 🆕 Параметры для интеграции с сервером (опционально)
        self.server_url = None
        self.token = None
    
    def _on_frame_arrived(self, frame, capture_control):
        """Callback метод для получения кадров от windows-capture с ограничением FPS"""
        
        # Проверка ограничения частоты кадров
        current_time = time.time()
        if current_time - self.last_processed_time < self.frame_interval:
            return  # Пропускаем кадр для снижения нагрузки
        
        self.last_processed_time = current_time
        
        # Отладочная информация только для первых кадров
        if not hasattr(self, '_frame_count'):
            self._frame_count = 0
        self._frame_count += 1
        
        # ИСПРАВЛЕНИЕ GPT: Получаем полный кадр как numpy массив
        full_img = frame.frame_buffer
        
        # ИСПРАВЛЕНИЕ: Вся логика обработки триггеров теперь здесь
        
        # Проверяем каждый триггер
        for trigger in self.triggers:
            # Проверяем cooldown
            if current_time - trigger.last_triggered_time < trigger.cooldown:
                continue
            
            # ИСПРАВЛЕНИЕ GPT: Прямая обрезка numpy массива вместо frame.crop()
            region = trigger.monitor_region
            x, y, w, h = region['x'], region['y'], region['width'], region['height']
            roi = full_img[y:y+h, x:x+w]  # Обрезаем напрямую numpy массив
            
            
            # Безопасная проверка размера
            try:
                if roi.size == 0:
                    continue
            except Exception as e:
                print(f"ERROR:Trigger {trigger.id} - ROI size check error: {e}", file=sys.stderr)
                continue
            
            # Этап 1: Быстрая проверка цветовой палитры
            current_palette = self.get_dominant_colors(roi)
            palette_match = self.compare_palettes(current_palette, trigger.color_palette)
            
            if not palette_match:
                # Сбрасываем счетчик если цвета не совпали
                trigger.current_confirmations = 0
                continue
            
            
            # Этап 2: Глубокая проверка структуры (только если есть template)
            if trigger.template_descriptors is not None:
                features_match = self.check_features(roi, trigger)
                if not features_match:
                    # Сбрасываем счетчик если структура не совпала
                    trigger.current_confirmations = 0
                    continue
            
            # Обе проверки прошли успешно
            trigger.current_confirmations += 1
            
            # Проверяем достаточно ли подтверждений
            if trigger.current_confirmations >= trigger.confirmations_needed:
                # Триггер сработал!
                print(f'TRIGGER_FIRED:{json.dumps({"id": trigger.id})}', flush=True)
                
                # Выполняем связанное с ним действие (с учетом задержки)
                if trigger.capture_delay > 0:
                    # СРАЗУ выводим сообщение об ожидании при обнаружении триггера
                    print(f"STATUS:Ожидание {trigger.capture_delay}с для загрузки полных данных...", flush=True)
                    
                    # Добавляем в очередь отложенных действий
                    ready_time = current_time + trigger.capture_delay
                    self.pending_actions.append({
                        "trigger": trigger,
                        "ready_time": ready_time
                    })
                else:
                    # Выполняем сразу
                    self._perform_capture(trigger, frame)
                
                # Обновляем состояние триггера
                trigger.last_triggered_time = current_time
                trigger.current_confirmations = 0
        
        # 🆕 Проверяем и выполняем отложенные действия
        for action in list(self.pending_actions):  # копия списка для безопасного удаления
            if current_time >= action["ready_time"]:
                # Время пришло - выполняем захват с текущего кадра
                self._perform_capture(action["trigger"], frame)
                self.pending_actions.remove(action)
    
    def _on_closed(self):
        """Callback метод при закрытии захвата"""
        print("Capture session closed")
    
    def _setup_event_handlers(self):
        """Настройка event handlers для windows-capture с правильными декораторами"""
        # ИСПРАВЛЕНИЕ: Используем правильный способ регистрации согласно официальной документации
        @self.capturer.event
        def on_frame_arrived(frame, capture_control):
            """Callback для получения кадров от windows-capture"""
            self._on_frame_arrived(frame, capture_control)
        
        @self.capturer.event  
        def on_closed():
            """Callback при закрытии захвата"""
            self._on_closed()
            
        print("STATUS:Event handlers configured successfully")
    
    def _create_capturer(self, target_type, target_id):
        """
        Создание захватчика экрана или окна с назначением декораторов
        
        Args:
            target_type (str): 'window' или 'screen'
            target_id (str): имя окна или индекс монитора
            
        Returns:
            WindowsCapture: Настроенный объект захвата
        """
        try:
            if target_type == 'window':
                # 🆕 ЭТАП 1.3: Проверяем существование окна перед созданием capturer
                if not self._validate_window_exists(target_id):
                    print(f"ERROR:Target window '{target_id}' not found or unavailable", file=sys.stderr)
                    print(f"STATUS:Available windows: {self._get_available_windows()}", file=sys.stderr)
                    sys.exit(1)  # 🆕 КРИТИЧНО: Чистое завершение, НЕ fallback!
                
                # 🖼️ Используем настройку пользователя для скрытия рамки
                if self.hide_capture_border:
                    capturer = windows_capture.WindowsCapture(window_name=target_id, draw_border=False)
                    print(f"Initialized window capture for: {target_id} (border hidden)")
                else:
                    capturer = windows_capture.WindowsCapture(window_name=target_id)
                    print(f"Initialized window capture for: {target_id} (border visible)")
            else:  # 'screen'
                monitor_index = int(target_id) + 1  # windows-capture использует 1-based индексы
                # 🖼️ Используем настройку пользователя для скрытия рамки
                if self.hide_capture_border:
                    capturer = windows_capture.WindowsCapture(monitor_index=monitor_index, draw_border=False)
                    print(f"Initialized screen capture for monitor: {monitor_index} (border hidden)")
                else:
                    capturer = windows_capture.WindowsCapture(monitor_index=monitor_index)
                    print(f"Initialized screen capture for monitor: {monitor_index} (border visible)")
            
            # Callback handlers будут назначены в _setup_event_handlers()
            
            return capturer
            
        except Exception as e:
            print(f"ERROR: Failed to create capturer: {str(e)}", file=sys.stderr)
            sys.exit(1)  # 🆕 КРИТИЧНО: Чистое завершение, НЕ fallback!
    
    def get_dominant_colors(self, image, k=3):
        """
        Извлечение доминирующих цветов изображения с помощью k-means
        
        Args:
            image (np.ndarray): Входное изображение
            k (int): Количество цветов для извлечения
            
        Returns:
            list: Список доминирующих цветов [[B, G, R], ...]
        """
        try:
            # ИСПРАВЛЕНИЕ: Конвертируем BGRA в BGR если необходимо
            if len(image.shape) == 3 and image.shape[2] == 4:
                # У нас BGRA, берем только первые 3 канала (BGR)
                image = image[:, :, :3]
            elif len(image.shape) == 3 and image.shape[2] != 3:
                print(f"WARNING: Unexpected image format with {image.shape[2]} channels", file=sys.stderr)
                return []
            
            # Преобразуем изображение в одномерный массив пикселей
            data = image.reshape((-1, 3))
            data = np.float32(data)
            
            # Применяем k-means кластеризацию
            criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 20, 1.0)
            _, labels, centers = cv2.kmeans(data, k, None, criteria, 10, cv2.KMEANS_RANDOM_CENTERS)
            
            # Конвертируем центры обратно в uint8 и возвращаем как список
            centers = np.uint8(centers)
            return centers.tolist()
            
        except Exception as e:
            print(f"ERROR in get_dominant_colors: {str(e)}", file=sys.stderr)
            return []
    
    def compare_palettes(self, palette1, palette2, tolerance=50):
        """
        Сравнение двух цветовых палитр с заданной толерантностью
        
        Args:
            palette1 (list): Первая палитра [[B, G, R], ...]
            palette2 (list): Вторая палитра [[B, G, R], ...]
            tolerance (int): Допустимое отклонение по каждому каналу
            
        Returns:
            bool: True если палитры схожи
        """
        try:
            if not palette1 or not palette2:
                return False
            
            # Для каждого цвета в первой палитре ищем близкий во второй
            for color1 in palette1:
                found_match = False
                for color2 in palette2:
                    # Вычисляем евклидово расстояние между цветами
                    distance = np.sqrt(sum([(c1 - c2) ** 2 for c1, c2 in zip(color1, color2)]))
                    if distance <= tolerance:
                        found_match = True
                        break
                
                if not found_match:
                    return False
            
            return True
            
        except Exception as e:
            print(f"ERROR in compare_palettes: {str(e)}", file=sys.stderr)
            return False
    
    def _validate_window_exists(self, window_name):
        """
        🆕 ЭТАП 1.3: Проверка существования целевого окна
        
        Args:
            window_name (str): Название окна для поиска
            
        Returns:
            bool: True если окно найдено и доступно
        """
        try:
            import win32gui
            import win32con
            
            def enum_windows_proc(hwnd, lParam):
                if win32gui.IsWindowVisible(hwnd):
                    window_text = win32gui.GetWindowText(hwnd)
                    if window_text and window_name.lower() in window_text.lower():
                        lParam.append((hwnd, window_text))
                return True
            
            windows = []
            win32gui.EnumWindows(enum_windows_proc, windows)
            
            if windows:
                print(f"Found {len(windows)} matching windows for '{window_name}'")
                for hwnd, title in windows:
                    print(f"  - {title} (HWND: {hwnd})")
                return True
            else:
                print(f"No windows found matching '{window_name}'")
                return False
                
        except ImportError:
            print("WARNING: win32gui not available, skipping window validation", file=sys.stderr)
            return True  # Предполагаем, что окно существует
        except Exception as e:
            print(f"ERROR: Window validation failed: {str(e)}", file=sys.stderr)
            return False
    
    def _get_available_windows(self):
        """
        🆕 ЭТАП 1.3: Получение списка доступных окон для отладки
        
        Returns:
            list: Список названий доступных окон
        """
        try:
            import win32gui
            
            def enum_windows_proc(hwnd, windows_list):
                if win32gui.IsWindowVisible(hwnd):
                    window_text = win32gui.GetWindowText(hwnd)
                    if window_text and window_text.strip():
                        windows_list.append(window_text)
                return True
            
            windows = []
            win32gui.EnumWindows(enum_windows_proc, windows)
            return windows[:10]  # Возвращаем первые 10 окон
            
        except ImportError:
            return ["win32gui not available"]
        except Exception as e:
            return [f"Error: {str(e)}"]
    
    def check_features(self, image, trigger_profile):
        """
        Проверка структурного сходства изображения с эталоном через ORB features
        
        Args:
            image (np.ndarray): Текущий кадр для анализа
            trigger_profile (TriggerProfile): Профиль с эталонными дескрипторами
            
        Returns:
            bool: True если найдено достаточно совпадений
        """
        try:
            if trigger_profile.template_descriptors is None:
                return False
            
            # Конвертируем в серый
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
            
            # Вычисляем дескрипторы текущего кадра
            keypoints, descriptors = self.orb.detectAndCompute(gray, None)
            
            if descriptors is None or len(descriptors) < 10:
                return False
            
            # Сопоставляем дескрипторы
            matches = self.matcher.match(trigger_profile.template_descriptors, descriptors)
            
            if len(matches) < 15:  # Минимум совпадений
                return False
            
            # Проверяем качество лучших совпадений
            matches = sorted(matches, key=lambda x: x.distance)
            good_matches = matches[:20]
            
            distance_threshold = 50
            good_match_count = sum(1 for match in good_matches if match.distance < distance_threshold)
            
            return good_match_count >= 12
            
        except Exception as e:
            print(f"ERROR in check_features: {str(e)}", file=sys.stderr)
            return False
    
    def _perform_capture(self, trigger, frame):
        """
        Выполняет захват данных для указанного триггера с текущего кадра
        
        Args:
            trigger (TriggerProfile): Профиль триггера для захвата
            frame: Объект кадра от windows-capture
        """
        try:
            if not trigger.data_capture_region:
                print(f"ERROR: No data_capture_region defined for {trigger.id}", file=sys.stderr)
                return
            
            # Получаем область данных из текущего кадра
            region = trigger.data_capture_region
            full_img = frame.frame_buffer
            x, y, w, h = region['x'], region['y'], region['width'], region['height'] 
            data_img = full_img[y:y+h, x:x+w]
            
            if data_img.size == 0:
                print(f"ERROR:Пустая область данных для {trigger.id}", file=sys.stderr)
                return
            
            # Конвертируем в PIL Image, затем в байты PNG
            pil_image = Image.fromarray(cv2.cvtColor(data_img, cv2.COLOR_BGR2RGB))
            image_buffer = BytesIO()
            pil_image.save(image_buffer, format='PNG', optimize=True)
            image_bytes = image_buffer.getvalue()
            
            # Кодируем в base64 
            image_b64 = base64.b64encode(image_bytes).decode('utf-8')
            
            action_data = {
                'id': trigger.id,
                'timestamp': datetime.now().isoformat(),
                'image_b64': image_b64,
                'capture_delay': trigger.capture_delay,
                'region': region
            }
            
            print(f'ACTION_DATA:{json.dumps(action_data)}', flush=True)
            print(f"STATUS:Данные для '{trigger.id}' захвачены и отправлены")
            
        except Exception as e:
            print(f"ERROR: Ошибка выполнения захвата для {trigger.id}: {str(e)}", file=sys.stderr)
    
    def run(self):
        """
        Запуск мониторинга с правильной архитектурой windows-capture
        """
        print("Starting screen monitoring...")
        
        try:
            # ИСПРАВЛЕНИЕ: Устанавливаем event handlers ПЕРЕД start()
            print("STATUS:Setting up event handlers...")
            self._setup_event_handlers()
            
            # Запускаем захват - это блокирующий вызов!
            # Вся логика обработки теперь в _on_frame_arrived
            print("STATUS:Attempting to start screen capture...")
            self.capturer.start()  # Блокирующий вызов - не вернется до остановки
            print("STATUS:Screen capture stopped")
                
        except KeyboardInterrupt:
            print("Monitoring stopped by user")
        except Exception as e:
            print(f"ERROR in monitoring: {str(e)}", file=sys.stderr)
            import traceback
            traceback.print_exc()


def main():
    """
    Точка входа программы с парсингом аргументов командной строки
    """
    parser = argparse.ArgumentParser(description='Universal Screen Monitor with Trigger Profiles')
    parser.add_argument('--target_type', required=True, choices=['window', 'screen'],
                       help='Target type: window or screen')
    parser.add_argument('--target_id', required=True,
                       help='Target ID: window name or monitor index')
    parser.add_argument('--profiles_file', required=True,
                       help='Path to JSON file with trigger profiles configuration')
    parser.add_argument('--fps', type=int, default=10,
                       help='Target frame rate (default: 10 FPS)')
    
    args = parser.parse_args()
    
    try:
        # Читаем конфигурацию профилей из файла
        with open(args.profiles_file, 'r', encoding='utf-8') as f:
            profiles_config = json.load(f)
        
        if not isinstance(profiles_config, list) or len(profiles_config) == 0:
            print("ERROR: Profiles must be a non-empty array", file=sys.stderr)
            sys.exit(1)
        
        # Создаем и запускаем монитор
        monitor = ScreenMonitor(args.target_type, args.target_id, profiles_config, target_fps=args.fps)
        monitor.run()
        
    except json.JSONDecodeError as e:
        print(f"ERROR: Invalid JSON in profiles: {str(e)}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"ERROR: {str(e)}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()