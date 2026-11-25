#!/usr/bin/env python3
"""notes_*.png (1644x1472) からアトラス座標表を生成する。

手法: アルファ>12 の連結成分を抽出し、形・対称性・色相・大きさで分類する。
  - シェブロン(フリック矢印): fill 0.70-0.80, w>=120, h>=130
      左右反転との重なり >=0.98 -> 縦向き(up), それ未満 -> 斜め(diag)
      黄色(G>200 かつ B<170) -> クリティカル, それ以外 -> ピンク(通常)
      (向き,色)グループ内で幅の昇順 -> width 1..6
  - ノーツ本体: fill>=0.90 の矩形 (w 260-320)
      色相で long(緑)/crit(黄)/flick(桃)/tap(青紫) に分類し、
      高さ >=100 を head, <100 を small とする
  - 宝石: ほぼ正方形・fill 0.60-0.68・小さいもの。色相で long/crit/flick、
      大きさで _l/_s を付ける
分類根拠は docs/DESIGN.md の「アトラス分類」節に記録する。
使い方: python3 tools/make_atlas.py
"""
import json, os, sys
import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def classify_components(path):
    im = np.array(Image.open(path).convert("RGBA"))
    H, W = im.shape[:2]
    lab, n = ndimage.label(im[:, :, 3] > 12)
    objs = ndimage.find_objects(lab)
    comps = []
    for i, sl in enumerate(objs, 1):
        ysl, xsl = sl
        w = xsl.stop - xsl.start; h = ysl.stop - ysl.start
        area = int((lab[sl] == i).sum())
        if area < 200:
            continue
        mask = lab[sl] == i
        px = im[sl][mask]
        opaque = px[px[:, 3] > 100]
        # 色の判定は「白っぽい内面」ではなく彩度の高い画素(縁・塗り)で行う。
        # 背の高い本体は中央がほぼ白のため、全体平均では色相を誤る。
        sat = opaque[(opaque[:, :3].max(axis=1) - opaque[:, :3].min(axis=1)) > 50]
        use = sat if len(sat) >= 20 else opaque
        mean = use[:, :3].mean(axis=0) if len(use) else np.array([0, 0, 0])
        sym = float((mask & np.fliplr(mask)).sum() / max(1, mask.sum()))
        comps.append(dict(x=int(xsl.start), y=int(ysl.start), w=int(w), h=int(h),
                          area=area, fill=area / (w * h), sym=sym,
                          rgb=[float(v) for v in mean]))
    return comps, (W, H)

def hue_family(rgb):
    r, g, b = rgb
    if g >= r and g >= b:
        return "long"      # teal/green: green channel dominates
    if b >= r and b >= g:
        return "tap"       # blue-purple: blue channel dominates
    # red dominates (彩度の高い画素の平均): yellow (crit) は緑も高い、pink (flick) は緑が低い
    return "crit" if g > 170 else "flick"

def build(png_path):
    comps, (W, H) = classify_components(png_path)
    sprites = {}

    def add(name, c, pad=2):
        x = max(0, c["x"] - pad); y = max(0, c["y"] - pad)
        w = min(W - x, c["w"] + 2 * pad); h = min(H - y, c["h"] + 2 * pad)
        sprites[name] = {"x": x, "y": y, "w": w, "h": h,
                         "u0": x / W, "v0": y / H, "u1": (x + w) / W, "v1": (y + h) / H,
                         "src": [c["x"], c["y"], c["w"], c["h"]]}

    chev = [c for c in comps if 120 <= c["w"] and c["h"] >= 130 and 0.68 <= c["fill"] <= 0.87]
    groups = {}
    for c in chev:
        direction = "up" if c["sym"] >= 0.98 else "diag"
        fam = "crit" if (c["rgb"][1] > 200 and c["rgb"][2] < 170) else "flick"
        groups.setdefault((direction, fam), []).append(c)
    for (direction, fam), lst in sorted(groups.items()):
        lst.sort(key=lambda c: c["w"])
        assert len(lst) == 6, f"chevron group {(direction, fam)} has {len(lst)} items: {lst}"
        for idx, c in enumerate(lst, 1):
            add(f"flick_{direction}_{fam}_{idx}", c)

    bodies = [c for c in comps if c["fill"] >= 0.90 and 250 <= c["w"] <= 330 and c["h"] <= 160]
    # 同じ色相の中で高さ順に small/head を振る(スキンで絶対高さが違うため)。
    by_fam = {}
    for c in bodies:
        by_fam.setdefault(hue_family(c["rgb"]), []).append(c)
    for fam, lst in by_fam.items():
        lst.sort(key=lambda c: c["h"])
        for i, c in enumerate(lst):
            size = "small" if i == 0 and len(lst) > 1 else ("mid" if i == 1 and len(lst) > 2 else "head")
            add(f"body_{fam}_{size}", c)

    gems = [c for c in comps if c["w"] <= 170 and c["h"] <= 170 and 0.58 <= c["fill"] <= 0.70
            and 0.8 <= c["w"] / c["h"] <= 1.2]
    for c in gems:
        fam = hue_family(c["rgb"])
        size = "l" if c["w"] >= 120 else "s"
        add(f"gem_{fam}_{size}", c)

    return {"image": os.path.basename(png_path), "width": W, "height": H,
            "sprites": sprites}

def main():
    for skin, name in [(1, "notes_01"), (2, "notes_02")]:
        png = os.path.join(ROOT, "assets", f"{name}.png")
        atlas = build(png)
        out = os.path.join(ROOT, "assets", f"{name}.json")
        with open(out, "w", encoding="utf-8") as f:
            json.dump(atlas, f, ensure_ascii=False, indent=1)
        print(f"{name}: {len(atlas['sprites'])} sprites -> {out}")
        for k in sorted(atlas["sprites"]):
            s = atlas["sprites"][k]
            print(f"  {k:22s} x={s['x']:4d} y={s['y']:4d} w={s['w']:3d} h={s['h']:3d}")

if __name__ == "__main__":
    main()
