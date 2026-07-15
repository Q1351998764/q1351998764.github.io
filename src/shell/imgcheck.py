from pathlib import Path
from PIL import Image
import json
import sys


# Add repository-relative image paths here when an image should be skipped.
skip_list = {
    ...,
}
image_suffixes = {'.jpg', '.jpeg', '.png', '.jfif', '.webp', '.gif', '.bmp'}


def d_hash(image, hash_size=8):
    image2 = image.convert('L').resize(
        (hash_size + 1, hash_size),
        Image.LANCZOS,
    )
    difference = []
    for row in range(hash_size):
        for col in range(hash_size):
            pixel_left = image2.getpixel((col, row))
            pixel_right = image2.getpixel((col + 1, row))
            difference.append(pixel_left > pixel_right)
    decimal_value = 0
    hex_string = []
    for index, value in enumerate(difference):
        if value:
            decimal_value += 2 ** (index % 8)
        if (index % 8) == 7:
            hex_string.append(hex(decimal_value)[2:].rjust(2, '0'))
            decimal_value = 0
    return ''.join(hex_string)


def count_similarity(hash1, hash2):
    similarity = 0
    for index, value in enumerate(hash1):
        if value == hash2[index]:
            similarity += 1
    return similarity / len(hash1)


hash_map = {}

print('Calculating dHash for each image')
for image_path in sorted(Path('meme').rglob('*')):
    if not image_path.is_file() or image_path.suffix.casefold() not in image_suffixes:
        continue
    relative_path = image_path.as_posix()
    if relative_path in skip_list:
        continue
    try:
        with Image.open(image_path) as image:
            hash_map[relative_path] = d_hash(image, 32)
    except Exception as error:
        print(f'Failed to calculate dHash for {relative_path}: {error}')

print('Checking for similar images')
similar_images = []
for name, hash1 in hash_map.items():
    for name2, hash2 in hash_map.items():
        if name >= name2:
            continue
        similarity = count_similarity(hash1, hash2)
        if similarity > 0.8:
            similar_images.append((name, name2, similarity))

output_map = {}
for name, name2, similarity in similar_images:
    output_map.setdefault(name, {})[name2] = similarity
    output_map.setdefault(name2, {})[name] = similarity

output_map = sorted(output_map.items(), key=lambda item: len(item[1]), reverse=True)

print('Similar images:')
for name, similar in output_map:
    print(f'{name} is similar to:')
    for name2, similarity in similar.items():
        print(f'    {name2} ({similarity * 100:.2f}%)')

output_directory = Path('static/data/images')
output_directory.mkdir(parents=True, exist_ok=True)
with (output_directory / 'hash_map.json').open('w', encoding='utf8') as file:
    json.dump(hash_map, file, indent=4, ensure_ascii=False)
with (output_directory / 'similar_images.json').open('w', encoding='utf8') as file:
    json.dump(output_map, file, indent=4, ensure_ascii=False)

if similar_images:
    print('Some images are similar')
else:
    print('All images are unique')
sys.exit(0)
