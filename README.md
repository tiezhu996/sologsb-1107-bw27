# 手工造纸帘纹与工序档案

围绕手工造纸的纸帘、纤维料批、抄纸工序与成纸样本建立一体化档案。界面可登记纸帘丝径与帘纹间距、推算网目密度，跟踪料批打浆度，复测抄纸帘纹偏差，并按匀度与帘纹条数复核样本。所有业务数据保存在浏览器 IndexedDB 中，无需后端服务。

## Docker 一键启动

```bash
cp .env.example .env && docker compose up -d --build
```

默认映射端口为 `21807`。启动后访问 `http://localhost:21807`。

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 前端框架 | React 18 + TypeScript 5 |
| 构建工具 | Vite 5 |
| 界面组件 | MUI 5 + Emotion |
| 路由 | React Router 6 |
| 状态管理 | Zustand 4 |
| 本地数据库 | Dexie 4 + IndexedDB |
| 部署 | Nginx + Docker Compose |

## 访问地址

`http://localhost:21807`

## 本地开发方式

```bash
cd frontend
npm install
npm run dev
```

本地开发服务器默认运行在 `http://localhost:5173`。

## 目录结构

```text
.
├── docker-compose.yml
├── .env.example
├── frontend/
│   ├── Dockerfile
│   ├── nginx.conf
│   ├── package.json
│   └── src/
│       ├── components/common/  公共可视化组件
│       ├── hooks/              筛选与单位换算
│       ├── pages/              五个业务页面
│       ├── router/             路由表
│       ├── stores/             Zustand 状态与持久化动作
│       ├── types/              四类业务模型
│       └── utils/              Stripe 计算、Dexie 与 JSON 导出
└── README.md
```

## 数据存储说明

数据存储使用 IndexedDB，Dexie 数据库名为 `gbpapermill-db`。

- `version(1)`：建立 `moulds`、`fiberBatches`、`sheetRuns`、`paperSamples` 四张表及编号、日期、状态等索引。
- `version(2)`：为四张表加入 `schemaRev` 索引，并通过 `upgrade` 将存量记录回填为版本 `2`。
- `version(3)`：新增 `relocationBatches`（搬迁批次）表，并为 `paperSamples` 加入搬迁对账字段与索引（`relocationBatchId`、`relocationStatus`、`appliedScanId` 等）；升级时旧柜位记录统一补上“存量旧柜（`BQ-0000-存量旧柜`）”搬迁批次，真实扫描导入后再改挂对应搬迁批次。
- 数据库首次创建时通过 `populate` 写入 5 张纸帘、5 个纤维料批、8 槽抄纸工序和 6 个成纸样本。
- 页面顶部的“导出 JSON”可下载五张表（含搬迁批次）的完整备份。

## 新库房搬迁对账

成纸样本页内置“新库房搬迁对账”面板，可导入离线清点器扫回的 JSON（形如 `{"scanBatchId":"...","scannedAt":"...","records":[{"sampleNo":"YZ-01","archiveBin":"新库A柜-01"}]}`），对账规则：

- **按样本编号认记录**：只与台账 `sampleNo` 匹配，台账中不存在的编号计入“未认编号”，不改动任何样本。
- **只接本机未改过的位置**：本机改过柜位（样本卡或面板“改柜位”）会置 `positionDirty`，扫描位置不会直接覆盖。
- **双方改过同一张样本**：保留双方柜格（本机侧在 `previousBin`、扫描侧在 `scannedBin`），标记“争议·未占格”，争议处理前**不占新格**；可在面板选择“用扫描格”或“留本机位”。扫描新格已被其他已落实样本占用、或扫描文件内同号给了不同格，也按争议处理。
- **漏扫样本仍留在原柜**：批次成员中未扫到的样本标“漏扫·仍在原柜”，同批次补扫可转为已落实。
- **写入失败恢复搬迁前状态**：整批对账在同一个 Dexie 事务中完成，任何一步失败整体回滚。
- **重出扫描结果不重复占格**：以扫描记录内容指纹（顺序无关）+ 扫描批次号去重，重复导入为无写入的幂等操作；只有“已落实”样本真正占用新柜格。
- 样本页卡片与工作台均显示“搬迁未落实”样本（漏扫留原柜、争议未决）。

纯对账规则位于 `src/utils/relocation.ts`（不依赖 IndexedDB，可单测），事务编排在 `src/utils/relocation-io.ts`。运行验证：

```bash
cd frontend
npm run verify:relocation
```

## 核心功能与路由表

| 路由 | 页面标题 | 核心功能 |
| --- | --- | --- |
| `/` | 工作台 | 查看纸帘状态分布、本周工序数、待复检样本与标准工序路径 |
| `/moulds` | 纸帘台帐 | 筛选纸帘，登记新纸帘，实时推算网目密度并登记修补 |
| `/fibers` | 纤维料批台账 | 按原料和打浆度筛选、比较，展开查看关联抄纸工序 |
| `/runs` | 抄纸工序记录台 | 按日期和帘号筛选，登记工序并即时判断 ±0.2 mm 帘纹偏差 |
| `/samples` | 成纸样本与透光检验卡 | 按匀度与帘纹条数分档，查看透光帘纹预览，导入离线清点结果做新库房搬迁对账、处理柜位争议 |

未匹配的地址会回到工作台。
