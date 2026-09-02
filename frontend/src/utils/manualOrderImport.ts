import { isPlausibleTrackingNo, normalizeTrackingNo } from '@/utils/tracking'

export const MANUAL_IMPORT_LIMITS = {
  maxFileBytes: 512 * 1024,
  maxPayloadBytes: 500 * 1024,
  maxRows: 500,
  maxTextCharacters: 256 * 1024,
} as const

export type ManualImportRowState = 'READY' | 'DUPLICATE_INPUT' | 'FAILED'

export interface ManualImportDefaults {
  productName?: string
  courier?: string
  remark?: string
}

export interface ManualImportPreviewRow {
  sourceRow: number
  trackingNo: string
  productName: string
  courier: string
  remark: string
  usesDefaultProduct: boolean
  state: ManualImportRowState
  message: string
}

export interface ManualImportPreview {
  rows: ManualImportPreviewRow[]
  fatalError: string
}

type TabularCell = unknown

const EXPLICIT_TRACKING_HEADERS = new Set(['运单号', '物流单号', '快递单号', '快递号', 'trackingno', 'trackingnumber'])
const PURCHASE_ORDER_HEADERS = new Set(['订单号', '单号'])
const PRODUCT_HEADERS = new Set(['商品名称', '商品', '品名', 'productname', 'product'])
const COURIER_HEADERS = new Set(['物流公司', '快递公司', '快递', '承运商', 'courier'])
const REMARK_HEADERS = new Set(['备注', '说明', 'remark', 'note'])

function normalizedHeader(value: TabularCell): string {
  return cellText(value).toLowerCase().replace(/[\s_\-（）()]/g, '')
}

function cellText(value: TabularCell): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  return String(value).trim()
}

const SCIENTIFIC_NOTATION = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)e[+-]?\d+$/i
const DATE_SHAPED_VALUE = /^(?:\d{4}|\d{1,2})[./-]\d{1,2}[./-](?:\d{4}|\d{1,2})(?:[ T].*)?$|^\d{4}年\d{1,2}月\d{1,2}日/
const DECIMAL_SHAPED_VALUE = /^[+-]?\d+[.,]\d+$/
const SPLIT_DECIMAL_SHAPED_VALUE = /(?:^|[,，;；\r\n])\s*\d{8,32}\s*[,，]\s*\d{1,7}\s*(?=$|[,，;；\r\n])/

export function suspiciousTrackingFormatMessage(value: string): string {
  if (!value.trim()) return ''
  const compact = value.trim().replace(/\s+/g, '')
  if (SCIENTIFIC_NOTATION.test(compact)) return '疑似科学计数法，单号可能已失真；请将单号列设为文本后重试'
  if (DATE_SHAPED_VALUE.test(compact)) return '疑似日期格式，单号可能已被改写；请将单号列设为文本后重试'
  if (DECIMAL_SHAPED_VALUE.test(compact)) return '疑似 Excel 数值改写，单号不应带小数；请将单号列设为文本后重试'
  if (!/^[A-Za-z0-9 -]+$/.test(value)) return '一个输入只能有一个运单号，多单号请分行/分列'
  return ''
}

function cleanDefaults(defaults: ManualImportDefaults): Required<ManualImportDefaults> {
  return {
    productName: defaults.productName?.trim() ?? '',
    courier: defaults.courier?.trim() ?? '',
    remark: defaults.remark?.trim() ?? '',
  }
}

