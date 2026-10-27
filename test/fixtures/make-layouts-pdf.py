"""Writes layouts.pdf and scanned.pdf, the sample PDFs for the reader's layout checks.

    python3 test/fixtures/make-layouts-pdf.py   (needs reportlab)

layouts.pdf: two pages in two columns (a title across both, a paragraph carrying on into the next
column, a stat block, a picture), a page in three columns, a page with a sidebar, and a page with a
centred letter and a loosely set table (for marking areas by hand).
scanned.pdf: a page set like an OCR text layer: one font, every word at its own height and size.
"""
import random
from pathlib import Path

from reportlab.lib.pagesizes import letter
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas

OUT = Path(__file__).parent
W, H = letter
WORDS = ('the party walks along the old road toward the ruined keep where goblins have made their camp '
         'among the fallen stones and the river runs cold beneath the broken bridge while crows watch').split()


def lines(seed, count, width, size=10, font='Times-Roman'):
    """Filler text broken into lines that fill `width`, the last one ending a sentence."""
    rng = random.Random(seed)
    words = [rng.choice(WORDS) for _ in range(count * 14)]
    out, line = [], ''
    for w in words:
        if stringWidth(f'{line} {w}'.strip(), font, size) > width:
            out.append(line)
            line = w
            if len(out) == count:
                break
        else:
            line = f'{line} {w}'.strip()
    out[-1] = out[-1] + '.'
    return out


def text(c, x, y, s, size=10, font='Times-Roman'):
    c.setFont(font, size)
    c.drawString(x, H - y, s)


def column(c, x, y, rows, size=10, leading=12, font='Times-Roman'):
    for i, s in enumerate(rows):
        text(c, x, y + i * leading, s, size, font)
    return y + len(rows) * leading


def picture():
    from PIL import Image, ImageDraw
    img = Image.new('RGB', (240, 160), (90, 120, 160))
    d = ImageDraw.Draw(img)
    for i in range(0, 240, 20):
        d.line([(i, 0), (240 - i, 160)], fill=(230, 200, 120), width=3)
    return ImageReader(img)


