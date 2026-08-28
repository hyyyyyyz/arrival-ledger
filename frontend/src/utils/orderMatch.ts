import type { OrderMatch } from '@/types'

export function orderMatchKey(match: OrderMatch, legacyIndex: number): string {
  const orderId = match.order_id?.trim()
  if (orderId) return `order-${orderId}`

  const account = match.account_label?.trim() || match.shop_name?.trim() || 'unknown-account'
  return `legacy-${match.platform}-${account}-${match.platform_order_id}-${legacyIndex}`
}

export function orderMatchSourceLabel(match: OrderMatch): string {
  const account = match.account_label?.trim()
  const shop = match.shop_name?.trim()
  const parts = [match.platform]

  if (account) parts.push(account)
  if (shop && shop !== account) parts.push(shop)
  if (!account && !shop) parts.push('店铺未知')

  return parts.join(' · ')
}
