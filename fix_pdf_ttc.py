"""修复 WPS 导出 PDF 在 Edge / Adobe Acrobat 中公式显示为方框的问题。

原因：WPS 把整个 .ttc 字体集合（如 cambria.ttc）嵌入为 FontFile2，
PDF 规范不允许这样做，Edge(Acrobat 引擎)无法加载，于是显示方框。
做法：从集合里取出与 /FontName 匹配的那一个字体，替换回 PDF。

用法：python fix_pdf_ttc.py 文件1.pdf [文件2.pdf ...]
     （也可传文件夹，会处理其中所有 PDF）
输出：同目录下 “原文件名_fixed.pdf”
依赖：pip install pymupdf fonttools
"""
import io
import re
import sys
from pathlib import Path

import fitz  # PyMuPDF
from fontTools.ttLib import TTCollection


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def pick_font(ttc_bytes: bytes, font_name: str):
    want = norm(font_name.split("+", 1)[-1])  # 去掉子集前缀 ABCDEF+
    coll = TTCollection(io.BytesIO(ttc_bytes))
    best = None
    for f in coll.fonts:
        names = {norm(f["name"].getDebugName(i) or "") for i in (1, 4, 6)}
        if want in names:
            best = f
            break
        if best is None and any(want in n or n in want for n in names if n):
            best = f
    best = best or coll.fonts[0]
    out = io.BytesIO()
    best.save(out)
    return out.getvalue(), best["name"].getDebugName(4)


def fix(path: Path) -> bool:
    doc = fitz.open(path)
    changed = 0
    for x in range(1, doc.xref_length()):
        try:
            obj = doc.xref_object(x)
        except Exception:
            continue
        if "/FontName" not in obj:
            continue
        m = re.search(r"/FontFile2\s+(\d+)\s+0\s+R", obj)
        if not m:
            continue
        fx = int(m.group(1))
        data = doc.xref_stream(fx)
        if not data or data[:4] != b"ttcf":
            continue
        name = re.search(r"/FontName\s*/([^\s/>\]]+)", obj).group(1)
        ttf, picked = pick_font(data, name)
        doc.update_stream(fx, ttf)
        doc.xref_set_key(fx, "Length1", str(len(ttf)))
        print(f"  {name}: 字体集合 {len(data)//1024} KB -> 单字体 '{picked}' {len(ttf)//1024} KB")
        changed += 1
    if not changed:
        print("  无需修复（没有嵌入字体集合）")
        return False
    out = path.with_name(path.stem + "_fixed.pdf")
    doc.save(out, garbage=3, deflate=True)
    print(f"  已保存: {out}")
    return True


def main(args):
    files = []
    for a in args:
        p = Path(a)
        files += sorted(p.glob("*.pdf")) if p.is_dir() else [p]
    for f in files:
        if f.stem.endswith("_fixed"):
            continue
        print(f)
        fix(f)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1:])
