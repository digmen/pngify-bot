# Аватарка @PngifyBot: стопка страниц, верхняя — с картинкой внутри, бейдж PNG. Рисуется в 4x и сглаживается.
import sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageChops

OUT = sys.argv[1]
N = 1024; K = 4; W = N * K
def s(v): return int(v * K)

# Фон: диагональный градиент индиго → фиолетовый, Telegram обрежет кругом.
c1, c2 = (64, 84, 255), (170, 60, 255)
grad = Image.linear_gradient("L").rotate(-45, expand=True).resize((W, W))
bg = Image.composite(Image.new("RGB", (W, W), c2), Image.new("RGB", (W, W), c1), grad)
# мягкое свечение сверху слева
glow = Image.new("L", (W, W), 0); ImageDraw.Draw(glow).ellipse([s(-200), s(-260), s(620), s(520)], fill=110)
bg = Image.composite(Image.new("RGB", (W, W), (140, 170, 255)), bg, glow.filter(ImageFilter.GaussianBlur(s(140))))
img = bg.convert("RGBA")

def sheet(box, fold, fill, radius=46):
    """Лист с загнутым правым верхним углом: маска + треугольник загиба."""
    x0, y0, x1, y1 = [s(v) for v in box]; f = s(fold); r = s(radius)
    m = Image.new("L", (W, W), 0); d = ImageDraw.Draw(m)
    d.rounded_rectangle([x0, y0, x1, y1], radius=r, fill=255)
    d.polygon([(x1 - f, y0 - 2), (x1 + 2, y0 - 2), (x1 + 2, y0 + f)], fill=0)  # срезанный угол
    layer = Image.new("RGBA", (W, W), fill); return layer, m, (x0, y0, x1, y1, f)

def shadow(mask, off, blur, alpha):
    sh = Image.new("RGBA", (W, W), (30, 10, 90, 0))
    a = mask.filter(ImageFilter.GaussianBlur(s(blur))).point(lambda v: int(v * alpha))
    sh.putalpha(ImageChops.offset(a, 0, s(off))); return sh

# Задний лист (стопка страниц), повёрнут.
back_l, back_m, _ = sheet((300, 230, 700, 760), 110, (255, 255, 255, 255))
back_m = back_m.rotate(9, center=(s(500), s(495)), resample=Image.BICUBIC)
img.alpha_composite(shadow(back_m, 14, 26, 0.35))
back = Image.new("RGBA", (W, W), (255, 255, 255, 0)); back.putalpha(back_m.point(lambda v: int(v * 0.55)))
img.alpha_composite(back)

# Передний лист.
front_l, front_m, (x0, y0, x1, y1, f) = sheet((262, 206, 682, 770), 120, (255, 255, 255, 255))
img.alpha_composite(shadow(front_m, 22, 34, 0.45))
fr = Image.new("RGBA", (W, W), (255, 255, 255, 0)); fr.putalpha(front_m); img.alpha_composite(fr)
d = ImageDraw.Draw(img)
# загиб угла
d.polygon([(x1 - f, y0), (x1 - f, y0 + f - s(18)), (x1 - f + s(18), y0 + f), (x1, y0 + f)], fill=(214, 206, 255, 255))

# Картинка внутри листа: рамка, солнце, горы — в цветах фона.
px0, py0, px1, py1 = s(318), s(372), s(626), s(598)
pm = Image.new("L", (W, W), 0); ImageDraw.Draw(pm).rounded_rectangle([px0, py0, px1, py1], radius=s(30), fill=255)
pic = Image.composite(Image.new("RGB", (W, W), (124, 96, 255)), Image.new("RGB", (W, W), (92, 120, 255)), grad).convert("RGBA")
pd = ImageDraw.Draw(pic)
pd.ellipse([s(548), s(400), s(598), s(450)], fill=(255, 214, 102, 255))           # солнце
pd.polygon([(s(318), s(598)), (s(420), s(470)), (s(500), s(560)), (s(500), s(598))], fill=(255, 255, 255, 235))   # гора 1
pd.polygon([(s(440), s(598)), (s(530), s(500)), (s(626), s(598))], fill=(225, 220, 255, 255))                     # гора 2
pic.putalpha(pm); img.alpha_composite(pic)

# Строки текста под картинкой.
for i, (a, b) in enumerate([(318, 600), (318, 520)]):
    y = s(636 + i * 46); d.rounded_rectangle([s(a), y, s(b), y + s(22)], radius=s(11), fill=(222, 218, 245, 255))

# Бейдж PNG снизу справа, выходит за край листа.
bx0, by0, bx1, by1 = s(560), s(668), s(800), s(790)
bm = Image.new("L", (W, W), 0); ImageDraw.Draw(bm).rounded_rectangle([bx0, by0, bx1, by1], radius=s(61), fill=255)
img.alpha_composite(shadow(bm, 12, 20, 0.5))
badge = Image.composite(Image.new("RGB", (W, W), (255, 92, 170)), Image.new("RGB", (W, W), (255, 140, 66)), grad).convert("RGBA")
badge.putalpha(bm); img.alpha_composite(badge)
font = None
for fp in ["/System/Library/Fonts/Supplemental/Arial Rounded Bold.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"]:
    try: font = ImageFont.truetype(fp, s(78)); break
    except OSError: pass
d = ImageDraw.Draw(img)
d.text(((bx0 + bx1) / 2, (by0 + by1) / 2 + s(2)), "PNG", font=font, fill=(255, 255, 255, 255), anchor="mm")

out = img.convert("RGB").resize((N, N), Image.LANCZOS)
out.save(OUT + ".png", optimize=True)
out.resize((640, 640), Image.LANCZOS).save(OUT + "-640.jpg", quality=95)
# Самопроверка без просмотра: цвета в ключевых точках.
for name, xy in [("фон", (40, 980)), ("лист", (300, 260)), ("картинка", (360, 420)), ("солнце", (573, 425)), ("бейдж", (600, 720)), ("угол обрезки круга", (5, 5))]:
    print(name, out.getpixel(xy))
