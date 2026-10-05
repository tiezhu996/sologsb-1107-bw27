import { useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import type { DisputeReason, PaperSample, RelocationStatus } from '../../types/paper-sample'
import { LEGACY_RELOCATION_BATCH_ID } from '../../types/paper-sample'
import type { RelocationBatch } from '../../types/relocation-batch'
import { useSampleStore } from '../../stores/sampleStore'

const statusChip: Record<RelocationStatus, { label: string; color: 'warning' | 'error' | 'success' }> = {
  missed: { label: '漏扫·留原柜', color: 'warning' },
  disputed: { label: '争议·未占格', color: 'error' },
  settled: { label: '已落实', color: 'success' },
}

const disputeText: Record<DisputeReason, string> = {
  'bin-edited-locally': '双方都改过位置',
  'bin-already-taken': '新格已被占用',
  'scan-duplicate': '扫描记录重复冲突',
}

function buildDemoScan(samples: PaperSample[]): string {
  const rows = samples.map((sample, index) => {
    // 演示：前两张平移到“新库A柜”，第三张（若本机改过）制造争议，其余漏扫
    if (index < 2) return { sampleNo: sample.sampleNo, archiveBin: `新库A柜-${String(index + 1).padStart(2, '0')}` }
    if (index === 2) return { sampleNo: sample.sampleNo, archiveBin: '新库A柜-03' }
    return null
  }).filter(Boolean)
  return JSON.stringify(
    {
      scanBatchId: `DEMO-${new Date().toISOString().slice(0, 10)}`,
      scannedAt: new Date().toISOString().slice(0, 10),
      records: rows,
    },
    null,
    2,
  )
}

interface BinEditCellProps {
  sample: PaperSample
  onSave: (bin: string) => Promise<void>
}

function BinEditCell({ sample, onSave }: BinEditCellProps) {
  const [editing, setEditing] = useState(false)
  const [bin, setBin] = useState(sample.archiveBin)
  const [saving, setSaving] = useState(false)

  if (!editing) {
    return (
      <Stack direction="row" spacing={1} alignItems="center">
        <Typography variant="body2" sx={{ fontWeight: 700 }}>{sample.archiveBin}</Typography>
        {sample.positionDirty && <Chip size="small" variant="outlined" color="info" label="本机改过" />}
        <Button size="small" onClick={() => { setBin(sample.archiveBin); setEditing(true) }} data-testid={`edit-bin-${sample.sampleNo}`}>
          改柜位
        </Button>
      </Stack>
    )
  }

  const save = async () => {
    setSaving(true)
    await onSave(bin)
    setSaving(false)
    setEditing(false)
  }

  return (
    <Stack direction="row" spacing={1} alignItems="center">
      <TextField
        size="small"
        value={bin}
        onChange={(event) => setBin(event.target.value)}
        inputProps={{ 'data-testid': `bin-input-${sample.sampleNo}` }}
        autoFocus
      />
      <Button
        size="small"
        variant="contained"
        disabled={saving || !bin.trim()}
        onClick={save}
        data-testid={`bin-save-${sample.sampleNo}`}
      >
        保存
      </Button>
      <Button size="small" onClick={() => setEditing(false)}>取消</Button>
    </Stack>
  )
}

export function RelocationPanel() {
  const samples = useSampleStore((state) => state.paperSamples)
  const batches = useSampleStore((state) => state.relocationBatches)
  const error = useSampleStore((state) => state.error)
  const importScan = useSampleStore((state) => state.importScan)
  const resolveDispute = useSampleStore((state) => state.resolveDispute)
  const changeBin = useSampleStore((state) => state.changeBin)
  const lastSummary = useSampleStore((state) => state.lastSummary)
  const fileInput = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)
  const [notice, setNotice] = useState('')
  const [busySample, setBusySample] = useState<number | null>(null)

  const realBatches = batches.filter((batch) => batch.id !== LEGACY_RELOCATION_BATCH_ID)
  const activeBatch: RelocationBatch | undefined = realBatches[realBatches.length - 1]
  const batchId = activeBatch?.id

  const tracked = samples
    .filter((sample) => sample.relocationBatchId === batchId)
    .sort((a, b) => a.sampleNo.localeCompare(b.sampleNo))
  const unresolved = tracked.filter((sample) => sample.relocationStatus === 'disputed' || sample.relocationStatus === 'missed')
  const disputed = tracked.filter((sample) => sample.relocationStatus === 'disputed')
  const missed = tracked.filter((sample) => sample.relocationStatus === 'missed')

  const handleFile = async (file: File | undefined) => {
    if (!file) return
    setImporting(true)
    setNotice('')
    const text = await file.text()
    const result = await importScan(text)
    setImporting(false)
    if (result.ok) {
      const summary = result.summary
      if (result.replayed) {
        setNotice('该扫描结果此前已对账落实，本次未重复占格。')
      } else if (summary) {
        setNotice(
          `对账完成：落实 ${summary.settledCount} 张，漏扫留原柜 ${summary.missedCount} 张，争议 ${summary.disputedCount} 张，未认编号 ${summary.unknownCount} 条。`,
        )
      }
    }
    if (fileInput.current) fileInput.current.value = ''
  }

  const handleResolve = async (sample: PaperSample, choice: 'scanned' | 'local') => {
    if (sample.id === undefined) return
    setBusySample(sample.id)
    const ok = await resolveDispute(sample.id, choice)
    if (ok) setNotice(`争议 ${sample.sampleNo} 已处理。`)
    setBusySample(null)
  }

  const handleBinSave = async (sample: PaperSample, bin: string) => {
    if (sample.id === undefined) return
    await changeBin(sample.id, bin)
  }

  return (
    <Card data-testid="relocation-panel" sx={{ border: '1px solid #cbb892', bgcolor: '#fbf7ec' }}>
      <CardContent sx={{ p: { xs: 2, md: 2.5 } }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2, flexWrap: 'wrap' }}>
          <Box>
            <Typography variant="h5">新库房搬迁对账</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              按样本编号认离线清点器记录：本机未改过的位置直接接新格；双方改过则保留双方柜格并标争议，争议处理前不占新格；漏扫样本仍留在原柜。
            </Typography>
          </Box>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(event) => void handleFile(event.target.files?.[0])}
              data-testid="scan-file-input"
            />
            <Tooltip title="按当前台账生成一份演示扫描 JSON（前 3 张在新库、其余漏扫）">
              <Button
                size="small"
                onClick={() => {
                  const blob = new Blob([buildDemoScan(samples)], { type: 'application/json;charset=utf-8' })
                  const url = URL.createObjectURL(blob)
                  const anchor = document.createElement('a')
                  anchor.href = url
                  anchor.download = 'demo-scan.json'
                  anchor.click()
                  URL.revokeObjectURL(url)
                }}
                data-testid="demo-scan"
              >
                生成演示扫描
              </Button>
            </Tooltip>
            <Button
              size="small"
              variant="contained"
              disabled={importing}
              onClick={() => fileInput.current?.click()}
              data-testid="import-scan"
            >
              {importing ? '对账中…' : '导入扫描结果'}
            </Button>
          </Stack>
        </Box>

        {error && <Alert severity="warning" sx={{ mt: 2 }}>{error}</Alert>}
        {notice && !error && <Alert severity="success" sx={{ mt: 2 }} data-testid="import-notice">{notice}</Alert>}
        {lastSummary && lastSummary.alreadyAppliedCount > 0 && (
          <Alert severity="info" sx={{ mt: 1.5 }}>
            其中 {lastSummary.alreadyAppliedCount} 张为此前已落实（含重出扫描结果），未重复占格。
          </Alert>
        )}

        {activeBatch ? (
          <>
            <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', mt: 2 }}>
              <Chip color="success" variant="outlined" label={`批次 ${activeBatch.batchNo} · 已落实 ${activeBatch.settledCount}`} />
              <Chip color="warning" variant="outlined" label={`漏扫留原柜 ${activeBatch.missedCount}`} />
              <Chip color="error" variant="outlined" label={`争议未占格 ${activeBatch.disputedCount}`} />
              {activeBatch.unknownCount > 0 && <Chip variant="outlined" label={`未认编号 ${activeBatch.unknownCount}`} />}
            </Box>

            {unresolved.length > 0 && (
              <Box sx={{ mt: 2 }}>
                <Typography variant="subtitle2" color="#8a5a17" sx={{ mb: 1 }}>
                  未落实样本（{unresolved.length}）
                </Typography>
                <Box sx={{ overflowX: 'auto' }}>
                  <Table size="small" data-testid="unresolved-table">
                    <TableHead>
                      <TableRow>
                        <TableCell>样本号</TableCell>
                        <TableCell>状态</TableCell>
                        <TableCell>本机/原柜位</TableCell>
                        <TableCell>扫描新格</TableCell>
                        <TableCell align="right">处理</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {[...disputed, ...missed].map((sample) => (
                        <TableRow key={sample.id} data-testid={`unresolved-${sample.sampleNo}`} sx={{ '&:last-child td, &:last-child th': { borderBottom: 0 } }}>
                          <TableCell sx={{ fontWeight: 700 }}>{sample.sampleNo}</TableCell>
                          <TableCell>
                            {sample.relocationStatus && (
                              <Tooltip title={sample.disputeReason ? disputeText[sample.disputeReason] : ''}>
                                <Chip
                                  size="small"
                                  color={statusChip[sample.relocationStatus].color}
                                  label={
                                    sample.disputeReason
                                      ? `${statusChip[sample.relocationStatus].label}·${disputeText[sample.disputeReason]}`
                                      : statusChip[sample.relocationStatus].label
                                  }
                                />
                              </Tooltip>
                            )}
                          </TableCell>
                          <TableCell>
                            <BinEditCell sample={sample} onSave={(bin) => handleBinSave(sample, bin)} />
                          </TableCell>
                          <TableCell>{sample.scannedBin ?? '—'}</TableCell>
                          <TableCell align="right">
                            {sample.relocationStatus === 'disputed' ? (
                              <Stack direction="row" spacing={1} justifyContent="flex-end">
                                <Button
                                  size="small"
                                  variant="outlined"
                                  color="success"
                                  disabled={busySample === sample.id}
                                  onClick={() => void handleResolve(sample, 'scanned')}
                                  data-testid={`take-scanned-${sample.sampleNo}`}
                                >
                                  用扫描格
                                </Button>
                                <Button
                                  size="small"
                                  variant="outlined"
                                  disabled={busySample === sample.id}
                                  onClick={() => void handleResolve(sample, 'local')}
                                  data-testid={`keep-local-${sample.sampleNo}`}
                                >
                                  留本机位
                                </Button>
                              </Stack>
                            ) : (
                              <Typography variant="caption" color="text.secondary">等待补扫，仍在原柜</Typography>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Box>
              </Box>
            )}

            {tracked.length > 0 && unresolved.length === 0 && (
              <Alert severity="success" sx={{ mt: 2 }}>本批次样本已全部落实到新库房柜格。</Alert>
            )}

            {tracked.length > 0 && (
              <>
                <Divider sx={{ my: 2 }} />
                <Typography variant="subtitle2" sx={{ mb: 1 }}>本批次全部柜格</Typography>
                <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                  {tracked.map((sample) => (
                    <Chip
                      key={sample.id}
                      size="small"
                      variant={sample.relocationStatus === 'settled' ? 'filled' : 'outlined'}
                      color={
                        sample.relocationStatus === 'settled'
                          ? 'success'
                          : sample.relocationStatus === 'disputed'
                            ? 'error'
                            : 'warning'
                      }
                      label={`${sample.sampleNo} · ${sample.archiveBin}`}
                    />
                  ))}
                </Box>
              </>
            )}
          </>
        ) : (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
            尚无搬迁批次。把离线清点器扫回的 JSON 导入后，将按样本编号对账并占用新库房柜格。
          </Typography>
        )}
      </CardContent>
    </Card>
  )
}
