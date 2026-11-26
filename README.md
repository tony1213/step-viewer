# STEP 查看器

在浏览器里查看机械 STEP / IGES 模型的本地小工具。模型由 OpenCascade（WebAssembly）在浏览器内解析，**文件不会上传到任何地方**。

**在线使用：<https://tony1213.github.io/step-viewer/>**，打开后把文件拖进页面即可。

## 本地运行

```bash
cd ~/work/step_viewer
npm install        # 只需第一次
npm start          # 构建并打开浏览器（http://127.0.0.1:5280），终端里 Ctrl+C 结束
```

把 `.step / .stp / .iges / .igs / .brep` 文件拖进窗口，或点击「打开文件」。13 MB 左右的装配体大约需要 7–10 秒。

**通过链接打开**：点工具栏「打开链接」，粘贴模型文件的网址即可。

- **分享**：打开后，地址栏里的网址形如 `https://tony1213.github.io/step-viewer/?model=<文件网址>`，发给别人就能看到同一个模型。也可以手动拼这样的链接，可选加 `&name=文件名.step` 指定显示的文件名。
- **隐私**：文件由浏览器直接从该网址下载，不经过任何其他服务器。
- **跨域（CORS）**：文件所在的服务器必须允许跨域访问（响应头 `Access-Control-Allow-Origin`），否则浏览器会拒绝读取。
  - 公开 GitHub 仓库里文件的 Raw 链接可以直接用。
  - 阿里云 OSS、腾讯云 COS 等对象存储需要在存储桶上开启 CORS。
  - 自己的 nginx 可以加 `add_header Access-Control-Allow-Origin *;`。
- **必须是直链**：网盘的分享页是网页，不是文件本身，不能直接打开。
- **http:// 链接**：在线版是 HTTPS 网页，浏览器不允许它下载 `http://` 链接的文件。这种情况请在本机运行（`npm start`）后再打开。

**大文件**：浏览器里的 OpenCascade 最多只能用 2 GB 内存，一次读不下 40–60 MB 以上的 STEP。超过 30 MB 的 STEP 会自动按零件拆开，多个线程并行解析，再按装配关系摆放；重复使用的零件只解析一次。130 MB、1200 多个零件实例的装配体大约需要 50 秒。

## 功能

- **装配结构**：按 STEP 文件还原完整的装配层级（多层子装配、中文零件名），可显示 / 隐藏、仅显示、设为透明、搜索。
- **查看**：旋转 / 平移 / 以光标为中心缩放，双击设旋转中心，标准视图（1–7 键），透视 / 正交，「上方向」可选 ±X/±Y/±Z。
- **显示**：着色 + 边线、仅着色、仅边线，按零件着色，X 光。
- **测量（M）**：
  - 点击一个面：显示面积和周长。平面的圆弧边界做了精确修正，结果与 SolidWorks 一致。
  - 依次点击两点：显示距离和 ΔX/ΔY/ΔZ。如果两点所在的面是平行平面，同时给出两平面的垂直距离。
  - 鼠标靠近孔边时吸附到圆心，并显示孔径。按住 Shift 可关闭吸附。
- **剖切**：沿 X/Y/Z 方向切开，实体的切面会填充颜色。
- **爆炸视图**：可按顶层组件或按所有零件拆开。
- **截图**：导出 PNG（包含测量标注）。
- **导出 GLB**：只导出可见零件，单位为米。

鼠标操作：左键旋转，右键 / 中键平移，滚轮缩放。快捷键见界面右上角「帮助」。

## 开发

```bash
npm run dev        # 开发服务器
npm test           # 单元测试
STEP_SAMPLE=/path/to/model.STEP npm test   # 额外用真实文件做验收（含按零件读取与整体读取的对比）
STEP_SAMPLE_LARGE=/path/to/big.STEP npm test   # 大文件按零件读取的验收（几分钟）
npm run build      # 类型检查 + 构建到 dist/
```

页面地址加 `?split=1` 或 `?split=0`，可以强制或禁止按零件读取，用于排查问题。

推送到 `main` 后，GitHub Actions（`.github/workflows/deploy.yml`）会测试、构建并部署到 GitHub Pages。

主要目录：
- `src/core`：纯逻辑，可在 Node 中测试：
  - STEP 装配结构解析；大文件按零件拆分和摆放（`step-split.ts`）；
  - B-rep 边线提取与圆识别；
  - 面积、周长和距离计算。
- `src/worker`：在 Web Worker 中运行 OpenCascade（大文件再分给多个 `mesh.worker` 并行处理）。
- `src/remote.ts`：通过网址下载模型（「打开链接」和 `?model=`），可在 Node 中测试。
- `src/viewer`：three.js 场景，以及测量、剖切、爆炸、导出等功能。
- `src/ui`：装配树和信息面板。

依赖的开源库：
- [occt-import-js](https://github.com/kovacsv/occt-import-js)（LGPL-2.1，OpenCascade）
- [three.js](https://threejs.org)
- [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh)
