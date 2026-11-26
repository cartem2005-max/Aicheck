"""otchet.md -> otchet.docx (без внешних библиотек, кроме markdown-it).
Чёрно-белая вёрстка, A4, поля 2 см, таблицы не рвутся между страницами,
заголовок не отрывается от текста. Разрыв страницы: строка <!-- pagebreak --> в md."""
import re
import zipfile
from xml.sax.saxutils import escape
from markdown_it import MarkdownIt

SRC, OUT = "otchet.md", "otchet.docx"
FONT = "Arial"
TEXT, MUTED, RULE, HEAD_BG, ACCENT = "111111", "555555", "BFBFBF", "EEEEEE", "8A1C1C"
BODY, CELL, H1, H2 = 20, 18, 34, 25          # половинки пункта: 10pt, 9pt, 17pt, 12.5pt
PAGE_W, PAGE_H, MARGIN = 11906, 16838, 1134  # A4 и поля 2 см в twips
TEXT_W = PAGE_W - 2 * MARGIN

md = open(SRC, encoding="utf-8").read()
tokens = MarkdownIt("commonmark", {"html": True}).enable("table").parse(md)

rels = []  # внешние ссылки


def link_rid(url):
    rels.append(url)
    return f"rIdL{len(rels)}"


def run(text, size=BODY, bold=False, color=TEXT, italic=False):
    if not text:
        return ""
    props = f'<w:rFonts w:ascii="{FONT}" w:hAnsi="{FONT}" w:cs="{FONT}"/>'
    props += "<w:b/>" if bold else ""
    props += "<w:i/>" if italic else ""
    props += f'<w:color w:val="{color}"/><w:sz w:val="{size}"/><w:szCs w:val="{size}"/>'
    return f'<w:r><w:rPr>{props}</w:rPr><w:t xml:space="preserve">{escape(text)}</w:t></w:r>'


def inline(tok, size=BODY, bold=False, color=TEXT):
    """inline-токен markdown-it -> runs (жирный, ссылки, переносы строк)."""
    out, b, href = [], bold, None
    for ch in tok.children or []:
        if ch.type == "text":
            if href:
                out.append(f'<w:hyperlink r:id="{link_rid(href)}">'
                           + run(ch.content, size, b, ACCENT).replace("<w:rPr>", '<w:rPr><w:u w:val="single"/>', 1)
                           + "</w:hyperlink>")
            else:
                out.append(run(ch.content, size, b, color))
        elif ch.type == "code_inline":
            out.append(run(ch.content, size, b, color))
        elif ch.type == "strong_open":
            b = True
        elif ch.type == "strong_close":
            b = bold
        elif ch.type == "link_open":
            href = ch.attrs.get("href")
        elif ch.type == "link_close":
            href = None
        elif ch.type == "softbreak":
            out.append(run(" ", size, b, color))
        elif ch.type == "hardbreak":
            out.append("<w:r><w:br/></w:r>")
    return "".join(out)


def para(runs, before=0, after=100, keep_next=False, ind=None, border_left=False, border_bottom=None, line=264):
    ppr = f'<w:spacing w:before="{before}" w:after="{after}" w:line="{line}" w:lineRule="auto"/>'
    if keep_next:
        ppr = "<w:keepNext/><w:keepLines/>" + ppr
    if border_left or border_bottom:
        bd = ""
        if border_left:
            bd += f'<w:left w:val="single" w:sz="18" w:space="8" w:color="{RULE}"/>'
        if border_bottom:
            bd += f'<w:bottom w:val="single" w:sz="12" w:space="4" w:color="{border_bottom}"/>'
        ppr = ppr.replace("<w:spacing", f"<w:pBdr>{bd}</w:pBdr><w:spacing", 1)
    if ind:
        ppr += ind
    return f"<w:p><w:pPr>{ppr}</w:pPr>{runs}</w:p>"


def table(rows):
    """rows: [[inline-токен,...], ...], первая строка — шапка."""
    n = len(rows[0])
    head = [re.sub(r"\s+", " ", c.content).strip() for c in rows[0]]
    special = {"Приём": 0.56, "Способ": 0.22, "Оценка бота": 0.31}
    fixed = {i: special[h] for i, h in enumerate(head) if h in special}
    rest = (1 - sum(fixed.values())) / max(1, n - len(fixed))
    widths = [int(TEXT_W * fixed.get(i, rest)) for i in range(n)]
    grid = "".join(f'<w:gridCol w:w="{w}"/>' for w in widths)
    bd = "".join(f'<w:{s} w:val="single" w:sz="4" w:space="0" w:color="{RULE}"/>'
                 for s in ("top", "left", "bottom", "right", "insideH", "insideV"))
    xml = (f'<w:tbl><w:tblPr><w:tblW w:w="{TEXT_W}" w:type="dxa"/><w:tblBorders>{bd}</w:tblBorders>'
           f'<w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="90" w:type="dxa"/>'
           f'<w:bottom w:w="40" w:type="dxa"/><w:right w:w="90" w:type="dxa"/></w:tblCellMar></w:tblPr>'
           f"<w:tblGrid>{grid}</w:tblGrid>")
    last = len(rows) - 1
    for ri, row in enumerate(rows):
        is_head = ri == 0
        trpr = "<w:cantSplit/>" + ("<w:tblHeader/>" if is_head else "")
        xml += f"<w:tr><w:trPr>{trpr}</w:trPr>"
        for ci, cell in enumerate(row):
            shd = f'<w:shd w:val="clear" w:color="auto" w:fill="{HEAD_BG}"/>' if is_head else ""
            # keepNext во всех строках, кроме последней: таблица не рвётся между страницами
            p = para(inline(cell, CELL, is_head), 0, 0, keep_next=ri != last, line=240)
            xml += f'<w:tc><w:tcPr><w:tcW w:w="{widths[ci]}" w:type="dxa"/>{shd}</w:tcPr>{p}</w:tc>'
        xml += "</w:tr>"
    return xml + "</w:tbl>" + para("", 0, 60)


