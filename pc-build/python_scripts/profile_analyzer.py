#!/usr/bin/env python3
"""
Profile Analyzer - Анализатор персональных профилей триггеров
Создает цветовую палитру и base64 эталон из изображения области триггера

Использование:
    python profile_analyzer.py path/to/trigger_area.png
    
Выход:
    JSON с полями: color_palette, template_base64, success/error
"""

import sys
import os
import json
import base64
import argparse
from io import BytesIO

import numpy as np
import cv2
from PIL import Image


def validate_input(image_path):
    """
    Валидация входного изображения
    
    Args:
        image_path (str): Путь к изображению
        
    Returns:
        dict: {"valid": True} или {"error": "описание ошибки"}
    """
    if not os.path.exists(image_path):
        return {"error": "Файл не найден"}
    
    try:
        # Проверяем, что файл можно прочитать как изображение
        image = cv2.imread(image_path)
        if image is None:
            return {"error": "Не удается прочитать изображение (поврежден или неверный формат)"}
        
        height, width = image.shape[:2]
        
        # Проверяем минимальные размеры
        if height < 16 or width < 16:
            return {"error": f"Область слишком маленькая ({width}x{height}), минимум 16x16 пикселей"}
        
        # Проверяем максимальные размеры для избежания проблем с памятью
        if height > 2000 or width > 2000:
            return {"error": f"Область слишком большая ({width}x{height}), максимум 2000x2000 пикселей"}
            
        return {"valid": True, "size": f"{width}x{height}"}
        
    except Exception as e:
        return {"error": f"Ошибка при проверке изображения: {str(e)}"}


def get_dominant_colors(image, k=3):
    """
    Извлечение доминирующих цветов из изображения методом K-means
    Переиспользует алгоритм из screen_monitor.py для единообразия
    
    Args:
        image (numpy.ndarray): Изображение в формате BGR
        k (int): Количество доминирующих цветов для извлечения
        
    Returns:
        list: Список доминирующих цветов в формате [[B, G, R], ...]
    """
    try:
        # Преобразуем изображение в массив пикселей
        data = image.reshape((-1, 3))
        data = np.float32(data)
        
        # Применяем K-means кластеризацию
        criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 20, 1.0)
        _, labels, centers = cv2.kmeans(data, k, None, criteria, 10, cv2.KMEANS_RANDOM_CENTERS)
        
        # Конвертируем центры кластеров обратно в целые числа
        centers = np.uint8(centers)
        
        # Сортируем цвета по частоте использования
        unique_labels, counts = np.unique(labels, return_counts=True)
        sorted_indices = np.argsort(-counts)  # Сортировка по убыванию
        
        # Возвращаем топ-K доминирующих цветов
        dominant_colors = []
        for i in sorted_indices:
            color = centers[i].tolist()  # [B, G, R]
            dominant_colors.append(color)
            
        return dominant_colors
        
    except Exception as e:
        print(f"ERROR in get_dominant_colors: {str(e)}", file=sys.stderr)
        # Возвращаем базовые цвета как fallback
        return [[128, 128, 128], [64, 64, 64], [192, 192, 192]]


def image_to_base64(image_path):
    """
    Конвертация изображения в base64 строку для эталона
    
    Args:
        image_path (str): Путь к изображению
        
    Returns:
        str: Base64 представление изображения
    """
    try:
        with open(image_path, "rb") as image_file:
            encoded_string = base64.b64encode(image_file.read()).decode('utf-8')
            return encoded_string
            
    except Exception as e:
        raise Exception(f"Ошибка конвертации в base64: {str(e)}")


def analyze_trigger_profile(image_path):
    """
    Главная функция анализа профиля триггера
    
    Args:
        image_path (str): Путь к изображению области триггера
        
    Returns:
        dict: Результат анализа с палитрой и эталоном
    """
    # Валидация входных данных
    validation = validate_input(image_path)
    if "error" in validation:
        return {
            "success": False,
            "error": validation["error"]
        }
    
    try:
        # Загружаем изображение
        image = cv2.imread(image_path)
        
        # Анализируем цветовую палитру
        print("Анализ цветовой палитры...", file=sys.stderr)
        color_palette = get_dominant_colors(image, k=3)
        
        # Конвертируем в base64 эталон
        print("Создание base64 эталона...", file=sys.stderr)
        template_base64 = image_to_base64(image_path)
        
        # Формируем результат
        result = {
            "success": True,
            "color_palette": color_palette,
            "template_base64": template_base64,
            "image_size": validation["size"],
            "palette_colors_count": len(color_palette)
        }
        
        print(f"Профиль успешно создан: {validation['size']}, цветов: {len(color_palette)}", file=sys.stderr)
        return result
        
    except Exception as e:
        return {
            "success": False,
            "error": f"Ошибка анализа профиля: {str(e)}"
        }


def main():
    """
    Главная функция - точка входа скрипта
    """
    parser = argparse.ArgumentParser(description='Анализатор персональных профилей триггеров')
    parser.add_argument('image_path', help='Путь к изображению области триггера')
    parser.add_argument('--colors', type=int, default=3, help='Количество доминирующих цветов (по умолчанию 3)')
    
    try:
        args = parser.parse_args()
        
        print(f"Анализ изображения: {args.image_path}", file=sys.stderr)
        
        # Выполняем анализ
        result = analyze_trigger_profile(args.image_path)
        
        # Выводим результат в stdout как JSON
        print(json.dumps(result, ensure_ascii=False, indent=2))
        
        # Возвращаем код завершения
        sys.exit(0 if result.get("success", False) else 1)
        
    except Exception as e:
        error_result = {
            "success": False,
            "error": f"Критическая ошибка: {str(e)}"
        }
        print(json.dumps(error_result, ensure_ascii=False, indent=2))
        sys.exit(1)


if __name__ == "__main__":
    main()