function buildPreviewRows(
  values: Array<{ sourceRow: number; tracking: TabularCell; product?: TabularCell; courier?: TabularCell; remark?: TabularCell }>,
  defaults: ManualImportDefaults,
): ManualImportPreview {
  if (values.length > MANUAL_IMPORT_LIMITS.maxRows) {
    return { rows: [], fatalError: `一次最多导入 ${MANUAL_IMPORT_LIMITS.maxRows} 条，请拆分后重试。` }
  }
  const fallback = cleanDefaults(defaults)
  const seen = new Set<string>()
  const rows = values.map((value): ManualImportPreviewRow => {
    const nonStringTracking = value.tracking !== null && value.tracking !== undefined && typeof value.tracking !== 'string'
    const rawTracking = cellText(value.tracking)
    const trackingNo = normalizeTrackingNo(rawTracking)
    const rowProduct = cellText(value.product)
    const productName = rowProduct || fallback.productName
    const courier = cellText(value.courier) || fallback.courier
    const remark = cellText(value.remark) || fallback.remark
    const usesDefaultProduct = !productName
    if (nonStringTracking) {
      return {
        sourceRow: value.sourceRow,
        trackingNo: rawTracking,
        productName,
        courier,
        remark,
        usesDefaultProduct,
        state: 'FAILED',
        message: '单号列必须为文本，请在 Excel 中将单号列设为文本后重试',
      }
    }
    if (!rawTracking) {
      return { sourceRow: value.sourceRow, trackingNo: '', productName, courier, remark, usesDefaultProduct, state: 'FAILED', message: '缺少运单号' }
    }
    const suspiciousMessage = suspiciousTrackingFormatMessage(rawTracking)
    if (suspiciousMessage) return { sourceRow: value.sourceRow, trackingNo: rawTracking, productName, courier, remark, usesDefaultProduct, state: 'FAILED', message: suspiciousMessage }
    if (!isPlausibleTrackingNo(trackingNo)) {
      return { sourceRow: value.sourceRow, trackingNo: rawTracking, productName, courier, remark, usesDefaultProduct, state: 'FAILED', message: '运单号应为 8–32 位且至少包含一个数字' }
    }
    if (productName.length > 256) {
      return { sourceRow: value.sourceRow, trackingNo, productName, courier, remark, usesDefaultProduct, state: 'FAILED', message: '商品名称超过 256 个字符，请缩短后重试' }
    }
    if (courier.length > 128) {
      return { sourceRow: value.sourceRow, trackingNo, productName, courier, remark, usesDefaultProduct, state: 'FAILED', message: '物流公司超过 128 个字符，请缩短后重试' }
    }
    if (remark.length > 512) {
      return { sourceRow: value.sourceRow, trackingNo, productName, courier, remark, usesDefaultProduct, state: 'FAILED', message: '备注超过 512 个字符，请缩短后重试' }
    }
    if (seen.has(trackingNo)) {
      return { sourceRow: value.sourceRow, trackingNo, productName, courier, remark, usesDefaultProduct, state: 'DUPLICATE_INPUT', message: '与本批前面的运单号重复，不会再次导入' }
    }
    seen.add(trackingNo)
    return {
      sourceRow: value.sourceRow,
      trackingNo,
      productName,
      courier,
      remark,
      usesDefaultProduct,
      state: 'READY',
      message: usesDefaultProduct ? '可导入；商品名将使用“未填写商品名称”' : '可导入',
    }
  })
  return { rows, fatalError: '' }
}

export function parseTrackingText(text: string, defaults: ManualImportDefaults = {}): ManualImportPreview {
  if (text.length > MANUAL_IMPORT_LIMITS.maxTextCharacters) {
    return { rows: [], fatalError: '粘贴内容超过 256 KiB，请拆分后重试。' }
  }
  if (SPLIT_DECIMAL_SHAPED_VALUE.test(text)) {
    return { rows: [], fatalError: '发现疑似 Excel 小数截断的单号（长纯数字后接短数字尾数），请将原单号设为文本后重新粘贴。' }
  }
  const entries = text
    .split(/[,，;；\r\n]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (entries.length === 0) return { rows: [], fatalError: '请先粘贴至少一个运单号。' }
  return buildPreviewRows(
    entries.map((tracking, index) => ({ sourceRow: index + 1, tracking })),
    defaults,
  )
}

function detectCsvDelimiter(text: string): string {
  const firstLine = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? ''
  const candidates = [',', ';', '\t', '，']
  return candidates.reduce((best, candidate) =>
    firstLine.split(candidate).length > firstLine.split(best).length ? candidate : best, ',')
}

export function parseCsv(text: string): string[][] {
  const delimiter = detectCsvDelimiter(text)
  const rows: string[][] = []
  let row: string[] = []
  let value = ''
  let quoted = false
  let closedQuotedField = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        value += '"'
        index += 1
      } else if (quoted) {
        quoted = false
        closedQuotedField = true
      } else if (value.length === 0 && !closedQuotedField) quoted = true
      else throw new Error('CSV 引号格式非法，请修正文件后重试。')
    } else if (character === delimiter && !quoted) {
      row.push(value)
      value = ''
      closedQuotedField = false
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1
      row.push(value)
      rows.push(row)
      row = []
      value = ''
      closedQuotedField = false
    } else if (closedQuotedField) {
      if (!/\s/.test(character ?? '')) throw new Error('CSV 引号格式非法，请修正文件后重试。')
    } else value += character
  }
  if (quoted) throw new Error('CSV 引号未闭合，请修正文件后重试。')
  if (value.length > 0 || row.length > 0) {
    row.push(value)
    rows.push(row)
  }
  if (rows[0]?.[0]) rows[0][0] = rows[0][0].replace(/^\uFEFF/, '')
  return rows
}