body = []
i = 0
list_stack = []  # ('ul'|'ol', счётчик, numId)
ol_count = 0
in_quote = False
while i < len(tokens):
    t = tokens[i]
    if t.type == "html_block" and "pagebreak" in t.content:
        body.append('<w:p><w:r><w:br w:type="page"/></w:r></w:p>')
    elif t.type == "heading_open":
        inl = tokens[i + 1]
        if t.tag == "h1":
            body.append(para(inline(inl, H1, True), 0, 80, keep_next=True, border_bottom=ACCENT))
        else:
            body.append(para(inline(inl, H2, True), 220, 80, keep_next=True))
        i += 2
    elif t.type == "blockquote_open":
        in_quote = True
    elif t.type == "blockquote_close":
        in_quote = False
    elif t.type in ("bullet_list_open", "ordered_list_open"):
        if t.type == "ordered_list_open":
            ol_count += 1
        list_stack.append(["ul" if t.type == "bullet_list_open" else "ol", 0, 1 if t.type == "bullet_list_open" else 1 + ol_count])
    elif t.type in ("bullet_list_close", "ordered_list_close"):
        list_stack.pop()
    elif t.type == "list_item_open":
        list_stack[-1][1] += 1
    elif t.type == "paragraph_open":
        inl = tokens[i + 1]
        if list_stack:
            kind, _, num_id = list_stack[-1]
            body.append(para(inline(inl), 0, 40, ind=f'<w:numPr><w:ilvl w:val="0"/><w:numId w:val="{num_id}"/></w:numPr>'))
        elif in_quote:
            body.append(para(inline(inl, CELL + 1, False, MUTED), 40, 100, border_left=True, ind='<w:ind w:left="180"/>'))
        else:
            # абзац, за которым идёт таблица, держим вместе с ней
            nxt = tokens[i + 3].type if i + 3 < len(tokens) else ""
            body.append(para(inline(inl), 0, 100, keep_next=nxt == "table_open"))
        i += 2
    elif t.type == "table_open":
        rows, row = [], None
        i += 1
        while tokens[i].type != "table_close":
            tt = tokens[i]
            if tt.type == "tr_open":
                row = []
            elif tt.type == "inline":
                row.append(tt)
            elif tt.type == "tr_close":
                rows.append(row)
            i += 1
        body.append(table(rows))
    i += 1

sect = (f'<w:sectPr><w:pgSz w:w="{PAGE_W}" w:h="{PAGE_H}"/>'
        f'<w:pgMar w:top="{MARGIN}" w:right="{MARGIN}" w:bottom="{MARGIN}" w:left="{MARGIN}" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>')
NS = ('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"')
document = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document {NS}><w:body>{"".join(body)}{sect}</w:body></w:document>'

styles = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles {NS}><w:docDefaults><w:rPrDefault><w:rPr>'
          f'<w:rFonts w:ascii="{FONT}" w:hAnsi="{FONT}" w:cs="{FONT}" w:eastAsia="{FONT}"/><w:sz w:val="{BODY}"/><w:lang w:val="ru-RU"/>'
          f'</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0"/></w:pPr></w:pPrDefault></w:docDefaults></w:styles>')
link_rels = "".join(f'<Relationship Id="rIdL{k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" '
                    f'Target="{escape(u)}" TargetMode="External"/>' for k, u in enumerate(rels))
doc_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
            f"{link_rels}</Relationships>")
content_types = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                 '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                 '<Default Extension="xml" ContentType="application/xml"/>'
                 '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
                 '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>')
root_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
             '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')

def lvl(fmt, text):
    return (f'<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="{fmt}"/><w:lvlText w:val="{text}"/><w:lvlJc w:val="left"/>'
            f'<w:pPr><w:ind w:left="360" w:hanging="260"/></w:pPr>'
            f'<w:rPr><w:rFonts w:ascii="{FONT}" w:hAnsi="{FONT}"/><w:color w:val="{TEXT}"/><w:sz w:val="{BODY}"/></w:rPr></w:lvl>')


nums = '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
nums += "".join(f'<w:num w:numId="{2 + k}"><w:abstractNumId w:val="1"/>'
                f'<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>' for k in range(ol_count))
numbering = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering {NS}>'
             f'<w:abstractNum w:abstractNumId="0">{lvl("bullet", "•")}</w:abstractNum>'
             f'<w:abstractNum w:abstractNumId="1">{lvl("decimal", "%1.")}</w:abstractNum>{nums}</w:numbering>')
doc_rels = doc_rels.replace("</Relationships>", '<Relationship Id="rIdN" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>')
content_types = content_types.replace("</Types>", '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>')

with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("word/numbering.xml", numbering)
    z.writestr("[Content_Types].xml", content_types)
    z.writestr("_rels/.rels", root_rels)
    z.writestr("word/document.xml", document)
    z.writestr("word/styles.xml", styles)
    z.writestr("word/_rels/document.xml.rels", doc_rels)
print("ok", OUT, "ссылок", len(rels))
