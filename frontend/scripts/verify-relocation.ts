/* eslint-disable no-console */
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { db } from '../src/utils/db'
import { importScanFile, resolveDispute, updateSampleBin, __setFailureHookForTests } from '../src/utils/relocation-io'
import { LEGACY_RELOCATION_BATCH_ID } from '../src/types/paper-sample'
import { planReconciliation, computeScanFingerprint } from '../src/utils/relocation'

interface Check {
  name: string
  pass: boolean
  detail?: string
}

const checks: Check[] = []
function check(name: string, pass: boolean, detail?: string) {
  checks.push({ name, pass: Boolean(pass), detail })
}

async function resetDb() {
  await db.transaction('rw', db.paperSamples, db.relocationBatches, db.moulds, db.fiberBatches, db.sheetRuns, async () => {
    await Promise.all([
      db.paperSamples.clear(),
      db.relocationBatches.clear(),
      db.moulds.clear(),
      db.fiberBatches.clear(),
      db.sheetRuns.clear(),
    ])
  })
}

function sampleSeedRows() {
  return [
    { id: 1, sampleNo: 'YZ-01', runId: 1, sizeMm: 210, stripeCount: 46, evenness: '均匀' as const, archiveBin: '甲柜-03' },
    { id: 2, sampleNo: 'YZ-02', runId: 2, sizeMm: 180, stripeCount: 52, evenness: '略花' as const, archiveBin: '甲柜-07' },
    { id: 3, sampleNo: 'YZ-03', runId: 3, sizeMm: 240, stripeCount: 39, evenness: '花' as const, archiveBin: '乙柜-02' },
    { id: 4, sampleNo: 'YZ-04', runId: 4, sizeMm: 210, stripeCount: 31, evenness: '略花' as const, archiveBin: '乙柜-05' },
  ]
}

async function seedV3() {
  await resetDb()
  const legacy = {
    id: LEGACY_RELOCATION_BATCH_ID,
    batchNo: 'BQ-0000-存量旧柜',
    scanBatchId: '',
    scanFingerprint: '',
    scannedAt: '',
    importedAt: '',
    settledCount: 0,
    missedCount: 0,
    disputedCount: 0,
    unknownCount: 0,
  }
  await db.relocationBatches.add(legacy)
  for (const row of sampleSeedRows()) {
    await db.paperSamples.add({
      ...row,
      previousBin: null,
      scannedBin: null,
      relocationBatchId: LEGACY_RELOCATION_BATCH_ID,
      relocationStatus: null,
      disputeReason: null,
      positionDirty: false,
      appliedScanId: null,
      schemaRev: 3,
    })
  }
}