export function parseTabularRows(rows: TabularCell[][], defaults: ManualImportDefaults = {}): ManualImportPreview {
  const nonEmptyRows = rows
    .map((row, index) => ({ row, sourceRow: index + 1 }))
    .filter(({ row }) => row.some((cell) => cellText(cell)))
  const headerEntry = nonEmptyRows[0]
  if (!headerEntry) return { rows: [], fatalError: '文件中没有可读取的数据。' }
  const headers = headerEntry.row
  const hasOverflowCells = nonEmptyRows.slice(1).some(({ row }) => row.slice(headers.length).some((cell) => cellText(cell)))
  if (hasOverflowCells) {
    return { rows: [], fatalError: '数据行包含超出表头范围的多余列，请检查 CSV 引号是否正确或删除多余列后重试。' }
  }
  const normalized = headers.map(normalizedHeader)
  const explicitTrackingIndexes = normalized.flatMap((header, index) => EXPLICIT_TRACKING_HEADERS.has(header) ? [index] : [])
  const hasPurchaseOrderHeader = normalized.some((header) => PURCHASE_ORDER_HEADERS.has(header))
  if (explicitTrackingIndexes.length > 1) {
    return { rows: [], fatalError: '发现多个物流单号列，请只保留一个：运单号、物流单号、快递单号或快递号。' }
  }
  const trackingIndex = explicitTrackingIndexes[0]
  if (trackingIndex === undefined) {
    if (hasPurchaseOrderHeader) {
      return { rows: [], fatalError: '采购订单号不能代替物流运单号。请确认内容确为物流单号，并把列名改成“运单号”后重试。' }
    }
    return { rows: [], fatalError: '未找到物流运单号列。表头请使用：运单号、物流单号、快递单号或快递号。' }
  }
  const productIndex = normalized.findIndex((header) => PRODUCT_HEADERS.has(header))
  const courierIndex = normalized.findIndex((header) => COURIER_HEADERS.has(header))
  const remarkIndex = normalized.findIndex((header) => REMARK_HEADERS.has(header))
  const values = nonEmptyRows.slice(1).map(({ row, sourceRow }) => ({
    sourceRow,
    tracking: row[trackingIndex],
    product: productIndex < 0 ? undefined : row[productIndex],
    courier: courierIndex < 0 ? undefined : row[courierIndex],
    remark: remarkIndex < 0 ? undefined : row[remarkIndex],
  }))
  if (values.length === 0) return { rows: [], fatalError: '文件只有表头，没有可导入的数据。' }
  return buildPreviewRows(values, defaults)
}

export async function parseManualOrderFile(file: File, defaults: ManualImportDefaults = {}): Promise<ManualImportPreview> {
  if (file.size > MANUAL_IMPORT_LIMITS.maxFileBytes) {
    return { rows: [], fatalError: '文件不能超过 512 KiB，请拆分后重试。' }
  }
  const extension = file.name.toLowerCase().split('.').pop() ?? ''
  if (extension === 'xls') {
    return { rows: [], fatalError: '暂不读取旧版 .xls，请在 Excel 中另存为 .xlsx 或 CSV 后上传。' }
  }
  try {
    if (extension === 'csv') {
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
      } catch {
        return { rows: [], fatalError: 'CSV 不是有效的 UTF-8 编码，请另存为 UTF-8 CSV 或 .xlsx 后重试。' }
      }
      return parseTabularRows(parseCsv(text), defaults)
    }
    if (extension === 'xlsx') {
      const { readSheet } = await import('read-excel-file/browser')
      const rows = await readSheet(file)
      return parseTabularRows(rows, defaults)
    }
    return { rows: [], fatalError: '仅支持 .xlsx、.csv；旧版 .xls 请先另存为 .xlsx 或 CSV。' }
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    return { rows: [], fatalError: message.startsWith('CSV 引号') ? message : '文件解析失败，请确认文件未损坏且表头正确。' }
  }
}
