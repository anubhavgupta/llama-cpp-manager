#!/usr/bin/env python3
"""Script to create modern gradient PWA icon design options"""

from PIL import Image, ImageDraw, ImageFont
import os

def create_icon_option_1(size):
    """Option 1: Minimalist with large centered text - blue gradient"""
    img = Image.new('RGB', (size, size), color='#0d0d0d')
    draw = ImageDraw.Draw(img)

    # Blue gradient background
    for y in range(size):
        progress = y / size
        if progress < 0.5:
            ratio = progress * 2
            r = int(13 + (59 - 13) * ratio)
            g = int(13 + (130 - 13) * ratio)
            b = int(13 + (246 - 13) * ratio)
        else:
            ratio = (progress - 0.5) * 2
            r = int(59 + (13 - 59) * ratio)
            g = int(130 + (13 - 130) * ratio)
            b = int(246 + (13 - 246) * ratio)
        draw.rectangle([0, y, size, y + 1], fill=(r, g, b))

    # Large LCM text centered
    try:
        font = ImageFont.truetype("C:\\Windows\\Fonts\\JetBrainsMono-Bold.ttf", int(size * 0.25))
    except:
        font = ImageFont.truetype("C:\\Windows\\Fonts\\arialbd.ttf", int(size * 0.25))

    text = "LCM"
    bbox = draw.textbbox((0, 0), text, font=font)
    text_x = (size - bbox[2] + bbox[0]) // 2
    text_y = (size - bbox[3] + bbox[1]) // 2

    # Glow effect
    glow_offset = 3
    for ox in range(-glow_offset, glow_offset + 1):
        for oy in range(-glow_offset, glow_offset + 1):
            draw.text((text_x + ox, text_y + oy), text, font=font, fill='#3b82f6')

    draw.text((text_x, text_y), text, font=font, fill='#3b82f6')

    return img