async function run() {
  // 0. v2 → v3 升级：旧柜记录补上搬迁批次
  {
    const legacy = new Dexie('gbpapermill-db')
    legacy.version(1).stores({
      moulds: '++id,&mouldNo,state,wireMaterial',
      fiberBatches: '++id,&batchNo,material,beatingDegree',
      sheetRuns: '++id,&runNo,mouldId,batchId,runDate,operator',
      paperSamples: '++id,&sampleNo,runId,evenness,stripeCount',
    })
    legacy.version(2).stores({
      moulds: '++id,&mouldNo,state,wireMaterial,schemaRev',
      fiberBatches: '++id,&batchNo,material,beatingDegree,schemaRev',
      sheetRuns: '++id,&runNo,mouldId,batchId,runDate,operator,schemaRev',
      paperSamples: '++id,&sampleNo,runId,evenness,stripeCount,schemaRev',
    })
    await legacy.table('paperSamples').bulkAdd(
      sampleSeedRows().map((row) => ({ ...row, schemaRev: 2 })),
    )
    await legacy.close()
    // 触发升级（当前单例 db 尚未打开）
    const upgraded = await db.paperSamples.toArray()
    check('升级后样本 schemaRev=3', upgraded.every((s) => s.schemaRev === 3))
    check('升级后旧柜记录补上搬迁批次', upgraded.every((s) => s.relocationBatchId === LEGACY_RELOCATION_BATCH_ID))
    check('升级后对账状态为空（尚未搬迁）', upgraded.every((s) => s.relocationStatus === null))
    check('升级时写入存量旧柜批次行', Boolean(await db.relocationBatches.get(LEGACY_RELOCATION_BATCH_ID)))
  }

  // 1. 全新建库即 v3：种子样本带“存量旧柜”批次
  await seedV3()
  let samples = await db.paperSamples.toArray()
  check('全新建库样本均挂存量旧柜批次', samples.every((s) => s.relocationBatchId === LEGACY_RELOCATION_BATCH_ID))
  check('全新建库样本 schemaRev=3', samples.every((s) => s.schemaRev === 3))
  const legacy = await db.relocationBatches.get(LEGACY_RELOCATION_BATCH_ID)
  check('存量旧柜批次行存在', Boolean(legacy))

  // 2. 导入扫描：只接本机未改过的位置；漏扫留原柜
  const scan1 = JSON.stringify({
    scanBatchId: 'SCAN-A',
    scannedAt: '2026-10-05',
    records: [
      { sampleNo: 'YZ-01', archiveBin: '新库A柜-01' },
      { sampleNo: 'YZ-02', archiveBin: '新库A柜-02' },
      { sampleNo: 'YZ-03', archiveBin: '新库A柜-03' },
    ],
  })
  const r1 = await importScanFile(scan1)
  check('首次导入成功', r1.ok, r1.error)
  check('首次导入落实 3 张', r1.summary?.settledCount === 3, JSON.stringify(r1.summary))
  check('首次导入漏扫 1 张（YZ-04 留原柜）', r1.summary?.missedCount === 1)

  samples = await db.paperSamples.toArray()
  const s1 = samples.find((s) => s.sampleNo === 'YZ-01')!
  const s4 = samples.find((s) => s.sampleNo === 'YZ-04')!
  check('YZ-01 占上新格', s1.archiveBin === '新库A柜-01' && s1.relocationStatus === 'settled')
  check('YZ-01 记录原柜位', s1.previousBin === '甲柜-03')
  check('YZ-01 记录应用指纹', Boolean(s1.appliedScanId))
  check('YZ-04 漏扫仍留原柜乙柜-05', s4.archiveBin === '乙柜-05' && s4.relocationStatus === 'missed')

  // 3. 重出一份扫描结果（新文件名/不同 scannedAt）：幂等，不重复占格
  const scan1b = JSON.stringify({
    scanBatchId: 'SCAN-A',
    scannedAt: '2026-10-06',
    records: [
      { sampleNo: 'YZ-01', archiveBin: '新库A柜-01' },
      { sampleNo: 'YZ-02', archiveBin: '新库A柜-02' },
      { sampleNo: 'YZ-03', archiveBin: '新库A柜-03' },
    ],
  })
  const r1b = await importScanFile(scan1b)
  check('重导同批识别为 replayed', r1b.ok && r1b.replayed === true, JSON.stringify(r1b.summary))
  samples = await db.paperSamples.toArray()
  const binsAfterReplay = samples.filter((s) => s.relocationStatus === 'settled').map((s) => s.archiveBin).sort()
  check('重导后柜格占用不增加', JSON.stringify(binsAfterReplay) === JSON.stringify(['新库A柜-01', '新库A柜-02', '新库A柜-03']))
  check('批次仍只有一条真实搬迁批次', (await db.relocationBatches.count()) === 2)

  // 4. 本机改过位置 + 扫描给不同格 → 争议，保留双方位置，不占新格
  await seedV3()
  // 先在本机把 YZ-02 的位置改掉（搬迁前人工调整台账）
  const edit = await updateSampleBin(2, '甲柜-09')
  check('本机改柜位成功', edit.ok && edit.sample?.archiveBin === '甲柜-09')
  check('改后 positionDirty=true', edit.sample?.positionDirty === true)
  const scanConflict = JSON.stringify({
    scanBatchId: 'SCAN-B',
    records: [
      { sampleNo: 'YZ-01', archiveBin: '新库B柜-01' },
      { sampleNo: 'YZ-02', archiveBin: '新库B柜-02' },
    ],
  })
  const rc = await importScanFile(scanConflict)
  check('争议导入成功完成', rc.ok)
  check('争议数=1，落实=1，漏扫=2', rc.summary?.disputedCount === 1 && rc.summary.settledCount === 1 && rc.summary.missedCount === 2, JSON.stringify(rc.summary))
  samples = await db.paperSamples.toArray()
  const s2 = samples.find((s) => s.sampleNo === 'YZ-02')!
  check('争议样本保留本机位置', s2.archiveBin === '甲柜-09' && s2.previousBin === '甲柜-09')
  check('争议样本保留扫描位置', s2.scannedBin === '新库B柜-02')
  check('争议状态且原因为本机改过', s2.relocationStatus === 'disputed' && s2.disputeReason === 'bin-edited-locally')
  const occupant = samples.find((s) => s.archiveBin === '新库B柜-02')
  check('争议未占新格（新库B柜-02 无人 settled）', !occupant || occupant.relocationStatus !== 'settled')

  // 5a. 争议处理：采用扫描格 → 落实占格
  const resolveScan = await resolveDispute(2, 'scanned')
  check('采用扫描格成功', resolveScan.ok, resolveScan.error)
  samples = await db.paperSamples.toArray()
  const s2b = samples.find((s) => s.sampleNo === 'YZ-02')!
  check('争议处理后占扫描格', s2b.archiveBin === '新库B柜-02' && s2b.relocationStatus === 'settled' && !s2b.scannedBin)
  const batchB = (await db.relocationBatches.toArray()).find((b) => b.scanBatchId === 'SCAN-B')!
  check('批次统计争议清零', batchB.disputedCount === 0 && batchB.settledCount === 2, JSON.stringify(batchB))

  // 5b. 争议处理：留本机位 → 以本机位落实，位置仍标 dirty
  await seedV3()
  await updateSampleBin(2, '甲柜-09')
  await importScanFile(scanConflict)
  const resolveLocal = await resolveDispute(2, 'local')
  check('留本机位成功', resolveLocal.ok)
  samples = await db.paperSamples.toArray()
  const s2c = samples.find((s) => s.sampleNo === 'YZ-02')!
  check('留本机位后 settled 且柜格仍是甲柜-09', s2c.relocationStatus === 'settled' && s2c.archiveBin === '甲柜-09')
  check('留本机位仍标 positionDirty', s2c.positionDirty === true)

  // 6. 扫描新格已被占用 → bin-already-taken 争议，不重复占格
  await seedV3()
  // YZ-01 先落实到 新库C柜-01
  await importScanFile(JSON.stringify({ scanBatchId: 'SCAN-C1', records: [{ sampleNo: 'YZ-01', archiveBin: '新库C柜-01' }] }))
  // 第二张扫描也指向同一格（本机未改位置）
  const rTaken = await importScanFile(JSON.stringify({ scanBatchId: 'SCAN-C2', records: [{ sampleNo: 'YZ-02', archiveBin: '新库C柜-01' }] }))
  check('占格冲突被标争议', rTaken.summary?.disputedCount === 1)
  samples = await db.paperSamples.toArray()
  const s2t = samples.find((s) => s.sampleNo === 'YZ-02')!
  check('占格冲突原因 bin-already-taken', s2t.disputeReason === 'bin-already-taken' && s2t.relocationStatus === 'disputed')
  check('占格冲突样本未移动', s2t.archiveBin === '甲柜-07' && s2t.scannedBin === '新库C柜-01')
  const owners = samples.filter((s) => s.archiveBin === '新库C柜-01' && s.relocationStatus === 'settled')
  check('新库C柜-01 仍只有 YZ-01 一个主人', owners.length === 1 && owners[0].sampleNo === 'YZ-01')

  // 7. 扫描文件内同号不同格 → scan-duplicate 争议
  await seedV3()
  const rDup = await importScanFile(JSON.stringify({
    scanBatchId: 'SCAN-D',
    records: [
      { sampleNo: 'YZ-01', archiveBin: '新库D柜-01' },
      { sampleNo: 'YZ-01', archiveBin: '新库D柜-07' },
    ],
  }))
  check('文件内重复冲突被标争议', rDup.summary?.disputedCount === 1)
  const s1d = (await db.paperSamples.toArray()).find((s) => s.sampleNo === 'YZ-01')!
  check('重复冲突原因 scan-duplicate 且不占格', s1d.disputeReason === 'scan-duplicate' && s1d.relocationStatus === 'disputed')

  // 8. 未认编号（台账没有）→ unknown，不动任何样本
  await seedV3()
  const rUnknown = await importScanFile(JSON.stringify({
    scanBatchId: 'SCAN-E',
    records: [
      { sampleNo: 'YZ-01', archiveBin: '新库E柜-01' },
      { sampleNo: 'YZ-XX', archiveBin: '新库E柜-09' },
    ],
  }))
  check('未认编号计入 unknown=1', rUnknown.summary?.unknownCount === 1)
  check('已认编号正常落实', (await db.paperSamples.where('sampleNo').equals('YZ-01').first())?.archiveBin === '新库E柜-01')

  // 9. 无效文件不产生写入
  await seedV3()
  const rBad = await importScanFile('{not json')
  check('坏 JSON 被拒绝', !rBad.ok && /合法 JSON/.test(rBad.error ?? ''))
  const rEmpty = await importScanFile(JSON.stringify({ records: [] }))
  check('空记录被拒绝', !rEmpty.ok)
  const countBefore = await db.paperSamples.count()
  check('拒绝后样本数不变（仍 4 张）', countBefore === 4)

  // 9b. 写入中途失败：整批回滚到搬迁前状态（样本未动、批次未建）
  await seedV3()
  __setFailureHookForTests(() => {
    throw new Error('模拟存储写入失败')
  })
  const rFail = await importScanFile(JSON.stringify({
    scanBatchId: 'SCAN-FAIL',
    records: [
      { sampleNo: 'YZ-01', archiveBin: '新库Z柜-01' },
      { sampleNo: 'YZ-02', archiveBin: '新库Z柜-02' },
    ],
  }))
  __setFailureHookForTests(null)
  check('写入失败返回失败结果', !rFail.ok && /已恢复搬迁前状态/.test(rFail.error ?? ''))
  const samplesAfterFail = await db.paperSamples.toArray()
  check('回滚后 YZ-01 仍在原柜甲柜-03', samplesAfterFail.find((s) => s.sampleNo === 'YZ-01')?.archiveBin === '甲柜-03')
  check('回滚后 YZ-02 仍在原柜甲柜-07', samplesAfterFail.find((s) => s.sampleNo === 'YZ-02')?.archiveBin === '甲柜-07')
  check('回滚后样本无 appliedScanId', samplesAfterFail.every((s) => !s.appliedScanId))
  check('回滚后未留下失败批次', !(await db.relocationBatches.toArray()).some((b) => b.scanBatchId === 'SCAN-FAIL'))
  // 回滚后再次导入同一份扫描，仍能正常落实（事务未留下半成品）
  const rRetry = await importScanFile(JSON.stringify({
    scanBatchId: 'SCAN-FAIL',
    records: [
      { sampleNo: 'YZ-01', archiveBin: '新库Z柜-01' },
      { sampleNo: 'YZ-02', archiveBin: '新库Z柜-02' },
    ],
  }))
  check('回滚后重试导入成功', rRetry.ok && rRetry.summary?.settledCount === 2, rRetry.error)

  // 10. 补扫漏扫样本：状态由 missed 转 settled，占新格（同一扫描批次补扫，不引入其他批次）
  await seedV3()
  const scanFFirst = JSON.stringify({ scanBatchId: 'SCAN-F', records: [{ sampleNo: 'YZ-01', archiveBin: '新库F柜-01' }] })
  await importScanFile(scanFFirst)
  let s4f = (await db.paperSamples.toArray()).find((s) => s.sampleNo === 'YZ-04')!
  check('补扫前 YZ-04 为 missed', s4f.relocationStatus === 'missed')
  const rPatch = await importScanFile(JSON.stringify({
    scanBatchId: 'SCAN-F',
    records: [
      { sampleNo: 'YZ-01', archiveBin: '新库F柜-01' },
      { sampleNo: 'YZ-04', archiveBin: '新库F柜-04' },
    ],
  }))
  check('补扫后无新增落实但不报错', rPatch.ok)
  s4f = (await db.paperSamples.toArray()).find((s) => s.sampleNo === 'YZ-04')!
  check('补扫后 YZ-04 settled 占新格', s4f.relocationStatus === 'settled' && s4f.archiveBin === '新库F柜-04' && s4f.appliedScanId)
  const batchF = (await db.relocationBatches.toArray()).find((b) => b.scanBatchId === 'SCAN-F')!
  check('补扫更新批次统计 settled=2 且争议=0', batchF.settledCount === 2 && batchF.disputedCount === 0, JSON.stringify(batchF))
  check('未补扫的 YZ-02/YZ-03 仍漏扫留原柜', batchF.missedCount === 2)
  check('补扫不新增批次（仍只有一条真实搬迁批次）', (await db.relocationBatches.count()) === 2)

  // 11. 纯函数：指纹对记录顺序不敏感
  const fp1 = computeScanFingerprint([{ sampleNo: 'A', archiveBin: 'x' }, { sampleNo: 'B', archiveBin: 'y' }])
  const fp2 = computeScanFingerprint([{ sampleNo: 'B', archiveBin: 'y' }, { sampleNo: 'A', archiveBin: 'x' }])
  check('指纹与顺序无关', fp1 === fp2)
  const fp3 = computeScanFingerprint([{ sampleNo: 'A', archiveBin: 'x' }, { sampleNo: 'B', archiveBin: 'z' }])
  check('指纹能区分不同柜格', fp1 !== fp3)

  // 12. 纯函数：争议不占格（占用表视角）——新格不进 occupied，仍归原主
  await seedV3()
  const planSamples = await db.paperSamples.toArray()
  const plan = planReconciliation({
    samples: planSamples,
    records: [{ sampleNo: 'YZ-01', archiveBin: '甲柜-07' }], // 指向 YZ-02 当前所在（未落实）格：无已落实占用，且未 dirty → 直接接受
    scanBatchId: 'SCAN-G',
    scannedAt: '2026-10-05',
    fingerprint: computeScanFingerprint([{ sampleNo: 'YZ-01', archiveBin: '甲柜-07' }]),
    batchId: 2,
    batchNo: 'BQ-2610-01',
    importedAt: new Date().toISOString(),
  })
  // YZ-02 当前不是 settled（旧柜记录），甲柜-07 未被 settled 占用，YZ-01 未 dirty → 接受
  check('指向未落实样本的旧格不算占用冲突', plan.summary.settledCount === 1 && plan.summary.disputedCount === 0)

  // 13. 批次编号递增
  const batches = await db.relocationBatches.toArray()
  const { nextBatchNo } = await import('../src/utils/relocation')
  const no1 = nextBatchNo(batches, new Date('2026-10-05T00:00:00Z'))
  check('新批次编号形如 BQ-2610-NN', /^BQ-2610-\d{2}$/.test(no1), no1)

  // 14. 跨批次隔离：此前真实批次的漏扫成员不会被新批次改挂
  await seedV3()
  await importScanFile(JSON.stringify({ scanBatchId: 'SCAN-OLD', records: [{ sampleNo: 'YZ-01', archiveBin: '新库旧批-01' }] }))
  // 此时 YZ-02/03/04 属 SCAN-OLD 批次且 missed；新批次只扫 YZ-03
  await importScanFile(JSON.stringify({ scanBatchId: 'SCAN-NEW', records: [{ sampleNo: 'YZ-03', archiveBin: '新库新批-03' }] }))
  samples = await db.paperSamples.toArray()
  const oldBatch = (await db.relocationBatches.toArray()).find((b) => b.scanBatchId === 'SCAN-OLD')!
  const newBatch = (await db.relocationBatches.toArray()).find((b) => b.scanBatchId === 'SCAN-NEW')!
  const s2i = samples.find((s) => s.sampleNo === 'YZ-02')!
  const s3i = samples.find((s) => s.sampleNo === 'YZ-03')!
  const s4i = samples.find((s) => s.sampleNo === 'YZ-04')!
  check('YZ-02 仍属旧批次漏扫', s2i.relocationBatchId === oldBatch.id && s2i.relocationStatus === 'missed')
  check('YZ-04 仍属旧批次漏扫', s4i.relocationBatchId === oldBatch.id && s4i.relocationStatus === 'missed')
  check('YZ-03 改挂新批次并落实', s3i.relocationBatchId === newBatch.id && s3i.relocationStatus === 'settled' && s3i.archiveBin === '新库新批-03')
  check('旧批次统计 settled=1 missed=2', oldBatch.settledCount === 1 && oldBatch.missedCount === 2, JSON.stringify(oldBatch))
  check('新批次统计 settled=1 missed=0', newBatch.settledCount === 1 && newBatch.missedCount === 0, JSON.stringify(newBatch))
}

run()
  .then(() => {
    let failed = 0
    for (const c of checks) {
      console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail && !c.pass ? `  → ${c.detail}` : ''}`)
      if (!c.pass) failed += 1
    }
    console.log(`\n${checks.length - failed}/${checks.length} passed`)
    process.exit(failed ? 1 : 0)
  })
  .catch((error) => {
    console.error(error)
    process.exit(2)
  })
