from pathlib import Path
p = Path("server/novel-play-api.ts")
s = p.read_text()
old = '\ttry {\n\t\tconst current = novelPlayBinding(host as NovelPlayModelHost);'
new = '\tif (route === "POST /api/novel-play/start" && (instance.starting || instance.recovery)) { send(res, 409, { error: "小说开演正在启动或等待恢复" }); return true; }\n\ttry {\n\t\tconst current = novelPlayBinding(host as NovelPlayModelHost);'
assert old in s
p.write_text(s.replace(old, new, 1))
