# 内存对照:真实扩展宿主 A/B

目的:验证 `src/shared/file-cache.ts`(mtime+size 命中跳过解析、`evictForRemovedSessions()`)与
可见会话裁剪在**真实扩展宿主进程**里的收益,而不是只看模块级基准。

## 方法与口径

- 同一夹具两次对照:老构建 `66ca061` 与当前构建 HEAD。
- 夹具:24 个会话,每个 `chat-log.json` 约 0.4MB(`scripts/ms-mem-fixture.mjs`);
  `sessions` 阶段 24 个全部可见,`close` 阶段只保留 6 个可见、其余 18 个标记已关闭。
- 读数:用 `--inspect-extensions=<port>` 连扩展宿主,每次先
  `HeapProfiler.collectGarbage` 再读 `process.memoryUsage()` / `process.cpuUsage()`,
  每 5s 采样一次。脚本:`scripts/ms-mem-ab.mjs`(依赖 `scripts/cdp-eval.mjs raw`)。

```bash
# 1) 起一个隔离窗口(独立 user-data-dir / extensions-dir,不碰在用的 Cursor)
Cursor --user-data-dir=$ISO/ud-a6 --extensions-dir=$ISO/ext-new \
  --remote-debugging-port=9346 --inspect-extensions=9406 $ISO/ws-shared

# 2) 同一夹具跑对照
node scripts/ms-mem-ab.mjs --port 9406 --root $ISO/data-heart --ws $ISO/ws-shared \
  --label 新构建-HEAD --seconds 45 --start-phase both
```

> 注意:第 1 步会弹出一个额外的可见 Cursor 窗口。这套对照只在需要重新取证时跑,
> 日常回归用 `npm run bench:memory` 即可。

## 结果

模块级基准(`npm run bench:memory`,24 会话 = 6 可见 + 18 已关闭,各 15s 独立进程):

| 指标 | 老构建 | 新构建 |
|---|---|---|
| chat-log 解析次数 | 720 | 6 |
| 解析字节数 | 335.8MB | 2.8MB |
| heapUsed 峰值 | 32.3MB | 6.8MB |
| RSS 起→末 | 35.3→85.5MB | 35.4→43.3MB |

真实扩展宿主(inspector GC 后读数,单位 MB):

| 阶段 | 老构建 66ca061 | 新构建 HEAD |
|---|---|---|
| 24 会话全部可见 | heapUsed 起 100.0 / 末 94.1 / 峰 96.8;RSS 238.8 / 195.3 / 229.7;CPU 4880ms(10.5%) | heapUsed 97.8 / 97.8 / 98.6;RSS 177.0 / 158.3 / 158.3;CPU 2479ms(5.0%) |
| 全部会话已关闭 | heapUsed 93.8 / 93.8 / 96.2;RSS 195.0 / 194.6 / 198.5;CPU 2853ms(6.1%) | heapUsed 97.3 / 97.3 / 97.5;RSS 303.7 / 304.3 / 304.3;CPU 2118ms(4.6%) |

## 结论(含未证实部分)

1. **可见会话多时收益明确**:新构建 CPU 时间约为老构建一半(2479ms vs 4880ms),
   RSS 更低,与 file-cache 跳过重复解析的行为一致。
2. **"已关闭会话占内存"在宿主层未被复现**:该阶段两者 GC 后 heapUsed 基本持平
   (97.3 vs 93.8MB)。RSS 不能当结论——V8 不把页归还系统,且两组是不同进程,基线本就不同。
3. 目前"已关闭会话占内存"只有**模块级**证据(`bench:memory` 直接驱动解析路径)。
   端到端还缺一个能强制宿主遍历已关闭会话日志的夹具(例如面板刷新或搜索路径);
   本夹具下宿主根本没有读这些会话的日志,因此没有差异可测。

## 复现注意

- 数据根必须用 `MULTISESSION_DATA_ROOT` 指向隔离目录,避免污染 `~/.multisession`。
- 老构建硬编码 `os.homedir()/.multisession`,要复现需先给它打上
  `MULTISESSION_DATA_ROOT` 覆盖(仅用于隔离测量,不进仓库)。
- 扩展宿主偶发被重启:日志尾部可能是 `Extension host ... exited with code: 0`,
  此时读数会中途空串,脚本已带重试;必要时用 `--start-phase close` 只补跑后半段。
