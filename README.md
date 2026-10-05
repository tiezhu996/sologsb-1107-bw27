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
- `version(3)`：为 `paperSamples` 增加 `baseBin`（对账基准位）、`scannedBin`、`binConflict`、`conflictBin`、`relocationBatch`、`lastScanBatch` 柜位合并字段并加索引；新增 `appMeta` 表登记已接收的清点批次。升级时旧柜位记录以现柜位回填基准位，并补上搬迁批次 `BQ-OLD`。
- 数据库首次创建时通过 `populate` 写入 5 张纸帘、5 个纤维料批、8 槽抄纸工序和 6 个成纸样本。
- 页面顶部的“导出 JSON”可下载全部表（含 `appMeta`）的完整备份。

## 搬迁柜格对账

成纸样本页支持“导入清点扫描”，读取离线清点器导出的 JSON：

```json
{
  "batch": "BQ-20261005-01",
  "scannedAt": "2026-10-05T09:30:00.000Z",
  "scannerId": "QDQ-02",
  "records": [
    { "sampleNo": "YZ-01", "bin": "新库-A01" }
  ]
}
```

对账按样本编号匹配，以 `baseBin`（上次对账基准位）做三方合并：

- 本机未改过柜位：直接接受清点器的新柜位；
- 仅本机改过、清点器未改：保留本机柜位；
- 两边都改：改到同一格自动落实；改到不同格则保留双方位置并标出**柜位争议**，争议处理前不占新格；
- 漏扫的已搬迁样本仍留在原柜，作为“未落实”样本显示，不换格、不标争议；
- 扫描中出现台账没有的编号，仅在对账报告中提示，不建记录。

整个对账在一个 Dexie 读写事务内完成，任一写入失败即全部回滚到搬迁前状态；同一搬迁批次重复导入幂等返回，柜位与批次都不会重复写入。争议可在样本页选择“保留本机位”或“采用清点器位”。样本页和工作台均列出未落实样本（争议未决或最新批次漏扫）。

## 核心功能与路由表

| 路由 | 页面标题 | 核心功能 |
| --- | --- | --- |
| `/` | 工作台 | 查看纸帘状态分布、本周工序数、待复检样本与标准工序路径 |
| `/moulds` | 纸帘台帐 | 筛选纸帘，登记新纸帘，实时推算网目密度并登记修补 |
| `/fibers` | 纤维料批台账 | 按原料和打浆度筛选、比较，展开查看关联抄纸工序 |
| `/runs` | 抄纸工序记录台 | 按日期和帘号筛选，登记工序并即时判断 ±0.2 mm 帘纹偏差 |
| `/samples` | 成纸样本与透光检验卡 | 按匀度与帘纹条数分档，查看透光帘纹预览和归档位置，导入清点扫描做搬迁柜格对账与争议处理 |

未匹配的地址会回到工作台。
