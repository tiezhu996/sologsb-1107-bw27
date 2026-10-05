import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Box, Button, Card, CardContent, Chip, Grid, Stack, TextField, Tooltip, Typography } from '@mui/material'
import { GrainStripePreview } from '../components/common/GrainStripePreview'
import { RulerInput } from '../components/common/RulerInput'
import { StatBadge } from '../components/common/StatBadge'
import { useUnitConvert } from '../hooks/useUnitConvert'
import { useMouldStore } from '../stores/mouldStore'
import { useRunStore } from '../stores/runStore'
import { useSampleStore } from '../stores/sampleStore'
import { EVENNESS_LEVELS, type EvennessLevel, type PaperSample, type PaperSampleInput } from '../types/paper-sample'
import { isGapOutOfTolerance } from '../utils/stripe'
import { isSampleUnsettled, parseScanFile } from '../utils/reconcile'
import { buildDemoScanFile } from '../utils/scanFixture'

const emptySampleForm: PaperSampleInput = {
  sampleNo: '',
  runId: 1,
  sizeMm: 210,
  stripeCount: 45,
  evenness: '均匀',
  archiveBin: '待归档-01',
}

function stripeTier(count: number): { label: string; color: 'success' | 'info' | 'warning' } {
  if (count >= 50) return { label: '密纹档', color: 'success' }
  if (count >= 40) return { label: '中密档', color: 'info' }
  return { label: '疏纹档', color: 'warning' }
}