def create_icon_option_2(size):
    """Option 2: Geometric with square container - copper theme"""
    img = Image.new('RGB', (size, size), color='#0d0d0d')
    draw = ImageDraw.Draw(img)

    # Dark copper gradient background
    for y in range(size):
        progress = y / size
        r = int(13 + (201 - 13) * progress)
        g = int(13 + (162 - 13) * progress)
        b = int(13 + (39 - 13) * progress)
        draw.rectangle([0, y, size, y + 1], fill=(r, g, b))

    # Central LCM text with square background
    try:
        font = ImageFont.truetype("C:\\Windows\\Fonts\\JetBrainsMono-Bold.ttf", int(size * 0.20))
    except:
        font = ImageFont.truetype("C:\\Windows\\Fonts\\arialbd.ttf", int(size * 0.20))

    text = "LCM"
    bbox = draw.textbbox((0, 0), text, font=font)
    text_width = bbox[2] - bbox[0]
    text_height = bbox[3] - bbox[1]

    # Square container
    box_size = int(size * 0.5)
    box_x = (size - box_size) // 2
    box_y = (size - box_size) // 2

    # Draw square with copper border
    draw.rectangle([box_x, box_y, box_x + box_size, box_y + box_size],
                   outline='#c9a227', width=4)

    # Inner square
    inner_size = int(box_size * 0.8)
    draw.rectangle([box_x + (box_size - inner_size)//2,
                    box_y + (box_size - inner_size)//2,
                    box_x + box_size - (box_size - inner_size)//2,
                    box_y + box_size - (box_size - inner_size)//2],
                   fill='#c9a227')

    # Text in center
    draw.text((box_x + (box_size - text_width)//2,
               box_y + (box_size - text_height)//2),
             text, font=font, fill='#0d0d0d')

    return img

def create_icon_option_3(size):
    """Option 3: Technical circuit pattern"""
    img = Image.new('RGB', (size, size), color='#0d0d0d')
    draw = ImageDraw.Draw(img)

    # Dark background
    for y in range(size):
        draw.rectangle([0, y, size, y + 1], fill='#0d0d0d')

    # Circuit pattern
    spacing = int(size * 0.08)
    for x in range(0, size, spacing):
        for y in range(0, size, spacing):
            # Small squares
            draw.rectangle([x, y, x + spacing//2, y + spacing//2], fill='#3b82f6')
            if x + spacing < size:
                draw.rectangle([x + spacing//2, y + spacing//2, x + spacing, y + spacing], fill='#3b82f6')

    # LCM text at bottom
    try:
        font = ImageFont.truetype("C:\\Windows\\Fonts\\JetBrainsMono-Bold.ttf", int(size * 0.18))
    except:
        font = ImageFont.truetype("C:\\Windows\\Fonts\\arialbd.ttf", int(size * 0.18))

    text = "LCM"
    bbox = draw.textbbox((0, 0), text, font=font)
    text_x = (size - bbox[2] + bbox[0]) // 2
    text_y = size - int(size * 0.15)

    draw.text((text_x, text_y), text, font=font, fill='#c9a227')

    return img

def create_icon_option_4(size):
    """Option 4: Modern diagonal gradient"""
    img = Image.new('RGB', (size, size), color='#0d0d0d')
    draw = ImageDraw.Draw(img)

    # Diagonal gradient
    for x in range(size):
        for y in range(size):
            progress = (x + y) / (size * 2)
            r = int(13 + (59 - 13) * progress)
            g = int(13 + (130 - 13) * progress)
            b = int(13 + (246 - 13) * progress)
            draw.point((x, y), fill=(r, g, b))

    # Large LCM in center
    try:
        font = ImageFont.truetype("C:\\Windows\\Fonts\\JetBrainsMono-Bold.ttf", int(size * 0.28))
    except:
        font = ImageFont.truetype("C:\\Windows\\Fonts\\arialbd.ttf", int(size * 0.28))

    text = "LCM"
    bbox = draw.textbbox((0, 0), text, font=font)
    text_x = (size - bbox[2] + bbox[0]) // 2
    text_y = (size - bbox[3] + bbox[1]) // 2

    draw.text((text_x, text_y), text, font=font, fill='#ffffff')

    # Border
    margin = int(size * 0.05)
    draw.rectangle([margin, margin, size - margin, size - margin],
                   outline='#c9a227', width=3)

    return img

def create_icon_option_5(size):
    """Option 5: Minimal copper accent"""
    img = Image.new('RGB', (size, size), color='#0d0d0d')
    draw = ImageDraw.Draw(img)

    # Copper gradient
    for y in range(size):
        progress = y / size
        r = int(13 + (201 - 13) * progress)
        g = int(13 + (162 - 13) * progress)
        b = int(13 + (39 - 13) * progress)
        draw.rectangle([0, y, size, y + 1], fill=(r, g, b))

    # Simple LCM text
    try:
        font = ImageFont.truetype("C:\\Windows\\Fonts\\JetBrainsMono-Bold.ttf", int(size * 0.22))
    except:
        font = ImageFont.truetype("C:\\Windows\\Fonts\\arialbd.ttf", int(size * 0.22))

    text = "LCM"
    bbox = draw.textbbox((0, 0), text, font=font)
    text_x = (size - bbox[2] + bbox[0]) // 2
    text_y = (size - bbox[3] + bbox[1]) // 2

    draw.text((text_x, text_y), text, font=font, fill='#ffffff')

    # Small copper dot
    dot_size = int(size * 0.03)
    draw.ellipse([size//2 - dot_size//2, size//2 - dot_size//2,
                  size//2 + dot_size//2, size//2 + dot_size//2],
                 fill='#c9a227')

    return img

def create_icon_option_6(size):
    """Option 6: Dark blue with copper accent - modern"""
    img = Image.new('RGB', (size, size), color='#0d0d0d')
    draw = ImageDraw.Draw(img)

    # Dark blue gradient
    for y in range(size):
        progress = y / size
        r = int(13 + (30 - 13) * progress)
        g = int(13 + (58 - 13) * progress)
        b = int(13 + (138 - 13) * progress)
        draw.rectangle([0, y, size, y + 1], fill=(r, g, b))

    # Large LCM text
    try:
        font = ImageFont.truetype("C:\\Windows\\Fonts\\JetBrainsMono-Bold.ttf", int(size * 0.26))
    except:
        font = ImageFont.truetype("C:\\Windows\\Fonts\\arialbd.ttf", int(size * 0.26))

    text = "LCM"
    bbox = draw.textbbox((0, 0), text, font=font)
    text_x = (size - bbox[2] + bbox[0]) // 2
    text_y = (size - bbox[3] + bbox[1]) // 2

    # Glow effect
    glow_offset = 4
    for ox in range(-glow_offset, glow_offset + 1):
        for oy in range(-glow_offset, glow_offset + 1):
            draw.text((text_x + ox, text_y + oy), text, font=font, fill='#c9a227')

    draw.text((text_x, text_y), text, font=font, fill='#c9a227')

    return img

def create_icon_option_7(size):
    """Option 7: Geometric hexagon pattern"""
    img = Image.new('RGB', (size, size), color='#0d0d0d')
    draw = ImageDraw.Draw(img)

    # Dark background with subtle blue tint
    for y in range(size):
        draw.rectangle([0, y, size, y + 1], fill='#0d0d0d')

    # Hexagonal pattern
    hex_size = int(size * 0.04)
    for x in range(0, size, hex_size * 2):
        for y in range(0, size, hex_size * 2 + hex_size):
            draw.polygon([
                x, y,
                x + hex_size, y + hex_size * 0.866,
                x + hex_size * 2, y,
                x + hex_size, y - hex_size * 0.866,
                x, y
            ], fill='#3b82f6')

    # LCM text centered
    try:
        font = ImageFont.truetype("C:\\Windows\\Fonts\\JetBrainsMono-Bold.ttf", int(size * 0.22))
    except:
        font = ImageFont.truetype("C:\\Windows\\Fonts\\arialbd.ttf", int(size * 0.22))

    text = "LCM"
    bbox = draw.textbbox((0, 0), text, font=font)
    text_x = (size - bbox[2] + bbox[0]) // 2
    text_y = (size - bbox[3] + bbox[1]) // 2

    draw.text((text_x, text_y), text, font=font, fill='#ffffff')

    # Copper border
    margin = int(size * 0.06)
    draw.rectangle([margin, margin, size - margin, size - margin],
                   outline='#c9a227', width=3)

    return img

def create_icon_option_8(size):
    """Option 8: Gradient bars with LCM"""
    img = Image.new('RGB', (size, size), color='#0d0d0d')
    draw = ImageDraw.Draw(img)

    # Horizontal gradient bars
    bar_count = 6
    bar_height = size // bar_count
    colors = [
        '#1e3a8a', '#1e40af', '#2563eb',
        '#3b82f6', '#60a5fa', '#93c5fd'
    ]

    for i in range(bar_count):
        y = i * bar_height
        draw.rectangle([0, y, size, y + bar_height], fill=colors[i])

    # Large LCM text
    try:
        font = ImageFont.truetype("C:\\Windows\\Fonts\\JetBrainsMono-Bold.ttf", int(size * 0.25))
    except:
        font = ImageFont.truetype("C:\\Windows\\Fonts\\arialbd.ttf", int(size * 0.25))

    text = "LCM"
    bbox = draw.textbbox((0, 0), text, font=font)
    text_x = (size - bbox[2] + bbox[0]) // 2
    text_y = (size - bbox[3] + bbox[1]) // 2

    draw.text((text_x, text_y), text, font=font, fill='#0d0d0d')

    return img

def create_icon_option_9(size):
    """Option 9: Copper gradient with white text"""
    img = Image.new('RGB', (size, size), color='#0d0d0d')
    draw = ImageDraw.Draw(img)

    # Copper gradient
    for y in range(size):
        progress = y / size
        r = int(13 + (201 - 13) * progress)
        g = int(13 + (162 - 13) * progress)
        b = int(13 + (39 - 13) * progress)
        draw.rectangle([0, y, size, y + 1], fill=(r, g, b))

    # Large LCM text
    try:
        font = ImageFont.truetype("C:\\Windows\\Fonts\\JetBrainsMono-Bold.ttf", int(size * 0.26))
    except:
        font = ImageFont.truetype("C:\\Windows\\Fonts\\arialbd.ttf", int(size * 0.26))

    text = "LCM"
    bbox = draw.textbbox((0, 0), text, font=font)
    text_x = (size - bbox[2] + bbox[0]) // 2
    text_y = (size - bbox[3] + bbox[1]) // 2

    draw.text((text_x, text_y), text, font=font, fill='#ffffff')

    # Small blue accent dots
    dot_size = int(size * 0.025)
    draw.ellipse([size*0.15, size*0.15, size*0.15+dot_size, size*0.15+dot_size], fill='#3b82f6')
    draw.ellipse([size*0.85, size*0.85, size*0.85+dot_size, size*0.85+dot_size], fill='#3b82f6')

    return img

def create_icon_option_10(size):
    """Option 10: Dark gradient with copper outline"""
    img = Image.new('RGB', (size, size), color='#0d0d0d')
    draw = ImageDraw.Draw(img)

    # Dark gradient (dark blue to black)
    for y in range(size):
        progress = y / size
        r = int(13 + (15 - 13) * progress)
        g = int(13 + (23 - 13) * progress)
        b = int(13 + (42 - 13) * progress)
        draw.rectangle([0, y, size, y + 1], fill=(r, g, b))

    # Large LCM text
    try:
        font = ImageFont.truetype("C:\\Windows\\Fonts\\JetBrainsMono-Bold.ttf", int(size * 0.28))
    except:
        font = ImageFont.truetype("C:\\Windows\\Fonts\\arialbd.ttf", int(size * 0.28))

    text = "LCM"
    bbox = draw.textbbox((0, 0), text, font=font)
    text_x = (size - bbox[2] + bbox[0]) // 2
    text_y = (size - bbox[3] + bbox[1]) // 2

    # Glow effect
    glow_offset = 4
    for ox in range(-glow_offset, glow_offset + 1):
        for oy in range(-glow_offset, glow_offset + 1):
            draw.text((text_x + ox, text_y + oy), text, font=font, fill='#3b82f6')

    draw.text((text_x, text_y), text, font=font, fill='#3b82f6')

    # Copper border
    margin = int(size * 0.06)
    draw.rectangle([margin, margin, size - margin, size - margin],
                   outline='#c9a227', width=4)

    return img

# Create icons for all options
sizes = [192, 512]
output_dir = "C:\\claude\\llama-cpp-manager\\public"

options = [
    ("option1", create_icon_option_1),
    ("option2", create_icon_option_2),
    ("option3", create_icon_option_3),
    ("option4", create_icon_option_4),
    ("option5", create_icon_option_5),
    ("option6", create_icon_option_6),
    ("option7", create_icon_option_7),
    ("option8", create_icon_option_8),
    ("option9", create_icon_option_9),
    ("option10", create_icon_option_10),
]

for size in sizes:
    for option_name, create_func in options:
        icon = create_func(size)
        filename = f"icon-{size}x{size}-{option_name}.png"
        icon.save(os.path.join(output_dir, filename), 'PNG')
        print(f"Created {filename}")

print("\nAll icon options created successfully!")
print("Options available:")
print("  option1 - Minimalist with large centered text - blue gradient")
print("  option2 - Geometric with square container - copper theme")
print("  option3 - Technical circuit pattern")
print("  option4 - Modern diagonal gradient")
print("  option5 - Minimal copper accent")
print("  option6 - Dark blue with copper accent - modern")
print("  option7 - Geometric hexagon pattern")
print("  option8 - Gradient bars with LCM")
print("  option9 - Copper gradient with white text")
print("  option10 - Dark gradient with copper outline")