def layouts():
    c = canvas.Canvas(str(OUT / 'layouts.pdf'), pagesize=letter)
    c.setTitle('Layout Samples')
    left, right, colw = 54, 315, 243

    # Page 1: title across both columns, two columns with a paragraph running on into the right one.
    text(c, left, 70, 'The Ruined Keep', 28, 'Helvetica-Bold')
    text(c, left, 110, 'Background', 15, 'Helvetica-Bold')
    y = column(c, left, 130, lines(1, 18, colw))
    text(c, left, y + 14, 'The Road', 15, 'Helvetica-Bold')
    column(c, left, y + 34, lines(2, 20, colw)[:-1] + ['the travellers keep on'])
    column(c, right, 110, ['walking until nightfall.'] + lines(3, 25, colw))
    text(c, right, 450, 'Goblin Camp', 15, 'Helvetica-Bold')
    column(c, right, 470, lines(4, 14, colw))
    text(c, W - 60, H - 30, '1')
    c.showPage()

    # Page 2: a stat block in the left column, a picture and text on the right.
    text(c, left, 70, 'Goblin Boss', 15, 'Helvetica-Bold')
    text(c, left, 86, 'Small humanoid (goblinoid), neutral evil', 10, 'Times-Italic')
    for i, (k, v) in enumerate([('Armor Class', '17 (chain shirt, shield)'), ('Hit Points', '21 (6d6)'), ('Speed', '30 ft.')]):
        text(c, left, 104 + i * 12, k, 10, 'Times-Bold')
        text(c, left + stringWidth(k + ' ', 'Times-Bold', 10), 104 + i * 12, v)
    for i, k in enumerate(['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']):
        text(c, left + i * 40, 150, k, 9, 'Times-Bold')
        text(c, left + i * 40, 162, ['10 (+0)', '14 (+2)', '10 (+0)', '10 (+0)', '8 (-1)', '10 (+0)'][i], 9)
    text(c, left, 190, 'Actions', 13, 'Helvetica-Bold')
    text(c, left, 208, 'Multiattack.', 10, 'Times-Bold')
    text(c, left + 58, 208, 'The goblin boss makes two attacks.')
    column(c, left, 240, lines(5, 30, colw))
    c.drawImage(picture(), right, H - 260, 243, 162)
    column(c, right, 290, lines(6, 32, colw))
    text(c, W - 60, H - 30, '2')
    c.showPage()

    # Page 3: three columns under a title.
    text(c, left, 70, 'Three Columns', 22, 'Helvetica-Bold')
    for n, x in enumerate([54, 228, 402]):
        column(c, x, 110, lines(10 + n, 40, 156))
    text(c, W - 60, H - 30, '3')
    c.showPage()

    # Page 4: a narrow sidebar on the left, the main text on the right.
    text(c, 200, 70, 'The Village', 22, 'Helvetica-Bold')
    text(c, 54, 110, 'Village Notes', 11, 'Helvetica-Bold')
    column(c, 54, 128, lines(20, 24, 120, 9), 9, 11)
    column(c, 200, 110, lines(21, 48, 358))
    text(c, W - 60, H - 30, '4')
    c.showPage()

    # Page 5: a centred letter, then a table set with narrow gaps.
    text(c, left, 70, 'The Letter', 22, 'Helvetica-Bold')
    for i, s in enumerate(['My dear Lord Wyvern,', 'come at once to the old mill,', 'for the miller has seen', 'the thing in the river again.', 'Your friend, Ostler Gundigoot']):
        c.setFont('Times-Italic', 11)
        c.drawCentredString(W / 2, H - (120 + i * 16), s)
    text(c, left, 230, 'd6', 10, 'Times-Bold')
    text(c, left + 22, 230, 'Encounter', 10, 'Times-Bold')
    for i, (n, s) in enumerate([('1', 'A lost goblin'), ('2', 'Two wolves'), ('3', 'A hungry bear')]):
        text(c, left, 244 + i * 13, n)
        text(c, left + 22, 244 + i * 13, s)
    column(c, left, 300, lines(30, 20, 504))
    text(c, W - 60, H - 30, '5')
    c.showPage()

    # Page 6: two columns with a tinted panel across both (its own two columns inside), then text
    # wrapped round a picture in the left column.
    text(c, left, 70, 'The Inn', 22, 'Helvetica-Bold')
    column(c, left, 100, lines(40, 8, colw))
    column(c, right, 100, lines(41, 8, colw))
    c.setFillColorRGB(0.91, 0.86, 0.75)
    c.rect(48, H - 290, 516, 90, stroke=0, fill=1)
    c.setFillColorRGB(0, 0, 0)
    text(c, 60, 222, 'Rumours at the Inn', 11, 'Helvetica-Bold')
    column(c, 60, 240, lines(42, 4, 230, 9), 9, 11)
    column(c, 320, 240, lines(43, 4, 230, 9), 9, 11)
    c.drawImage(picture(), 190, H - 410, 107, 90)
    wrapped = lines(44, 7, 125)
    wrapped[2] = wrapped[2].rstrip('.') + '.'
    column(c, left, 330, wrapped[:-1] + ['and on it goes'])
    column(c, left, 414, ['beyond the picture into the rest of the column.'] + lines(45, 12, colw))
    column(c, right, 330, lines(46, 26, colw))
    text(c, W - 60, H - 30, '6')
    c.showPage()
    c.save()


def scanned():
    c = canvas.Canvas(str(OUT / 'scanned.pdf'), pagesize=letter)
    rng = random.Random(7)

    def ocr_line(x, y, words, size):
        for w in words:
            s = size * rng.uniform(0.96, 1.04)
            c.setFont('Times-Roman', s)
            c.drawString(x, H - (y + rng.uniform(-0.08, 0.08) * size), w)
            x += c.stringWidth(w, 'Times-Roman', s) + size * 0.3

    y = 80
    for section in range(3):
        ocr_line(54, y, ['Chapter', str(section + 1)], 20)
        y += 34
        for s in lines(40 + section, 9, 480):
            ocr_line(54, y, s.split(), 10)
            y += 13
        y += 20
    c.showPage()
    c.save()


layouts()
scanned()
