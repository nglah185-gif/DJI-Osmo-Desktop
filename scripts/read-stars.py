import sqlite3, os, shutil, tempfile
src = r"F:\MISC\AC002.db"
tmp = os.path.join(tempfile.gettempdir(), "AC002_readonly.db")
shutil.copyfile(src, tmp)
con = sqlite3.connect("file:" + tmp + "?mode=ro", uri=True)
cur = con.cursor()
tables = [r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'")]
print("TABLES:", tables)
cols = cur.execute("PRAGMA table_info(gis_info_table)").fetchall()
print("GIS COLS:", [c[1] for c in cols])
rows = cur.execute("SELECT dcf_index, file_name, file_type, sub_type, star, result, highlight, video_index, image_index FROM gis_info_table").fetchall()
print("TOTAL GIS ROWS:", len(rows))
starred = [r for r in rows if (r[4] or 0) != 0]
print("STARRED ROWS:", len(starred))
for r in starred:
    print("STAR", r[4], "| type", r[2], r[3], "| video_index", r[7], "| image_index", r[8], "|", r[1])
print("--- video_info highlight check ---")
vcols = [c[1] for c in cur.execute("PRAGMA table_info(video_info_table)").fetchall()]
print("VIDEO COLS:", vcols)
try:
    vrows = cur.execute("SELECT ID, model_name, highlight FROM video_info_table WHERE highlight != 0").fetchall()
    print("VIDEO HIGHLIGHT ROWS:", len(vrows))
    for r in vrows[:40]:
        print("HIGHLIGHT", r[2], "| video ID", r[0], "|", r[1])
except Exception as e:
    print("video highlight query error:", e)
con.close()
os.remove(tmp)