export default function SampleCards() {
  const samples = useSampleStore((state) => state.paperSamples)
  const error = useSampleStore((state) => state.error)
  const notice = useSampleStore((state) => state.notice)
  const loadSamples = useSampleStore((state) => state.loadSamples)
  const addSample = useSampleStore((state) => state.addSample)
  const changeLocalBin = useSampleStore((state) => state.changeLocalBin)
  const importScanFile = useSampleStore((state) => state.importScanFile)
  const settleConflictKeepLocal = useSampleStore((state) => state.settleConflictKeepLocal)
  const settleConflictKeepScanned = useSampleStore((state) => state.settleConflictKeepScanned)
  const clearNotice = useSampleStore((state) => state.clearNotice)
  const runs = useRunStore((state) => state.sheetRuns)
  const runError = useRunStore((state) => state.error)
  const loadRuns = useRunStore((state) => state.loadRuns)
  const moulds = useMouldStore((state) => state.moulds)
  const mouldError = useMouldStore((state) => state.error)
  const loadMoulds = useMouldStore((state) => state.loadMoulds)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<PaperSampleInput>(emptySampleForm)
  const [evennessFilter, setEvennessFilter] = useState<EvennessLevel | '全部'>('全部')
  const [stripeFloor, setStripeFloor] = useState(0)
  const [onlyUnsettled, setOnlyUnsettled] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [editingBinId, setEditingBinId] = useState<number | null>(null)
  const [binDraft, setBinDraft] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { mmToCm, formatGrammage } = useUnitConvert()

  useEffect(() => {
    void loadSamples()
    void loadRuns()
    void loadMoulds()
  }, [loadMoulds, loadRuns, loadSamples])

  const runById = useMemo(() => new Map(runs.map((run) => [run.id, run])), [runs])
  const mouldById = useMemo(() => new Map(moulds.map((mould) => [mould.id, mould])), [moulds])
  const latestBatch = useMemo(
    () => samples.reduce<string | undefined>((max, sample) => {
      const current = sample.lastScanBatch
      if (!current) return max
      return !max || current > max ? current : max
    }, undefined),
    [samples],
  )
  const unsettledSamples = useMemo(
    () => samples.filter((sample) => isSampleUnsettled(sample, latestBatch)),
    [latestBatch, samples],
  )
  const conflictSamples = useMemo(() => samples.filter((sample) => sample.binConflict), [samples])
  const filteredSamples = useMemo(
    () => samples.filter(
      (sample) =>
        (evennessFilter === '全部' || sample.evenness === evennessFilter) &&
        sample.stripeCount >= stripeFloor &&
        (!onlyUnsettled || isSampleUnsettled(sample, latestBatch)),
    ),
    [evennessFilter, latestBatch, onlyUnsettled, samples, stripeFloor],
  )
  const denseCount = samples.filter((sample) => sample.stripeCount >= 50).length
  const recheckCount = samples.filter((sample) => sample.evenness !== '均匀').length

  const updateForm = <K extends keyof PaperSampleInput,>(key: K, value: PaperSampleInput[K]) => {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const handleSubmit = async () => {
    if (!form.sampleNo.trim() || !form.archiveBin.trim() || form.sizeMm <= 0 || form.stripeCount <= 0) return
    setSubmitting(true)
    const created = await addSample({ ...form, sampleNo: form.sampleNo.trim(), archiveBin: form.archiveBin.trim() })
    setSubmitting(false)
    if (created) {
      setForm(emptySampleForm)
      setShowForm(false)
    }
  }

  const handleScanFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0]
    event.target.value = ''
    if (!picked) return
    setImporting(true)
    try {
      const text = await picked.text()
      const parsed = parseScanFile(text)
      await importScanFile(parsed)
    } catch (reason) {
      // 解析错误不涉及写入，直接提示，不需要回滚
      useSampleStore.setState({ error: reason instanceof Error ? reason.message : '扫描结果读取失败' })
    } finally {
      setImporting(false)
    }
  }

  const handleDemoImport = async () => {
    setImporting(true)
    const demo = buildDemoScanFile(samples.map((sample) => sample.sampleNo))
    await importScanFile(demo)
    setImporting(false)
  }

  const saveBinDraft = async (sample: PaperSample) => {
    if (sample.id === undefined) return
    if (binDraft.trim() && binDraft.trim() !== sample.archiveBin) {
      await changeLocalBin(sample.id, binDraft)
    }
    setEditingBinId(null)
  }

  const errorMessage = error ?? runError ?? mouldError

  return (
    <Stack spacing={3}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, alignItems: { xs: 'flex-start', md: 'center' }, flexDirection: { xs: 'column', md: 'row' } }}>
        <Box>
          <Typography component="h1" variant="h3" color="#344a34">成纸样本与透光检验卡</Typography>
          <Typography color="text.secondary" sx={{ mt: 0.75 }}>按匀度与帘纹条数分档，复核样本对应的抄纸工序和归档位置。</Typography>
        </Box>
        <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap>
          <Button variant="outlined" size="large" onClick={() => fileInputRef.current?.click()} disabled={importing} data-testid="import-scan">
            {importing ? '对账中…' : '导入清点扫描'}
          </Button>
          <Tooltip title="按当前台账编号生成一份示例扫描结果（含漏扫与未知编号）">
            <Button variant="outlined" size="large" onClick={handleDemoImport} disabled={importing} data-testid="demo-scan">
              示例扫描
            </Button>
          </Tooltip>
          <Button variant="contained" size="large" onClick={() => setShowForm((current) => !current)} data-testid="new-sample">
            {showForm ? '收起登记' : '新建样本'}
          </Button>
          <input ref={fileInputRef} type="file" accept="application/json,.json" hidden onChange={handleScanFile} data-testid="scan-file-input" />
        </Stack>
      </Box>

      {errorMessage && <Alert severity="warning">{errorMessage}</Alert>}
      {notice && !error && (
        <Alert severity="success" onClose={clearNotice} data-testid="reconcile-report">{notice}</Alert>
      )}

      {showForm && (
        <Card data-testid="form-sample" sx={{ borderColor: '#9eb096' }}>
          <CardContent sx={{ p: { xs: 2, md: 3 } }}>
            <Typography variant="h5" sx={{ mb: 2 }}>登记成纸样本</Typography>
            <Grid container spacing={2}>
              <Grid item xs={12} md={3}><TextField fullWidth label="样本编号" value={form.sampleNo} onChange={(event) => updateForm('sampleNo', event.target.value)} inputProps={{ 'data-testid': 'field-sampleNo' }} /></Grid>
              <Grid item xs={12} md={4}>
                <TextField select fullWidth label="对应工序" value={form.runId} onChange={(event) => updateForm('runId', Number(event.target.value))} SelectProps={{ native: true, inputProps: { 'data-testid': 'field-runId' } }}>
                  {!runs.some((run) => run.id === form.runId) && <option value={form.runId}>工序数据载入中</option>}
                  {runs.map((run) => <option key={run.id} value={run.id}>{run.runNo} · {run.runDate}</option>)}
                </TextField>
              </Grid>
              <Grid item xs={6} md={2}><TextField fullWidth type="number" label="样本尺寸" value={form.sizeMm} onChange={(event) => updateForm('sizeMm', Number(event.target.value))} inputProps={{ min: 20, max: 1000, step: 1, 'data-testid': 'field-sizeMm' }} InputProps={{ endAdornment: 'mm' }} /></Grid>
              <Grid item xs={6} md={3}><TextField fullWidth type="number" label="帘纹条数" value={form.stripeCount} onChange={(event) => updateForm('stripeCount', Number(event.target.value))} inputProps={{ min: 1, max: 300, step: 1, 'data-testid': 'field-stripeCount' }} /></Grid>
              <Grid item xs={6} md={3}>
                <TextField select fullWidth label="匀度" value={form.evenness} onChange={(event) => updateForm('evenness', event.target.value as EvennessLevel)} SelectProps={{ native: true, inputProps: { 'data-testid': 'field-evenness' } }}>
                  {EVENNESS_LEVELS.map((option) => <option key={option} value={option}>{option}</option>)}
                </TextField>
              </Grid>
              <Grid item xs={12} md={5}><TextField fullWidth label="存档位" value={form.archiveBin} onChange={(event) => updateForm('archiveBin', event.target.value)} inputProps={{ 'data-testid': 'field-archiveBin' }} /></Grid>
            </Grid>
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1.5, mt: 2.5 }}>
              <Button onClick={() => setShowForm(false)}>取消</Button>
              <Button variant="contained" onClick={handleSubmit} disabled={submitting} data-testid="submit-sample">保存样本</Button>
            </Box>
          </CardContent>
        </Card>
      )}

      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
        <StatBadge label="样本总数" value={samples.length} detail="档案柜入库数量" />
        <StatBadge label="密纹样本" value={denseCount} detail="帘纹条数不少于 50" tone="bamboo" />
        <StatBadge label="待复检" value={recheckCount} detail="匀度非“均匀”" tone={recheckCount ? 'warning' : 'neutral'} />
        <StatBadge label="未落实样本" value={unsettledSamples.length} detail="争议未处理或漏扫留柜" tone={unsettledSamples.length ? 'warning' : 'neutral'} />
      </Box>

      {conflictSamples.length > 0 && (
        <Card data-testid="conflict-panel" sx={{ borderColor: '#d9a928', bgcolor: '#fff8e6' }}>
          <CardContent sx={{ p: { xs: 2, md: 2.5 } }}>
            <Typography variant="h5" sx={{ mb: 0.5 }}>柜位争议（{conflictSamples.length}）</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              本机台账与清点器同时改了同一张样本。争议处理前样本不占新格，双方位置都保留。
            </Typography>
            <Stack spacing={1.5}>
              {conflictSamples.map((sample) => (
                <Box key={sample.id ?? sample.sampleNo} data-testid="conflict-row" sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Box>
                    <Typography sx={{ fontWeight: 700 }}>{sample.sampleNo}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      本机位置 <Chip size="small" label={sample.archiveBin} sx={{ mx: 0.5 }} />
                      清点器位置 <Chip size="small" color="warning" label={sample.conflictBin ?? sample.scannedBin} sx={{ mx: 0.5 }} />
                    </Typography>
                  </Box>
                  <Stack direction="row" spacing={1}>
                    <Button size="small" variant="outlined" onClick={() => sample.id !== undefined && settleConflictKeepLocal(sample.id)} data-testid={`keep-local-${sample.sampleNo}`}>
                      保留本机位
                    </Button>
                    <Button size="small" variant="contained" color="warning" onClick={() => sample.id !== undefined && settleConflictKeepScanned(sample.id)} data-testid={`keep-scan-${sample.sampleNo}`}>
                      采用清点器位
                    </Button>
                  </Stack>
                </Box>
              ))}
            </Stack>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent sx={{ p: { xs: 2, md: 2.5 } }}>
          <Grid container spacing={2} alignItems="center">
            <Grid item xs={12} sm={5} md={3}>
              <TextField select fullWidth size="small" label="匀度筛选" value={evennessFilter} onChange={(event) => setEvennessFilter(event.target.value as EvennessLevel | '全部')} SelectProps={{ native: true }}>
                <option value="全部">全部匀度</option>
                {EVENNESS_LEVELS.map((option) => <option key={option} value={option}>{option}</option>)}
              </TextField>
            </Grid>
            <Grid item xs={12} sm={7} md={4}>
              <RulerInput label="最低帘纹条数" value={stripeFloor} onChange={setStripeFloor} unit="条" min={0} max={300} step={1} compact />
            </Grid>
            <Grid item xs={6} md={2}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}><Typography variant="body2" color="text.secondary">当前记录</Typography><Typography variant="h5" data-testid="count-sample">{filteredSamples.length}</Typography></Box>
            </Grid>
            <Grid item xs={6} md={3}>
              <Button fullWidth variant={onlyUnsettled ? 'contained' : 'outlined'} color={onlyUnsettled ? 'warning' : 'primary'} onClick={() => setOnlyUnsettled((value) => !value)} data-testid="filter-unsettled">
                {onlyUnsettled ? '只看未落实 · 已开启' : '只看未落实'}
              </Button>
            </Grid>
          </Grid>
        </CardContent>
      </Card>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))', xl: 'repeat(3, minmax(0, 1fr))' }, gap: 2 }}>
        {filteredSamples.map((sample) => {
          const run = runById.get(sample.runId)
          const mould = run ? mouldById.get(run.mouldId) : undefined
          const tier = stripeTier(sample.stripeCount)
          const gap = run?.measuredGap ?? mould?.stripeGap ?? 1
          const missedInLatest = latestBatch !== undefined && !sample.binConflict && sample.lastScanBatch !== latestBatch
          return (
            <Card key={sample.id ?? sample.sampleNo} data-testid="row-sample" sx={{ bgcolor: sample.binConflict ? '#fff3d6' : sample.evenness === '均匀' ? '#fffdf7' : '#fff9e8', borderColor: sample.binConflict ? '#d9a928' : undefined }}>
              <CardContent sx={{ p: 2.25 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1.5, alignItems: 'flex-start', mb: 1.5 }}>
                  <Box>
                    <Typography variant="h6" sx={{ fontWeight: 800 }}>{sample.sampleNo}</Typography>
                    <Typography variant="caption" color="text.secondary">工序 {run?.runNo ?? '待关联'} · {run?.runDate ?? '日期待补'}</Typography>
                  </Box>
                  <Stack spacing={0.5} alignItems="flex-end">
                    <Chip size="small" color={tier.color} label={tier.label} />
                    {sample.binConflict && <Chip size="small" color="warning" label="柜位争议" data-testid={`conflict-chip-${sample.sampleNo}`} />}
                    {missedInLatest && <Chip size="small" variant="outlined" color="warning" label="漏扫留柜" data-testid={`missed-chip-${sample.sampleNo}`} />}
                  </Stack>
                </Box>
                <GrainStripePreview
                  gap={gap}
                  wireDiameter={mould?.wireDiameter ?? 0.25}
                  density={mould?.meshDensity}
                  stripeCount={sample.stripeCount}
                  direction={run?.stripeDirection === '横帘纹' ? 'horizontal' : 'vertical'}
                />
                <Grid container spacing={1} sx={{ mt: 1 }}>
                  <Grid item xs={6}><Typography variant="caption" color="text.secondary">帘纹条数</Typography><Typography sx={{ fontWeight: 700 }}>{sample.stripeCount} 条</Typography></Grid>
                  <Grid item xs={6}><Typography variant="caption" color="text.secondary">匀度</Typography><Typography sx={{ fontWeight: 700, color: sample.evenness === '均匀' ? 'success.dark' : 'warning.dark' }}>{sample.evenness}</Typography></Grid>
                  <Grid item xs={6}><Typography variant="caption" color="text.secondary">样本尺寸</Typography><Typography>{sample.sizeMm} mm · {mmToCm(sample.sizeMm)} cm</Typography></Grid>
                  <Grid item xs={6}><Typography variant="caption" color="text.secondary">纸页克重</Typography><Typography>{run ? formatGrammage(run.grammage) : '待补'}</Typography></Grid>
                </Grid>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, alignItems: 'center', mt: 1.5, flexWrap: 'wrap' }}>
                  {editingBinId === sample.id ? (
                    <Stack direction="row" spacing={1} alignItems="center">
                      <TextField
                        size="small"
                        label="本机柜格"
                        defaultValue={sample.archiveBin}
                        autoFocus
                        onChange={(event) => setBinDraft(event.target.value)}
                        onKeyDown={(event) => { if (event.key === 'Enter') void saveBinDraft(sample) }}
                        inputProps={{ 'data-testid': `bin-input-${sample.sampleNo}` }}
                      />
                      <Button size="small" onClick={() => void saveBinDraft(sample)} data-testid={`bin-save-${sample.sampleNo}`}>保存</Button>
                      <Button size="small" onClick={() => setEditingBinId(null)}>取消</Button>
                    </Stack>
                  ) : (
                    <Chip
                      size="small"
                      variant="outlined"
                      label={`存档 ${sample.archiveBin}`}
                      onClick={() => { setEditingBinId(sample.id ?? null); setBinDraft(sample.archiveBin) }}
                      data-testid={`bin-chip-${sample.sampleNo}`}
                    />
                  )}
                  {run && isGapOutOfTolerance(run.deviation) && <Chip size="small" color="warning" label={`偏差 ${run.deviation > 0 ? '+' : ''}${run.deviation.toFixed(2)} mm`} />}
                </Box>
                <Box sx={{ mt: 1, display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                  {sample.relocationBatch
                    ? <Chip size="small" variant="outlined" label={`批次 ${sample.relocationBatch}`} data-testid={`batch-chip-${sample.sampleNo}`} />
                    : <Chip size="small" variant="outlined" label="搬迁前旧柜" />}
                  {sample.binConflict && sample.conflictBin && (
                    <Chip size="small" color="warning" variant="outlined" label={`清点器主张 ${sample.conflictBin}`} />
                  )}
                </Box>
              </CardContent>
            </Card>
          )
        })}
        {filteredSamples.length === 0 && (
          <Card sx={{ gridColumn: '1 / -1' }}><CardContent sx={{ textAlign: 'center', py: 7 }}><Typography color="text.secondary">没有符合当前匀度与帘纹条数分档的样本</Typography></CardContent></Card>
        )}
      </Box>
    </Stack>
  )
}
